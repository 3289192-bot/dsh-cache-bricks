/**
 * Derived telemetry for one attempt.
 *
 * Nothing here needs a new provider API: every number is computed from fields the
 * runtime already reports. Keeping the arithmetic in one pure module means the
 * board, the detail panel and the diff view all quote the same formula — and the
 * formulas can be tested against hand-computed cases instead of eyeballed in a
 * browser.
 */
import type { BrickMetrics, BrickUsage } from './brick';
/**
 * Prompt size in tokens.
 *
 * DSH keeps the three prompt buckets disjoint: `inputTokens` is the uncached
 * input, cache reads and cache writes are counted separately. The prompt the
 * provider billed is therefore their sum, and the ratios below divide by it — no
 * guessing at a provider's own `prompt_tokens` convention.
 *
 * @param usage - provider usage for the attempt.
 * @returns the prompt size, or undefined when the attempt reported no usage.
 */
export declare function promptTokensOf(usage: BrickUsage | undefined): number | undefined;
/** The three prompt buckets as ratios of the prompt. */
export interface PromptRatios {
    readonly promptTokens: number;
    readonly cacheHitRatio: number;
    readonly uncachedRatio: number;
    readonly cacheWriteRatio: number;
}
/**
 * Split the prompt into its three disjoint parts.
 *
 * Returns nothing when the provider reported **no** cache buckets at all: a
 * missing field means "not reported", not "zero cached", and printing `0.00%`
 * for a provider that never mentions caching is the same lie as printing `n/a`
 * for one that does.
 *
 * @param usage - provider usage for the attempt.
 * @returns the ratios, or undefined when there is no usable prompt size or no
 *   cache accounting to split.
 */
export declare function promptRatiosOf(usage: BrickUsage | undefined): PromptRatios | undefined;
/**
 * Share of the output that was reasoning tokens.
 * @param usage - provider usage for the attempt.
 * @returns the ratio in `0..1`, or undefined when the provider reports no split.
 */
export declare function reasoningRatioOf(usage: BrickUsage | undefined): number | undefined;
/**
 * How full the context window was for this request.
 * @param promptTokens - prompt size in tokens.
 * @param contextWindow - the window the request ran against.
 * @returns the ratio in `0..1`, or undefined when either side is unknown.
 */
export declare function contextOccupancyOf(promptTokens: number | undefined, contextWindow: number | undefined): number | undefined;
/** Timestamps collected while an attempt ran. */
export interface AttemptTiming {
    /** When the request was dispatched — from the `llm/stream` hook, not from step start. */
    readonly dispatchedAt?: number;
    /** When the first stream chunk arrived. */
    readonly firstTokenAt?: number;
    /** When the usage chunk arrived. */
    readonly usageAt?: number;
    /** When the terminal frame arrived. */
    readonly finishAt?: number;
}
/** Timing figures for one attempt, in milliseconds. Absent figures are explicit `undefined`. */
export interface AttemptTimingDerived {
    /**
     * Dispatch to first token.
     *
     * Deliberately *not* measured from `step/start`: that frame is emitted before
     * routing, adapter setup and retry policy, so it would flatter the number.
     */
    readonly ttftMs: number | undefined;
    /** Dispatch to the terminal frame. */
    readonly durationMs: number | undefined;
    /** Generation time (first token to finish), used as the TPS denominator. */
    readonly generationMs: number | undefined;
    /** Output tokens per second over the generation window. */
    readonly tps: number | undefined;
}
/**
 * Derive timing and throughput.
 * @param timing - the timestamps the collector captured.
 * @param outputTokens - output tokens for the attempt, when known.
 * @returns the derived timings, each present only when its inputs are.
 */
export declare function deriveTiming(timing: AttemptTiming, outputTokens?: number): AttemptTimingDerived;
/** Character and chunk counters accumulated from the stream. */
export interface StreamCounters {
    readonly chunkCount: number;
    readonly textChars: number;
    readonly reasoningChars: number;
    readonly toolCallCount: number;
}
/** An empty counter set, so a record is never missing its shape. */
export declare const EMPTY_COUNTERS: StreamCounters;
/**
 * Assemble the metrics block.
 * @param usage - provider usage, when the attempt produced any.
 * @param timing - captured timestamps.
 * @param counters - stream counters.
 * @param contextWindow - the window the request ran against.
 * @returns a fully populated metrics block (absent figures stay absent).
 */
export declare function deriveMetrics(usage: BrickUsage | undefined, timing: AttemptTiming, counters: StreamCounters, contextWindow?: number): BrickMetrics;
/** One side of a brick-to-brick comparison. */
export interface FieldDelta {
    readonly label: string;
    readonly before: string;
    readonly after: string;
    /** True when the two sides differ, i.e. this is what to look at. */
    readonly changed: boolean;
    /** Set for hashes: equal hashes mean an identical payload, not merely equal text. */
    readonly sameHash?: boolean;
}
/** Format a number with thousands separators, or an em dash when absent. */
export declare function showNumber(value: number | undefined): string;
/** Format a ratio as a percentage, or an em dash when absent. */
export declare function showPercent(value: number | undefined, digits?: number): string;
/** Format a duration in ms as seconds, or an em dash when absent. */
export declare function showSeconds(value: number | undefined): string;
/** Format a hash for display, keeping it short but identifiable. */
export declare function showHash(value: string | undefined): string;
