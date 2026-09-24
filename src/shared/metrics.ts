/**
 * Derived telemetry for one attempt.
 *
 * Nothing here needs a new provider API: every number is computed from fields the
 * runtime already reports. Keeping the arithmetic in one pure module means the
 * board, the detail panel and the diff view all quote the same formula — and the
 * formulas can be tested against hand-computed cases instead of eyeballed in a
 * browser.
 */
import type { BrickMetrics, BrickUsage } from './brick'

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
export function promptTokensOf(usage: BrickUsage | undefined): number | undefined {
  if (usage === undefined) return undefined
  const total = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return total > 0 ? total : undefined
}

/** The three prompt buckets as ratios of the prompt. */
export interface PromptRatios {
  readonly promptTokens: number
  readonly cacheHitRatio: number
  readonly uncachedRatio: number
  readonly cacheWriteRatio: number
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
export function promptRatiosOf(usage: BrickUsage | undefined): PromptRatios | undefined {
  if (usage !== undefined && usage.cacheReadTokens === undefined && usage.cacheWriteTokens === undefined) {
    return undefined
  }
  const promptTokens = promptTokensOf(usage)
  if (promptTokens === undefined || usage === undefined) return undefined
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  return {
    promptTokens,
    cacheHitRatio: cacheRead / promptTokens,
    uncachedRatio: usage.inputTokens / promptTokens,
    cacheWriteRatio: cacheWrite / promptTokens,
  }
}

/**
 * Share of the output that was reasoning tokens.
 * @param usage - provider usage for the attempt.
 * @returns the ratio in `0..1`, or undefined when the provider reports no split.
 */
export function reasoningRatioOf(usage: BrickUsage | undefined): number | undefined {
  if (usage === undefined || usage.reasoningTokens === undefined) return undefined
  const output = usage.totalTokens !== undefined
    ? usage.totalTokens - (promptTokensOf(usage) ?? 0)
    : usage.outputTokens
  return output > 0 ? usage.reasoningTokens / output : undefined
}

/**
 * How full the context window was for this request.
 * @param promptTokens - prompt size in tokens.
 * @param contextWindow - the window the request ran against.
 * @returns the ratio in `0..1`, or undefined when either side is unknown.
 */
export function contextOccupancyOf(promptTokens: number | undefined, contextWindow: number | undefined): number | undefined {
  if (promptTokens === undefined || contextWindow === undefined || contextWindow <= 0) return undefined
  return promptTokens / contextWindow
}

/** Timestamps collected while an attempt ran. */
export interface AttemptTiming {
  /** When the request was dispatched — from the `llm/stream` hook, not from step start. */
  readonly dispatchedAt?: number
  /** When the first stream chunk arrived. */
  readonly firstTokenAt?: number
  /** When the usage chunk arrived. */
  readonly usageAt?: number
  /** When the terminal frame arrived. */
  readonly finishAt?: number
}

/** Timing figures for one attempt, in milliseconds. Absent figures are explicit `undefined`. */
export interface AttemptTimingDerived {
  /**
   * Dispatch to first token.
   *
   * Deliberately *not* measured from `step/start`: that frame is emitted before
   * routing, adapter setup and retry policy, so it would flatter the number.
   */
  readonly ttftMs: number | undefined
  /** Dispatch to the terminal frame. */
  readonly durationMs: number | undefined
  /** Generation time (first token to finish), used as the TPS denominator. */
  readonly generationMs: number | undefined
  /** Output tokens per second over the generation window. */
  readonly tps: number | undefined
}

/**
 * Derive timing and throughput.
 * @param timing - the timestamps the collector captured.
 * @param outputTokens - output tokens for the attempt, when known.
 * @returns the derived timings, each present only when its inputs are.
 */
export function deriveTiming(timing: AttemptTiming, outputTokens?: number): AttemptTimingDerived {
  const { dispatchedAt, firstTokenAt, finishAt } = timing
  const ttftMs = dispatchedAt !== undefined && firstTokenAt !== undefined
    ? Math.max(0, firstTokenAt - dispatchedAt)
    : undefined
  const durationMs = dispatchedAt !== undefined && finishAt !== undefined
    ? Math.max(0, finishAt - dispatchedAt)
    : undefined
  const generationMs = firstTokenAt !== undefined && finishAt !== undefined
    ? Math.max(0, finishAt - firstTokenAt)
    : undefined
  const tps = generationMs !== undefined && generationMs > 0 && outputTokens !== undefined && outputTokens > 0
    ? outputTokens / (generationMs / 1000)
    : undefined
  return { ttftMs, durationMs, generationMs, tps }
}

/** Character and chunk counters accumulated from the stream. */
export interface StreamCounters {
  readonly chunkCount: number
  readonly textChars: number
  readonly reasoningChars: number
  readonly toolCallCount: number
}

/** An empty counter set, so a record is never missing its shape. */
export const EMPTY_COUNTERS: StreamCounters = { chunkCount: 0, textChars: 0, reasoningChars: 0, toolCallCount: 0 }

/**
 * Assemble the metrics block.
 * @param usage - provider usage, when the attempt produced any.
 * @param timing - captured timestamps.
 * @param counters - stream counters.
 * @param contextWindow - the window the request ran against.
 * @returns a fully populated metrics block (absent figures stay absent).
 */
export function deriveMetrics(
  usage: BrickUsage | undefined,
  timing: AttemptTiming,
  counters: StreamCounters,
  contextWindow?: number,
): BrickMetrics {
  // The prompt size is knowable whenever the provider reports any prompt bucket,
  // even if it never mentions caching; the *split* is what needs both.
  const promptTokens = promptTokensOf(usage)
  const ratios = promptRatiosOf(usage)
  const derived = deriveTiming(timing, usage?.outputTokens)
  const occupancy = contextOccupancyOf(promptTokens, contextWindow)
  const reasoningRatio = reasoningRatioOf(usage)
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(ratios === undefined ? {} : {
      cacheHitRatio: ratios.cacheHitRatio,
      uncachedRatio: ratios.uncachedRatio,
      cacheWriteRatio: ratios.cacheWriteRatio,
    }),
    ...(reasoningRatio === undefined ? {} : { reasoningRatio }),
    ...(occupancy === undefined ? {} : { contextOccupancy: occupancy }),
    ...(derived.ttftMs === undefined ? {} : { ttftMs: derived.ttftMs }),
    ...(derived.durationMs === undefined ? {} : { durationMs: derived.durationMs }),
    ...(derived.tps === undefined ? {} : { tps: derived.tps }),
    ...(timing.dispatchedAt === undefined ? {} : { dispatchedAt: timing.dispatchedAt }),
    ...(timing.firstTokenAt === undefined ? {} : { firstTokenAt: timing.firstTokenAt }),
    ...(timing.usageAt === undefined ? {} : { usageAt: timing.usageAt }),
    ...(timing.finishAt === undefined ? {} : { finishAt: timing.finishAt }),
    chunkCount: counters.chunkCount,
    textChars: counters.textChars,
    reasoningChars: counters.reasoningChars,
    toolCallCount: counters.toolCallCount,
  }
}

/** One side of a brick-to-brick comparison. */
export interface FieldDelta {
  readonly label: string
  readonly before: string
  readonly after: string
  /** True when the two sides differ, i.e. this is what to look at. */
  readonly changed: boolean
  /** Set for hashes: equal hashes mean an identical payload, not merely equal text. */
  readonly sameHash?: boolean
}

/** Format a number with thousands separators, or an em dash when absent. */
export function showNumber(value: number | undefined): string {
  return value === undefined ? '—' : value.toLocaleString('en-US')
}

/** Format a ratio as a percentage, or an em dash when absent. */
export function showPercent(value: number | undefined, digits = 2): string {
  return value === undefined ? '—' : `${(value * 100).toFixed(digits)}%`
}

/** Format a duration in ms as seconds, or an em dash when absent. */
export function showSeconds(value: number | undefined): string {
  return value === undefined ? '—' : `${(value / 1000).toFixed(2)}s`
}

/** Format a hash for display, keeping it short but identifiable. */
export function showHash(value: string | undefined): string {
  return value === undefined ? '—' : value.slice(0, 12)
}
