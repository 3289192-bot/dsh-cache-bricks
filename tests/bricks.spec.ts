import { describe, expect, it } from 'vitest'
import {
  abnormalOf,
  activityOf,
  boardFromFeed,
  boardFromReadings,
  boardFromSources,
  contentOf,
  labelOfRatio,
  reasoningShareOf,
  targetOf,
  titleFor,
  ttftShareOf,
  toneOfRatio,
  type StepReading,
} from '../src/client/bricks'
import { CHANNEL, brickEdges } from '../src/client/tetris'
import { EMPTY_COUNTERS, deriveMetrics } from '../src/shared/metrics'
import type { BrickFeed, BrickRecord, BrickUsage } from '../src/shared/brick'

/** One measured usage block, for the timings the official TTFT gradient needs. */
const USAGE_IN_SPEC: BrickUsage = { inputTokens: 2461, outputTokens: 2986, cacheReadTokens: 317_992 }

/** A record with sane defaults. */
function record(overrides: {
  turn?: number
  step?: number
  attemptOrdinal?: number
  usage?: BrickUsage
  finish?: BrickRecord['finish']
  retry?: BrickRecord['retry']
  settlement?: BrickRecord['settlement']
  ttftMs?: number
} = {}): BrickRecord {
  const usage = overrides.usage ?? { inputTokens: 2461, outputTokens: 2986, cacheReadTokens: 317_992 }
  const turn = overrides.turn ?? 1
  const step = overrides.step ?? 1
  const attemptOrdinal = overrides.attemptOrdinal ?? 0
  return {
    identity: { id: `s1:${String(turn)}:${String(step)}:${String(attemptOrdinal)}`, sessionId: 's1', turn, step, attemptOrdinal },
    settlement: overrides.settlement ?? 'message',
    route: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    usage,
    metrics: deriveMetrics(usage, overrides.ttftMs === undefined ? {} : { dispatchedAt: 0, firstTokenAt: overrides.ttftMs }, EMPTY_COUNTERS),
    request: {},
    tools: [],
    ...(overrides.finish === undefined ? {} : { finish: overrides.finish }),
    ...(overrides.retry === undefined ? {} : { retry: overrides.retry }),
    raw: {},
  }
}

/** A feed around a list of records. */
function feed(bricks: BrickRecord[], endedTurns?: number[]): BrickFeed {
  return {
    sessionId: 's1',
    bricks,
    ...(endedTurns === undefined ? {} : { endedTurns }),
    store: { blobs: 1, bytes: 2 },
  }
}

describe('toneOfRatio', () => {
  it('maps the reading onto the same tones the badges use', () => {
    expect(toneOfRatio(0.992, 320_453)).toBe('good')
    expect(toneOfRatio(0.43, 320_453)).toBe('critical')
    expect(toneOfRatio(0.85, 320_453)).toBe('warn')
    expect(toneOfRatio(0.087, 320_453)).toBe('critical')
  })

  it('stays "unknown" when nothing was reported, rather than accusing the provider', () => {
    expect(toneOfRatio(undefined, 320_453)).toBe('unknown')
  })

  it('keeps a tiny prompt quiet even at 0%', () => {
    // A 300-token request cannot have a meaningful cache ratio; alarming on it
    // would drown the red bricks that matter.
    expect(toneOfRatio(0, 300)).toBe('minor')
  })
})

describe('labelOfRatio', () => {
  it('rounds down, so a partial hit never reads as 100%', () => {
    expect(labelOfRatio(0.999)).toBe('99.9%')
    expect(labelOfRatio(0.5)).toBe('50.0%')
    // The one string that would need a sixth character drops the decimal instead: an exact
    // full hit is not a rounded-up 99.9, and a brick only has room for five.
    expect(labelOfRatio(1)).toBe('100%')
    expect(labelOfRatio(0.087)).toBe('8.7%')
    // Rounding is downward at the printed precision: never an overstated hit.
    expect(labelOfRatio(0.99999)).toBe('99.9%')
    expect(labelOfRatio(undefined)).toBe('n/a')
  })
})

