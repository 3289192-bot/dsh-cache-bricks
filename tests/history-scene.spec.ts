/**
 * History as a scene: the index, the slice, and the cache in front of the replay.
 *
 * Three properties are being pinned, in the order they can go wrong:
 *
 * 1. **The index is geography, not a guess.** A step is a bracket (`step/start` … `step/end`)
 *    and everything an attempt owns sits inside it — its settled stream, its tool calls, and,
 *    for a retried step, the failed attempts *and* their `llm/retry` records. If the bracket is
 *    read wrong, a sliced brick silently loses an attempt.
 * 2. **A slice means the same thing as the whole window.** The proof is not a count of events
 *    but an equality: for the steps a scene covers, its bricks must be *the same bricks* the
 *    whole-window replay produced — same identity, same usage, same type, same settlement seq.
 *    A slice that carried too little would still produce bricks; they would just be wrong.
 * 3. **The budget stops deciding what a reader sees.** This is the defect 0.1.3 shipped: with a
 *    fixed 400-brick ledger, the oldest attempts of a long window came back typed `output` by
 *    the client fold. A scene is bounded by the screen, so the oldest brick on it is exact.
 */
import { describe, expect, it } from 'vitest'
import { activityOf } from '../src/client/bricks'
import {
  HistoryScene, indexEvents, prefetchDue, quantizeDemand, sceneKeyOf, scenePlanOf, sceneSlice, windowKeyOf,
} from '../src/client/history-scene'
import type { DurableEvent } from '../src/client/navigation'
import { boardWindow, BRICK_H, BRICK_W, GAP, type BoardColumn, type BoardMetrics } from '../src/client/tetris'
import { replaySession } from '../src/core/replay'
import type { BrickRecord } from '../src/shared/brick'

/** A durable event, with the envelope the window publishes. */
function event(seq: number, type: string, data: Record<string, unknown>, time = 1_000 + seq): DurableEvent {
  return { type, seq, time, data }
}

/** One compact run record, as the log writes it. */
function run(type: 'reasoning-chunks' | 'text-chunks' | 'tool-call-chunks', texts: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type,
    time0: 1_100 + texts.length,
    index: 0,
    dt: texts.map(() => 5),
    ...(type === 'tool-call-chunks' ? { args: texts } : { texts }),
    ...extra,
  }
}

/** The stream a settled attempt carries. */
function stream(options: { reasoning?: string[]; text?: string[]; call?: { id: string; name: string; args: string[] } }): unknown[] {
  const records: unknown[] = []
  if (options.reasoning !== undefined) records.push(run('reasoning-chunks', options.reasoning))
  if (options.text !== undefined) records.push(run('text-chunks', options.text))
  if (options.call !== undefined) {
    records.push(run('tool-call-chunks', options.call.args, { id: options.call.id, name: options.call.name }))
  }
  records.push({ type: 'chunk', time: 1_300, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 } } })
  records.push({ type: 'chunk', time: 1_300, chunk: { type: 'finish', reason: { kind: options.call === undefined ? 'stop' : 'tool-calls' } } })
  return records
}

/** The header in force for a series, as the log writes it once per request series. */
function header(seq: number, model = 'deepseek-flash'): DurableEvent {
  return event(seq, 'request/header', {
    header: { model, tools: [{ name: 'bash' }, { name: 'read' }] },
    reason: 'initial',
    startsSeries: true,
  })
}

/** The route the requests ran on, written once per series like the header. */
function context(seq: number, model = 'deepseek-flash'): DurableEvent {
  return event(seq, 'request/context', { provider: 'deepseek-official', model, contextWindow: 128_000 })
}

/**
 * A whole Turn, written the way a real log writes one: a step bracket, the model's own
 * events inside it, and the noise the replay deliberately ignores.
 */
