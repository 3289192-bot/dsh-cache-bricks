import { describe, expect, it } from 'vitest'
import {
  CRITICAL_BELOW,
  MIN_SIGNIFICANT_TOKENS,
  WARN_BELOW,
  badgeLogLine,
  badgeStatus,
  brickLabel,
  chipLabel,
  formatPercent,
  formatTokens,
  hasCacheFields,
  hitRatioOf,
  promptTokensOf,
  ttftMs,
} from '../src/client/logic'

describe('token accounting', () => {
  it('sums the three disjoint buckets into the prompt', () => {
    expect(promptTokensOf({ inputTokens: 1000, cacheReadTokens: 9000 })).toBe(10_000)
    expect(promptTokensOf({ inputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 500 })).toBe(10_500)
    expect(promptTokensOf({ inputTokens: 700 })).toBe(700)
  })

  it('treats a negative cache count as zero instead of shrinking the prompt', () => {
    expect(promptTokensOf({ inputTokens: 700, cacheReadTokens: -5 })).toBe(700)
    expect(hitRatioOf({ inputTokens: 700, cacheReadTokens: -5 })).toBe(0)
  })

  it('knows when a usage record carries no cache accounting', () => {
    expect(hasCacheFields(undefined)).toBe(false)
    expect(hasCacheFields({ inputTokens: 10 })).toBe(false)
    expect(hasCacheFields({ inputTokens: 10, cacheReadTokens: 0 })).toBe(true)
    expect(hasCacheFields({ inputTokens: 10, cacheWriteTokens: 5 })).toBe(true)
  })

  it('computes the cache-read share of the whole prompt', () => {
    expect(hitRatioOf({ inputTokens: 1000, cacheReadTokens: 9000 })).toBeCloseTo(0.9, 10)
    expect(hitRatioOf({ inputTokens: 0, cacheReadTokens: 5000 })).toBe(1)
    expect(hitRatioOf({ inputTokens: 5000 })).toBeNull()
    expect(hitRatioOf(undefined)).toBeNull()
  })

  it('does not flatter a call that also wrote cache entries', () => {
    // 9000 read of a 10500 prompt, not 9000 of 10000.
    expect(hitRatioOf({ inputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 500 })).toBeCloseTo(9000 / 10_500, 10)
  })

  it('reports no ratio for a prompt of zero tokens', () => {
    expect(hitRatioOf({ inputTokens: 0, cacheReadTokens: 0 })).toBeNull()
    expect(hitRatioOf({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull()
  })
})

describe('formatting', () => {
  it('keeps one decimal and never rounds a partial hit up to 100.0', () => {
    expect(formatPercent(0.992)).toBe('99.2')
    expect(formatPercent(0.087)).toBe('8.7')
    expect(formatPercent(0)).toBe('0.0')
    expect(formatPercent(1)).toBe('100.0')
    expect(formatPercent(0.99999)).toBe('99.9')
  })

  it('abbreviates token counts in the official style', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(517)).toBe('517')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(1200)).toBe('1.2k')
    expect(formatTokens(12_200)).toBe('12.2k')
    expect(formatTokens(91_300)).toBe('91.3k')
    expect(formatTokens(182_400)).toBe('182k')
    expect(formatTokens(999_499)).toBe('999k')
    expect(formatTokens(1_200_000)).toBe('1.2M')
  })

  it('rounds a brick reading downward so a partial hit never prints 100%', () => {
    const at = (hitRatio: number): string => brickLabel(badgeStatus({
      usage: { inputTokens: Math.round((1 - hitRatio) * 100_000), cacheReadTokens: Math.round(hitRatio * 100_000) },
      hasCacheEvidence: true,
    })!)
    expect(at(1)).toBe('100%')
    expect(at(0.999)).toBe('99%')
    expect(at(0.9999)).toBe('99%')
    expect(at(0.5)).toBe('50%')
    // Below ten percent the fraction is the whole point, so it keeps a decimal.
    expect(at(0.087)).toBe('8.7%')
    expect(at(0)).toBe('0.0%')
    expect(brickLabel(badgeStatus({ usage: { inputTokens: 9000 }, hasCacheEvidence: false })!)).toBe('n/a')
  })

  it('labels a row chip without repeating the row label', () => {
    expect(chipLabel(badgeStatus({ usage: { inputTokens: 1200, cacheReadTokens: 150_000 }, hasCacheEvidence: true })!)).toBe('99.2%')
    expect(chipLabel(badgeStatus({ usage: { inputTokens: 91_300, cacheReadTokens: 8700 }, hasCacheEvidence: true })!)).toBe('8.7%')
    expect(chipLabel(badgeStatus({ usage: { inputTokens: 9000 }, hasCacheEvidence: false })!)).toBe('n/a')
  })

  it('derives TTFT only from two ordered boundaries', () => {
    expect(ttftMs(1000, 3100)).toBe(2100)
    expect(ttftMs(1000, 1000)).toBe(0)
    expect(ttftMs(1000, 900)).toBe(0)
    expect(ttftMs(null, 900)).toBe(0)
    expect(ttftMs(1000, null)).toBe(0)
  })
})

