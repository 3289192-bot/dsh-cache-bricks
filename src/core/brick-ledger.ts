/**
 * The ledger: folds what the runtime reports into one brick per **real model
 * request attempt**.
 *
 * Three facts about DSH 0.1.7-rc.1 shape this design, all verified in the
 * installed source:
 *
 * 1. `llm/stream` is a waterfall that carries the full outgoing request but **no
 *    turn, step or attempt id**. The attempt identity arrives separately on
 *    `agent/assistant-stream`'s `start` frame (`turn`, `step`, `attemptId`,
 *    `revision`). So a dispatch is paired with an attempt through a per-session
 *    FIFO: whichever side arrives first, the two meet in the middle.
 * 2. `llm/retry` and `llm/retry-started` are **durable session events**, not
 *    Cordis events. They come in through the session feed, and a retry is what
 *    makes one `(turn, step)` hold more than one brick.
 * 3. Context pressure and composition are *last-wins slots*, explicitly not one
 *    atomic request observation. They are therefore snapshotted **at dispatch**
 *    and frozen onto the brick, never read back after the fact.
 *
 * The ledger is pure: it consumes normalized observations and writes to a blob
 * store. No DSH imports, no timers, no IO — so a whole session, including retries
 * and failures, can be replayed in a unit test.
 */
import { BlobStore } from './blob-store'
import type {
  BrickContext,
  BrickFeed,
  BrickFinish,
  BrickRecord,
  BrickRetry,
  BrickRoute,
  BrickSettlement,
  BrickToolCall,
  BrickUsage,
} from '../shared/brick'
import { EMPTY_COUNTERS, deriveMetrics, promptTokensOf, type StreamCounters } from '../shared/metrics'

/** What the adapter saw in the outgoing request, already hashed and stored. */
export interface DispatchOptions {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
  /** Set for auxiliary calls the loop did not make for a Turn. */
  readonly purpose?: 'compaction' | 'session-title'
  readonly messageCount?: number
  /** Developer messages among them: the carriers of tool additions and removals. */
  readonly developerMessageCount?: number
  /** Declarations the model could call at this point in the history. */
  readonly toolSchemaCount?: number
  /** Declarations the header itself listed, when the history added more. */
  readonly toolSchemaDeclared?: number
  /** Declarations contributed by tool history. */
  readonly toolSchemaAdded?: number
  /** Declarations the history activated (`tool-addition` blocks), whether or not the header already listed them. */
  readonly toolSchemaActivated?: number
  /** Declarations waiting on a later developer message (`deferLoading`). */
  readonly deferredToolCount?: number
  /** How many developer messages of this request changed the tool set. */
  readonly toolUpdateMessages?: number
  /** Content ref of the request's tool history. */
  readonly toolHistoryRef?: string
  readonly systemHash?: string
  readonly toolsHash?: string
  readonly messagesHash?: string
  /**
   * Content ref of the per-message ref list, for prefix forensics and for reading
   * individual messages back: every entry is itself a ref into the store.
   */
  readonly messageHashesRef?: string
  /** Messages this request had to store because no earlier request had them. */
  readonly messagesStored?: number
  /** Leading messages this request shared with the previous attempt of the session. */
  readonly sharedMessagePrefix?: number
  /** Content ref of the full outgoing request (config, system, tools, messages). */
  readonly requestRef?: string
}

/** A `request/header` snapshot: the config plus the schemas the request ran with. */
export interface HeaderSnapshot {
  readonly seq: number
  readonly reason: 'initial' | 'resume' | 'change' | 'series'
  readonly startsSeries?: boolean
  readonly adapterDefaults?: { readonly reasoningEffort?: boolean; readonly maxTokens?: boolean }
  readonly headerHash?: string
  readonly headerRef?: string
  readonly systemHash?: string
  readonly toolsHash?: string
  readonly toolSchemaCount?: number
}

/** A `request/context` snapshot: route and capacity. */
export interface ContextSnapshot {
  readonly provider: string
  readonly model: string
  readonly contextWindow?: number
  readonly systemPromptUpdate?: 'in-history'
}

/** The context environment as it stood when a request was dispatched. */
export interface PressureSnapshot {
  readonly contextWindow?: number
  readonly pressureTokens?: number
  readonly projectedTokens?: number
  readonly surfaceTokens?: number
  readonly systemTokens?: number
  readonly toolsTokens?: number
  readonly messageTokens?: number
  readonly baselineKind?: 'none' | 'estimated' | 'usage'
  readonly baselineTokens?: number
  readonly surfaceDeltaTokens?: number
  readonly totalMeterTokens?: number
  readonly nodeCount?: number
  readonly meterRef?: string
}

/** One scheduled retry, as recorded by `llm/retry`. */
export interface RetrySnapshot {
  readonly retryId: string
  /** The attempt the retry replaces, when the runtime reported it. */
  readonly turn?: number
  readonly step?: number
  readonly provider: string
  readonly mode: 'normal' | 'always'
  readonly policyKey: string
  readonly retry: number
  readonly maxRetries?: number
  readonly delayMs: number
  readonly failureMessage?: string
  readonly failureCode?: string
}

