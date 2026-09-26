/**
 * The tracker: which real request is this brick?
 *
 * This is the one piece of the previous line that must not be lost in a rewrite, because it is
 * where the harness makes honesty hard. `llm/stream` has the request but no identity;
 * `agent/assistant-stream` has the identity but is not the request; `session/event` has the
 * billed usage. A tracker that merged them by "the newest thing that looked close" would show a
 * retried step as one brick and hide exactly the event the board exists to display.
 *
 * The retry fixture below is the shape copied out of a real session log
 * (`session-24f42588…`, seq 712-721): a transport failure settles as `assistant/attempt`, the
 * retry is recorded, the retry settles as `assistant/message`.
 */
import { describe, expect, it } from 'vitest'
import { AttemptTracker, usageFromStream } from '../src/host/attempt-tracker'

/** A tracker with a clock a test can move. */
function tracker(options: { capacity?: number } = {}): AttemptTracker {
  let now = 1_000
  const instance = new AttemptTracker('S', {
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    now: () => now,
  })
  return instance
}

describe('one settled request, one brick', () => {
  it('takes identity from the stream and usage from the settlement', () => {
    const attempts = tracker()
    attempts.dispatched()
    attempts.frame({ type: 'start', turn: 4, step: 17, attemptId: 'a1', time: 1_100 })
    attempts.frame({ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 990 } } })
    const brick = attempts.settle({ turn: 4, step: 17, time: 1_500, usage: { inputTokens: 12, cacheReadTokens: 1_988 } })
    expect(brick).toBeDefined()
    expect(brick!.id).toBe('S:4:17:0')
    expect(brick!.attempt).toBe(0)
    expect(brick!.inputTokens).toBe(12)
    expect(brick!.cacheReadTokens).toBe(1_988)
    expect(brick!.hitRatio).toBeCloseTo(1_988 / 2_000, 6)
    expect(brick!.tone).toBe('good')
    expect(brick!.startedAt).toBe(1_100)
    expect(brick!.finishedAt).toBe(1_500)
    expect(attempts.records()).toHaveLength(1)
    expect(attempts.dispatchedCount).toBe(1)
    expect(attempts.inFlight).toBe(0)
  })

  it('falls back to the live usage when the settlement carried none', () => {
    const attempts = tracker()
    attempts.frame({ type: 'start', turn: 1, step: 1, time: 1_000 })
    attempts.frame({ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 200, cacheReadTokens: 800 } } })
    const brick = attempts.settle({ turn: 1, step: 1, time: 1_200 })
    expect(brick!.hitRatio).toBeCloseTo(0.8, 6)
    // 80% cached: the amber band, not green — a tenth of this prompt was re-billed.
    expect(brick!.tone).toBe('warn')
  })

  it('reads the compact stream when the event body has no usage of its own', () => {
    // How a settled attempt is written to the log: the numbers live inside the stream.
    const stream = [
      { type: 'chunk', time: 1, chunk: { type: 'block-start' } },
      { type: 'text-chunks', time0: 2, index: 0, dt: [4], texts: ['hello'] },
      { type: 'chunk', time: 3, chunk: { type: 'usage', usage: { inputTokens: 5, cacheReadTokens: 995 } } },
    ]
    expect(usageFromStream(stream)).toEqual({ inputTokens: 5, cacheReadTokens: 995 })
    const attempts = tracker()
    const brick = attempts.settle({ turn: 2, step: 3, time: 9, stream })
    expect(brick!.hitRatio).toBeCloseTo(0.995, 6)
  })

  it('does not look at text or reasoning deltas at all', () => {
    const attempts = tracker()
    attempts.frame({ type: 'start', turn: 1, step: 1 })
    for (let index = 0; index < 5_000; index += 1) attempts.frame({ type: 'chunk', chunk: { type: 'text-delta' } })
    // Five thousand deltas changed nothing: they are not bricks, and counting them would be the
    // only way this plugin could cost anything per token.
    expect(attempts.records()).toHaveLength(0)
    expect(attempts.settle({ turn: 1, step: 1, usage: { inputTokens: 10, cacheReadTokens: 10 } })!.hitRatio).toBe(0.5)
  })

  it('shows nothing while a request is in flight', () => {
    const attempts = tracker()
    attempts.frame({ type: 'start', turn: 1, step: 1 })
    attempts.frame({ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 900 } } })
    // Usage arrived, the request has not settled: no brick yet, because the number the provider
    // bills is not final until then.
    expect(attempts.records()).toHaveLength(0)
    expect(attempts.inFlight).toBe(1)
  })
})

