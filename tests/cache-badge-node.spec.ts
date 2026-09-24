import { describe, expect, it } from 'vitest'
import { cacheBadgeDefinition } from '../src/client/cache-badge-node'

/** Turn opening event. */
function turnStart(turn: number, seq = 1, time = 1000): any {
  return { type: 'turn/start', seq, time, data: { turn } }
}

/** Step opening event inside one turn. */
function stepStart(turn: number, step: number, seq: number, time: number): any {
  return { type: 'step/start', seq, time, data: { turn, step } }
}

/** Assistant stream chunk for one step. */
function chunk(turn: number, step: number, seq: number, time: number, chunkType: string, payload: unknown): any {
  return { type: 'assistant/chunk', seq, time, data: { turn, step, chunk: { type: chunkType, ...payload } } }
}

/**
 * The live transient chunk row, under the name this core actually publishes.
 *
 * `assistant/live-chunk` is what `dsh-api-session-controller` emits between durable events,
 * and its `seq` is a **fractional** ordering key rather than a log position — the fixture
 * keeps that shape so the fold can be proved not to confuse the two.
 */
function liveChunk(turn: number, step: number, seq: number, time: number, chunkType: string, payload: unknown): any {
  return { type: 'assistant/live-chunk', seq, time, data: { turn, step, chunk: { type: chunkType, ...payload } } }
}

/** Finalized assistant message for one step. */
function assistantMessage(
  turn: number,
  step: number,
  seq: number,
  time: number,
  usage: unknown,
  provider?: string,
): any {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn,
      step,
      message: provider === undefined ? { content: [], id: 'm' } : { source: { provider }, content: [], id: 'm' },
      usage,
    },
  }
}

/** Turn closing event. */
function turnEnd(turn: number, seq: number, time: number): any {
  return { type: 'turn/end', seq, time, data: { turn } }
}

describe('cacheBadgeDefinition.match', () => {
  it('keys every event of one turn to that turn', () => {
    expect(cacheBadgeDefinition.match(turnStart(3))).toEqual({ id: 'turn:3', role: 'start' })
    expect(cacheBadgeDefinition.match(stepStart(3, 1, 2, 1100))).toEqual({ id: 'turn:3', role: 'start' })
    expect(cacheBadgeDefinition.match(chunk(3, 1, 3, 1200, 'usage', { usage: { inputTokens: 1 } }))).toEqual({ id: 'turn:3', role: 'update' })
    expect(cacheBadgeDefinition.match(assistantMessage(3, 1, 4, 1300, { inputTokens: 1 }))).toEqual({ id: 'turn:3', role: 'update' })
    expect(cacheBadgeDefinition.match(turnEnd(3, 9, 1400))).toEqual({ id: 'turn:3', role: 'update' })
  })

  it('separates turns and ignores unrelated events', () => {
    expect(cacheBadgeDefinition.match(turnStart(4))).toEqual({ id: 'turn:4', role: 'start' })
    expect(cacheBadgeDefinition.match({ type: 'tool/result', seq: 5, data: { turn: 3, step: 1 } })).toBeNull()
    expect(cacheBadgeDefinition.match({ type: 'turn/start', seq: 5, data: {} })).toBeNull()
  })
})