describe('boardFromFeed', () => {
  it('puts each attempt in its Turn column, keyed by the attempt identity', () => {
    const data = boardFromFeed(feed([
      record({ turn: 1, step: 1 }),
      record({ turn: 2, step: 1, attemptOrdinal: 0 }),
      record({ turn: 2, step: 1, attemptOrdinal: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 200_000 } }),
    ]))
    expect(data.columns.map((column) => column.turn)).toEqual([1, 2])
    expect(data.columns[1]!.bricks.map((brick) => brick.attempt)).toEqual([0, 1])
    expect(data.columns[1]!.bricks[0]!.key).toBe('s1:2:1:0')
    expect(data.order).toEqual(['s1:1:1:0', 's1:2:1:0', 's1:2:1:1'])
  })

  it('marks a failed-and-retried attempt differently from the retry that replaced it', () => {
    const data = boardFromFeed(feed([
      record({ settlement: 'attempt', finish: { reason: 'error' }, retry: { retryId: 'r1', provider: 'p', mode: 'normal', policyKey: 'k', retry: 1, maxRetries: 3, delayMs: 1000 } }),
      record({ attemptOrdinal: 1 }),
    ]))
    const [failed, retried] = data.columns[0]!.bricks
    expect(failed!.failed).toBe(true)
    expect(failed!.retried).toBe(true)
    expect(retried!.failed).toBeUndefined()
    expect(retried!.retried).toBeUndefined()
  })

  it('marks a column finished only when the log says so', () => {
    const bricks = [record({ turn: 1, step: 1 }), record({ turn: 2, step: 1 })]
    // turn 1 finished, turn 2 still running: the ghost slot and the reserved lead
    // column both depend on this.
    const running = boardFromFeed(feed(bricks, [1]))
    expect(running.columns.map((column) => column.ended)).toEqual([true, false])
    const bothDone = boardFromFeed(feed(bricks, [1, 2]))
    expect(bothDone.columns.map((column) => column.ended)).toEqual([true, true])
    // A feed from a host build without the field cannot claim the newest is done.
    const legacy = boardFromFeed(feed(bricks))
    expect(legacy.columns.map((column) => column.ended)).toEqual([true, false])
    // A collector that started mid-session has seen no `turn/end` at all; the
    // Turns before the newest are still finished by definition.
    const midSession = boardFromFeed(feed([
      record({ turn: 30, step: 1 }),
      record({ turn: 31, step: 1 }),
      record({ turn: 32, step: 1 }),
    ], []))
    expect(midSession.columns.map((column) => column.ended)).toEqual([true, true, false])
  })

  it('keeps auxiliary calls off the board instead of inventing a Turn 0 column', () => {
    const data = boardFromFeed(feed([
      { ...record({ turn: 0, step: 0 }), route: { provider: 'p', model: 'm', purpose: 'compaction' } },
      record({ turn: 5, step: 1 }),
    ], [5]))
    expect(data.columns.map((column) => column.turn)).toEqual([5])
    // It is still a brick with a record, just not a column.
    expect(data.records.size).toBe(2)
  })

  it('exposes every record for the panel, and a hover line for every brick', () => {
    const data = boardFromFeed(feed([record({ ttftMs: 1410 })]))
    expect(data.records.size).toBe(1)
    expect(data.titles.get('s1:1:1:0')).toContain('cache 99.2%')
    expect(data.titles.get('s1:1:1:0')).toContain('ttft 1.41s')
  })
})

describe('boardFromReadings (the no-host-half fallback)', () => {
  it('keys bricks by step and carries the ended flag onto the column', () => {
    const data = boardFromReadings([
      { turn: 1, step: 1, tone: 'good', label: '99%', ended: true },
      { turn: 1, step: 2, tone: 'critical', label: '0.0%', ended: false },
    ])
    expect(data.columns).toHaveLength(1)
    expect(data.columns[0]!.bricks.map((brick) => brick.key)).toEqual(['1:1', '1:2'])
    expect(data.columns[0]!.ended).toBe(false)
    expect(data.titles.get('1:2')).toContain('0.0%')
  })

  it('still produces a reduced record, so the panel opens without a host half', () => {
    const data = boardFromReadings([
      {
        turn: 1,
        step: 2,
        tone: 'critical',
        label: '0.0%',
        ended: true,
        provider: 'deepseek-official',
        usage: { inputTokens: 321_844, cacheReadTokens: 0 },
        usageAt: 10_000,
        ttftMs: 1400,
      },
    ])
    const record = data.records.get('1:2')!
    expect(record.observedBy).toBe('client')
    expect(record.route.provider).toBe('deepseek-official')
    expect(record.metrics.promptTokens).toBe(321_844)
    expect(record.metrics.cacheHitRatio).toBe(0)
    expect(record.metrics.ttftMs).toBe(1400)
    // What the client cannot see stays absent rather than guessed.
    expect(record.request.requestRef).toBeUndefined()
    expect(record.raw.streamRef).toBeUndefined()
    expect(record.tools).toHaveLength(0)
    expect(record.context).toBeUndefined()
  })
})

