/**
 * The half of the previous line worth keeping: **which real request is this?**
 *
 * The harness does not hand out attempt identity in one place, and the two places it does hand
 * it out disagree about what they are:
 *
 * - `llm/stream` is the actual model call — the only place a *request* exists — and it carries
 *   no `turn`, no `step` and no attempt id;
 * - `agent/assistant-stream` carries the frame identity (`turn`, `step`, `attemptId`, revision)
 *   and every chunk the model produced, but it is not the request;
 * - `session/event` carries the durable settlement (`assistant/message` / `assistant/attempt`)
 *   with the authoritative usage — written once per attempt, in log order.
 *
 * A tracker that merged them wrongly would quietly lie about the thing this product is for: a
 * retried step is **two** real requests with two different cache outcomes, and a board that
 * showed one brick would hide exactly the event worth seeing.
 *
 * The rule here is the one the previous line proved out, reduced to what a brick needs:
 *
 * 1. a `start` frame opens an attempt and fixes its ordinal — 0, then 1 for the retry, by
 *    counting starts within `(turn, step)`;
 * 2. usage is taken from the live stream if it arrives, but it is only a *placeholder*: the
 *    settlement's usage wins, because that is the number the provider billed;
 * 3. a settlement **emits the brick**, taking the oldest attempt still waiting on that
 *    `(turn, step)`. Nothing is emitted while a request is in flight: a brick that appeared
 *    before the number existed would have to guess it;
 * 4. a settlement whose attempt was never seen (the plugin loaded mid-turn, or a request that
 *    outlived a reload) still lands, because the settlement carries its own identity and its own
 *    usage. There is nothing to mis-attribute — this is the one place the reduced tracker is
 *    deliberately more willing than the full ledger was, which dropped such events rather than
 *    risk pairing them with the wrong attempt. It can afford to: the full ledger was protecting
 *    a request *capture*, and this one is building the brick out of the settlement itself.
 *
 * Pure: no DSH import, no IO, no clock of its own. The whole correlation is testable from a
 * fixture, which is what `tests/attempt-tracker.spec.ts` does — including the retry shape copied
 * out of a real session log.
 */
import {
  brickIdOf,
  hitRatioOf,
  toneOf,
  type CacheBrick,
  type CacheUsage,
} from '../shared/cache-brick'

/** The subset of one `agent/assistant-stream` frame this tracker reads. */
export interface AttemptFrame {
  readonly type: string
  readonly turn?: number | undefined
  readonly step?: number | undefined
  readonly attemptId?: string | undefined
  readonly time?: number | undefined
  readonly chunk?: {
    readonly type?: string | undefined
    readonly usage?: CacheUsage | undefined
  } | undefined
}

/** The subset of one durable settlement event this tracker reads. */
export interface Settlement {
  readonly turn?: number | undefined
  readonly step?: number | undefined
  readonly time?: number | undefined
  /** The billed usage, straight off the event. */
  readonly usage?: CacheUsage | undefined
  /** The compact stream, read only when the event carries no usage of its own. */
  readonly stream?: readonly unknown[] | undefined
}

/** A request that has started and not settled yet. */
interface OpenAttempt {
  readonly turn: number
  readonly step: number
  readonly ordinal: number
  readonly attemptId: string | undefined
  readonly startedAt: number
  /** Usage seen on the live stream, kept only until the settlement replaces it. */
  liveUsage: CacheUsage | undefined
}

/** Options for {@link AttemptTracker}. */
export interface AttemptTrackerOptions {
  /** Bricks kept, newest last; the oldest fall off. */
  readonly capacity?: number
  /** Clock, injectable so a test can assert timings. */
  readonly now?: () => number
}

/** Default ring size: a couple of long sessions' worth of bricks, a few dozen bytes each. */
export const DEFAULT_CAPACITY = 1024

/** Reads the last `usage` chunk out of a durable compact stream. */
export function usageFromStream(stream: readonly unknown[] | undefined): CacheUsage | undefined {
  let found: CacheUsage | undefined
  for (const record of stream ?? []) {
    if (record === null || typeof record !== 'object') continue
    const entry = record as { type?: unknown; chunk?: { type?: unknown; usage?: CacheUsage } }
    if (entry.type !== 'chunk' || entry.chunk?.type !== 'usage') continue
    const usage = entry.chunk.usage
    if (usage !== undefined) found = usage
  }
  return found
}

/**
 * Turns the harness's three channels into bricks.
 *
 * One tracker per session. It holds the open attempts (a handful), the bricks (a ring), and two
 * counters. Nothing else — no store, no refs, no history.
 */
export class AttemptTracker {
  private readonly sessionId: string
  private readonly capacity: number
  private readonly now: () => number
  private readonly bricks: CacheBrick[] = []
  private readonly open = new Map<string, OpenAttempt[]>()
  private readonly ordinals = new Map<string, number>()
  private readonly ended = new Set<number>()
  private droppedCount = 0
  private dispatchCount = 0
  private skippedSettlements = 0
  private backfilledCount = 0
  /**
   * `(turn, step)` pairs this process has seen live.
   *
   * A step that is running *now* must not be filled in from the log: the live attempt is the one
   * that is actually being billed, and a backfilled brick for the same step would either duplicate
   * it or steal its ordinal. So the log fills the past and the live path owns the present.
   */
  private readonly liveSteps = new Set<string>()