function turn(
  events: DurableEvent[],
  seq: { at: number },
  options: { turn: number; steps: number; kind: (step: number) => 'text' | 'reasoning' | 'tool' | 'mixed'; retryAt?: number },
): void {
  const push = (type: string, data: Record<string, unknown>): void => {
    events.push(event(seq.at, type, data))
    seq.at += 1
  }
  for (let step = 1; step <= options.steps; step += 1) {
    push('step/start', { turn: options.turn, step })
    push('session-log-deepseek/delivery-accepted', { turn: options.turn, step })
    const kind = options.kind(step)
    const body = {
      ...(kind === 'reasoning' || kind === 'mixed' ? { reasoning: ['thinking about it'] } : {}),
      ...(kind === 'text' ? { text: ['here is the answer'] } : {}),
      ...(kind === 'tool' || kind === 'mixed' ? { call: { id: `call-${String(options.turn)}-${String(step)}`, name: 'bash', args: ['{"cmd":"ls"}'] } } : {}),
    }
    if (options.retryAt === step) {
      // A retried step: the failed attempt settles, the retry is recorded, then the real one.
      push('assistant/attempt', { turn: options.turn, step, stream: [{ type: 'chunk', time: 900, chunk: { type: 'finish', reason: { kind: 'error' } } }] })
      push('llm/retry', {
        retryId: `retry-${String(options.turn)}-${String(step)}`,
        retry: 1,
        turn: options.turn,
        step,
        provider: 'deepseek-official',
        mode: 'normal',
        policyKey: 'transport',
        delayMs: 250,
        failure: { message: 'transport failed', code: 'TRANSPORT' },
      })
      push('llm/retry-started', { retryId: `retry-${String(options.turn)}-${String(step)}`, retry: 1, turn: options.turn, step })
    }
    push('assistant/message', {
      turn: options.turn,
      step,
      message: { role: 'assistant' },
      stream: stream(body),
      usage: { inputTokens: 1_000, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 0 },
    })
    if (kind === 'tool' || kind === 'mixed') {
      push('tool/call', { turn: options.turn, step, callId: `call-${String(options.turn)}-${String(step)}`, name: 'bash', arguments: '{"cmd":"ls"}' })
      push('tool/result', { turn: options.turn, step, message: { role: 'tool' } })
    }
    push('step/end', { turn: options.turn, step })
  }
  push('turn/end', { turn: options.turn, reason: { kind: 'completed' } })
}

/** A window of `turns` Turns of `steps` steps, header and context first, like a real log. */
function windowOf(turns: number, steps: number, retryAt?: number): DurableEvent[] {
  const events: DurableEvent[] = [header(1), context(2)]
  const seq = { at: 3 }
  for (let turnNumber = 1; turnNumber <= turns; turnNumber += 1) {
    turn(events, seq, {
      turn: turnNumber,
      steps,
      kind: (step) => (step % 4 === 0 ? 'text' : step % 4 === 1 ? 'reasoning' : step % 4 === 2 ? 'tool' : 'mixed'),
      ...(retryAt === undefined ? {} : { retryAt }),
    })
    // The kind of durable event a real log writes between Turns: outside every bracket, and
    // therefore outside every slice.
    events.push(event(seq.at, 'session/title', { title: `turn ${String(turnNumber)}` }))
    seq.at += 1
  }
  return events
}

/** A brick's meaning, for comparing two replays of the same step. */
function meaning(record: BrickRecord): string {
  return [
    record.identity.id,
    record.identity.attemptOrdinal,
    activityOf(record),
    record.settlement,
    String(record.settlementSeq),
    String(record.usage?.cacheReadTokens),
    String(record.usage?.inputTokens),
    String(record.metrics?.cacheHitRatio),
    record.finish?.reason ?? '-',
    String(record.retry?.retry ?? '-'),
  ].join('|')
}

describe('the step index', () => {
  const events = windowOf(3, 4, 2)

  it('brackets every step by its own start and end', () => {
    const index = indexEvents(events)
    expect(index.spanCount).toBe(12)
    const span = index.spanAt(2, 2)!
    expect(events.find((entry) => entry.seq === span.startSeq)!.type).toBe('step/start')
    expect(events.find((entry) => entry.seq === span.endSeq)!.type).toBe('step/end')
    // The bracket holds the attempt, its tool call and the retry records in between.
    const inside = events.filter((entry) => entry.seq > span.startSeq && entry.seq < span.endSeq)
    expect(inside.map((entry) => entry.type)).toContain('assistant/attempt')
    expect(inside.map((entry) => entry.type)).toContain('llm/retry')
    expect(inside.map((entry) => entry.type)).toContain('assistant/message')
    expect(inside.map((entry) => entry.type)).toContain('tool/result')
    expect(index.spanAt(9, 9)).toBeUndefined()
  })

  it('closes a step the window ends in the middle of', () => {
    const open = [event(1, 'step/start', { turn: 1, step: 1 }), event(2, 'assistant/message', { turn: 1, step: 1, stream: stream({ text: ['hi'] }) })]
    const index = indexEvents(open)
    expect(index.spanAt(1, 1)).toEqual({ turn: 1, step: 1, startSeq: 1, endSeq: 2 })
    expect(index.newestSeq).toBe(2)
  })

  it('keeps the marks a slice must carry: turn ends and the header in force', () => {
    const index = indexEvents(events)
    expect(index.turnEnds.get(2)).toBe(events.find((entry) => entry.type === 'turn/end' && entry.data.turn === 2)!.seq)
    expect(index.contextSeqs).toEqual([2])
    expect(index.headerSeqs).toEqual([1])
    expect(index.key).toBe(windowKeyOf(events))
  })
})