/** One client-side reading, for the fallback half of a merged board. */
function reading(turn: number, step: number, overrides: Partial<StepReading> = {}): StepReading {
  return { turn, step, tone: 'good', label: '99%', ended: true, ...overrides }
}

describe('boardFromSources (durable history + live attempts)', () => {
  it('keeps the folded history when the collector only has the newest Turn', () => {
    // The acceptance case: a session whose history is Turns 1-20, resumed after the
    // collector restarted, so the feed holds nothing but the new Turn 21.
    const history = Array.from({ length: 20 }, (_, index) => reading(index + 1, 1))
    const data = boardFromSources({ live: feed([record({ turn: 21, step: 1 })]), readings: history })
    expect(data.columns.map((column) => column.turn)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ])
    expect(data.columns[19]!.bricks.map((brick) => brick.key)).toEqual(['20:1'])
    expect(data.columns[20]!.bricks.map((brick) => brick.key)).toEqual(['s1:21:1:0'])
    // Board order is oldest-first across both sources, so "compare with the previous" holds.
    expect(data.order).toHaveLength(21)
    expect(data.order[0]).toBe('1:1')
    expect(data.order.at(-1)).toBe('s1:21:1:0')
  })

  it('interleaves a folded column with the collected bricks of the same Turn', () => {
    const data = boardFromSources({ live: feed([record({ turn: 2, step: 3 })]), readings: [reading(1, 1), reading(1, 2), reading(2, 1)] })
    expect(data.columns.map((column) => column.turn)).toEqual([1, 2])
    expect(data.columns[1]!.bricks.map((brick) => brick.key)).toEqual(['2:1', 's1:2:3:0'])
  })

  it('replaces only the steps the collector has, and keeps every attempt of them', () => {
    const data = boardFromSources({
      live: feed([
        record({ turn: 20, step: 3, attemptOrdinal: 0, settlement: 'attempt', finish: { reason: 'error' } }),
        record({ turn: 20, step: 3, attemptOrdinal: 1 }),
      ]),
      readings: [reading(20, 2), reading(20, 3), reading(20, 4)],
    })
    const column = data.columns[0]!
    // The merge key is the step, not the brick: one folded brick must not sit beside the
    // two real attempts of the same step and turn it into three.
    expect(column.bricks.map((brick) => brick.key)).toEqual(['20:2', 's1:20:3:0', 's1:20:3:1', '20:4'])
    expect(data.records.get('20:3')).toBeUndefined()
    expect(data.records.get('s1:20:3:0')).toBeDefined()
    // The failed attempt and the retry that replaced it both survive.
    expect(column.bricks.filter((brick) => brick.step === 3).map((brick) => brick.failed === true)).toEqual([true, false])
  })

  it('does not lose the history when the feed goes from empty to one brick', () => {
    // What a collector restart (or an LRU eviction of the session) looks like from the
    // browser: a feed that answered nothing a moment ago answers with one new attempt.
    const history = [reading(1, 1), reading(2, 1), reading(3, 1)]
    const before = boardFromSources({ live: feed([]), readings: history })
    expect(before.columns).toHaveLength(3)
    // Nothing collected at all: the whole board is the fold, and says so.
    expect(before.estimated).toBe(true)

    const after = boardFromSources({ live: feed([{ ...record({ turn: 4, step: 1 }), observedBy: 'host' }]), readings: history })
    expect(after.columns.map((column) => column.turn)).toEqual([1, 2, 3, 4])
    // Mixed board: the claim is per brick now, never the whole board.
    expect(after.estimated).toBeUndefined()
    expect(after.columns[0]!.bricks[0]!.estimated).toBe(true)
    expect(after.records.get('1:1')!.observedBy).toBe('client')
    expect(after.columns[3]!.bricks[0]!.estimated).toBeUndefined()
    expect(after.records.get('s1:4:1:0')!.observedBy).toBe('host')
  })

  it('lets either half end a Turn, keeps the auxiliary lane, and needs no host to fold', () => {
    // The collector died mid-Turn and never saw the `turn/end` its log recorded.
    const ended = boardFromSources({ live: feed([record({ turn: 7, step: 2 })], []), readings: [reading(7, 1, { ended: true })] })
    expect(ended.columns[0]!.ended).toBe(true)
    // A Turn the collector has not finished stays open when the log agrees.
    const running = boardFromSources({ live: feed([record({ turn: 7, step: 2 })], []), readings: [reading(7, 1, { ended: false })] })
    expect(running.columns[0]!.ended).toBe(false)

    const withAux = boardFromSources({
      live: feed([{ ...record({ turn: 0, step: 0 }), route: { provider: 'p', model: 'm', purpose: 'compaction' } }, record({ turn: 5, step: 1 })], [5]),
      readings: [reading(1, 1)],
    })
    expect(withAux.columns.map((column) => column.turn)).toEqual([1, 5])
    expect(withAux.aux).toHaveLength(1)
    expect(withAux.order).toEqual(['1:1', 's1:5:1:0', 's1:0:0:0'])
  })

  it('keeps Turns 1-80 on the board while Turn 81 lands as an exact collected brick', () => {
    // Acceptance case ⑤: the merged board must hold both halves at once, each with the
    // precision it actually has — and the restored bricks must still be *navigable*.
    const history = Array.from({ length: 80 }, (_, index) => reading(index + 1, 1))
    const live = { ...record({ turn: 81, step: 1 }), settlementSeq: 900, observedBy: 'host' as const }
    const data = boardFromSources({ live: feed([live]), readings: history })
    expect(data.columns).toHaveLength(81)
    const restored = data.columns[79]!.bricks[0]!
    const collected = data.columns[80]!.bricks[0]!
    expect(restored.key).toBe('80:1')
    expect(restored.estimated).toBe(true)
    expect(restored.target.kind).toBe('historical-step')
    expect(collected.key).toBe('s1:81:1:0')
    expect(collected.estimated).toBeUndefined()
    // The collected brick keeps the attempt target its record produced.
    expect(collected.target).toEqual({ kind: 'assistant-step', turn: 81, step: 1, part: 'response', loadSeq: 900 })
  })

  it('is the fallback board, unchanged, when there is no feed to merge', () => {
    const history = [reading(2, 3, { label: '8.7%', tone: 'critical' })]
    const data = boardFromSources({ readings: history })
    expect(data.estimated).toBe(true)
    expect(data.columns[0]!.bricks[0]!.key).toBe('2:3')
    expect(data.columns[0]!.bricks[0]!.label).toBe('8.7%')
  })
})