describe('a retried step is two bricks', () => {
  it('pairs each settlement with its own attempt, in order', () => {
    const attempts = tracker()
    // The shape a real log writes: start, failed attempt settles, retry runs, then the message.
    attempts.dispatched()
    attempts.frame({ type: 'start', turn: 4, step: 17, attemptId: 'a1', time: 1_100 })
    const failed = attempts.settle({ turn: 4, step: 17, time: 1_150, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 900 } } }] })!
    attempts.dispatched()
    attempts.frame({ type: 'start', turn: 4, step: 17, attemptId: 'a2', time: 1_400 })
    const retried = attempts.settle({ turn: 4, step: 17, time: 1_900, usage: { inputTokens: 20, cacheReadTokens: 1_980 } })!

    expect(attempts.records().map((brick) => [brick.attempt, brick.tone])).toEqual([[0, 'unknown'], [1, 'good']])
    expect(failed.id).not.toBe(retried.id)
    expect(failed.hitRatio).toBeNull()
    // A failed transport attempt has no cache field: the brick is grey, not red. Painting it red
    // would claim the prefix was re-billed, which nobody told us.
    expect(failed.tone).toBe('unknown')
    expect(retried.attempt).toBe(1)
    expect(attempts.dispatchedCount).toBe(2)
  })

  it('keeps attempts of different steps apart', () => {
    const attempts = tracker()
    attempts.frame({ type: 'start', turn: 1, step: 1, time: 1 })
    attempts.frame({ type: 'start', turn: 1, step: 2, time: 2 })
    const second = attempts.settle({ turn: 1, step: 2, time: 3, usage: { inputTokens: 10, cacheReadTokens: 10 } })!
    const first = attempts.settle({ turn: 1, step: 1, time: 4, usage: { inputTokens: 10, cacheReadTokens: 990 } })!
    expect(second.attempt).toBe(0)
    expect(first.attempt).toBe(0)
    expect(first.tone).toBe('good')
  })
})

describe('a settlement the tracker never saw start', () => {
  it('still lands, because the settlement carries its own identity and numbers', () => {
    // The plugin loaded mid-turn, or a request outlived a reload. The full ledger dropped these
    // to avoid attaching one attempt's capture to another; a brick has nothing to mis-attach —
    // it is built out of this event — so a hole would be a loss with no benefit.
    const attempts = tracker()
    const brick = attempts.settle({ turn: 7, step: 2, time: 5_000, usage: { inputTokens: 500, cacheReadTokens: 500 } })!
    expect(brick.id).toBe('S:7:2:0')
    expect(brick.startedAt).toBe(5_000)
    expect(brick.hitRatio).toBe(0.5)
    expect(brick.tone).toBe('bad')
  })

  it('numbers late settlements of the same step as further attempts', () => {
    const attempts = tracker()
    attempts.settle({ turn: 1, step: 1, time: 1, usage: { inputTokens: 1, cacheReadTokens: 1 } })
    const second = attempts.settle({ turn: 1, step: 1, time: 2, usage: { inputTokens: 1, cacheReadTokens: 1 } })!
    expect(second.attempt).toBe(1)
  })

  it('skips a settlement that names no step, rather than inventing a column', () => {
    const attempts = tracker()
    // Auxiliary calls (a compaction, a session title) settle too, and have no `turn`/`step`.
    expect(attempts.settle({ time: 1, usage: { inputTokens: 10, cacheReadTokens: 10 } })).toBeUndefined()
    expect(attempts.records()).toHaveLength(0)
    expect(attempts.skipped).toBe(1)
  })
})

describe('the ring', () => {
  it('keeps the newest bricks and counts what it let go', () => {
    const attempts = tracker({ capacity: 3 })
    for (let step = 1; step <= 5; step += 1) {
      attempts.settle({ turn: 1, step, time: step, usage: { inputTokens: 10, cacheReadTokens: 990 } })
    }
    expect(attempts.records().map((brick) => brick.step)).toEqual([3, 4, 5])
    expect(attempts.dropped).toBe(2)
  })

  it('reports ended turns, which is what slides a finished stack left', () => {
    const attempts = tracker()
    attempts.turnEnded(3)
    attempts.turnEnded(1)
    expect(attempts.endedTurns()).toEqual([1, 3])
  })
})
