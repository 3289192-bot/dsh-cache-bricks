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
export interface CacheBadgeStatus {
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

/** Below this share the step is red: the cache did not survive into this call. */
export const CRITICAL_BELOW = 0.1

/** Below this share the step is amber, but not alarming. */
export const WARN_BELOW = 0.8

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
 * Percentage text with one decimal. A partial hit is never rounded up to a flat
 * `100.0%`: honesty about the last fraction is the point of a cache badge, so
 * the rounded-up case is pinned to `99.9%`.
 * @param ratio - share in [0, 1].
 */
export function formatPercent(ratio: number): string {
  const text = (ratio * 100).toFixed(1)
  return ratio < 1 && text === '100.0' ? '99.9' : text
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
export function chipLabel(status: CacheBadgeStatus): string {
  return status.hitRatio === null ? 'n/a' : `${formatPercent(status.hitRatio)}%`
}

/**
 * Brick-face reading: whole percent from 10% up, one decimal below it, `n/a`
 * when the provider reports nothing. Rounding is always downward so a partial
 * hit can never print `100%`; the decimal is kept exactly where a fraction of a
 * percent is the difference between "healthy" and "worth a look".
 * @param status - the decided badge for that step.
 */
export function brickLabel(status: CacheBadgeStatus): string {
  if (status.hitRatio === null) return 'n/a'
  const percent = status.hitRatio * 100
  return percent >= 10 ? `${String(Math.floor(percent))}%` : `${formatPercent(status.hitRatio)}%`
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
export function badgeStatus(input: BadgeInput): CacheBadgeStatus | null {
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
      reason: `under ${String(CRITICAL_BELOW * 100)}% of this prompt was cached — the cache was rebuilt`,
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
  status: CacheBadgeStatus,
  context: {
    readonly turn: number
    readonly step: number
    readonly provider: string | undefined
    readonly at: number
  },
): string {
  const head = `[dsh-cache-badge] ${formatLocalTime(context.at)} turn ${context.turn} step ${context.step}: ${status.label}`
  const tail = status.hitRatio === null
    ? `uncached input ${formatTokens(status.rebilledTokens)} tokens`
    : `cached ${formatTokens(status.cachedTokens)} / prompt ${formatTokens(status.promptTokens)}, `
      + `${formatTokens(status.rebilledTokens)} re-billed`
  return `${head} (${tail})`
}