/** Provider usage, exactly as reported. */
export interface UsageSnapshot {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** How one attempt ended, from the durable log. */
export interface SettlementSnapshot {
  readonly seq: number
  readonly time: number
  /** Which `(turn, step)` this settles. Both events carry it; it is what identifies the
   * draft, and guessing "the newest one" is how a late settlement lands on the wrong
   * attempt. */
  readonly turn?: number
  readonly step?: number
  readonly settlement: 'message' | 'attempt'
  readonly usage?: UsageSnapshot
  readonly interrupted?: boolean
  readonly finishReason?: BrickFinish['reason']
  readonly failure?: NonNullable<BrickFinish['failure']>
  readonly streamRef?: string
  readonly replayRef?: string
}

/** A normalized stream chunk: counts and terminal facts, not the payload. */
export type ChunkObservation =
  | { readonly type: 'text'; readonly chars: number }
  | { readonly type: 'reasoning'; readonly chars: number }
  | { readonly type: 'tool-call'; readonly callId: string; readonly name?: string; readonly argsChars: number }
  | { readonly type: 'usage'; readonly usage: UsageSnapshot }
  | { readonly type: 'finish'; readonly reason: BrickFinish['reason']; readonly failure?: NonNullable<BrickFinish['failure']> }
  | { readonly type: 'other' }

/** Everything the adapter can tell the ledger. */
export type Observation =
  | { readonly kind: 'dispatch'; readonly at: number; readonly options: DispatchOptions }
  | {
    readonly kind: 'attempt-start'
    readonly at: number
    readonly turn: number
    readonly step: number
    readonly attemptId?: string
    readonly revision?: number
  }
  | {
    readonly kind: 'chunk'
    readonly at: number
    readonly chunk: ChunkObservation
    /**
     * Set by the pass-through wrapper around an auxiliary call's stream. Auxiliary
     * calls produce no `agent/assistant-stream` frames, so their chunks arrive only
     * this way and must be routed to the auxiliary brick rather than to whichever
     * Turn attempt happens to be current.
     */
    readonly auxiliary?: true
  }
  | { readonly kind: 'turn-end'; readonly turn: number }
  | {
    readonly kind: 'attempt-end'
    readonly at: number
    /** True when this closes an auxiliary call rather than a Turn attempt. */
    readonly auxiliary?: true
    readonly outcome: 'committed' | 'abandoned'
    /**
     * Which durable event the attempt committed to, and its `seq`, when the live
     * end frame reported a commit. The durable settle event can arrive later (or,
     * for a pre-dispatch failure, never), so the frame is the reliable signal.
     */
    readonly eventType?: 'assistant/message' | 'assistant/attempt'
    readonly seq?: number
  }
  | { readonly kind: 'settled'; readonly snapshot: SettlementSnapshot }
  | { readonly kind: 'header'; readonly snapshot: HeaderSnapshot }
  | { readonly kind: 'context'; readonly snapshot: ContextSnapshot }
  | { readonly kind: 'pressure'; readonly snapshot: PressureSnapshot }
  | { readonly kind: 'retry'; readonly snapshot: RetrySnapshot }
  | {
    /**
     * The durable `tool/call` record. The live `tool-call-delta` frames already
     * created the call (with its timing); this adds the raw argument JSON, which
     * is what the Tools tab shows.
     */
    readonly kind: 'tool-call'
    readonly at: number
    readonly seq: number
    readonly callId: string
    readonly name: string
    readonly argumentsRef?: string
    readonly argumentsChars?: number
  }
  | {
    readonly kind: 'tool-result'
    readonly at: number
    readonly callId: string
    readonly isError?: boolean
    readonly error?: { readonly name: string; readonly code: string; readonly reason?: string }
    readonly resultChars?: number
    readonly resultRef?: string
  }
  | {
    /**
     * The durable `compaction/start` record. Its `compactionId` is what the transcript's
     * compaction row is keyed by, and it is attached to the auxiliary call it belongs to.
     */
    readonly kind: 'compaction'
    readonly compactionId: string
  }
  | { readonly kind: 'flush'; readonly at: number }

/** Mutable working state for one attempt. */
interface AttemptDraft {
  readonly id: string
  readonly turn: number
  readonly step: number
  readonly attemptOrdinal: number
  readonly attemptId?: string
  readonly revision?: number
  readonly dispatchedAt?: number
  readonly options?: DispatchOptions
  readonly header?: HeaderSnapshot
  readonly context?: PressureSnapshot
  readonly contextRoute?: ContextSnapshot
  counters: StreamCounters
  usage?: UsageSnapshot
  firstTokenAt?: number
  usageAt?: number
  finishAt?: number
  finish?: BrickFinish
  settlement: BrickSettlement
  settlementSeq?: number
  settlementTime?: number
  interrupted?: boolean
  streamRef?: string
  replayRef?: string
  tools: BrickToolCall[]
  retry?: BrickRetry
  /** Retry chain this attempt ran inside, when it is a retry of a failed one. */
  retryChainId?: string
  /** Compaction this auxiliary call performed, when it is the one that did it. */
  compactionId?: string
}

/** Limits that keep a long session's ledger bounded. */
export interface LedgerOptions {
  /** Bricks kept per session, newest last. */
  readonly maxBricks?: number
  /** Blob store used for raw payloads. */
  readonly store?: BlobStore
  /**
   * What the bricks from this ledger should claim about where they came from.
   *
   * `host` (the default) is the live tap. `replay` is the same fold run over a session's
   * own log, where the request capture and the dispatch-time context do not exist — the
   * record says so instead of leaving fields that look measured.
   */
  readonly observedBy?: 'host' | 'replay'
}

const DEFAULT_MAX_BRICKS = 400

/** The per-session ledger. */
export class BrickLedger {
  private readonly sessionId: string
  private readonly maxBricks: number
  private readonly store: BlobStore
  private readonly observedBy: 'host' | 'replay'
  private readonly drafts: AttemptDraft[] = []
  private readonly pendingDispatches: { at: number; options: DispatchOptions }[] = []
  private attemptCounts = new Map<string, number>()
  /** Retry chain id per `(turn, step)`, so the attempt that runs it can be stamped. */
  private readonly retryChains = new Map<string, string>()
  /** Observations that could not be attributed to an attempt, and were dropped. */
  private unattributed = 0
  private readonly endedTurns = new Set<number>()
  private current: AttemptDraft | undefined
  /** The auxiliary call in flight, if any: auxiliary calls are serialized. */
  private auxiliary: AttemptDraft | undefined
  private header: HeaderSnapshot | undefined
  private contextRoute: ContextSnapshot | undefined
  private pressure: PressureSnapshot | undefined

