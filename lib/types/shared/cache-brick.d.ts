/**
 * The whole product, as a type.
 *
 * **One settled real model request is one brick, and a brick's colour is one thing: how much of
 * that request's prompt came from the cache.**
 *
 * That is the entire contract. Everything a brick does not carry is a decision, not an
 * omission — this version exists because the previous line grew into a session debugger
 * (request captures, blob store, replay, inspector, history paging), and none of that is needed
 * to watch a cache work. What is *not* here:
 *
 * - no prompt, no messages, no system prompt;
 * - no tool calls, no tool schemas, no tool results;
 * - no request envelope, no header, no context snapshot;
 * - no stream, no reasoning counters, no TTFT, no diff;
 * - no navigation target, no transcript row, no settlement seq.
 *
 * A brick is therefore a few dozen bytes, it never needs to be stored anywhere, and losing one
 * costs a reader nothing. The board keeps a ring of them in memory; the oldest are dropped, and
 * a page reload starts a new ring. This is a **live telemetry read-out**, not an audit log.
 */
/**
 * The token-accounting subset this plugin reads.
 *
 * Aligned with the official `TokenUsage` contract: the buckets are **disjoint** — `inputTokens`
 * is the uncached part that had to be billed again, `cacheReadTokens` came out of the cache, and
 * `cacheWriteTokens` went into it on this same call. The cache fields are optional because some
 * providers report none at all, and "no field" must never be read as "0% cached".
 */
export interface CacheUsage {
    readonly inputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
}
/**
 * What a brick can say — 0.1.3's four bands, restored.
 *
 * The three-tone version this line first shipped folded the amber band into green, and a reader
 * noticed within the hour: twelve bricks on a live board sat between 70% and 90% and read as
 * healthy. The band exists because those two readings are not the same fact — at 0.85 a *tenth* of
 * a long prompt was re-billed, which is worth seeing before it becomes a red one — so it is back,
 * with 0.1.3's own colours.
 */
export type BrickTone = 
/** The prompt was mostly reused. */
'good'
/** A tenth of the prefix was re-billed: neither healthy nor alarming. */
 | 'warn'
/** The prompt was mostly re-billed. */
 | 'bad'
/** Nothing to say: the provider reported no cache field, or the prompt is too small to mean anything. */
 | 'unknown';
/** One real model request attempt, settled. */
export interface CacheBrick {
    /** `${sessionId}:${turn}:${step}:${attempt}`. */
    readonly id: string;
    readonly turn: number;
    readonly step: number;
    /** 0 for the first request of this `(turn, step)`, 1 for the retry that replaced it, … */
    readonly attempt: number;
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    /**
     * Cache-read share of the prompt, or `null` when the provider reported no cache field.
     *
     * `null` is not 0: a provider that says nothing has not told us the cache missed.
     */
    readonly hitRatio: number | null;
    readonly startedAt: number;
    readonly finishedAt: number;
    readonly tone: BrickTone;
}
/** One session's bricks, oldest first, plus what the ring had to let go. */
export interface BrickFeed {
    readonly sessionId: string;
    readonly bricks: readonly CacheBrick[];
    /**
     * Bricks dropped off the old end of the ring.
     *
     * Reported rather than hidden: a board that silently forgot the beginning of a long run would
     * look like a session that started late.
     */
    readonly dropped: number;
    /** Turns whose `turn/end` was seen — the flag that slides a finished stack one cell left. */
    readonly endedTurns: readonly number[];
    /**
     * Bricks in the ring that came from the session's own log rather than from this process.
     *
     * Reported so a reader can tell "the board is showing what happened" from "the board is showing
     * what has happened since this process started, plus the session's recorded past".
     */
    readonly backfilled: number;
    /**
     * Real model requests dispatched on this session since the plugin loaded.
     *
     * The counter exists to be compared with `bricks.length`: a gap between them is requests that
     * were dispatched and never settled (still running, or aborted), which is the only kind of
     * loss this design can have.
     */
    readonly dispatched: number;
}
/**
 * Below this share the brick is **red**: this call re-billed most of its prompt.
 *
 * The number is inherited unchanged from the 0.1.0.a palette, where it was chosen so that red
 * means "most of the prefix was paid for again" rather than "the cache was rebuilt from
 * nothing" — a 30% loss on a 400k prompt is 120k tokens at full price, and it is exactly the
 * event a board of bricks exists to make visible.
 */
export declare const BAD_BELOW = 0.7;
/**
 * Below this share the brick is **amber**: a tenth of the prefix was re-billed.
 *
 * Inherited from the 0.1.0.a palette, where it was chosen so that the board answers "is the tail
 * of this conversation still cached?" rather than "was the cache rebuilt from nothing?".
 */
export declare const WARN_BELOW = 0.9;
/**
 * Prompts smaller than this are **grey**, whatever their ratio.
 *
 * A 300-token probe that hits 0% is not a cache regression, it is a small call; painting it red
 * would put noise where the signal goes and train a reader to ignore red.
 */
export declare const MIN_SIGNIFICANT_TOKENS = 1000;
/** Whether a usage record carries at least one cache-accounting field. */
export declare function hasCacheFields(usage: CacheUsage | undefined): boolean;
/**
 * The whole prompt of one call: the three disjoint buckets summed.
 *
 * Writing cache is not a hit — a call that paid full price for 400k tokens *and* wrote them into
 * the cache is not a 99% hit — so the denominator includes what was read, what was re-billed and
 * what was written.
 *
 * @param usage - one call's accounting.
 * @returns prompt tokens, never negative.
 */
export declare function promptTokensOf(usage: CacheUsage): number;
/**
 * Cache-read share of one call's prompt.
 *
 * @param usage - one call's accounting, or undefined while the provider has said nothing.
 * @returns the share in [0, 1], or `null` when there is no cache field to divide by.
 */
export declare function hitRatioOf(usage: CacheUsage | undefined): number | null;
/**
 * The colour of one brick.
 *
 * @param usage - one call's accounting.
 * @returns `good`, `warn`, `bad`, or `unknown` when there is nothing honest to say.
 */
export declare function toneOf(usage: CacheUsage | undefined): BrickTone;
/**
 * The reading printed on a brick: one decimal, **always rounded down**.
 *
 * A cache read-out that rounds up is a read-out that lies in the direction that matters, so
 * `0.9999` prints `99.9` and never `100.0`; the only way to print `100%` is to have hit every
 * token. Five characters fit the brick (`99.9%`), so an exact full hit drops the decimal rather
 * than needing a sixth.
 *
 * @param ratio - share in [0, 1].
 * @returns e.g. `99.9%`, `100%`.
 */
export declare function percentLabel(ratio: number): string;
/** What a brick prints, or `n/a` when the provider said nothing. */
export declare function brickLabel(brick: Pick<CacheBrick, 'hitRatio'>): string;
/** Built from the settlement, so it needs no id counter and stays stable across a reload. */
export declare function brickIdOf(sessionId: string, turn: number, step: number, attempt: number): string;
