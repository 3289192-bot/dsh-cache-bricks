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
import { type CacheBrick, type CacheUsage } from '../shared/cache-brick';
/** The subset of one `agent/assistant-stream` frame this tracker reads. */
export interface AttemptFrame {
    readonly type: string;
    readonly turn?: number | undefined;
    readonly step?: number | undefined;
    readonly attemptId?: string | undefined;
    readonly time?: number | undefined;
    readonly chunk?: {
        readonly type?: string | undefined;
        readonly usage?: CacheUsage | undefined;
    } | undefined;
}
/** The subset of one durable settlement event this tracker reads. */
export interface Settlement {
    readonly turn?: number | undefined;
    readonly step?: number | undefined;
    readonly time?: number | undefined;
    /** The billed usage, straight off the event. */
    readonly usage?: CacheUsage | undefined;
    /** The compact stream, read only when the event carries no usage of its own. */
    readonly stream?: readonly unknown[] | undefined;
}
/** Options for {@link AttemptTracker}. */
export interface AttemptTrackerOptions {
    /** Bricks kept, newest last; the oldest fall off. */
    readonly capacity?: number;
    /** Clock, injectable so a test can assert timings. */
    readonly now?: () => number;
}
/** Default ring size: a couple of long sessions' worth of bricks, a few dozen bytes each. */
export declare const DEFAULT_CAPACITY = 1024;
/** Reads the last `usage` chunk out of a durable compact stream. */
export declare function usageFromStream(stream: readonly unknown[] | undefined): CacheUsage | undefined;
/**
 * Turns the harness's three channels into bricks.
 *
 * One tracker per session. It holds the open attempts (a handful), the bricks (a ring), and two
 * counters. Nothing else — no store, no refs, no history.
 */
export declare class AttemptTracker {
    private readonly sessionId;
    private readonly capacity;
    private readonly now;
    private readonly bricks;
    private readonly open;
    private readonly ordinals;
    private readonly ended;
    private droppedCount;
    private dispatchCount;
    private skippedSettlements;
    private backfilledCount;
    /**
     * `(turn, step)` pairs this process has seen live.
     *
     * A step that is running *now* must not be filled in from the log: the live attempt is the one
     * that is actually being billed, and a backfilled brick for the same step would either duplicate
     * it or steal its ordinal. So the log fills the past and the live path owns the present.
     */
    private readonly liveSteps;
    constructor(sessionId: string, options?: AttemptTrackerOptions);
    /** A real model call was dispatched (`llm/stream`). */
    dispatched(): void;
    /**
     * One `agent/assistant-stream` frame.
     *
     * Only `start` and a `usage` chunk are read. Text and reasoning deltas are not observed at
     * all: this plugin's brick does not count characters, so the cheapest handling of a delta is
     * not to look at it — which is also why a long answer costs the tracker nothing.
     */
    frame(frame: AttemptFrame): void;
    /**
     * A durable settlement landed: this is the brick.
     *
     * @param settlement - the `assistant/message` / `assistant/attempt` event's fields.
     * @returns the brick, or undefined when the event named no step (a compaction or a title call,
     *   which this version does not draw).
     */
    settle(settlement: Settlement): CacheBrick | undefined;
    /**
     * A settlement read out of the session's own log, for a session opened after this process started.
     *
     * Same brick, same arithmetic — the log carries the billed usage — with one rule: a step this
     * process has already seen live is left alone (see {@link liveSteps}).
     *
     * @param settlement - the settlement as the log recorded it.
     * @returns the brick, or undefined when the log had nothing to add for this step.
     */
    settleFromLog(settlement: Settlement): CacheBrick | undefined;
    /** Bricks that came out of a session log rather than from this process's own traffic. */
    get backfilled(): number;
    /** A `turn/end` was seen: its stack may slide one cell left on the board. */
    turnEnded(turn: number): void;
    /** Every brick still in the ring, oldest first. */
    records(): readonly CacheBrick[];
    /** Bricks the ring had to let go. */
    get dropped(): number;
    /** Real requests dispatched on this session. */
    get dispatchedCount(): number;
    /** Settlements that named no `(turn, step)` — auxiliary calls, which have no column. */
    get skipped(): number;
    /** Turns known to have ended. */
    endedTurns(): readonly number[];
    /** Attempts that started and never settled: requests in flight, or aborted. */
    get inFlight(): number;
    private keyOf;
    /** The oldest attempt still waiting on this step — the one this settlement belongs to. */
    private takeOpen;
    /** Count a settlement whose start frame was never seen. */
    private nextOrdinal;
    private newestOpen;
}
