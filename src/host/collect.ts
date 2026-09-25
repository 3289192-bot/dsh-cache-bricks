/**
 * The host half's collector: a read-only tap on the model-call path plus the
 * ledger and HTTP surface behind it.
 *
 * The whole design rests on one promise: **observing a request must not change
 * it**. DSH makes that easy to keep, and hard to break silently:
 *
 * - `llm/stream` is a waterfall, so its listener *is* the dispatch: the value it
 *   returns is the stream the agent loop consumes. Every path through this module
 *   returns `next()` — a listener that returns nothing would replace the model's
 *   stream with `undefined`.
 * - A loop-built request arrives deep-frozen, so writing to it throws rather than
 *   corrupting the prompt; this module only reads.
 * - Observation happens inside `try`/`catch`: a bug in the ledger must never turn
 *   into a failed model call.
 *
 * Attempt identity is the other half of the design. `llm/stream` carries the
 * request but no turn/step/attempt id; `agent/assistant-stream` carries the
 * identity but no request. The ledger pairs them through a per-session FIFO, so
 * whichever channel reports first, the two meet.
 */
import { BrickLedger, type Observation } from '../core/brick-ledger'
import { BlobStore } from '../core/blob-store'
import { createCacheBricksRouter } from './routes'
import {
  RequestSummarizer,
  chunkObservation,
  compactionObservation,
  contextObservation,
  headerObservation,
  retryObservation,
  settlementObservation,
  toolCallObservation,
  toolResultObservation,
  type ChunkLike,
  type RequestLike,
} from '../core/observe'
import type { BrickFeed } from '../shared/brick'

/** Structural view of the Cordis context this plugin uses. */
export interface HostContextLike {
  on(name: string, listener: (...args: never[]) => unknown, options?: { global?: boolean; prepend?: boolean }): unknown
  get(name: string): unknown
  inject(names: readonly string[], callback: (ctx: HostContextLike) => void): unknown
  effect(callback: () => void | (() => void)): unknown
}

/** One session's observation state. */
interface SessionState {
  readonly ledger: BrickLedger
  readonly summarizer: RequestSummarizer
  readonly listeners: Set<(feed: BrickFeed) => void>
  /** True once the first dropped observation has been reported for this session. */
  warnedUnattributed: boolean
}

/** Session lookup surface, as `@deepseek-ai/dsh-session` provides it. */
interface SessionsLike {
  get(id: string): unknown
}

/** Token meter surface, as `@deepseek-ai/dsh-token-meter` provides it. */
interface TokenMeterLike {
  measure(session: unknown, header?: unknown): {
    readonly baseline?: { readonly kind?: string; readonly tokens?: number }
    readonly surfaceDeltaTokens?: number
    readonly totalTokens?: number
    readonly surfaceTokens?: number
    readonly nodes?: readonly unknown[]
  }
}

/** Projection surface, as `@deepseek-ai/dsh-session-projection` provides it. */
interface ProjectionsLike {
  stateOf(session: unknown, key: string): unknown
}

/** Options for {@link installCollector}. */
export interface CollectorOptions {
  /** Bricks kept per session in memory. */
  readonly maxBricks?: number
  /** Session states kept before the least recently used is dropped. */
  readonly maxSessions?: number
  /** Bytes kept per session in the blob store. */
  readonly maxStoreBytes?: number
  /** Route namespace base path. */
  readonly basePath?: string
  /** Disable the HTTP surface (used by tests). */
  readonly serve?: boolean
}

/** The collector handle, exposed so a host can inspect what was gathered. */
export interface Collector {
  readonly store: BlobStore
  feed(sessionId: string): BrickFeed | undefined
  sessions(): readonly string[]
  blob(ref: string): unknown
  subscribe(sessionId: string, sink: (feed: BrickFeed) => void): () => void
  dispose(): void
}

/**
 * Install the collector on a host context.
 * @param ctx - the plugin's Cordis context.
 * @param options - capacity and serving options.
 * @returns the collector, so tests and hosts can read from it directly.
 */