describe('cutting a scene', () => {
  it('carries the demanded steps, their turn end, and the header in force', () => {
    const events = windowOf(4, 6)
    const index = indexEvents(events)
    const slice = sceneSlice(index, { turns: [{ turn: 3, fromStep: 2, toStep: 4 }] })
    expect(slice.spans).toBe(3)
    expect(slice.attempts).toBe(3)
    // Steps 2..4 of Turn 3, and nothing from Turn 2 or 4.
    const turns = new Set(slice.events.map((entry) => entry.data.turn).filter((turn): turn is number => typeof turn === 'number'))
    expect([...turns]).toEqual([3])
    const steps = new Set(slice.events.filter((entry) => entry.type === 'assistant/message').map((entry) => entry.data.step))
    expect([...steps].sort()).toEqual([2, 3, 4])
    // The header and context written before the slice come with it; the Turn's end mark too.
    expect(slice.events.filter((entry) => entry.type === 'request/header')).toHaveLength(1)
    expect(slice.events.filter((entry) => entry.type === 'request/context')).toHaveLength(1)
    expect(slice.events.filter((entry) => entry.type === 'turn/end')).toHaveLength(1)
    // Noise *between* brackets is not carried: a slice is the brackets plus the sticky facts,
    // and the events a real log writes between steps (a title, an inbox splice) are not any of
    // them. Noise *inside* a bracket rides along — dropping it would turn the slice into a
    // second, hand-maintained copy of the replay's alphabet.
    expect(slice.events.some((entry) => entry.type === 'session/title')).toBe(false)
    expect(slice.events.some((entry) => entry.type === 'session-log-deepseek/delivery-accepted')).toBe(true)
    // And the header is presented before the attempts it governs.
    expect(slice.events[0]!.type).toBe('request/header')
  })

  it('carries a retried step whole, so the attempt is not lost', () => {
    const events = windowOf(2, 4, 2)
    const index = indexEvents(events)
    const slice = sceneSlice(index, { turns: [{ turn: 1, fromStep: 2, toStep: 2 }] })
    const report = replaySession('scene', slice.events, { maxBricks: slice.attempts + 8 })
    expect(report.feed.bricks).toHaveLength(2)
    expect(report.feed.bricks.map((brick) => brick.identity.attemptOrdinal)).toEqual([0, 1])
    // The failed attempt records the retry that replaced it; the retry carries the chain id of
    // the failure it replaced. Both halves are only in the slice because the retry records sit
    // inside the same step bracket as the attempts they link.
    expect(report.feed.bricks[0]!.finish?.reason).toBe('error')
    expect(report.feed.bricks[0]!.retry?.retry).toBe(1)
    expect(report.feed.bricks[1]!.retryChainId).toBe('retry-1-2')
    expect(report.unattributed).toBe(0)
  })

  it('means the same thing as the whole-window replay', () => {
    const events = windowOf(5, 6, 3)
    const index = indexEvents(events)
    const whole = replaySession('same', events)
    const slice = sceneSlice(index, { turns: [{ turn: 3, fromStep: 1, toStep: 6 }, { turn: 4, fromStep: 1, toStep: 2 }] })
    const scene = replaySession('same', slice.events, { maxBricks: slice.attempts + 8 })
    const wanted = new Set(['3:1', '3:2', '3:3', '3:4', '3:5', '3:6', '4:1', '4:2'])
    const pick = (bricks: readonly BrickRecord[]): string[] => bricks
      .filter((brick) => wanted.has(`${String(brick.identity.turn)}:${String(brick.identity.step)}`))
      .map(meaning)
      .sort()
    // Same bricks, field for field — a slice that dropped the header, the retry record or the
    // Turn's end mark would differ here without failing any count.
    expect(pick(scene.feed.bricks)).toEqual(pick(whole.feed.bricks))
    expect(scene.feed.bricks).toHaveLength(9)
    // The retried step still comes out as two attempts, one of them failed.
    const retried = scene.feed.bricks.filter((brick) => brick.identity.turn === 3 && brick.identity.step === 3)
    expect(retried.map((brick) => brick.identity.attemptOrdinal)).toEqual([0, 1])
  })

  it('costs the scene, not the window', () => {
    const events = windowOf(400, 8)
    const index = indexEvents(events)
    expect(index.spanCount).toBe(3_200)
    const slice = sceneSlice(index, { turns: [{ turn: 200, fromStep: 1, toStep: 8 }, { turn: 201, fromStep: 1, toStep: 8 }] })
    // Sixteen steps of a three-thousand-step window: the slice is a page, not a session.
    expect(slice.events.length).toBeLessThan(120)
    expect(slice.spans).toBe(16)
  })

  it('returns nothing rather than everything when the demand names nothing the window holds', () => {
    const index = indexEvents(windowOf(2, 3))
    expect(sceneSlice(index, { turns: [{ turn: 99, fromStep: 1, toStep: 9 }] })).toEqual({ events: [], spans: 0, attempts: 0 })
    expect(sceneSlice(index, { turns: [] }).events).toEqual([])
  })
})