  constructor(sessionId: string, options: AttemptTrackerOptions = {}) {
    this.sessionId = sessionId
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY)
    this.now = options.now ?? Date.now
  }

  /** A real model call was dispatched (`llm/stream`). */
  dispatched(): void {
    this.dispatchCount += 1
  }

  /**
   * One `agent/assistant-stream` frame.
   *
   * Only `start` and a `usage` chunk are read. Text and reasoning deltas are not observed at
   * all: this plugin's brick does not count characters, so the cheapest handling of a delta is
   * not to look at it — which is also why a long answer costs the tracker nothing.
   */
  frame(frame: AttemptFrame): void {
    if (frame.type === 'start') {
      const turn = frame.turn ?? 0
      const step = frame.step ?? 0
      const key = this.keyOf(turn, step)
      const ordinal = this.ordinals.get(key) ?? 0
      this.ordinals.set(key, ordinal + 1)
      const queue = this.open.get(key) ?? []
      queue.push({
        turn,
        step,
        ordinal,
        attemptId: frame.attemptId,
        startedAt: frame.time ?? this.now(),
        liveUsage: undefined,
      })
      this.open.set(key, queue)
      return
    }
    if (frame.type !== 'chunk' || frame.chunk?.type !== 'usage') return
    const usage = frame.chunk.usage
    if (usage === undefined) return
    // The live usage belongs to the newest open attempt: chunks arrive on the stream that is
    // running now, and only one attempt per session runs at a time.
    const attempt = this.newestOpen()
    if (attempt !== undefined) attempt.liveUsage = usage
  }

  /**
   * A durable settlement landed: this is the brick.
   *
   * @param settlement - the `assistant/message` / `assistant/attempt` event's fields.
   * @returns the brick, or undefined when the event named no step (a compaction or a title call,
   *   which this version does not draw).
   */
  settle(settlement: Settlement): CacheBrick | undefined {
    const turn = settlement.turn
    const step = settlement.step
    if (typeof turn !== 'number' || typeof step !== 'number') {
      this.skippedSettlements += 1
      return undefined
    }
    this.liveSteps.add(this.keyOf(turn, step))
    const attempt = this.takeOpen(turn, step)
    const ordinal = attempt?.ordinal ?? this.nextOrdinal(turn, step)
    const usage = settlement.usage ?? usageFromStream(settlement.stream) ?? attempt?.liveUsage
    const finishedAt = settlement.time ?? this.now()
    const brick: CacheBrick = {
      id: brickIdOf(this.sessionId, turn, step, ordinal),
      turn,
      step,
      attempt: ordinal,
      inputTokens: usage?.inputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
      hitRatio: hitRatioOf(usage),
      startedAt: attempt?.startedAt ?? finishedAt,
      finishedAt,
      tone: toneOf(usage),
    }
    this.bricks.push(brick)
    while (this.bricks.length > this.capacity) {
      this.bricks.shift()
      this.droppedCount += 1
    }
    return brick
  }

  /**
   * A settlement read out of the session's own log, for a session opened after this process started.
   *
   * Same brick, same arithmetic — the log carries the billed usage — with one rule: a step this
   * process has already seen live is left alone (see {@link liveSteps}).
   *
   * @param settlement - the settlement as the log recorded it.
   * @returns the brick, or undefined when the log had nothing to add for this step.
   */
  settleFromLog(settlement: Settlement): CacheBrick | undefined {
    const turn = settlement.turn
    const step = settlement.step
    if (typeof turn !== 'number' || typeof step !== 'number') {
      this.skippedSettlements += 1
      return undefined
    }
    if (this.liveSteps.has(this.keyOf(turn, step))) return undefined
    const brick = this.settle(settlement)
    if (brick !== undefined) this.backfilledCount += 1
    return brick
  }

  /** Bricks that came out of a session log rather than from this process's own traffic. */
  get backfilled(): number {
    return this.backfilledCount
  }

  /** A `turn/end` was seen: its stack may slide one cell left on the board. */
  turnEnded(turn: number): void {
    this.ended.add(turn)
  }

  /** Every brick still in the ring, oldest first. */
  records(): readonly CacheBrick[] {
    return this.bricks
  }

  /** Bricks the ring had to let go. */
  get dropped(): number {
    return this.droppedCount
  }

  /** Real requests dispatched on this session. */
  get dispatchedCount(): number {
    return this.dispatchCount
  }

  /** Settlements that named no `(turn, step)` — auxiliary calls, which have no column. */
  get skipped(): number {
    return this.skippedSettlements
  }

  /** Turns known to have ended. */
  endedTurns(): readonly number[] {
    return [...this.ended].sort((left, right) => left - right)
  }

  /** Attempts that started and never settled: requests in flight, or aborted. */
  get inFlight(): number {
    let count = 0
    for (const queue of this.open.values()) count += queue.length
    return count
  }

  private keyOf(turn: number, step: number): string {
    return `${String(turn)}:${String(step)}`
  }

  /** The oldest attempt still waiting on this step — the one this settlement belongs to. */
  private takeOpen(turn: number, step: number): OpenAttempt | undefined {
    const key = this.keyOf(turn, step)
    const queue = this.open.get(key)
    if (queue === undefined || queue.length === 0) return undefined
    const attempt = queue.shift()
    if (queue.length === 0) this.open.delete(key)
    return attempt
  }

  /** Count a settlement whose start frame was never seen. */
  private nextOrdinal(turn: number, step: number): number {
    const key = this.keyOf(turn, step)
    const ordinal = this.ordinals.get(key) ?? 0
    this.ordinals.set(key, ordinal + 1)
    return ordinal
  }

  private newestOpen(): OpenAttempt | undefined {
    let newest: OpenAttempt | undefined
    for (const queue of this.open.values()) {
      const candidate = queue[queue.length - 1]
      if (candidate !== undefined && (newest === undefined || candidate.startedAt >= newest.startedAt)) newest = candidate
    }
    return newest
  }
}
