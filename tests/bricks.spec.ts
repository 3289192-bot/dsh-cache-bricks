import { describe, expect, it } from 'vitest'
import {
  abnormalOf,
  activityOf,
  boardFromFeed,
  boardFromReadings,
  contentOf,
  labelOfRatio,
  reasoningShareOf,
  targetOf,
  titleFor,
  ttftShareOf,
  toneOfRatio,
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
    expect(toneOfRatio(0.43, 320_453)).toBe('warn')
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
    expect(labelOfRatio(0.999)).toBe('99%')
    expect(labelOfRatio(1)).toBe('100%')
    expect(labelOfRatio(0.087)).toBe('8.7%')
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

  it('gives a client-folded brick no target at all, because it has no identity', () => {
    // Those bricks are one per *step*, folded from the event feed: there is nothing in
    // the transcript they could claim to be, and pretending otherwise is what made the
    // model ambiguous in the first place.
    const folded = boardFromReadings([
      { turn: 1, step: 1, tone: 'good', label: '99%', ended: true, usage: { inputTokens: 10, cacheReadTokens: 90 } },
    ])
    expect(folded.columns[0]!.bricks[0]!.target).toEqual({ kind: 'none', reason: 'client-fold' })
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
