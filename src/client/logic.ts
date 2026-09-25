/**
 * Per-step prompt-cache badge logic. Pure functions with no DSH runtime
 * dependency: the Definition maps a session `usage` payload into
 * {@link CacheUsage} and calls these; the renderer formats the badge.
 *
 * One badge describes exactly ONE assistant step — one `llm/stream` call —
 * never a turn aggregate. That is the point of this plugin: a turn total
 * averages a healthy step and a cache-blowing step into a number that hides
 * both, while a per-step badge shows which step lost the cache.
 */

/** The token-accounting subset this plugin reads, aligned with the official
 * `TokenUsage` contract (@deepseek-ai/dsh-llm). Counts are DISJOINT:
 * `inputTokens` is UNCACHED input, `cacheReadTokens` was served from cache, and
 * `cacheWriteTokens` was written into the cache by this same call. Cache fields
 * are optional because some providers report none. */
export interface CacheUsage {
  inputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Colour class of one badge. `critical` is the red one. */
export type CacheTone = 'good' | 'warn' | 'critical' | 'minor' | 'unknown'

/** Everything the renderer needs for one step's badge and its tooltip. */
export interface CacheBricksStatus {
  readonly tone: CacheTone
  /** Badge text, e.g. `Cache 99.2%` or `Cache n/a`. */
  readonly label: string
  /** Short human explanation of the tone, shown in the tooltip. */
  readonly reason: string
  /** Cache-read share of the prompt, or null when the provider reported no cache field. */
  readonly hitRatio: number | null
  /** Prompt tokens served from cache. */
  readonly cachedTokens: number
  /** Prompt tokens that had to be re-billed (disjoint `inputTokens`). */
  readonly rebilledTokens: number
  /** Whole prompt for this call: cached + uncached + newly written. */
  readonly promptTokens: number
}

/**
 * Below this share the step is red: **most of the prefix was paid for again**.
 *
 * 0.1.0.a moved this from 10% to 70%, and it changes what red is *for*. At 10% only a rebuilt
 * cache could reach it, so red meant "the prefix was thrown away"; at 70% red means "this call
 * re-billed most of its prompt", which is the reading a board whose subject is the *tail* of a
 * long conversation wants to see — a 30% loss on a 400k prompt is 120k tokens of full price, and
 * it used to be painted amber and scrolled past.
 */
export const CRITICAL_BELOW = 0.7

/** Below this share the step is amber: a tenth of the prefix was re-billed. */
export const WARN_BELOW = 0.9

/** Steps smaller than this prompt are not a meaningful cache signal; they stay
 * grey so a tiny step cannot dilute the red ones the badge exists to surface. */
export const MIN_SIGNIFICANT_TOKENS = 1000

/** Whether a usage record carries at least one cache-accounting field. */
export function hasCacheFields(usage: CacheUsage | undefined): boolean {
  if (usage === undefined) return false
  return typeof usage.cacheReadTokens === 'number' || typeof usage.cacheWriteTokens === 'number'
}

/** Whole prompt of one call: the three disjoint buckets summed. */
export function promptTokensOf(usage: CacheUsage): number {
  return usage.inputTokens
    + (typeof usage.cacheReadTokens === 'number' ? Math.max(0, usage.cacheReadTokens) : 0)
    + (typeof usage.cacheWriteTokens === 'number' ? Math.max(0, usage.cacheWriteTokens) : 0)
}

/**
 * Cache-read share of one call's prompt.
 *
 * `cacheReadTokens` is the hit and the whole prompt is the denominator, so a
 * call that also wrote new cache entries is not flattered by ignoring them.
 *
 * @param usage - one call's token accounting.
 * @returns the share in [0, 1], or null when the provider reported no cache
 *   field at all (unknown, which must not be displayed as 0%).
 */
export function hitRatioOf(usage: CacheUsage | undefined): number | null {
  if (usage === undefined || !hasCacheFields(usage)) return null
  const prompt = promptTokensOf(usage)
  if (prompt <= 0) return null
  const cached = typeof usage.cacheReadTokens === 'number' ? Math.max(0, usage.cacheReadTokens) : 0
  return Math.min(1, cached / prompt)
}

/**
 * Percentage text with one decimal, **always rounded downward**.
 *
 * Honesty about the last fraction is the point of a cache badge, so the printed number never
 * overstates the hit: `0.9999` is `99.9`, not `100.0`, and `0.0875` is `8.7`, not `8.8`. The
 * floor is what makes the `100.0` clamp unnecessary — no ratio below one can reach it.
 *
 * @param ratio - share in [0, 1].
 * @returns the number, without the percent sign.
 */
export function formatPercent(ratio: number): string {
  const capped = Math.max(0, Math.min(1, ratio))
  return (Math.floor(capped * 1000) / 10).toFixed(1)
}

/**
 * The reading printed on a brick: one decimal, never overstated.
 *
 * A brick has room for five characters and no more (see the typography note on `BRICK_W`), so
 * the one case that would need a sixth — an exact full hit — drops the decimal instead:
 * `100%` is exact, not a rounded-up `99.9`, and nothing is lost by writing it shorter. Every
 * partial hit keeps its tenth, which is the whole point of the change.
 *
 * @param ratio - share in [0, 1].
 * @returns e.g. `99.9%`, `100%`, `0.0%`.
 */
export function percentLabel(ratio: number): string {
  return ratio >= 1 ? '100%' : `${formatPercent(ratio)}%`
}

/**
 * Compact token count in the official chat style: `517`, `12.2k`, `517k`,
 * `1.2M` — three significant digits, so a five- or six-digit count drops the
 * decimal instead of pretending to precision it does not display.
 * @param value - non-negative token count.
 */
export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value))
  const thousands = value / 1000
  if (thousands < 99.5) return `${trimZero(thousands.toFixed(1))}k`
  if (value < 999_500) return `${String(Math.round(thousands))}k`
  return `${trimZero((value / 1_000_000).toFixed(1))}M`
}