describe('the scene budget', () => {
  it('keeps the oldest brick on screen exact, where the whole-window replay lost it', () => {
    // Six hundred attempts in the window: more than the 400-brick ledger 0.1.3 replayed with.
    const events = windowOf(100, 6)
    const whole = replaySession('wall', events)
    expect(whole.feed.bricks).toHaveLength(400)
    const oldestWhole = whole.feed.bricks[0]!.identity.turn
    expect(oldestWhole).toBeGreaterThan(1)

    // The scene that shows the oldest Turn still holds every attempt of it, typed exactly.
    const index = indexEvents(events)
    const slice = sceneSlice(index, { turns: [{ turn: 1, fromStep: 1, toStep: 6 }] })
    const scene = replaySession('wall', slice.events, { maxBricks: slice.attempts + 8 })
    expect(scene.feed.bricks).toHaveLength(6)
    expect(scene.feed.bricks.every((brick) => brick.identity.turn === 1)).toBe(true)
    // Which is the difference between a brick that says what the model did and the fold's
    // honest "output, estimated" — the reason this release exists.
    expect(new Set(scene.feed.bricks.map((brick) => activityOf(brick))).size).toBeGreaterThan(1)
  })
})

describe('the demand quantum', () => {
  it('snaps outward, so a scene never asks for less than the screen', () => {
    const demand = quantizeDemand({ turns: [{ turn: 7, fromStep: 9, toStep: 20 }] })
    expect(demand.turns).toEqual([{ turn: 7, fromStep: 8, toStep: 23 }])
  })

  it('keeps one key while the reader moves inside a page', () => {
    const first = sceneKeyOf(quantizeDemand({ turns: [{ turn: 7, fromStep: 9, toStep: 20 }] }))
    const second = sceneKeyOf(quantizeDemand({ turns: [{ turn: 7, fromStep: 12, toStep: 22 }] }))
    const third = sceneKeyOf(quantizeDemand({ turns: [{ turn: 7, fromStep: 24, toStep: 30 }] }))
    expect(second).toBe(first)
    expect(third).not.toBe(first)
  })

  it('drops an inverted range instead of asking for a negative span', () => {
    expect(quantizeDemand({ turns: [{ turn: 1, fromStep: 9, toStep: 4 }] }).turns).toEqual([])
    expect(sceneKeyOf({ turns: [] })).toBe('empty')
  })
})