  constructor(sessionId: string, options: LedgerOptions = {}) {
    this.sessionId = sessionId
    this.maxBricks = options.maxBricks ?? DEFAULT_MAX_BRICKS
    this.store = options.store ?? new BlobStore()
    this.observedBy = options.observedBy ?? 'host'
  }

  /** The raw-payload store, so the adapter can stash blobs and hand back refs. */
  get blobStore(): BlobStore {
    return this.store
  }

  /**
   * Fold one observation.
   * @param observation - a normalized runtime observation.
   * @returns the brick that changed, when the observation completed or updated one.
   */
  observe(observation: Observation): BrickRecord | undefined {
    switch (observation.kind) {
      case 'dispatch':
        // An auxiliary call never enters the pairing queue: it has no Turn attempt
        // to pair with, and leaving it there would hand its request to the next
        // real attempt (compaction runs between steps, exactly where a long
        // session spends its time).
        if (observation.options.purpose !== undefined) {
          return this.startAuxiliary(observation.at, observation.options)
        }
        this.pendingDispatches.push({ at: observation.at, options: observation.options })
        return undefined
      case 'turn-end':
        this.endedTurns.add(observation.turn)
        return undefined
      case 'attempt-start':
        return this.startAttempt(observation)
      case 'chunk':
        return this.applyChunk(observation)
      case 'attempt-end':
        return this.endAttempt(observation)
      case 'settled':
        return this.settle(observation.snapshot)
      case 'header':
        this.header = observation.snapshot
        return undefined
      case 'context':
        this.contextRoute = observation.snapshot
        return undefined
      case 'pressure':
        this.pressure = observation.snapshot
        return undefined
      case 'retry':
        return this.attachRetry(observation.snapshot)
      case 'tool-call':
        return this.attachToolCall(observation)
      case 'tool-result':
        return this.attachToolResult(observation)
      case 'compaction':
        return this.attachCompaction(observation.compactionId)
      case 'flush':
        return this.flushOrphans(observation.at)
    }
  }

  /**
   * Record an auxiliary call as its own brick.
   *
   * It gets one immediately, at `turn 0`, because there is no attempt frame coming
   * to complete a pairing; its stream is observed through the pass-through wrapper
   * the collector returns for it.
   */
  private startAuxiliary(at: number, options: DispatchOptions): undefined {
    const key = `0:${options.purpose ?? 'auxiliary'}`
    const ordinal = this.attemptCounts.get(key) ?? 0
    this.attemptCounts.set(key, ordinal + 1)
    const draft: AttemptDraft = {
      id: `${this.sessionId}:0:0:${String(ordinal)}`,
      turn: 0,
      step: 0,
      attemptOrdinal: ordinal,
      dispatchedAt: at,
      options,
      ...(this.header === undefined ? {} : { header: this.header }),
      ...(this.pressure === undefined ? {} : { context: this.pressure }),
      ...(this.contextRoute === undefined ? {} : { contextRoute: this.contextRoute }),
      counters: EMPTY_COUNTERS,
      settlement: 'running',
      tools: [],
    }
    this.drafts.push(draft)
    this.auxiliary = draft
    this.evict()
    return undefined
  }

  /**
   * How many observations were dropped because no attempt could be identified for them.
   *
   * It is surfaced so "we lost something" is visible rather than silent — the alternative,
   * attaching it to the newest draft, is how a brick comes to hold another request's data.
   */
  get unattributedCount(): number {
    return this.unattributed
  }