describe('boardFromSources: the replayed log under the live feed', () => {
  /** A replay feed around replayed records. */
  const replayed = (bricks: BrickRecord[]): BrickFeed => ({
    sessionId: 's1',
    bricks: bricks.map((brick) => ({ ...brick, observedBy: 'replay' as const })),
    endedTurns: [],
    store: { blobs: 0, bytes: 0 },
  })

  it('fills the attempts the collector does not have, and lets the collector win its own', () => {
    // The case the whole tier exists for: attempt 0 happened before the collector started, and
    // attempt 1 it watched. Merging per *step* would throw the failed attempt away.
    const data = boardFromSources({
      live: feed([{ ...record({ turn: 5, step: 2, attemptOrdinal: 1 }), observedBy: 'host' }]),
      replay: replayed([
        record({ turn: 5, step: 1, attemptOrdinal: 0 }),
        record({ turn: 5, step: 2, attemptOrdinal: 0, settlement: 'attempt', finish: { reason: 'error' } }),
        record({ turn: 5, step: 2, attemptOrdinal: 1 }),
      ]),
    })
    const column = data.columns[0]!
    expect(column.bricks.map((brick) => [brick.step, brick.attempt])).toEqual([[1, 0], [2, 0], [2, 1]])
    // The live record won the attempt both sources have; the replayed one filled the rest.
    expect(column.bricks.map((brick) => brick.origin)).toEqual(['replay', 'replay', 'live'])
    expect(data.records.get('s1:5:2:1')!.observedBy).toBe('host')
    expect(data.records.get('s1:5:2:0')!.observedBy).toBe('replay')
  })

  it('drops the folded brick for a step the replay already covers, so nothing is counted twice', () => {
    const data = boardFromSources({
      replay: replayed([record({ turn: 3, step: 1 }), record({ turn: 3, step: 2 })]),
      readings: [reading(3, 1), reading(3, 2), reading(3, 3)],
    })
    const keys = data.columns[0]!.bricks.map((brick) => brick.key)
    // Steps 1 and 2 came from the log; only step 3, which it does not have, is a folded brick.
    expect(keys).toEqual(['s1:3:1:0', 's1:3:2:0', '3:3'])
    expect(data.columns[0]!.bricks.map((brick) => brick.origin)).toEqual(['replay', 'replay', 'fold'])
  })

  it('needs no collector at all to draw a typed, navigable history', () => {
    // A restart with no live traffic yet: everything on the board is the log's own, and every
    // brick is attempt-level with a real target — what the fold alone could never do.
    const data = boardFromSources({ replay: replayed([
      { ...record({ turn: 9, step: 1 }), settlementSeq: 120 },
      { ...record({ turn: 9, step: 2 }), settlementSeq: 130 },
    ]) })
    expect(data.estimated).toBeUndefined()
    expect(data.columns[0]!.bricks.map((brick) => brick.estimated)).toEqual([undefined, undefined])
    expect(data.columns[0]!.bricks[0]!.target).toEqual({ kind: 'assistant-step', turn: 9, step: 1, part: 'response', loadSeq: 120 })
  })
})