describe('the scene cache', () => {
  const events = windowOf(20, 6)

  it('replays once per demand and reports the memo', () => {
    const scene = new HistoryScene({ sessionId: 'cache' })
    scene.window(events)
    const demand = { turns: [{ turn: 10, fromStep: 1, toStep: 6 }] }
    const first = scene.demand(demand)!
    const again = scene.demand(demand)!
    expect(first.cached).toBe(false)
    expect(again.cached).toBe(true)
    expect(again.key).toBe(first.key)
    expect(scene.scene?.key).toBe(first.key)
  })

  it('re-cuts the reader\'s screen when the window changes underneath it', () => {
    const scene = new HistoryScene({ sessionId: 'window' })
    scene.window(events)
    const demand = { turns: [{ turn: 2, fromStep: 1, toStep: 6 }] }
    const before = scene.demand(demand)!
    expect(scene.window(events)).toBe(false)
    // A page lands: the window now starts earlier.
    const grown = [header(0), ...events]
    expect(scene.window(grown)).toBe(true)
    const after = scene.demand(demand)!
    expect(after.key).not.toBe(before.key)
    expect(after.spans).toBe(before.spans)
  })

  it('keeps a few scenes warm and drops the least recently used', () => {
    const scene = new HistoryScene({ sessionId: 'lru', maxScenes: 2 })
    scene.window(events)
    const one = scene.demand({ turns: [{ turn: 1, fromStep: 1, toStep: 6 }] })!
    const two = scene.demand({ turns: [{ turn: 5, fromStep: 1, toStep: 6 }] })!
    // Re-asking for the first makes the second the oldest.
    expect(scene.demand({ turns: [{ turn: 1, fromStep: 1, toStep: 6 }] })!.cached).toBe(true)
    const three = scene.demand({ turns: [{ turn: 9, fromStep: 1, toStep: 6 }] })!
    expect(three.cached).toBe(false)
    expect(scene.demand({ turns: [{ turn: 1, fromStep: 1, toStep: 6 }] })!.cached).toBe(true)
    expect(scene.demand({ turns: [{ turn: 5, fromStep: 1, toStep: 6 }] })!.cached).toBe(false)
    expect(one.key).not.toBe(two.key)
  })

  it('announces a new scene once, not on every lookup', () => {
    const scene = new HistoryScene({ sessionId: 'notify' })
    scene.window(events)
    let announcements = 0
    const stop = scene.subscribe(() => { announcements += 1 })
    scene.demand({ turns: [{ turn: 3, fromStep: 1, toStep: 6 }] })
    const after = announcements
    scene.demand({ turns: [{ turn: 3, fromStep: 2, toStep: 6 }] })
    expect(after).toBe(1)
    expect(announcements).toBe(1)
    scene.demand({ turns: [{ turn: 15, fromStep: 1, toStep: 6 }] })
    expect(announcements).toBe(2)
    stop()
    scene.demand({ turns: [{ turn: 18, fromStep: 1, toStep: 6 }] })
    expect(announcements).toBe(2)
  })

  it('says so when the window holds nothing to replay', () => {
    const scene = new HistoryScene({ sessionId: 'empty' })
    expect(scene.demand({ turns: [{ turn: 1, fromStep: 1, toStep: 2 }] })).toBeUndefined()
    scene.window([])
    expect(scene.demand({ turns: [{ turn: 1, fromStep: 1, toStep: 2 }] })).toBeUndefined()
    expect(scene.scene).toBeUndefined()
  })
})


/**
 * What the board asks for, and when it asks for more history.
 *
 * The board is a viewport and the scene is a step range; this is the translation between them,
 * kept pure so it can be asserted without a DOM. Two mistakes are worth a test each: asking for
 * too little (a brick on screen stays untyped), and asking differently for every row of scroll
 * (a replay per wheel notch, and a scene that never settles).
 */