  /** Every brick seen so far, oldest first. */
  records(): BrickRecord[] {
    return this.drafts.map((draft) => this.materialize(draft))
  }

  /** The feed the browser consumes. */
  feed(): BrickFeed {
    return {
      sessionId: this.sessionId,
      bricks: this.records(),
      endedTurns: [...this.endedTurns],
      store: { blobs: this.store.stats().blobs, bytes: this.store.stats().bytes },
      ...(this.unattributed === 0 ? {} : { unattributed: this.unattributed }),
    }
  }

  /** Bricks for one `(turn, step)`, in attempt order. */
  attemptsOf(turn: number, step: number): BrickRecord[] {
    return this.drafts
      .filter((draft) => draft.turn === turn && draft.step === step)
      .map((draft) => this.materialize(draft))
  }

  /**
   * Pair a live attempt with the dispatch that produced it.
   *
   * The order is not guaranteed: the loop constructs the attempt before calling
   * `llm.stream`, but the frames and the waterfall are observed through different
   * channels. Whichever arrives second completes the pair.
   */
  private startAttempt(observation: Extract<Observation, { kind: 'attempt-start' }>): undefined {
    const { turn, step } = observation
    const ordinal = this.attemptCounts.get(`${String(turn)}:${String(step)}`) ?? 0
    this.attemptCounts.set(`${String(turn)}:${String(step)}`, ordinal + 1)
    const pending = this.pendingDispatches.shift()
    // An attempt that runs after a retry was scheduled for this step *is* that retry:
    // the durable log records the schedule, not the attempt, so the chain is carried
    // over here.
    const chain = this.retryChains.get(`${String(turn)}:${String(step)}`)
    const draft: AttemptDraft = {
      id: `${this.sessionId}:${String(turn)}:${String(step)}:${String(ordinal)}`,
      turn,
      step,
      attemptOrdinal: ordinal,
      ...(observation.attemptId === undefined ? {} : { attemptId: observation.attemptId }),
      ...(observation.revision === undefined ? {} : { revision: observation.revision }),
      // Dispatch first, then the attempt's own start. A replayed attempt has no dispatch
      // observation — the log records when an attempt settled, not when it was sent — so its
      // start instant is the closest origin available, and a TTFT measured from it is honest
      // as long as it is labelled (see `replaySession`).
      dispatchedAt: pending?.at ?? observation.at,
      ...(pending === undefined ? {} : { options: pending.options }),
      ...(chain === undefined ? {} : { retryChainId: chain }),
      ...(this.header === undefined ? {} : { header: this.header }),
      ...(this.pressure === undefined ? {} : { context: this.pressure }),
      ...(this.contextRoute === undefined ? {} : { contextRoute: this.contextRoute }),
      counters: EMPTY_COUNTERS,
      settlement: 'running',
      tools: [],
    }
    this.drafts.push(draft)
    this.current = draft
    // Every attempt the loop makes is settled by the log eventually, so it joins the
    // queue for its step. Auxiliary calls never do — they are closed by the stream
    // wrapper — and are deliberately not queued.
    this.queueAwaiting(draft)
    this.evict()
    return undefined
  }

  /** Count chunks, catch the first token, usage and finish. */
  private applyChunk(observation: Extract<Observation, { kind: 'chunk' }>): undefined {
    const draft = observation.auxiliary === true ? this.auxiliary : this.current
    if (draft === undefined) return undefined
    const { chunk, at } = observation
    draft.counters = { ...draft.counters, chunkCount: draft.counters.chunkCount + 1 }
    switch (chunk.type) {
      case 'text':
        draft.counters = { ...draft.counters, textChars: draft.counters.textChars + chunk.chars }
        break
      case 'reasoning':
        draft.counters = { ...draft.counters, reasoningChars: draft.counters.reasoningChars + chunk.chars }
        break
      case 'tool-call': {
        const existing = draft.tools.find((call) => call.callId === chunk.callId)
        if (existing === undefined) {
          // The call is timed from the chunk that carried it, not from the first
          // token: a tool call can start long after a reasoning block.
          draft.tools.push({
            callId: chunk.callId,
            name: chunk.name ?? '',
            argumentsChars: chunk.argsChars,
            callAt: at,
          })
        }
        draft.counters = { ...draft.counters, toolCallCount: draft.tools.length }
        break
      }
      case 'usage':
        draft.usage = chunk.usage
        draft.usageAt = at
        break
      case 'finish':
        draft.finish = { reason: chunk.reason, ...(chunk.failure === undefined ? {} : { failure: chunk.failure }) }
        draft.finishAt = at
        break
      case 'other':
        break
    }
    // The first token is whatever the provider sends first that is not
    // bookkeeping: a text or reasoning delta, or the first piece of a tool call.
    if (draft.firstTokenAt === undefined && (chunk.type === 'text' || chunk.type === 'reasoning' || chunk.type === 'tool-call')) {
      draft.firstTokenAt = at
    }
    return undefined
  }