/**
 * One step's chip text inside a Turn row: `99.2%`, or `n/a` for a provider that
 * reports no cache field. The row's own label carries the word `Cache`, so the
 * chip stays short enough for a multi-step Turn.
 * @param status - the decided badge for that step.
 */
export function chipLabel(status: CacheBricksStatus): string {
  return status.hitRatio === null ? 'n/a' : `${formatPercent(status.hitRatio)}%`
}

/**
 * Brick-face reading: one decimal, `n/a` when the provider reports nothing.
 *
 * It used to drop the decimal from 10% up (`99%`), which threw away the difference between
 * 99.1 and 99.9 exactly where a long healthy session lives. The digit grew with it: nine
 * pixels was what a four-character label needed, and a five-character one at 12px is still
 * inside the brick.
 *
 * @param status - the decided badge for that step.
 */
export function brickLabel(status: CacheBricksStatus): string {
  if (status.hitRatio === null) return 'n/a'
  return percentLabel(status.hitRatio)
}

function trimZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/**
 * First-token latency from the step's own recorded boundaries, or 0 when a
 * boundary is unknown. Both timestamps are session event times (Unix epoch ms),
 * so the difference is wall-clock TTFT regardless of when it was read.
 */
export function ttftMs(
  stepStartTime: number | null | undefined,
  firstTokenTime: number | null | undefined,
): number {
  if (typeof stepStartTime !== 'number' || typeof firstTokenTime !== 'number') return 0
  const ms = firstTokenTime - stepStartTime
  return ms > 0 ? ms : 0
}

/** Format a Unix-epoch-ms instant in the browser's own locale and time zone. */
export function formatLocalTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString()
}

/** Inputs the renderer resolves before deciding the badge. */
export interface BadgeInput {
  /** The step's token accounting, or undefined while the provider has sent none. */
  readonly usage: CacheUsage | undefined
  /** Whether this provider has ever reported a cache field in this page's
   * lifetime. False means an absent cache field cannot be read as a 0% hit. */
  readonly hasCacheEvidence: boolean
}

/** Text shown when the provider reports no cache accounting at all. */
export const UNKNOWN_LABEL = 'Cache n/a'

/**
 * Decide tone and text for one step's badge.
 *
 * @param input - the step's usage plus per-provider cache evidence.
 * @returns the badge status, or null when the step has no usage at all: the
 *   badge appears once the provider has reported accounting, because a request
 *   still in flight has nothing to show and must not flash a wrong number.
 */
export function badgeStatus(input: BadgeInput): CacheBricksStatus | null {
  const usage = input.usage
  if (usage === undefined) return null
  if (!hasCacheFields(usage) && !input.hasCacheEvidence) {
    return {
      tone: 'unknown',
      label: UNKNOWN_LABEL,
      reason: 'provider reports no cache fields — cache status cannot be confirmed',
      hitRatio: null,
      cachedTokens: 0,
      rebilledTokens: usage.inputTokens,
      promptTokens: usage.inputTokens,
    }
  }
  const promptTokens = promptTokensOf(usage)
  const cachedTokens = typeof usage.cacheReadTokens === 'number' ? Math.max(0, usage.cacheReadTokens) : 0
  const hitRatio = hitRatioOf(usage) ?? 0
  const base = {
    label: `Cache ${formatPercent(hitRatio)}%`,
    hitRatio,
    cachedTokens,
    rebilledTokens: usage.inputTokens,
    promptTokens,
  }
  if (promptTokens < MIN_SIGNIFICANT_TOKENS) {
    return {
      ...base,
      tone: 'minor',
      reason: `prompt under ${formatTokens(MIN_SIGNIFICANT_TOKENS)} tokens — not a meaningful cache signal`,
    }
  }
  if (hitRatio < CRITICAL_BELOW) {
    return {
      ...base,
      tone: 'critical',
      reason: `under ${String(CRITICAL_BELOW * 100)}% of this prompt was cached — most of the prefix was re-billed`,
    }
  }
  if (hitRatio < WARN_BELOW) {
    return { ...base, tone: 'warn', reason: `under ${String(WARN_BELOW * 100)}% of this prompt was cached` }
  }
  return { ...base, tone: 'good', reason: 'prompt cache reused' }
}

/**
 * One console line per step, stamped in the browser's local time.
 * @param status - the decided badge.
 * @param context - step identity, provider and the accounting instant.
 */
export function badgeLogLine(
  status: CacheBricksStatus,
  context: {
    readonly turn: number
    readonly step: number
    readonly provider: string | undefined
    readonly at: number
  },
): string {
  const head = `[dsh-cache-bricks] ${formatLocalTime(context.at)} turn ${context.turn} step ${context.step}: ${status.label}`
  const tail = status.hitRatio === null
    ? `uncached input ${formatTokens(status.rebilledTokens)} tokens`
    : `cached ${formatTokens(status.cachedTokens)} / prompt ${formatTokens(status.promptTokens)}, `
      + `${formatTokens(status.rebilledTokens)} re-billed`
  return `${head} (${tail})`
}