describe('per-turn fold', () => {
  /** Apply one event sequence to a fresh context. */
  function fold(events: any[]): any {
    const [first, ...rest] = events
    let state = cacheBadgeDefinition.start!({} as any, { event: first } as any)
    for (const event of rest) state = cacheBadgeDefinition.update!({ state } as any, { event } as any)
    return state
  }

  it('accumulates one sample per step, in step order', () => {
    const state = fold([
      turnStart(2),
      stepStart(2, 1, 2, 1100),
      chunk(2, 1, 3, 1200, 'text-delta', { text: 'hi' }),
      chunk(2, 1, 4, 1300, 'usage', { usage: { inputTokens: 900, cacheReadTokens: 121_100 } }),
      assistantMessage(2, 1, 5, 1400, { inputTokens: 900, cacheReadTokens: 121_100 }, 'deepseek-official'),
      stepStart(2, 2, 6, 1500),
      chunk(2, 2, 7, 1600, 'usage', { usage: { inputTokens: 91_300, cacheReadTokens: 8700 } }),
      assistantMessage(2, 2, 8, 1700, { inputTokens: 91_300, cacheReadTokens: 8700 }, 'deepseek-official'),
      turnEnd(2, 9, 1800),
    ])
    expect(state.turn).toBe(2)
    expect(state.ended).toBe(true)
    const steps = [...state.steps.values()]
    expect(steps.map((sample: any) => sample.step)).toEqual([1, 2])
    expect(steps[0].usage).toEqual({ inputTokens: 900, cacheReadTokens: 121_100 })
    expect(steps[0].firstTokenTime).toBe(1200)
    expect(steps[0].stepStartTime).toBe(1100)
    expect(steps[0].provider).toBe('deepseek-official')
    expect(steps[1].usage).toEqual({ inputTokens: 91_300, cacheReadTokens: 8700 })
  })

  it('keeps the streamed usage when the settled message repeats it', () => {
    const state = fold([
      turnStart(5),
      stepStart(5, 1, 2, 1100),
      chunk(5, 1, 3, 1200, 'usage', { usage: { inputTokens: 9000, cacheReadTokens: 1000 } }),
      assistantMessage(5, 1, 4, 1300, { inputTokens: 42 }, 'deepseek-official'),
    ])
    const sample = state.steps.get(1)
    expect(sample.usage).toEqual({ inputTokens: 9000, cacheReadTokens: 1000 })
    expect(sample.usageTime).toBe(1200)
    expect(sample.provider).toBe('deepseek-official')
  })

  it('fills a missing usage from the settled message', () => {
    const state = fold([
      turnStart(5),
      stepStart(5, 1, 2, 1100),
      assistantMessage(5, 1, 3, 1300, { inputTokens: 42 }, 'deepseek-official'),
    ])
    expect(state.steps.get(1).usage).toEqual({ inputTokens: 42 })
    expect(state.steps.get(1).usageTime).toBe(1300)
  })

  it('ignores empty deltas for the first-token boundary', () => {
    const state = fold([
      turnStart(5),
      stepStart(5, 1, 2, 1100),
      chunk(5, 1, 3, 1200, 'text-delta', { text: '' }),
    ])
    expect(state.steps.get(1).firstTokenTime).toBeNull()
  })

  it('folds the live transient chunk, which is the name this core publishes', () => {
    const state = fold([
      turnStart(5),
      stepStart(5, 1, 2, 1100),
      liveChunk(5, 1, 3, 1200, 'text-delta', { text: 'hi' }),
      liveChunk(5, 1, 3.5, 1300, 'usage', { usage: { inputTokens: 9000, cacheReadTokens: 1000 } }),
      assistantMessage(5, 1, 4, 1400, { inputTokens: 9000, cacheReadTokens: 1000 }, 'deepseek-official'),
    ])
    const sample = state.steps.get(1)
    // The live row is what makes the reading grow while the step is still running.
    expect(sample.usage).toEqual({ inputTokens: 9000, cacheReadTokens: 1000 })
    expect(sample.usageTime).toBe(1300)
    expect(sample.firstTokenTime).toBe(1200)
  })

  it('never stamps the fractional seq of a transient row, which is not a log position', () => {
    const state = fold([
      turnStart(5),
      stepStart(5, 1, 2, 1100),
      liveChunk(5, 1, 2.25, 1200, 'text-delta', { text: 'hi' }),
      assistantMessage(5, 1, 9, 1400, { inputTokens: 9000 }, 'deepseek-official'),
    ])
    // `loadThrough()` is handed this seq: a fractional ordering key would ask the session
    // log for a position it does not have, so the durable settlement's seq is what stays.
    expect(state.steps.get(1).seq).toBe(9)
  })
})

describe('cacheBadgeDefinition.publication', () => {
  it('publishes as soon as a step reports usage', () => {
    expect(cacheBadgeDefinition.publication!({ event: chunk(1, 1, 2, 2000, 'usage', { usage: { inputTokens: 1 } }) } as any)).toBe('immediate')
    // Including on the live row, so the chip keeps up with a step that is still streaming.
    expect(cacheBadgeDefinition.publication!({ event: liveChunk(1, 1, 2.5, 2050, 'usage', { usage: { inputTokens: 1 } }) } as any)).toBe('immediate')
    expect(cacheBadgeDefinition.publication!({ event: assistantMessage(1, 1, 3, 2100, { inputTokens: 1 }) } as any)).toBe('immediate')
    expect(cacheBadgeDefinition.publication!({ event: turnEnd(1, 4, 2200) } as any)).toBe('immediate')
  })

  it('stays quiet for events that do not change the row', () => {
    expect(cacheBadgeDefinition.publication!({ event: turnStart(1) } as any)).toBe('none')
    expect(cacheBadgeDefinition.publication!({ event: stepStart(1, 1, 2, 1100) } as any)).toBe('none')
    expect(cacheBadgeDefinition.publication!({ event: chunk(1, 1, 3, 1200, 'text-delta', { text: 'x' }) } as any)).toBe('none')
  })
})