  /** The live attempt frame ended: committed to the log or abandoned. */
  private endAttempt(observation: Extract<Observation, { kind: 'attempt-end' }>): BrickRecord | undefined {
    const draft = observation.auxiliary === true ? this.auxiliary : this.current
    if (draft === undefined) return undefined
    draft.settlement = observation.outcome === 'abandoned'
      ? 'abandoned'
      : observation.eventType === 'assistant/attempt' ? 'attempt' : 'message'
    if (observation.seq !== undefined) draft.settlementSeq = observation.seq
    draft.finishAt ??= observation.at
    if (observation.auxiliary === true) this.auxiliary = undefined
    else this.current = undefined
    return this.materialize(draft)
  }

  /**
   * Enrich a brick with its durable settlement.
   *
   * The live end frame already said which event the attempt committed to; this
   * adds what only the log carries (authoritative usage, `interrupted`, the
   * embedded stream, the settlement `seq`).
   */
  private settle(snapshot: SettlementSnapshot): BrickRecord | undefined {
    // Three keys, strongest first.
    //
    // 1. **The settlement seq.** The live end frame already reported which durable event
    //    this attempt committed to, and that seq is unique — so it identifies the attempt
    //    outright. This is what makes a step whose attempts settled by different events
    //    (one committed an `assistant/attempt`, the next an `assistant/message`) come out
    //    right.
    // 2. **FIFO within the step**, for an attempt whose frame never arrived — the log
    //    settles a step's attempts in the order they started, and `(turn, step)` is only a
    //    bucket, so the oldest unsettled one is the one being settled.
    // There is deliberately no third key. An event that names a step with nothing left to
    // settle, or that carries no identity at all, is **dropped and counted** rather than
    // handed to "the newest draft" — see `unattributed`.
    const bySeq = snapshot.seq > 0
      ? this.drafts.find((draft) => draft.settlementSeq === snapshot.seq)
      : undefined
    const draft = bySeq ?? (snapshot.turn === undefined || snapshot.step === undefined
      ? undefined
      : this.takeAwaiting(snapshot.turn, snapshot.step))
    if (draft === undefined) {
      // Nothing to attach it to. Counting it and dropping it is the whole point of a flight
      // recorder: "probably the last request" is how a brick ends up wearing somebody else's
      // cache accounting, and a missing figure is a smaller lie than a borrowed one.
      this.unattributed += 1
      return undefined
    }
    this.forgetAwaiting(draft)
    if (draft.settlement === 'running') draft.settlement = snapshot.settlement
    draft.settlementSeq = snapshot.seq
    draft.settlementTime = snapshot.time
    if (snapshot.usage !== undefined) draft.usage = snapshot.usage
    if (snapshot.interrupted === true) draft.interrupted = true
    if (snapshot.finishReason !== undefined) {
      draft.finish = {
        reason: snapshot.finishReason,
        ...(snapshot.failure === undefined ? {} : { failure: snapshot.failure }),
      }
    }
    if (snapshot.streamRef !== undefined) draft.streamRef = snapshot.streamRef
    if (snapshot.replayRef !== undefined) draft.replayRef = snapshot.replayRef
    draft.finishAt ??= snapshot.time
    // Only give up the live pointer when the attempt being closed *is* the live one: a
    // late settlement for an older attempt of the same step must not orphan the newer one
    // that is still streaming into it.
    if (this.current === draft) this.current = undefined
    return this.materialize(draft)
  }

  /**
   * Attach a compaction id to the auxiliary call that performed it.
   *
   * The compaction row in the transcript is keyed by this id, while the auxiliary model
   * call is keyed by nothing at all — so this is the only link between the brick and the
   * row it belongs to. The call itself is the most recent `compaction` auxiliary call that
   * has not been claimed yet.
   *
   * @param compactionId - the id from the durable `compaction/start` event.
   * @returns the brick that changed, when an unclaimed one was found.
   */
  private attachCompaction(compactionId: string): BrickRecord | undefined {
    for (let index = this.drafts.length - 1; index >= 0; index -= 1) {
      const draft = this.drafts[index]!
      if (draft.options?.purpose !== 'compaction' || draft.compactionId !== undefined) continue
      draft.compactionId = compactionId
      return this.materialize(draft)
    }
    return undefined
  }

