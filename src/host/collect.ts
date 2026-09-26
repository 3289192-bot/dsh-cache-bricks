/**
 * The host half: watch real model calls, and drop a brick when one settles.
 *
 * Three taps, and the smallest possible amount of work behind each:
 *
 * | tap | what it is for | what is done with it |
 * |---|---|---|
 * | `llm/stream` | the request itself | counted — a request that settles is a brick, and the count says so |
 * | `agent/assistant-stream` | identity (`turn`, `step`, `attemptId`) and live chunks | `start` opens an attempt; a `usage` chunk is a placeholder; **deltas are not looked at** |
 * | `session/event` | the durable settlement with the billed usage | the brick: one per `assistant/message` / `assistant/attempt` |
 *
 * That is the whole collector. There is no blob store, no request summarizer, no context
 * snapshot, no retry bookkeeping and no tool tracking, because none of them are part of a brick
 * (see `shared/cache-brick.ts`). The only structural care taken is the one that matters: this
 * code runs **inside the model-call path**, so every read of a payload is guarded, `next()` is
 * always returned untouched, and nothing is ever thrown back into the caller.
 */
import { AttemptTracker, type AttemptFrame } from './attempt-tracker'
import { BrickFeeds, type SessionFeed } from './brick-feed'
import { createBrickRouter, type BricksRouter } from './routes'
import { readSessionLog } from './session-log'

/** The parts of the plugin's Cordis context this half uses, structurally. */
export interface HostContextLike {
  on(event: string, listener: (...args: never[]) => unknown, options?: { global?: boolean; prepend?: boolean }): unknown
  get(name: string): unknown
  inject(names: string[], callback: (ctx: HostContextLike) => void): unknown
  effect(callback: () => void): unknown
}

/** Capacity and serving options, from the plugin row's config. */
export interface CollectorOptions {
  /** Bricks kept per session, newest last. */
  readonly capacity?: number
  /** Sessions kept. */
  readonly sessions?: number
  /** Route prefix; defaults to `/cache-bricks`. */
  readonly basePath?: string
  /**
   * Read a session's own log once, when a browser first asks for its bricks (default true).
   *
   * This is the only history this build touches, and it is why an old session is not a blank
   * gutter: the log's settled attempts become the same eleven-field bricks, oldest first, into the
   * same ring. Set false for a host that must not read session artifacts at all.
   */
  readonly backfill?: boolean
  /** Extra log roots to search, in order; defaults to `$DSH_SESSION_ROOT` then `$DSH_HOME/sessions`. */
  readonly logsRoots?: readonly string[]
  /** Set false to observe without serving (headless profiles, tests). */
  readonly serve?: boolean
}

/** The collector's own surface, for tests and hosts. */
export interface Collector {
  readonly feeds: BrickFeeds
  feed(sessionId: string): ReturnType<SessionFeed['snapshot']> | undefined
  sessions(): string[]
  subscribe(sessionId: string, sink: (feed: ReturnType<SessionFeed['snapshot']>) => void): () => void
  /** A reader is looking at this session: read its log once, if that has not happened yet. */
  looked(sessionId: string): void
  dispose(): void
}

/** How long bricks are allowed to wait for one push. One frame at 60 Hz is 16 ms. */
const PUBLISH_INTERVAL_MS = 100

/**
 * Install the collector.
 * @param ctx - the plugin's Cordis context.
 * @param options - capacity and serving options.
 * @returns the collector, so a host or a test can read it directly.
 */