describe('content channels and abnormal markers', () => {
  it('reads each channel off the record', () => {
    const rich = record()
    rich.tools = [{ callId: 'c1', name: 'read', argumentsChars: 4 }]
    rich.metrics = { ...rich.metrics, reasoningChars: 120, textChars: 40, toolCallCount: 1 }
    rich.request = { ...rich.request, headerReason: 'change' }
    expect(contentOf(rich)).toEqual({
      reasoning: true,
      tools: true,
      output: true,
      inputChange: true,
      auxiliary: false,
    })

    // A silent step is not given channels it did not earn.
    const quiet = record()
    quiet.metrics = { ...quiet.metrics, reasoningChars: 0, textChars: 0, toolCallCount: 0 }
    quiet.tools = []
    expect(contentOf(quiet)).toEqual({
      reasoning: false,
      tools: false,
      output: false,
      inputChange: false,
      auxiliary: false,
    })
  })

  it('marks a new series on the left edge, and recognises an auxiliary call', () => {
    const series = record()
    series.request = { ...series.request, startsSeries: true }
    expect(contentOf(series).inputChange).toBe(true)

    const auxiliary = record()
    auxiliary.route = { provider: 'p', model: 'm', purpose: 'compaction' }
    expect(contentOf(auxiliary).auxiliary).toBe(true)
  })

  it('marks an unclean ending, with failure ahead of retry', () => {
    expect(abnormalOf(record())).toBeUndefined()
    expect(abnormalOf(record({ finish: { reason: 'max-tokens' } }))).toBe('max-tokens')
    const failedAndRetried = record({
      settlement: 'attempt',
      finish: { reason: 'error' },
      retry: { retryId: 'r', provider: 'p', mode: 'normal', policyKey: 'k', retry: 1, delayMs: 10 },
    })
    expect(abnormalOf(failedAndRetried)).toBe('failed')
    expect(abnormalOf(record({ attemptOrdinal: 1 }))).toBe('retry')
  })

  it('names the channels in the hover summary, since the edges no longer show them', () => {
    const rich = record()
    rich.tools = [{ callId: 'c1', name: 'bash', argumentsChars: 5 }]
    rich.metrics = { ...rich.metrics, reasoningChars: 9, textChars: 3, toolCallCount: 1 }
    expect(titleFor(rich)).toContain('reasoning + tools + text')

    // A quiet step says nothing extra rather than listing things it did not do.
    const quiet = record()
    quiet.metrics = { ...quiet.metrics, reasoningChars: 0, textChars: 0, toolCallCount: 0 }
    quiet.tools = []
    expect(titleFor(quiet)).not.toContain('reasoning')
    expect(titleFor(quiet)).not.toContain('tools')

    // The channel data still reaches the board's brick.
    const data = boardFromFeed(feed([rich], [1]))
    expect(data.columns[0]!.bricks[0]!.content?.tools).toBe(true)
  })
})