describe('cacheBadgeDefinition.buildViewNode', () => {
  /** Build a context from an event sequence, returning the published node. */
  function nodeFor(events: any[]): any {
    const [first, ...rest] = events
    let state = cacheBadgeDefinition.start!({} as any, { event: first } as any)
    const matches: any[] = [{ event: first, location: { kind: 'turn', turn: { turn: first.data.turn } } }]
    for (const event of rest) {
      state = cacheBadgeDefinition.update!({ state } as any, { event } as any)
      matches.push({ event, location: { kind: 'turn', turn: { turn: event.data.turn } } })
    }
    return cacheBadgeDefinition.buildViewNode!({
      key: 'k', id: `turn:${String(first.data.turn)}`, kind: 'cache-badge', target: 'chat', state, matches,
      start: { event: first, role: 'start', location: { kind: 'turn', turn: {} } },
    } as any)
  }

  const twoSteps = [
    turnStart(2),
    stepStart(2, 1, 2, 1100),
    chunk(2, 1, 3, 1200, 'usage', { usage: { inputTokens: 900, cacheReadTokens: 121_100 } }),
    stepStart(2, 2, 4, 1300),
    chunk(2, 2, 5, 1400, 'usage', { usage: { inputTokens: 91_300, cacheReadTokens: 8700 } }),
    turnEnd(2, 6, 1500),
  ]

  it('publishes the whole turn with the last matched event as its anchor', () => {
    const node = nodeFor(twoSteps)
    expect(node).not.toBeNull()
    expect(node.kind).toBe('cache-badge')
    // Anchored at turn/end and published hidden: the node is a data carrier for
    // the composer-dock chip, never a row in the Chat flow.
    expect(node.anchorSeq).toBe(6)
    expect(node.visibility).toBe('hidden')
    expect(node.data.turn).toBe(2)
    expect(node.data.ended).toBe(true)
    expect(node.data.steps.map((sample: any) => sample.step)).toEqual([1, 2])
    expect(node.data.steps[1].usage).toEqual({ inputTokens: 91_300, cacheReadTokens: 8700 })
  })

  it('publishes an empty turn rather than withdrawing a node it may have published', () => {
    // It used to return null here, and the conversation assembler treats "materialized, then
    // null" as a contract violation: `buildTargetUpserts` throws, and the whole flush — the
    // page of history that triggered the rebuild — is lost. A turn with no measured step yet
    // is therefore published with no steps: the node is hidden, and the board derives nothing
    // from it.
    const node = nodeFor([turnStart(2), stepStart(2, 1, 2, 1100), chunk(2, 1, 3, 1200, 'text-delta', { text: 'x' })])
    expect(node).not.toBeNull()
    expect(node!.data).toEqual({ turn: 2, steps: [], ended: false })
  })

  it('publishes nothing at all when the turn was never seen in the window', () => {
    expect(cacheBadgeDefinition.buildViewNode!({ state: undefined, id: 'turn:9' } as any)).toBeNull()
  })

  it('keeps publishing a turn whose state is gone, once it has been published', () => {
    // A prepend rebuilds the window; a step whose usage arrived on a client-only live chunk
    // has no durable event to replay, so its state can come back empty. Withdrawing the node
    // there would abort the very flush that carries the loaded history.
    const first = nodeFor([
      turnStart(7, 7, 100),
      stepStart(7, 1, 8, 110),
      chunk(7, 1, 9, 120, 'usage', { usage: { inputTokens: 500, cacheReadTokens: 400 } }),
    ])
    expect(first).not.toBeNull()
    const after = cacheBadgeDefinition.buildViewNode!({ state: undefined, id: 'turn:7', key: 'k', matches: [], start: undefined } as any)
    expect(after).not.toBeNull()
    expect(after!.data.turn).toBe(7)
  })
})
