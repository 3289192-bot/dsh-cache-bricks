/**
 * What a page landing costs the window index, measured on a window the size of a paged session.
 *
 * Skipped unless `DSH_BENCH=1`, so the ordinary suite stays fast:
 *
 *   DSH_BENCH=1 pnpm exec vitest run tests/index-cost.spec.ts
 *
 * The claim this exists to keep honest is "a page landing indexes the page, not the window": the
 * log is append-only, so a hundred thousand events already indexed do not change when five hundred
 * older ones arrive. The counts are asserted (they are the contract); the milliseconds are printed,
 * because a timing is evidence for a reader rather than a gate for a machine.
 */
import { describe, expect, it } from 'vitest'
import { HistoryScene, indexEvents } from '../src/client/history-scene'
import type { DurableEvent } from '../src/client/navigation'

/** A window of `turns` Turns, each writing a bracket, a message and a turn end. */
function windowOf(turns: number, from = 1): DurableEvent[] {
  const events: DurableEvent[] = []
  let seq = from
  for (let turn = from; turn < from + turns; turn += 1) {
    events.push({ type: 'request/header', seq, time: seq, data: { header: { model: 'bench' }, reason: 'initial' } })
    seq += 1
    events.push({ type: 'request/context', seq, time: seq, data: { provider: 'bench', model: 'bench' } })
    seq += 1
    for (let step = 1; step <= 3; step += 1) {
      events.push({ type: 'step/start', seq, time: seq, data: { turn, step } })
      seq += 1
      events.push({ type: 'assistant/message', seq, time: seq, data: { turn, step, message: { role: 'assistant' }, stream: [], usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 } } })
      seq += 1
      events.push({ type: 'step/end', seq, time: seq, data: { turn, step } })
      seq += 1
    }
    events.push({ type: 'turn/end', seq, time: seq, data: { turn, reason: { kind: 'completed' } } })
    seq += 1
  }
  return events
}

const median = (samples: number[]): number => [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)]!

describe.skipIf(process.env.DSH_BENCH !== '1')('the cost of keeping the window indexed', () => {
  it('prices a page landing against a full rescan', () => {
    const window = windowOf(10_000)
    const page = windowOf(500, -10_000)
    const grown = [...page, ...window]
    console.log(`window ${String(window.length)} events · page ${String(page.length)} events`)

    const fulls: number[] = []
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now()
      indexEvents(window, `full-${String(run)}`)
      fulls.push(performance.now() - started)
    }
    const deltas: number[] = []
    for (let run = 0; run < 5; run += 1) {
      const scene = new HistoryScene({ sessionId: 'bench' })
      scene.window(window, `w-${String(run)}`)
      const started = performance.now()
      scene.windowGrew(page, [], `grown-${String(run)}`)
      deltas.push(performance.now() - started)
    }
    const full = median(fulls)
    const delta = median(deltas)
    console.log(`full rescan ${full.toFixed(1)} ms · page delta ${delta.toFixed(2)} ms · ${(full / delta).toFixed(0)}x`)

    const scene = new HistoryScene({ sessionId: 'bench' })
    scene.window(window, 'w')
    scene.windowGrew(page, [], 'grown')
    expect(scene.stats.windowDeltas).toBe(1)
    expect(scene.stats.windows).toBe(1)
    expect(scene.stats.indexDeltaEvents).toBe(page.length)
    expect(scene.indexedCount).toBe(grown.length)
    // The index a delta builds is the index a full scan would have built, step for step.
    const reference = indexEvents(grown, 'grown')
    for (const [turn, step] of [[1, 1], [5_000, 2], [12_000, 3], [-9_000, 1], [-9_500, 3]] as const) {
      expect(scene.currentIndex?.spanAt(turn, step)).toEqual(reference.spanAt(turn, step))
    }
    expect(scene.currentIndex?.newestSeq).toBe(reference.newestSeq)
  })
})
