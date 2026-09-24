import { describe, expect, it } from 'vitest'
import {
  EMPTY_COUNTERS,
  contextOccupancyOf,
  deriveMetrics,
  deriveTiming,
  promptRatiosOf,
  promptTokensOf,
  reasoningRatioOf,
  showNumber,
  showPercent,
  showSeconds,
} from '../src/shared/metrics'
import type { BrickUsage } from '../src/shared/brick'

/** The example the design notes use: a healthy step with a big cached prefix. */
const HEALTHY: BrickUsage = {
  inputTokens: 2461,
  outputTokens: 2986,
  cacheReadTokens: 317_992,
  cacheWriteTokens: 0,
  reasoningTokens: 1421,
}

/** The same shape after the prefix was invalidated: nothing cached. */
const REBUILD: BrickUsage = { inputTokens: 321_844, outputTokens: 118, cacheReadTokens: 0 }

describe('promptTokensOf', () => {
  it('sums the three disjoint prompt buckets', () => {
    expect(promptTokensOf(HEALTHY)).toBe(320_453)
    expect(promptTokensOf(REBUILD)).toBe(321_844)
  })

  it('treats missing cache buckets as zero', () => {
    expect(promptTokensOf({ inputTokens: 900, outputTokens: 10 })).toBe(900)
  })

  it('returns nothing for an empty or absent prompt, rather than dividing by zero later', () => {
    expect(promptTokensOf(undefined)).toBeUndefined()
    expect(promptTokensOf({ inputTokens: 0, outputTokens: 0 })).toBeUndefined()
  })
})

describe('the honesty rule for unreported cache fields', () => {
  it('refuses to compute ratios when the provider mentioned no cache bucket at all', () => {
    // The prompt size is still knowable, but the split is not: printing 0.00%
    // here would accuse a provider that never claimed to cache anything.
    const silent: BrickUsage = { inputTokens: 900, outputTokens: 10 }
    expect(promptTokensOf(silent)).toBe(900)
    expect(promptRatiosOf(silent)).toBeUndefined()
    expect(deriveMetrics(silent, {}, EMPTY_COUNTERS).cacheHitRatio).toBeUndefined()
  })

  it('treats an explicitly reported zero as a real zero', () => {
    // Once a provider reports the bucket, a 0 is a measurement: full rebuild.
    const rebuilt: BrickUsage = { inputTokens: 321_844, outputTokens: 118, cacheReadTokens: 0 }
    expect(promptRatiosOf(rebuilt)?.cacheHitRatio).toBe(0)
    expect(deriveMetrics(rebuilt, {}, EMPTY_COUNTERS).cacheHitRatio).toBe(0)
  })
})

describe('promptRatiosOf', () => {
  it('splits the prompt into cached, uncached and newly written shares that add up to one', () => {
    const ratios = promptRatiosOf(HEALTHY)!
    expect(ratios.promptTokens).toBe(320_453)
    expect(ratios.cacheHitRatio).toBeCloseTo(317_992 / 320_453, 12)
    expect(ratios.uncachedRatio).toBeCloseTo(2461 / 320_453, 12)
    expect(ratios.cacheWriteRatio).toBe(0)
    expect(ratios.cacheHitRatio + ratios.uncachedRatio + ratios.cacheWriteRatio).toBeCloseTo(1, 12)
  })

  it('reports a total rebuild as zero cache hit', () => {
    const ratios = promptRatiosOf(REBUILD)!
    expect(ratios.cacheHitRatio).toBe(0)
    expect(ratios.uncachedRatio).toBe(1)
  })

  it('counts a write-only prompt as a write, not as a hit', () => {
    const ratios = promptRatiosOf({ inputTokens: 0, outputTokens: 5, cacheWriteTokens: 1000 })!
    expect(ratios.cacheHitRatio).toBe(0)
    expect(ratios.cacheWriteRatio).toBe(1)
  })
})