export function installCollector(ctx: HostContextLike, options: CollectorOptions = {}): Collector {
  const store = new BlobStore({ maxTotalBytes: options.maxStoreBytes ?? 48 * 1024 * 1024 })
  const sessions = new Map<string, SessionState>()
  let disposed = false

  /** Run an observation without ever letting it reach the caller. */
  const safely = (action: () => void): void => {
    try {
      action()
    } catch (error) {
      // Never rethrow: this code sits inside the model-call path.
      console.warn('[dsh-cache-bricks] observation failed:', error instanceof Error ? error.message : error)
    }
  }

  /**
   * Session states, capped. A long-running host sees many sessions, and each one
   * holds a ledger and (through the shared store) raw payloads; the oldest is
   * dropped rather than kept until the plugin is disposed.
   */
  const MAX_SESSIONS = options.maxSessions ?? 8

  const stateFor = (sessionId: string): SessionState => {
    const existing = sessions.get(sessionId)
    if (existing !== undefined) {
      // Re-insert to mark it as most recently used.
      sessions.delete(sessionId)
      sessions.set(sessionId, existing)
      return existing
    }
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next()
      if (oldest.done !== true) sessions.delete(oldest.value)
    }
    const state: SessionState = {
      ledger: new BrickLedger(sessionId, {
        store,
        ...(options.maxBricks === undefined ? {} : { maxBricks: options.maxBricks }),
      }),
      summarizer: new RequestSummarizer(store),
      listeners: new Set(),
      warnedUnattributed: false,
    }
    sessions.set(sessionId, state)
    return state
  }

  const PUBLISH_INTERVAL_MS = 100
  let lastPublish = 0
  let trailing: ReturnType<typeof setTimeout> | undefined

  const publishNow = (state: SessionState): void => {
    lastPublish = Date.now()
    // Materializing every brick is the expensive part; skip it when the tab that
    // asked for the stream has gone.
    if (state.listeners.size === 0) return
    const feed = state.ledger.feed()
    for (const listener of state.listeners) {
      try {
        listener(feed)
      } catch {
        // A dead SSE client is not the collector's problem.
      }
    }
  }

  /**
   * Push the current feed, coalesced to at most one send per
   * {@link PUBLISH_INTERVAL_MS}. The trailing send matters: the last observation
   * of an attempt must reach the browser even if it lands inside a quiet window.
   */
  const publish = (state: SessionState): void => {
    const wait = PUBLISH_INTERVAL_MS - (Date.now() - lastPublish)
    if (wait <= 0) {
      publishNow(state)
      return
    }
    if (trailing !== undefined) return
    trailing = setTimeout(() => {
      trailing = undefined
      publishNow(state)
    }, wait)
  }

  /**
   * Observations worth waking a browser for.
   *
   * `agent/assistant-stream` emits one frame per token-level delta, and materializing
   * every retained brick (up to 400) plus serializing the whole feed on each of a
   * long answer's ~1500 chunks is pure waste: nothing a brick displays changes
   * until usage, a tool call, or the attempt ends. Text and reasoning deltas are
   * still folded — they just do not trigger a push.
   */
  const publishable = (observation: Observation): boolean => {
    if (observation.kind === 'chunk') {
      const type = observation.chunk.type
      return type === 'usage' || type === 'finish' || type === 'tool-call'
    }
    return true
  }

  const collect = (sessionId: string, observation: Observation): void => {
    const state = stateFor(sessionId)
    state.ledger.observe(observation)
    // A dropped observation is a hole in the record. Say so once per session rather than
    // every time, and never paper over it by attaching it to an unrelated attempt.
    if (!state.warnedUnattributed && state.ledger.unattributedCount > 0) {
      state.warnedUnattributed = true
      console.warn(
        `[dsh-cache-bricks] dropped ${String(state.ledger.unattributedCount)} observation(s) for session `
        + `${sessionId}: no attempt could be identified for them (see feed.unattributed).`,
      )
    }
    if (state.listeners.size === 0) return
    if (!publishable(observation)) return
    publish(state)
  }

  /** Snapshot the context environment at dispatch: pressure, composition, meter. */
  const snapshotContext = (sessionId: string): void => {
    const session = (ctx.get('sessions') as SessionsLike | undefined)?.get(sessionId)
    if (session === undefined) return
    const pressure = (ctx.get('sessionProjections') as ProjectionsLike | undefined)?.stateOf(session, 'contextPressure') as
      | { contextWindow?: number; pressureTokens?: number; surfaceTokens?: number; sampledSurfaceTokens?: number }
      | undefined
    const breakdown = (ctx.get('sessionProjections') as ProjectionsLike | undefined)?.stateOf(session, 'contextBreakdown') as
      | { systemTokens?: number; toolsTokens?: number; messageTokens?: number }
      | undefined
    const header = (session as { requestHeader?: () => unknown }).requestHeader?.()
    const meter = (ctx.get('tokenMeter') as TokenMeterLike | undefined)?.measure(session, header)
    const meterRef = meter === undefined ? undefined : store.put(meter)
    const projected = pressure?.pressureTokens !== undefined && pressure.surfaceTokens !== undefined
      && pressure.sampledSurfaceTokens !== undefined
      ? Math.max(0, pressure.pressureTokens + pressure.surfaceTokens - pressure.sampledSurfaceTokens)
      : undefined
    collect(sessionId, {
      kind: 'pressure',
      snapshot: {
        ...(pressure?.contextWindow === undefined ? {} : { contextWindow: pressure.contextWindow }),
        ...(pressure?.pressureTokens === undefined ? {} : { pressureTokens: pressure.pressureTokens }),
        ...(projected === undefined ? {} : { projectedTokens: projected }),
        ...(pressure?.surfaceTokens === undefined ? {} : { surfaceTokens: pressure.surfaceTokens }),
        ...(breakdown?.systemTokens === undefined ? {} : { systemTokens: breakdown.systemTokens }),
        ...(breakdown?.toolsTokens === undefined ? {} : { toolsTokens: breakdown.toolsTokens }),
        ...(breakdown?.messageTokens === undefined ? {} : { messageTokens: breakdown.messageTokens }),
        ...(meter?.baseline?.kind === undefined
          ? {}
          : { baselineKind: meter.baseline.kind as 'none' | 'estimated' | 'usage' }),
        ...(meter?.baseline?.tokens === undefined ? {} : { baselineTokens: meter.baseline.tokens }),
        ...(meter?.surfaceDeltaTokens === undefined ? {} : { surfaceDeltaTokens: meter.surfaceDeltaTokens }),
        ...(meter?.totalTokens === undefined ? {} : { totalMeterTokens: meter.totalTokens }),
        ...(meter?.nodes === undefined ? {} : { nodeCount: meter.nodes.length }),
        ...(meterRef === undefined ? {} : { meterRef: meterRef.hash }),
      },
    })
  }

  // --- The model-call tap -------------------------------------------------
  // `prepend` so the request is captured before any listener that might wrap or
  // short-circuit the dispatch; `next()` is returned untouched, always.
  ctx.on('llm/stream', ((...args: unknown[]) => {
    const options = args[0] as RequestLike
    const next = args[1] as () => unknown
    // Every read of the payload is guarded: a hostile or exotic request object
    // must not be able to turn into a throw inside the model-call path.
    let sessionId = 'unknown'
    try {
      if (typeof options.sessionId === 'string') sessionId = options.sessionId
    } catch {
      sessionId = 'unknown'
    }
    safely(() => {
      snapshotContext(sessionId)
      collect(sessionId, { kind: 'dispatch', at: Date.now(), options: stateFor(sessionId).summarizer.summarize(options) })
    })
    const stream = next()
    // Reading the payload is itself guarded: this code sits inside the model-call
    // path, so even a hostile or exotic request object must not turn into a throw
    // here. Anything unreadable is treated as a normal request.
    let purpose: unknown
    try {
      purpose = options.purpose
    } catch {
      purpose = undefined
    }
    // An auxiliary call has no Turn attempt to pair with and produces no
    // `agent/assistant-stream` frames, so its chunks can only be observed by
    // wrapping the stream. The wrapper yields exactly what it receives: the
    // request and the stream the caller consumes are both unchanged.
    if (purpose !== 'compaction' && purpose !== 'session-title') return stream
    return observeAuxiliary(stream, sessionId)
  }) as (...args: never[]) => unknown, { global: true, prepend: true })

  /**
   * Pass every chunk through untouched while folding it onto the auxiliary brick.
   * @param stream - the downstream async iterable.
   * @param sessionId - the session the call belongs to.
   * @returns an iterable that yields the same chunks in the same order.
   */
  async function* observeAuxiliary(stream: unknown, sessionId: string): AsyncGenerator<unknown> {
    try {
      for await (const chunk of stream as AsyncIterable<unknown>) {
        safely(() => {
          collect(sessionId, {
            kind: 'chunk',
            at: Date.now(),
            chunk: chunkObservation(chunk as ChunkLike),
            auxiliary: true,
          })
        })
        yield chunk
      }
    } finally {
      safely(() => {
        collect(sessionId, { kind: 'attempt-end', at: Date.now(), outcome: 'committed', auxiliary: true })
      })
    }
  }

  // --- Live attempt frames ------------------------------------------------
  ctx.on('agent/assistant-stream', ((...args: unknown[]) => {
    const payload = args[0] as {
      agent?: { session?: { id?: string } }
      frame?: {
        type?: string
        attemptId?: string
        revision?: number
        turn?: number
        step?: number
        time?: number
        chunk?: ChunkLike
        outcome?: { kind?: string; eventType?: string; seq?: number }
      }
    }
    const frame = payload?.frame
    if (frame === undefined) return
    safely(() => {
      const sessionId = payload.agent?.session?.id ?? 'unknown'
      const state = stateFor(sessionId)
      if (frame.type === 'start') {
        void state
        collect(sessionId, {
          kind: 'attempt-start',
          at: Date.now(),
          turn: frame.turn ?? 0,
          step: frame.step ?? 0,
          ...(frame.attemptId === undefined ? {} : { attemptId: frame.attemptId }),
          ...(frame.revision === undefined ? {} : { revision: frame.revision }),
        })
        return
      }
      if (frame.type === 'chunk') {
        if (frame.chunk === undefined) return
        collect(sessionId, { kind: 'chunk', at: frame.time ?? Date.now(), chunk: chunkObservation(frame.chunk) })
        return
      }
      if (frame.type === 'end') {
        const committed = frame.outcome?.kind === 'committed'
        collect(sessionId, {
          kind: 'attempt-end',
          at: Date.now(),
          outcome: committed ? 'committed' : 'abandoned',
          ...(committed && frame.outcome?.eventType !== undefined
            ? { eventType: frame.outcome.eventType as 'assistant/message' | 'assistant/attempt' }
            : {}),
          ...(frame.outcome?.seq === undefined ? {} : { seq: frame.outcome.seq }),
        })
      }
    })
  }) as (...args: never[]) => unknown, { global: true })

  // --- Durable session records -------------------------------------------
  ctx.on('session/event', ((...args: unknown[]) => {
    const session = args[0] as { id?: string } | undefined
    const event = args[1] as { type?: string; seq?: number; time?: number; data?: unknown } | undefined
    if (session?.id === undefined || event?.type === undefined) return
    safely(() => {
      const sessionId = session.id!
      switch (event.type) {
        case 'request/header':
          collect(sessionId, headerObservation({ seq: event.seq, data: event.data as never }, store) ?? { kind: 'flush', at: Date.now() })
          break
        case 'request/context':
          safely(() => {
            const observation = contextObservation({ data: event.data as never })
            if (observation !== undefined) collect(sessionId, observation)
          })
          break
        case 'assistant/message':
        case 'assistant/attempt':
          safely(() => {
            const observation = settlementObservation({ seq: event.seq, time: event.time, data: event.data as never }, store)
            if (observation !== undefined) collect(sessionId, observation)
          })
          break
        case 'turn/end': {
          const turn = (event.data as { turn?: number } | undefined)?.turn
          if (typeof turn === 'number') collect(sessionId, { kind: 'turn-end', turn })
          break
        }
        case 'compaction/start':
          safely(() => {
            const observation = compactionObservation({ data: event.data as never })
            if (observation !== undefined) collect(sessionId, observation)
          })
          break
        case 'llm/retry':
          safely(() => {
            const observation = retryObservation({ data: event.data as never })
            if (observation !== undefined) collect(sessionId, observation)
          })
          break
        case 'tool/call':
          safely(() => {
            const observation = toolCallObservation({ seq: event.seq, time: event.time, data: event.data as never }, store)
            if (observation !== undefined) collect(sessionId, observation)
          })
          break
        case 'tool/result':
          safely(() => {
            const observation = toolResultObservation({ time: event.time, data: event.data as never }, store)
            if (observation !== undefined) collect(sessionId, observation)
          })
          break
        default:
          break
      }
    })
  }) as (...args: never[]) => unknown, { global: true })

  // --- HTTP surface -------------------------------------------------------
  const collector: Collector = {
    store,
    feed: (sessionId) => sessions.get(sessionId)?.ledger.feed(),
    sessions: () => [...sessions.keys()],
    blob: (ref) => store.get(ref),
    subscribe: (sessionId, sink) => {
      const state = stateFor(sessionId)
      state.listeners.add(sink)
      return () => {
        state.listeners.delete(sink)
      }
    },
    dispose: () => {
      disposed = true
      sessions.clear()
      if (trailing !== undefined) {
        clearTimeout(trailing)
        trailing = undefined
      }
    },
  }

  if (options.serve !== false) {
    const router = createCacheBricksRouter({
      feed: (sessionId) => collector.feed(sessionId),
      sessions: () => collector.sessions(),
      blob: (ref) => collector.blob(ref),
      subscribe: (sessionId, sink) => collector.subscribe(sessionId, sink),
    }, {
      ...(options.basePath === undefined ? {} : { basePath: options.basePath }),
      // Prefer the harness's own request policy: it applies the same host, origin
      // and browser-authentication checks as /api, which matters because /blob
      // serves whole requests, tool arguments and streams.
      guard: (request) => {
        const connection = ctx.get('connection') as
          | { requestRejection?: (request: unknown) => number | undefined }
          | undefined
        return connection?.requestRejection?.(request)
      },
    })
    ctx.inject(['webServer'], (webCtx) => {
      const server = webCtx.get('webServer') as { register(route: { kind: string; path: string; handler: unknown }): () => void } | undefined
      if (server === undefined || disposed) return
      webCtx.effect(() => server.register({ kind: 'prefix', path: options.basePath ?? router.path, handler: router.handler }))
    })
  }

  return collector
}