  /** A scheduled retry belongs to the attempt that failed. */
  private attachRetry(snapshot: RetrySnapshot): BrickRecord | undefined {
    // `retry` is the ordinal of the retry about to run, so the attempt it replaces is the
    // one before it — an identity, where "the newest draft" is a coincidence that holds
    // only while nothing else is in flight.
    const started = snapshot.turn === undefined || snapshot.step === undefined
      ? undefined
      : this.attemptCounts.get(`${String(snapshot.turn)}:${String(snapshot.step)}`)
    const draft = this.draftAt(snapshot.turn, snapshot.step, snapshot.retry - 1)
      ?? (started === undefined ? undefined : this.draftAt(snapshot.turn, snapshot.step, started - 1))
    if (draft === undefined) {
      // The runtime always sends `turn`/`step` on `llm/retry`, so a retry that cannot be
      // placed is a bug or a foreign event — not an invitation to guess.
      this.unattributed += 1
      return undefined
    }
    draft.retry = {
      retryId: snapshot.retryId,
      provider: snapshot.provider,
      mode: snapshot.mode,
      policyKey: snapshot.policyKey,
      retry: snapshot.retry,
      ...(snapshot.maxRetries === undefined ? {} : { maxRetries: snapshot.maxRetries }),
      delayMs: snapshot.delayMs,
      ...(snapshot.failureMessage === undefined ? {} : { failureMessage: snapshot.failureMessage }),
      ...(snapshot.failureCode === undefined ? {} : { failureCode: snapshot.failureCode }),
    }
    // Remember the chain for the attempt that is about to run it: the retry itself
    // leaves no durable record of its own, so without this the two bricks of one
    // failed-then-retried step would be indistinguishable.
    this.retryChains.set(`${String(draft.turn)}:${String(draft.step)}`, snapshot.retryId)

    if (draft.finish === undefined || draft.finish.reason !== 'error') {
      draft.finish = {
        reason: 'error',
        ...(snapshot.failureMessage === undefined
          ? {}
          : { failure: { message: snapshot.failureMessage, code: snapshot.failureCode ?? 'unknown' } }),
      }
    }
    if (this.current === draft) this.current = undefined
    return this.materialize(draft)
  }

  /** Attach the durable call record (raw arguments) to the brick that made it. */
  private attachToolCall(observation: Extract<Observation, { kind: 'tool-call' }>): BrickRecord | undefined {
    for (let index = this.drafts.length - 1; index >= 0; index -= 1) {
      const draft = this.drafts[index]!
      const callIndex = draft.tools.findIndex((call) => call.callId === observation.callId)
      if (callIndex === -1) {
        // No live delta was seen (the frame channel missed it): record the call now.
        if (draft.settlement === 'running' || index === this.drafts.length - 1) {
          draft.tools = [
            ...draft.tools,
            {
              callId: observation.callId,
              name: observation.name,
              argumentsChars: observation.argumentsChars ?? 0,
              ...(observation.argumentsRef === undefined ? {} : { argumentsRef: observation.argumentsRef }),
            },
          ]
          draft.counters = { ...draft.counters, toolCallCount: draft.tools.length }
          return this.materialize(draft)
        }
        continue
      }
      const call = draft.tools[callIndex]!
      draft.tools = draft.tools.map((entry, position) => (position === callIndex
        ? {
          ...entry,
          name: entry.name === '' ? observation.name : entry.name,
          ...(observation.argumentsRef === undefined ? {} : { argumentsRef: observation.argumentsRef }),
          ...(observation.argumentsChars === undefined ? {} : { argumentsChars: observation.argumentsChars }),
        }
        : entry))
      void call
      return this.materialize(draft)
    }
    return undefined
  }

  /** A tool result belongs to the attempt that emitted the call. */
  private attachToolResult(observation: Extract<Observation, { kind: 'tool-result' }>): BrickRecord | undefined {
    for (let index = this.drafts.length - 1; index >= 0; index -= 1) {
      const draft = this.drafts[index]!
      const callIndex = draft.tools.findIndex((call) => call.callId === observation.callId)
      if (callIndex === -1) continue
      const call = draft.tools[callIndex]!
      const updated: BrickToolCall = {
        ...call,
        resultAt: observation.at,
        ...(call.callAt === undefined ? {} : { durationMs: Math.max(0, observation.at - call.callAt) }),
        ...(observation.isError === undefined ? {} : { isError: observation.isError }),
        ...(observation.error === undefined ? {} : { error: observation.error }),
        ...(observation.resultRef === undefined ? {} : { resultRef: observation.resultRef }),
      }
      draft.tools = draft.tools.map((entry, index2) => (index2 === callIndex ? updated : entry))
      return this.materialize(draft)
    }
    return undefined
  }

  /**
   * Close dispatches that never got an attempt frame.
   *
   * A dispatch with no attempt is not noise: it is either an auxiliary call the
   * loop made outside a Turn (`session-title`, `compaction`) or a request that a
   * `llm/stream` listener vetoed before any frame existed. Both are worth a brick.
   */
  private flushOrphans(at: number): BrickRecord | undefined {
    let last: BrickRecord | undefined
    // An auxiliary call whose end was never observed is settled here: a flush means
    // nothing more is coming.
    if (this.auxiliary !== undefined && this.auxiliary.settlement === 'running') {
      this.auxiliary.settlement = 'abandoned'
      this.auxiliary.finishAt ??= at
      last = this.materialize(this.auxiliary)
      this.auxiliary = undefined
    }
    while (this.pendingDispatches.length > 0) {
      const pending = this.pendingDispatches.shift()!
      const ordinal = this.attemptCounts.get('0:0') ?? 0
      this.attemptCounts.set('0:0', ordinal + 1)
      const draft: AttemptDraft = {
        id: `${this.sessionId}:0:0:${String(ordinal)}`,
        turn: 0,
        step: 0,
        attemptOrdinal: ordinal,
        dispatchedAt: pending.at,
        options: pending.options,
        ...(this.header === undefined ? {} : { header: this.header }),
        ...(this.pressure === undefined ? {} : { context: this.pressure }),
        ...(this.contextRoute === undefined ? {} : { contextRoute: this.contextRoute }),
        counters: EMPTY_COUNTERS,
        settlement: 'abandoned',
        finishAt: at,
        tools: [],
      }
      this.drafts.push(draft)
      last = this.materialize(draft)
    }
    this.evict()
    return last
  }

