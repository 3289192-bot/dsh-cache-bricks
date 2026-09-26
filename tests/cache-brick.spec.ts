/**
 * The product's arithmetic, pinned.
 *
 * A brick is one settled real model request, and its colour is one number: how much of that
 * request's prompt came out of the cache. Both halves of that sentence have a way of going
 * quietly wrong — a denominator that flatters a call which wrote cache, a ratio that rounds up,
 * a missing cache field read as a miss — so each is asserted here rather than in a rendering
 * test.
 */
import { describe, expect, it } from 'vitest'
import {
  BAD_BELOW,
  MIN_SIGNIFICANT_TOKENS,
  WARN_BELOW,
  brickIdOf,
  brickLabel,
  hasCacheFields,
  hitRatioOf,
  percentLabel,
  promptTokensOf,
  toneOf,
} from '../src/shared/cache-brick'

describe('the prompt of one call', () => {
  it('is the three disjoint buckets summed', () => {
    // Real numbers from a cached call: 267 tokens re-billed, 807,680 read, nothing written.
    expect(promptTokensOf({ inputTokens: 267, cacheReadTokens: 807_680, cacheWriteTokens: 0 })).toBe(807_947)
    // A call that paid full price and also wrote the cache is not a 99% hit.
    expect(promptTokensOf({ inputTokens: 400_000, cacheReadTokens: 0, cacheWriteTokens: 400_000 })).toBe(800_000)
  })

  it('treats an absent bucket as zero and a negative one as zero', () => {
    expect(promptTokensOf({ inputTokens: 1_000 })).toBe(1_000)
    expect(promptTokensOf({ inputTokens: -5, cacheReadTokens: -5 })).toBe(0)
  })
})

describe('the hit ratio', () => {
  it('divides the cache read by the whole prompt', () => {
    expect(hitRatioOf({ inputTokens: 267, cacheReadTokens: 807_680 })).toBeCloseTo(807_680 / 807_947, 9)
    expect(hitRatioOf({ inputTokens: 1_000, cacheReadTokens: 1_000 })).toBe(0.5)
  })

  it('is null — not zero — when the provider reported no cache field', () => {
    // "No field" and "0% cached" are different facts, and a board that painted them the same
    // would report a miss the provider never claimed.
    expect(hitRatioOf({ inputTokens: 1_000 })).toBeNull()
    expect(hitRatioOf(undefined)).toBeNull()
    expect(hitRatioOf({ inputTokens: 0, cacheReadTokens: 0 })).toBeNull()
    expect(hasCacheFields({ inputTokens: 10, cacheWriteTokens: 0 })).toBe(true)
    expect(hasCacheFields({ inputTokens: 10 })).toBe(false)
  })

  it('never exceeds one', () => {
    expect(hitRatioOf({ inputTokens: 0, cacheReadTokens: 500 })).toBe(1)
  })
})

describe('the colour', () => {
  it('is 0.1.3\'s four bands: green, amber, red, grey', () => {
    // A tenth of the prefix re-billed is neither healthy nor alarming, and a reader noticed the
    // three-tone version painting exactly these green.
    expect(toneOf({ inputTokens: 100, cacheReadTokens: 900 })).toBe('good')
    expect(toneOf({ inputTokens: 101, cacheReadTokens: 899 })).toBe('warn')
    expect(toneOf({ inputTokens: 300, cacheReadTokens: 700 })).toBe('warn')
    expect(toneOf({ inputTokens: 300.1, cacheReadTokens: 699.9 })).toBe('bad')
    expect(toneOf({ inputTokens: 500, cacheReadTokens: 500 })).toBe('bad')
    expect(BAD_BELOW).toBe(0.7)
    expect(WARN_BELOW).toBe(0.9)
  })

  it('puts both boundaries in the calmer band, as 0.1.3 did', () => {
    // `< 0.7` is red and `< 0.9` is amber, so exactly 70% and exactly 90% are amber and green.
    expect(toneOf({ inputTokens: 300, cacheReadTokens: 700 })).toBe('warn')
    expect(toneOf({ inputTokens: 100, cacheReadTokens: 900 })).toBe('good')
  })

  it('is grey when there is nothing honest to say', () => {
    // No cache field at all.
    expect(toneOf({ inputTokens: 200_000 })).toBe('unknown')
    expect(toneOf(undefined)).toBe('unknown')
    // A prompt too small to be a cache signal: a 300-token probe that missed is not a regression,
    // and painting it red would put noise exactly where the signal goes.
    expect(toneOf({ inputTokens: 300, cacheReadTokens: 0 })).toBe('unknown')
    expect(toneOf({ inputTokens: MIN_SIGNIFICANT_TOKENS - 1, cacheReadTokens: 0 })).toBe('unknown')
    expect(toneOf({ inputTokens: MIN_SIGNIFICANT_TOKENS, cacheReadTokens: 0 })).toBe('bad')
  })
})

describe('the reading', () => {
  it('never rounds up', () => {
    // A cache read-out must not lie in the direction that matters: 0.9999 is 99.9, not 100.0.
    expect(percentLabel(0.9999)).toBe('99.9%')
    expect(percentLabel(0.0875)).toBe('8.7%')
    expect(percentLabel(0.999)).toBe('99.9%')
  })

  it('prints 100% only for an exact full hit, because it needs one character fewer', () => {
    expect(percentLabel(1)).toBe('100%')
    expect(percentLabel(1.4)).toBe('100%')
  })

  it('says n/a rather than a number when the provider said nothing', () => {
    expect(brickLabel({ hitRatio: null })).toBe('n/a')
    expect(brickLabel({ hitRatio: 0 })).toBe('0.0%')
  })

  it('stays inside the five characters a brick can print', () => {
    for (const ratio of [0, 0.005, 0.5, 0.777, 0.995, 1]) {
      expect(percentLabel(ratio).length).toBeLessThanOrEqual(5)
    }
  })
})

describe('the identity of a brick', () => {
  it('is the session and the attempt, so a retry is a different brick', () => {
    expect(brickIdOf('S', 12, 3, 0)).toBe('S:12:3:0')
    expect(brickIdOf('S', 12, 3, 1)).not.toBe(brickIdOf('S', 12, 3, 0))
  })
})