describe('activityOf: what each brick did in the conversation', () => {
  const withTools = {
    ...record(),
    tools: [{ callId: 'c1', name: 'bash' }],
    metrics: { ...record().metrics, toolCallCount: 1 },
  }
  const withReasoning = (chars: number) => ({ ...record(), metrics: { ...record().metrics, reasoningChars: chars } })

  it('separates thinking, acting, both, and neither', () => {
    expect(activityOf(withReasoning(40))).toBe('reasoning')
    expect(activityOf(withTools)).toBe('tool')
    expect(activityOf({ ...withTools, metrics: { ...withTools.metrics, reasoningChars: 9 } })).toBe('mixed')
    expect(activityOf({ ...record(), metrics: { ...record().metrics, textChars: 12 } })).toBe('output')
  })

  it('reads visible output as one type, whatever shape it arrived in', () => {
    // text, an image or a file are all "the model produced something visible"; the
    // block map in the runtime separates them, and this face deliberately does not.
    expect(activityOf({ ...record(), metrics: { ...record().metrics, textChars: 1 } })).toBe('output')
    expect(activityOf(record())).toBe('output')
  })

  it('never lets a bad ending change the type', () => {
    // A failed tool call is still a tool call: lifecycle is a corner mark, not a
    // sixth colour that would need its own legend entry.
    const failedTool = { ...withTools, finish: { reason: 'error' as const } }
    expect(activityOf(failedTool)).toBe('tool')
    expect(activityOf({ ...withTools, finish: { reason: 'aborted' as const } })).toBe('tool')
    expect(activityOf({ ...withTools, finish: { reason: 'max-tokens' as const } })).toBe('tool')
    expect(activityOf({ ...withTools, attemptOrdinal: 1 })).toBe('tool')
    expect(abnormalOf(failedTool)).toBe('failed')
  })

  it('gives an auxiliary call its own type, ahead of any content it happens to carry', () => {
    const auxiliary = {
      ...record(),
      route: { provider: 'p', model: 'm', purpose: 'compaction' as const },
      metrics: { ...record().metrics, textChars: 100, reasoningChars: 50 },
    }
    expect(activityOf(auxiliary)).toBe('auxiliary')
  })

  it('splits a mixed brick by what the attempt actually did', () => {
    const heavyReasoning = { ...withTools, metrics: { ...withTools.metrics, reasoningChars: 10_000 } }
    const heavyTools = {
      ...record(),
      tools: Array.from({ length: 10 }, (_, index) => ({ callId: `c${String(index)}`, name: 'bash' })),
      metrics: { ...record().metrics, toolCallCount: 10, reasoningChars: 10 },
    }
    expect(reasoningShareOf(heavyReasoning)).toBeGreaterThan(0.9)
    expect(reasoningShareOf(heavyTools)).toBeLessThan(0.1)
    // Nothing to weigh splits evenly rather than inventing a majority.
    expect(reasoningShareOf(record())).toBe(0.5)
  })

  it('carries the type onto the board, from both brick sources', () => {
    const data = boardFromFeed(feed([{ ...withTools, metrics: { ...withTools.metrics, reasoningChars: 30 } }], [1]))
    expect(data.columns[0]!.bricks[0]!.kind).toBe('mixed')
    expect(data.columns[0]!.bricks[0]!.activityShare).toBeGreaterThan(0)

    // The client fold sees no channels, so every brick it makes is the quiet default.
    const folded = boardFromReadings([
      { turn: 1, step: 1, tone: 'good', label: '99%', ended: false, usage: { inputTokens: 10, cacheReadTokens: 90 } },
    ])
    expect(folded.columns[0]!.bricks[0]!.kind).toBe('output')
    expect(folded.columns[0]!.bricks[0]!.activityShare).toBeUndefined()
  })
})