  /**
   * The drafts of one `(turn, step)` waiting to be settled by the log, oldest first.
   *
   * `(turn, step)` is a **bucket, not an identity**: one step can hold several attempts
   * (that is what a retry is), so it can narrow a settlement down to the attempts of that
   * step and no further. Within the bucket the rule is **FIFO**: the log settles a step's
   * attempts in the order they started, so the oldest unsettled one is the one being
   * settled. Picking "the newest" or "the newest running" instead would hand an early
   * attempt's verdict to a later one the moment two are in flight together — which is
   * exactly the interleave a retry creates.
   */
  private readonly awaiting = new Map<string, AttemptDraft[]>()

  /** Queue a draft as awaiting its durable settlement. */
  private queueAwaiting(draft: AttemptDraft): void {
    const key = `${String(draft.turn)}:${String(draft.step)}`
    const queue = this.awaiting.get(key)
    if (queue === undefined) this.awaiting.set(key, [draft])
    else queue.push(draft)
  }

  /**
   * Consume the oldest unsettled attempt of one step.
   *
   * @param turn - the Turn the settlement names.
   * @param step - the step the settlement names.
   * @returns the draft, or undefined when that step has no unsettled attempt left.
   */
  private takeAwaiting(turn: number, step: number): AttemptDraft | undefined {
    const key = `${String(turn)}:${String(step)}`
    const queue = this.awaiting.get(key)
    if (queue === undefined) return undefined
    const draft = queue.shift()
    if (queue.length === 0) this.awaiting.delete(key)
    return draft
  }

  /** Drop a draft from its step's settlement queue, because it will not be settled again. */
  private forgetAwaiting(draft: AttemptDraft): void {
    const key = `${String(draft.turn)}:${String(draft.step)}`
    const queue = this.awaiting.get(key)
    if (queue === undefined) return
    const at = queue.indexOf(draft)
    if (at === -1) return
    queue.splice(at, 1)
    if (queue.length === 0) this.awaiting.delete(key)
  }

  /** One exact attempt of a step, by its ordinal. */
  private draftAt(turn: number | undefined, step: number | undefined, ordinal: number | undefined): AttemptDraft | undefined {
    if (turn === undefined || step === undefined || ordinal === undefined) return undefined
    return this.drafts.find((draft) => draft.turn === turn && draft.step === step && draft.attemptOrdinal === ordinal)
  }

  private evict(): void {
    while (this.drafts.length > this.maxBricks) {
      const dropped = this.drafts.shift()
      if (dropped === this.current) this.current = undefined
      if (dropped === undefined) continue
      // A dropped brick must leave the settlement queue as well, or a later settlement
      // would be consumed by an attempt that is no longer in the ledger.
      this.forgetAwaiting(dropped)
    }
  }