describe('reasoningRatioOf', () => {
  it('divides reasoning by the generated output', () => {
    expect(reasoningRatioOf(HEALTHY)).toBeCloseTo(1421 / 2986, 12)
  })

  it('prefers the provider total when it is present', () => {
    const usage: BrickUsage = { inputTokens: 100, outputTokens: 0, totalTokens: 150, reasoningTokens: 30 }
    // Output is the total minus the prompt (150 - 100 = 50), not the raw output field.
    expect(reasoningRatioOf(usage)).toBeCloseTo(30 / 50, 12)
  })

  it('stays absent when the provider does not split reasoning out', () => {
    expect(reasoningRatioOf(REBUILD)).toBeUndefined()
    expect(reasoningRatioOf(undefined)).toBeUndefined()
  })
})

describe('contextOccupancyOf', () => {
  it('measures the prompt against the window', () => {
    expect(contextOccupancyOf(320_453, 1_000_000)).toBeCloseTo(0.320453, 12)
  })

  it('stays absent without a window', () => {
    expect(contextOccupancyOf(1000, undefined)).toBeUndefined()
    expect(contextOccupancyOf(undefined, 1000)).toBeUndefined()
    expect(contextOccupancyOf(1000, 0)).toBeUndefined()
  })
})

describe('deriveTiming', () => {
  it('measures TTFT from dispatch, not from step start', () => {
    const derived = deriveTiming({ dispatchedAt: 1000, firstTokenAt: 2410, finishAt: 35_200 }, 2986)
    expect(derived.ttftMs).toBe(1410)
    expect(derived.durationMs).toBe(34_200)
    expect(derived.tps).toBeCloseTo(2986 / 32.79, 9)
  })

  it('omits what it cannot know instead of guessing zero', () => {
    expect(deriveTiming({ dispatchedAt: 1000 }).ttftMs).toBeUndefined()
    expect(deriveTiming({ firstTokenAt: 2000, finishAt: 3000 }).durationMs).toBeUndefined()
    expect(deriveTiming({ dispatchedAt: 0, firstTokenAt: 0, finishAt: 0 }, 10).tps).toBeUndefined()
  })

  it('never reports a negative span when timestamps arrive out of order', () => {
    const derived = deriveTiming({ dispatchedAt: 500, firstTokenAt: 400, finishAt: 300 }, 10)
    expect(derived.ttftMs).toBe(0)
    expect(derived.durationMs).toBe(0)
  })
})

describe('deriveMetrics', () => {
  it('assembles a complete block from the pieces', () => {
    const metrics = deriveMetrics(
      HEALTHY,
      { dispatchedAt: 1000, firstTokenAt: 2410, usageAt: 35_150, finishAt: 35_200 },
      { chunkCount: 412, textChars: 8112, reasoningChars: 4210, toolCallCount: 2 },
      1_000_000,
    )
    expect(metrics.promptTokens).toBe(320_453)
    expect(metrics.cacheHitRatio).toBeCloseTo(0.99232, 5)
    expect(metrics.ttftMs).toBe(1410)
    expect(metrics.durationMs).toBe(34_200)
    expect(metrics.contextOccupancy).toBeCloseTo(0.320453, 12)
    expect(metrics.reasoningRatio).toBeCloseTo(1421 / 2986, 12)
    expect(metrics.chunkCount).toBe(412)
    expect(metrics.toolCallCount).toBe(2)
  })

  it('keeps the keys absent when the attempt reported nothing, so the UI can say "n/a"', () => {
    const metrics = deriveMetrics(undefined, {}, EMPTY_COUNTERS)
    expect('cacheHitRatio' in metrics).toBe(false)
    expect('ttftMs' in metrics).toBe(false)
    expect(metrics.chunkCount).toBe(0)
  })
})

describe('display helpers', () => {
  it('formats numbers, percents and seconds, and marks the unknown', () => {
    expect(showNumber(320_453)).toBe('320,453')
    expect(showNumber(undefined)).toBe('—')
    expect(showPercent(0.99232)).toBe('99.23%')
    expect(showPercent(undefined)).toBe('—')
    expect(showSeconds(1410)).toBe('1.41s')
    expect(showSeconds(undefined)).toBe('—')
  })
})