describe('badgeStatus', () => {
  it('shows a healthy step as good', () => {
    const status = badgeStatus({ usage: { inputTokens: 1200, cacheReadTokens: 150_000 }, hasCacheEvidence: true })
    expect(status).toMatchObject({ tone: 'good', label: 'Cache 99.2%' })
    expect(status?.hitRatio).toBeCloseTo(150_000 / 151_200, 10)
  })

  it('shows a mid-range hit as a warning', () => {
    const status = badgeStatus({ usage: { inputTokens: 57_000, cacheReadTokens: 43_000 }, hasCacheEvidence: true })
    expect(status).toMatchObject({ tone: 'warn', label: 'Cache 43.0%' })
  })

  it('turns red below the critical share', () => {
    const status = badgeStatus({ usage: { inputTokens: 91_300, cacheReadTokens: 8700 }, hasCacheEvidence: true })
    expect(status?.tone).toBe('critical')
    expect(status?.label).toBe('Cache 8.7%')
    expect(status?.hitRatio).toBeLessThan(CRITICAL_BELOW)
  })

  it('turns red on a full rebuild', () => {
    expect(badgeStatus({ usage: { inputTokens: 182_000 }, hasCacheEvidence: true }))
      .toMatchObject({ tone: 'critical', label: 'Cache 0.0%' })
  })

  it('stays grey on a step too small to mean anything', () => {
    const status = badgeStatus({ usage: { inputTokens: 300 }, hasCacheEvidence: true })
    expect(status).toMatchObject({ tone: 'minor', label: 'Cache 0.0%' })
    expect(MIN_SIGNIFICANT_TOKENS).toBe(1000)
  })

  it('stays grey at the boundary between minor and critical', () => {
    expect(badgeStatus({ usage: { inputTokens: 999 }, hasCacheEvidence: true })?.tone).toBe('minor')
    expect(badgeStatus({ usage: { inputTokens: 1000 }, hasCacheEvidence: true })?.tone).toBe('critical')
  })

  it('says n/a instead of 0% for a provider with no cache fields at all', () => {
    const status = badgeStatus({ usage: { inputTokens: 9000 }, hasCacheEvidence: false })
    expect(status).toMatchObject({ tone: 'unknown', label: 'Cache n/a', hitRatio: null })
  })

  it('reads a missing cache field as a full miss once the provider has shown one', () => {
    const status = badgeStatus({ usage: { inputTokens: 9000 }, hasCacheEvidence: true })
    expect(status).toMatchObject({ tone: 'critical', label: 'Cache 0.0%' })
  })

  it('publishes nothing before the provider reports usage', () => {
    expect(badgeStatus({ usage: undefined, hasCacheEvidence: true })).toBeNull()
    expect(badgeStatus({ usage: undefined, hasCacheEvidence: false })).toBeNull()
  })

  it('keeps the warning band open above the critical one', () => {
    expect(WARN_BELOW).toBe(0.8)
    const justBelow = badgeStatus({ usage: { inputTokens: 2000, cacheReadTokens: 7999 }, hasCacheEvidence: true })
    expect(justBelow?.tone).toBe('warn')
    const atBoundary = badgeStatus({ usage: { inputTokens: 2000, cacheReadTokens: 8000 }, hasCacheEvidence: true })
    expect(atBoundary?.tone).toBe('good')
  })
})

describe('badge presentation', () => {
  it('logs one line per step with its accounting', () => {
    const status = badgeStatus({ usage: { inputTokens: 8700, cacheReadTokens: 91_300 }, hasCacheEvidence: true })!
    const line = badgeLogLine(status, { turn: 4, step: 1, provider: 'deepseek-official', at: 0 })
    expect(line).toContain('[dsh-cache-badge]')
    expect(line).toContain('turn 4 step 1: Cache 91.3%')
    expect(line).toContain('cached 91.3k / prompt 100k, 8.7k re-billed')
  })
})