export function installCollector(ctx: HostContextLike, options: CollectorOptions = {}): Collector {
  // Sessions whose log has already been read (or found to be unreadable): one pass each, ever.
  const backfilled = new Set<string>()
  const backfillEnabled = options.backfill !== false

  const feeds = new BrickFeeds({
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    ...(options.capacity === undefined ? {} : { tracker: { capacity: options.capacity } }),
  })
  let disposed = false

  /** Run something that sits inside the model-call path without ever letting it throw. */
  const safely = (action: () => void): void => {
    try {
      action()
    } catch (error) {
      console.warn('[dsh-cache-bricks] observation failed:', error instanceof Error ? error.message : error)
    }
  }

  // --- publishing, coalesced -------------------------------------------------
  let lastPublish = 0
  let trailing: ReturnType<typeof setTimeout> | undefined

  const publishNow = (feed: SessionFeed): void => {
    lastPublish = Date.now()
    feed.publish()
  }

  /**
   * Push the current bricks, at most once per {@link PUBLISH_INTERVAL_MS}.
   *
   * A settlement is the only thing that calls this, so the coalescing matters for one case only:
   * a turn that settles several attempts in quick succession (a retry chain) should reach the
   * browser as one repaint rather than three.
   */
  const publish = (feed: SessionFeed): void => {
    if (feed.listeners === 0) return
    const wait = PUBLISH_INTERVAL_MS - (Date.now() - lastPublish)
    if (wait <= 0) {
      publishNow(feed)
      return
    }
    if (trailing !== undefined) return
    trailing = setTimeout(() => {
      trailing = undefined
      publishNow(feed)
    }, wait)
  }

  // --- the taps --------------------------------------------------------------

  // `prepend` so the request is counted before any listener that might wrap or short-circuit the
  // dispatch; `next()` is returned untouched, always: returning anything else would replace the
  // model's stream.
  ctx.on('llm/stream', ((...args: unknown[]) => {
    const request = args[0] as { sessionId?: unknown } | undefined
    const next = args[1] as (() => unknown) | undefined
    // Reading the payload is itself guarded: a hostile or exotic request object must not turn
    // into a throw inside the model-call path. Anything unreadable is counted as `unknown`.
    let sessionId = 'unknown'
    try {
      if (typeof request?.sessionId === 'string') sessionId = request.sessionId
    } catch {
      sessionId = 'unknown'
    }
    safely(() => { feeds.for(sessionId).attempts.dispatched() })
    return next?.()
  }) as (...args: never[]) => unknown, { global: true, prepend: true })

  // The identity channel. Only `start` and a `usage` chunk are read; a text or reasoning delta
  // costs one property read and returns.
  ctx.on('agent/assistant-stream', ((...args: unknown[]) => {
    const payload = args[0] as { agent?: { session?: { id?: string } }; frame?: AttemptFrame } | undefined
    const frame = payload?.frame
    if (frame === undefined) return
    safely(() => {
      const sessionId = payload?.agent?.session?.id ?? 'unknown'
      feeds.for(sessionId).attempts.frame(frame)
    })
  }) as (...args: never[]) => unknown, { global: true })

  // The settlement channel: this is what makes a brick. `assistant/attempt` is a failed attempt
  // (a transport error, a retry that replaced it) and settles exactly like a message does, which
  // is why a retried step comes out as two bricks without any retry bookkeeping at all.
  ctx.on('session/event', ((...args: unknown[]) => {
    const session = args[0] as { id?: string } | undefined
    const event = args[1] as { type?: string; time?: number; data?: unknown } | undefined
    if (session?.id === undefined || event?.type === undefined) return
    safely(() => {
      const sessionId = session.id!
      const feed = feeds.for(sessionId)
      if (event.type === 'turn/end') {
        const turn = (event.data as { turn?: unknown } | undefined)?.turn
        if (typeof turn === 'number') {
          feed.attempts.turnEnded(turn)
          publish(feed)
        }
        return
      }
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return
      const data = (event.data ?? {}) as {
        turn?: unknown
        step?: unknown
        usage?: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
        stream?: readonly unknown[]
      }
      const brick = feed.attempts.settle({
        ...(typeof data.turn === 'number' ? { turn: data.turn } : {}),
        ...(typeof data.step === 'number' ? { step: data.step } : {}),
        ...(event.time === undefined ? {} : { time: event.time }),
        ...(data.usage === undefined ? {} : {
          usage: {
            inputTokens: data.usage.inputTokens ?? 0,
            ...(data.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: data.usage.cacheReadTokens }),
            ...(data.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: data.usage.cacheWriteTokens }),
          },
        }),
        ...(data.stream === undefined ? {} : { stream: data.stream }),
      })
      if (brick !== undefined) publish(feed)
    })
  }) as (...args: never[]) => unknown, { global: true })

  /**
   * Fill a session's ring from its own log, once, when a browser first looks at it.
   *
   * Deliberately *not* done when the collector merely sees an event for a session: an active
   * session is already producing live bricks and its past is the least interesting thing about it.
   * The trigger is a reader asking, which is also when the cost is worth paying.
   *
   * @param sessionId - the session a browser asked about.
   */
  const ensureBackfilled = (sessionId: string): void => {
    if (!backfillEnabled || backfilled.has(sessionId)) return
    backfilled.add(sessionId)
    void (async () => {
      try {
        const read = await readSessionLog(sessionId, {
          ...(options.logsRoots === undefined ? {} : { roots: options.logsRoots }),
        })
        if (read === undefined || disposed) return
        const feed = feeds.for(sessionId)
        let added = 0
        for (const settlement of read.settlements) {
          if (feed.attempts.settleFromLog(settlement) !== undefined) added += 1
        }
        for (const turn of read.endedTurns) feed.attempts.turnEnded(turn)
        if (added > 0) {
          feed.publish()
          console.info(
            `[dsh-cache-bricks] read ${String(added)} settled attempt(s) for ${sessionId} `
            + `from ${read.path} (${String(read.records)} records, ${String(read.frames)} frame(s))`,
          )
        }
      } catch (error) {
        // A log that cannot be read is not a reason to stop counting live requests.
        console.warn('[dsh-cache-bricks] session log backfill failed:', error instanceof Error ? error.message : error)
      }
    })()
  }

  // --- HTTP ------------------------------------------------------------------

  const collector: Collector = {
    feeds,
    feed: (sessionId) => feeds.peek(sessionId)?.snapshot(),
    sessions: () => feeds.sessions(),
    subscribe: (sessionId, sink) => feeds.for(sessionId).subscribe(sink),
    looked: (sessionId) => { ensureBackfilled(sessionId) },
    dispose: () => {
      disposed = true
      feeds.dispose()
      if (trailing !== undefined) {
        clearTimeout(trailing)
        trailing = undefined
      }
    },
  }

  if (options.serve !== false) {
    const router: BricksRouter = createBrickRouter({
      bricks: (sessionId) => collector.feed(sessionId),
      sessions: () => collector.sessions(),
      subscribe: (sessionId, sink) => collector.subscribe(sessionId, sink),
      // A browser is looking at this session: this is the moment its recorded past is worth a read.
      looked: (sessionId) => { collector.looked(sessionId) },
    }, {
      ...(options.basePath === undefined ? {} : { basePath: options.basePath }),
      // Prefer the harness's own request policy: the board is as reachable as the rest of the
      // GUI and no more.
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

/** The tracker type, re-exported for a host that wants to read a feed directly. */
export type { AttemptTracker }