describe('targetOf: identity is the attempt, the anchor is what shows it', () => {
  const withTools = {
    ...record(),
    tools: [{ callId: 'call_00_x', name: 'bash' }],
    metrics: { ...record().metrics, toolCallCount: 1 },
  }

  it('aims a step with assistant content at the step’s own row, naming the half it began in', () => {
    // Fixture ②: the three classes an attempt can be. A final answer with no reasoning has
    // **no reasoning half** in the DOM (`client.js:1735`: only `reasoning` is keyed with a
    // part), so the part is decided here, from what the attempt contains — never guessed at
    // landing time.
    expect(targetOf(record())).toEqual({ kind: 'assistant-step', turn: 1, step: 1, part: 'response' })
    const reasoned = { ...record(), metrics: { ...record().metrics, reasoningChars: 40 } }
    expect(targetOf(reasoned)).toEqual({ kind: 'assistant-step', turn: 1, step: 1, part: 'reasoning' })
    const answered = { ...record(), metrics: { ...record().metrics, textChars: 600 } }
    expect(targetOf(answered)).toEqual({ kind: 'assistant-step', turn: 1, step: 1, part: 'response' })
    const both = { ...record(), metrics: { ...record().metrics, reasoningChars: 40, textChars: 600 } }
    expect(targetOf(both)).toEqual({ kind: 'assistant-step', turn: 1, step: 1, part: 'reasoning' })
  })

  it('aims a step with no assistant content at the call that is its only visible trace', () => {
    // Measured, not assumed: a tool-only step *does* commit an `assistant/message`, and
    // the Chat view still renders no `assistant-step` row for it. What decides the anchor
    // is whether the attempt produced assistant content, so both settlement values below
    // aim at the call — the first is exactly the live case that exposed this.
    const settledToolOnly = { ...withTools, settlement: 'message' as const }
    expect(targetOf(settledToolOnly)).toEqual({ kind: 'tool-call', turn: 1, step: 1, callId: 'call_00_x' })
    const unfinishedToolOnly = { ...withTools, settlement: 'attempt' as const }
    expect(targetOf(unfinishedToolOnly)).toEqual({ kind: 'tool-call', turn: 1, step: 1, callId: 'call_00_x' })
  })

  it('prefers the step’s own row once the attempt has any assistant content at all', () => {
    const reasoned = { ...withTools, metrics: { ...withTools.metrics, reasoningChars: 40 } }
    expect(targetOf(reasoned)).toEqual({ kind: 'assistant-step', turn: 1, step: 1, part: 'reasoning' })
    const answered = { ...withTools, metrics: { ...withTools.metrics, textChars: 12 } }
    expect(targetOf(answered)).toEqual({ kind: 'assistant-step', turn: 1, step: 1, part: 'response' })
  })

  it('aims every attempt of a retry chain at the chain’s single row', () => {
    // N:1 by construction: the chat view resets and reuses one assistant-step node for a
    // retried step, so the chain row is the only place the pair is shown together.
    const failed = record({
      retry: { retryId: 'retry-7', provider: 'p', mode: 'normal', policyKey: 'k', retry: 1, delayMs: 10 },
    })
    expect(targetOf(failed)).toEqual({ kind: 'retry-chain', turn: 1, step: 1, retryId: 'retry-7' })
    // The retry that replaced it carries no durable record of its own; the ledger stamps
    // the chain id on it so both bricks aim at the same scene.
    const retried = { ...record({ attemptOrdinal: 1 }), retryChainId: 'retry-7' }
    expect(targetOf(retried)).toEqual({ kind: 'retry-chain', turn: 1, step: 1, retryId: 'retry-7' })
  })

  it('aims a compaction at the row keyed by its compaction id, never at a seq', () => {
    // Fixture ③: no Turn, no step, only the auxiliary call's own identity. The transcript's
    // compaction node is anchored at *its* checkpoint seq, a different event from this
    // call's settlement, so a seq cannot stand in for the id — and the id is what the row
    // is keyed by (`chatNode(context, "compaction", marker.seq, marker)`).
    const auxiliary = {
      ...record({ turn: 0, step: 0 }),
      route: { provider: 'p', model: 'm', purpose: 'compaction' as const },
      compactionId: 'cmp-9',
      settlementSeq: 418,
    }
    // The *row* is keyed by the id and by nothing else — and the call's own settlement is
    // still the log position the window must cover before that row can be rendered, so it
    // travels alongside as the load request rather than as the anchor.
    expect(targetOf(auxiliary)).toEqual({ kind: 'compaction', compactionId: 'cmp-9', loadSeq: 418 })
  })

  it('declares a session title and an unidentified compaction unreachable instead of guessing', () => {
    const title = {
      ...record({ turn: 0, step: 0 }),
      route: { provider: 'p', model: 'm', purpose: 'session-title' as const },
      settlementSeq: 418,
    }
    expect(targetOf(title)).toEqual({ kind: 'none', reason: 'session-title' })
    // A compaction whose durable event the collector never saw has nothing to aim at; that
    // is reported, not papered over with the nearest row.
    const unidentified = {
      ...record({ turn: 0, step: 0 }),
      route: { provider: 'p', model: 'm', purpose: 'compaction' as const },
      settlementSeq: 418,
    }
    expect(targetOf(unidentified)).toEqual({ kind: 'none', reason: 'no-compaction-id' })
  })

  it('gives a client-folded brick a step target, not an attempt it cannot back', () => {
    // Those bricks are one per *step*, folded from the event feed, so they must not claim to
    // be one request — but the step is still a real place in the conversation, and the durable
    // log says which row it became. Navigable at step granularity, never at attempt
    // granularity: the target says `historical-step` and the brick stays `estimated`.
    const folded = boardFromReadings([
      { turn: 1, step: 1, tone: 'good', label: '99%', ended: true, usage: { inputTokens: 10, cacheReadTokens: 90 }, seq: 28371 },
    ])
    expect(folded.columns[0]!.bricks[0]!.target).toEqual({ kind: 'historical-step', turn: 1, step: 1, loadSeq: 28371 })
    expect(folded.columns[0]!.bricks[0]!.estimated).toBe(true)
  })

  it('leaves the log position off a folded brick that was measured without one', () => {
    // No seq means no page to ask for: the target still says which step it is, and the loader
    // answers `no-seq` rather than guessing a position.
    const folded = boardFromReadings([
      { turn: 2, step: 4, tone: 'good', label: '99%', ended: true, usage: { inputTokens: 10, cacheReadTokens: 90 } },
    ])
    expect(folded.columns[0]!.bricks[0]!.target).toEqual({ kind: 'historical-step', turn: 2, step: 4 })
  })

  it('carries the target onto the board from the host feed', () => {
    const data = boardFromFeed(feed([{ ...withTools, settlement: 'attempt' }], [1]))
    expect(data.columns[0]!.bricks[0]!.target).toEqual({ kind: 'tool-call', turn: 1, step: 1, callId: 'call_00_x' })
  })
})