describe('planning a scene from the viewport', () => {
  const metrics = (columns: number, rows: number): BoardMetrics => ({ width: BRICK_W, height: BRICK_H, gap: GAP, columns, rows })
  const board = (length: number, steps: number, endStep = 40): BoardColumn[] => Array.from({ length }, (_, index) => ({
    turn: index + 1,
    ended: index !== length - 1,
    bricks: Array.from({ length: steps }, (_, row) => ({
      turn: index + 1,
      step: endStep + row,
      tone: 'good' as const,
      label: '99.2%',
      kind: 'tool' as const,
      target: { kind: 'assistant-step' as const, turn: index + 1, step: endStep + row },
    })),
  }))

  it('asks for the screen plus one screen of overscan on each side', () => {
    const columns = board(20, 10)
    // A ten-column window showing the last ten Turns of twenty.
    const window = boardWindow(columns, metrics(10, 6), undefined, false)
    const plan = scenePlanOf(columns, window, metrics(10, 6))
    expect(window.older).toBe(10)
    expect(plan.older).toBe(10)
    // Turns 1..20: the ten on screen, one screen of overscan to the left, none to the right.
    expect(plan.demand.turns.map((turn) => turn.turn)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
    // The window rises to keep the running Turn's top brick in frame (rows 4..9 of a ten-brick
    // column), and the demand reaches three rows further up and three past the top — the last
    // of which the column does not have, so it is clamped to the brick that exists.
    expect(plan.demand.turns[0]!.fromStep).toBe(41)
    expect(plan.demand.turns[0]!.toStep).toBe(49)
  })

  it('keeps one key while the reader scrolls inside a page', () => {
    const columns = board(4, 40, 1)
    const first = scenePlanOf(columns, boardWindow(columns, metrics(4, 6), { back: 0, up: 20 }, false), metrics(4, 6))
    const second = scenePlanOf(columns, boardWindow(columns, metrics(4, 6), { back: 0, up: 21 }, false), metrics(4, 6))
    // A one-row scroll stays inside the same scene: no replay, no re-render.
    expect(second.key).toBe(first.key)
    const far = scenePlanOf(columns, boardWindow(columns, metrics(4, 6), { back: 0, up: 40 }, false), metrics(4, 6))
    expect(far.key).not.toBe(first.key)
  })

  it('asks for a short column\'s top brick rather than nothing', () => {
    const columns: BoardColumn[] = [
      { turn: 1, ended: true, bricks: [] },
      { turn: 2, ended: true, bricks: [{ turn: 2, step: 7, tone: 'good', label: '99%', kind: 'tool', target: { kind: 'assistant-step', turn: 2, step: 7 } }] },
    ]
    // A window raised well above both columns: the tall column has nothing to offer, the short
    // one still gets asked for its top brick so scrolling up finds it typed.
    const window = boardWindow(columns, metrics(2, 3), { back: 0, up: 20 }, false)
    const plan = scenePlanOf(columns, window, metrics(2, 3))
    expect(plan.demand.turns).toEqual([{ turn: 2, fromStep: 7, toStep: 7 }])
  })

  it('leaves the auxiliary lane out of history', () => {
    const columns: BoardColumn[] = [
      { turn: 0, ended: true, bricks: [{ turn: 0, step: 0, tone: 'good', label: 'n/a', kind: 'auxiliary', target: { kind: 'none' } }] },
      ...board(2, 3, 1),
    ]
    const window = boardWindow(columns, metrics(3, 4), undefined, false)
    expect(scenePlanOf(columns, window, metrics(3, 4)).demand.turns.map((turn) => turn.turn)).toEqual([1, 2])
  })

  it('plans an empty scene for an empty board instead of throwing', () => {
    const window = boardWindow([], metrics(4, 6), undefined, false)
    const plan = scenePlanOf([], window, metrics(4, 6))
    expect(plan.demand.turns).toEqual([])
    expect(plan.key).toBe('empty')
  })
})

/**
 * When to ask the session for more history.
 *
 * The question is about the *loaded* history, not about the pan: a board showing everything it
 * holds is at the left edge whether or not there is anything to pan to.
 */
describe('when more history is due', () => {
  const metrics = (columns: number, rows: number): BoardMetrics => ({ width: BRICK_W, height: BRICK_H, gap: GAP, columns, rows })
  const columns = (length: number): BoardColumn[] => Array.from({ length }, (_, index) => ({
    turn: index + 1,
    ended: index !== length - 1,
    bricks: [{ turn: index + 1, step: 1, tone: 'good' as const, label: '99%', kind: 'tool' as const, target: { kind: 'none' as const } }],
  }))

  it('is due when the board shows everything it holds', () => {
    const board = boardWindow(columns(3), metrics(10, 6), undefined, false)
    expect(board.older).toBe(0)
    expect(prefetchDue(board, metrics(10, 6))).toBe(true)
  })

  it('is due one screen before the left edge, and not before that', () => {
    // Forty Turns against a ten-column window: two columns of history still hidden on the left
    // is inside the prefetch margin, twenty is not.
    const near = boardWindow(columns(40), metrics(10, 6), { back: 28, up: 0 }, false)
    expect(near.older).toBe(2)
    expect(prefetchDue(near, metrics(10, 6))).toBe(true)
    const middle = boardWindow(columns(40), metrics(10, 6), { back: 10, up: 0 }, false)
    expect(middle.older).toBe(20)
    expect(prefetchDue(middle, metrics(10, 6))).toBe(false)
  })
})