  /** Freeze a draft into the record the UI reads. */
  private materialize(draft: AttemptDraft): BrickRecord {
    const options = draft.options
    const usage: BrickUsage | undefined = draft.usage
    const contextWindow = draft.context?.contextWindow ?? draft.contextRoute?.contextWindow
    const metrics = deriveMetrics(
      usage,
      {
        ...(draft.dispatchedAt === undefined ? {} : { dispatchedAt: draft.dispatchedAt }),
        ...(draft.firstTokenAt === undefined ? {} : { firstTokenAt: draft.firstTokenAt }),
        ...(draft.usageAt === undefined ? {} : { usageAt: draft.usageAt }),
        ...(draft.finishAt === undefined ? {} : { finishAt: draft.finishAt }),
      },
      draft.counters,
      contextWindow,
    )
    const route: BrickRoute = {
      provider: options?.provider ?? draft.contextRoute?.provider ?? 'unknown',
      model: options?.model ?? draft.contextRoute?.model ?? 'unknown',
      ...(options?.purpose === undefined ? {} : { purpose: options.purpose }),
      ...(options?.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options?.stop === undefined ? {} : { stop: options.stop }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(draft.header?.adapterDefaults?.reasoningEffort === true ? { reasoningEffortDefaulted: true } : {}),
      ...(draft.header?.adapterDefaults?.maxTokens === true ? { maxTokensDefaulted: true } : {}),
    }
    const context: BrickContext = {
      ...(draft.context?.pressureTokens === undefined ? {} : { pressureTokens: draft.context.pressureTokens }),
      ...(draft.context?.projectedTokens === undefined ? {} : { projectedTokens: draft.context.projectedTokens }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(draft.context?.systemTokens === undefined ? {} : { systemTokens: draft.context.systemTokens }),
      ...(draft.context?.toolsTokens === undefined ? {} : { toolsTokens: draft.context.toolsTokens }),
      ...(draft.context?.messageTokens === undefined ? {} : { messageTokens: draft.context.messageTokens }),
      ...(draft.context?.meterRef === undefined ? {} : { meterRef: draft.context.meterRef }),
      ...(draft.context?.surfaceTokens === undefined ? {} : { surfaceTokens: draft.context.surfaceTokens }),
      ...(draft.context?.totalMeterTokens === undefined ? {} : { totalMeterTokens: draft.context.totalMeterTokens }),
      ...(draft.context?.surfaceDeltaTokens === undefined ? {} : { surfaceDeltaTokens: draft.context.surfaceDeltaTokens }),
      ...(draft.context?.baselineKind === undefined ? {} : { baselineKind: draft.context.baselineKind }),
      ...(draft.context?.baselineTokens === undefined ? {} : { baselineTokens: draft.context.baselineTokens }),
      ...(draft.context?.nodeCount === undefined ? {} : { nodeCount: draft.context.nodeCount }),
    }
    return {
      observedBy: this.observedBy,
      identity: {
        id: draft.id,
        sessionId: this.sessionId,
        turn: draft.turn,
        step: draft.step,
        attemptOrdinal: draft.attemptOrdinal,
        ...(draft.attemptId === undefined ? {} : { attemptId: draft.attemptId }),
        ...(draft.revision === undefined ? {} : { revision: draft.revision }),
      },
      settlement: draft.settlement,
      ...(draft.interrupted === undefined ? {} : { interrupted: draft.interrupted }),
      ...(draft.settlementSeq === undefined ? {} : { settlementSeq: draft.settlementSeq }),
      ...(draft.settlementTime === undefined ? {} : { settlementTime: draft.settlementTime }),
      route,
      ...(usage === undefined ? {} : { usage }),
      metrics,
      request: {
        ...(draft.header?.seq === undefined ? {} : { headerEventSeq: draft.header.seq }),
        ...(draft.header?.reason === undefined ? {} : { headerReason: draft.header.reason }),
        ...(draft.header?.startsSeries === undefined ? {} : { startsSeries: draft.header.startsSeries }),
        ...(options?.messageCount === undefined ? {} : { messageCount: options.messageCount }),
        ...(options?.developerMessageCount === undefined ? {} : { developerMessageCount: options.developerMessageCount }),
        ...(options?.toolSchemaCount === undefined ? {} : { toolSchemaCount: options.toolSchemaCount }),
        ...(options?.toolSchemaDeclared === undefined ? {} : { toolSchemaDeclared: options.toolSchemaDeclared }),
        ...(options?.toolSchemaAdded === undefined ? {} : { toolSchemaAdded: options.toolSchemaAdded }),
        ...(options?.toolSchemaActivated === undefined ? {} : { toolSchemaActivated: options.toolSchemaActivated }),
        ...(options?.deferredToolCount === undefined ? {} : { deferredToolCount: options.deferredToolCount }),
        ...(options?.toolUpdateMessages === undefined ? {} : { toolUpdateMessages: options.toolUpdateMessages }),
        ...(options?.toolHistoryRef === undefined ? {} : { toolHistoryRef: options.toolHistoryRef }),
        // The durable header is the authoritative tools/system snapshot; the
        // dispatch summary is the fallback when no header was logged yet.
        ...(options?.systemHash ?? draft.header?.systemHash) === undefined
          ? {}
          : { systemHash: (options?.systemHash ?? draft.header?.systemHash)! },
        ...(options?.toolsHash ?? draft.header?.toolsHash) === undefined
          ? {}
          : { toolsHash: (options?.toolsHash ?? draft.header?.toolsHash)! },
        ...(options?.messagesHash === undefined ? {} : { messagesHash: options.messagesHash }),
        ...(options?.messageHashesRef === undefined ? {} : { messageHashesRef: options.messageHashesRef }),
        ...(options?.messagesStored === undefined ? {} : { messagesStored: options.messagesStored }),
        ...(options?.sharedMessagePrefix === undefined ? {} : { sharedMessagePrefix: options.sharedMessagePrefix }),
        ...(draft.header?.headerHash === undefined ? {} : { headerHash: draft.header.headerHash }),
        ...(options?.requestRef === undefined ? {} : { requestRef: options.requestRef }),
        ...(draft.header?.headerRef === undefined ? {} : { headerRef: draft.header.headerRef }),
      },
      ...(Object.keys(context).length === 0 ? {} : { context }),
      tools: draft.tools,
      ...(draft.retry === undefined ? {} : { retry: draft.retry }),
      ...(draft.retryChainId === undefined ? {} : { retryChainId: draft.retryChainId }),
      ...(draft.compactionId === undefined ? {} : { compactionId: draft.compactionId }),
      ...(draft.finish === undefined ? {} : { finish: draft.finish }),
      raw: {
        ...(draft.streamRef === undefined ? {} : { streamRef: draft.streamRef }),
        ...(draft.replayRef === undefined ? {} : { replayRef: draft.replayRef }),
      },
    }
  }
}

/** Prompt size of a record, for callers that want it without importing metrics. */
export function promptSizeOf(record: BrickRecord): number | undefined {
  return promptTokensOf(record.usage)
}