describe('the official TTFT gradient’s input', () => {
  it('measures the waiting share of an attempt', () => {
    const waited = {
      ...record(),
      metrics: deriveMetrics(USAGE_IN_SPEC, { dispatchedAt: 1000, firstTokenAt: 2000, finishAt: 6000 }, EMPTY_COUNTERS),
    }
    expect(ttftShareOf(waited)).toBeCloseTo(0.2)
    // Nothing to draw when the timing is unknown, or when there was no wait at all.
    expect(ttftShareOf(record())).toBeUndefined()
    const instant = {
      ...record(),
      metrics: deriveMetrics(USAGE_IN_SPEC, { dispatchedAt: 1000, firstTokenAt: 1000, finishAt: 6000 }, EMPTY_COUNTERS),
    }
    expect(ttftShareOf(instant)).toBeUndefined()
  })

  it('carries the share onto the board', () => {
    const waited = {
      ...record(),
      metrics: deriveMetrics(USAGE_IN_SPEC, { dispatchedAt: 0, firstTokenAt: 1000, finishAt: 4000 }, EMPTY_COUNTERS),
    }
    const data = boardFromFeed(feed([waited], [1]))
    expect(data.columns[0]!.bricks[0]!.ttftShare).toBeCloseTo(0.25)
  })
})

describe('the auxiliary lane and the estimated fold', () => {
  it('sends an auxiliary brick to the lane instead of inventing a Turn column', () => {
    const auxiliary = {
      ...record({ turn: 0, step: 0 }),
      route: { provider: 'p', model: 'm', purpose: 'compaction' as const },
      compactionId: 'cmp-1',
    }
    const data = boardFromFeed(feed([record(), auxiliary], [1]))
    // One Turn column, and the auxiliary call in the lane — never in that column.
    expect(data.columns).toHaveLength(1)
    expect(data.columns[0]!.bricks.map((brick) => brick.turn)).toEqual([1])
    // The lane brick carries the log position its row needs, like every other target: the
    // compaction row itself is keyed by the id, but the *history* is reached by the seq.
    expect(data.aux.map((brick) => brick.target)).toEqual([{
      kind: 'compaction',
      compactionId: 'cmp-1',
      ...(data.records.get(data.aux[0]!.key)?.settlementSeq === undefined
        ? {}
        : { loadSeq: data.records.get(data.aux[0]!.key)!.settlementSeq }),
    }])
    expect(data.aux[0]!.estimated).toBeUndefined()
  })

  it('marks the client’s fold as estimated, so it cannot pass for collected requests', () => {
    const folded = boardFromReadings([
      { turn: 1, step: 1, tone: 'good', label: '99%', ended: true, usage: { inputTokens: 10, cacheReadTokens: 90 } },
    ])
    expect(folded.estimated).toBe(true)
    expect(folded.columns[0]!.bricks[0]!.estimated).toBe(true)
    expect(folded.aux).toEqual([])
  })
})

describe('titleFor', () => {
  it('names the attempt, the reading, the timing and how it ended', () => {
    const title = titleFor(record({ attemptOrdinal: 1, ttftMs: 2000, finish: { reason: 'tool-calls' } }))
    expect(title).toContain('attempt 1')
    expect(title).toContain('cache 99.2%')
    expect(title).toContain('ttft 2.00s')
    expect(title).toContain('tool-calls')
  })

  it('says "cache n/a" instead of inventing a number', () => {
    const silent = record({ usage: { inputTokens: 900, outputTokens: 10 } })
    expect(titleFor(silent)).toContain('cache n/a')
  })
})
