import { describe, expect, it } from 'vitest'
import { BrickLedger, type Observation } from '../src/host/brick-ledger'
import { BlobStore } from '../src/host/blob-store'
import type { BrickRecord } from '../src/shared/brick'

/** A request that cached a large prefix. */
const HEALTHY_USAGE = {
  inputTokens: 2461,
  outputTokens: 2986,
  cacheReadTokens: 317_992,
  cacheWriteTokens: 0,
  reasoningTokens: 1421,
}

/** The same step after the prefix broke: everything is uncached input. */
const REBUILD_USAGE = { inputTokens: 321_844, outputTokens: 118, cacheReadTokens: 0 }

/** Feed a whole healthy attempt, ending in a committed message. */
function healthyAttempt(ledger: BrickLedger, turn: number, step: number, base = 0): void {
  const script: Observation[] = [
    {
      kind: 'header',
      snapshot: {
        seq: 300,
        reason: 'initial',
        headerHash: 'hdr-a',
        toolsHash: 'tools-a',
        systemHash: 'sys-a',
        toolSchemaCount: 21,
        adapterDefaults: { maxTokens: true },
      },
    },
    { kind: 'context', snapshot: { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 1_000_000 } },
    {
      kind: 'pressure',
      snapshot: {
        contextWindow: 1_000_000,
        pressureTokens: 317_464,
        projectedTokens: 320_411,
        surfaceTokens: 317_229,
        surfaceDeltaTokens: 2947,
        baselineKind: 'usage',
        baselineTokens: 317_464,
        nodeCount: 273,
        systemTokens: 18_344,
        toolsTokens: 31_221,
        messageTokens: 274_661,
        meterRef: 'meter-1',
      },
    },
    {
      kind: 'dispatch',
      at: 1000 + base,
      options: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
        maxTokens: 256_000,
        messageCount: 273,
        toolSchemaCount: 21,
        toolsHash: 'tools-a',
        systemHash: 'sys-a',
        requestRef: 'req-1',
      },
    },
    { kind: 'attempt-start', at: 1000 + base, turn, step, attemptId: `${String(turn)}:${String(step)}:7`, revision: 1 },
    { kind: 'chunk', at: 1100 + base, chunk: { type: 'other' } },
    { kind: 'chunk', at: 2410 + base, chunk: { type: 'reasoning', chars: 4210 } },
    { kind: 'chunk', at: 2500 + base, chunk: { type: 'text', chars: 8112 } },
    { kind: 'chunk', at: 2600 + base, chunk: { type: 'tool-call', callId: 'call-1', name: 'read', argsChars: 120 } },
    { kind: 'chunk', at: 35_150 + base, chunk: { type: 'usage', usage: HEALTHY_USAGE } },
    { kind: 'chunk', at: 35_200 + base, chunk: { type: 'finish', reason: 'tool-calls' } },
    { kind: 'attempt-end', at: 35_200 + base, outcome: 'committed', eventType: 'assistant/message', seq: 500 + base },
    {
      kind: 'settled',
      snapshot: {
        seq: 500 + base,
        time: 1_700_000_000_000 + base,
        settlement: 'message',
        usage: HEALTHY_USAGE,
        streamRef: 'stream-1',
      },
    },
  ]
  for (const observation of script) ledger.observe(observation)
}

describe('BrickLedger: one brick per real request attempt', () => {
  it('folds a whole healthy attempt from dispatch to settlement', () => {
    const ledger = new BrickLedger('session-1')
    healthyAttempt(ledger, 27, 6)
    const bricks = ledger.records()
    expect(bricks).toHaveLength(1)
    const brick = bricks[0]!
    expect(brick.observedBy).toBe('host')
    expect(brick.identity.turn).toBe(27)
    expect(brick.identity.step).toBe(6)
    expect(brick.identity.attemptOrdinal).toBe(0)
    expect(brick.settlement).toBe('message')
    expect(brick.settlementSeq).toBe(500)
    // Route, including the fact that maxTokens was the adapter's idea.
    expect(brick.route.provider).toBe('deepseek-official')
    expect(brick.route.reasoningEffort).toBe('max')
    expect(brick.route.maxTokensDefaulted).toBe(true)
    expect(brick.route.reasoningEffortDefaulted).toBeUndefined()
    // Cache accounting, from disjoint buckets.
    expect(brick.metrics.promptTokens).toBe(320_453)
    expect(brick.metrics.cacheHitRatio).toBeCloseTo(0.99232, 5)
    expect(brick.metrics.uncachedRatio).toBeCloseTo(2461 / 320_453, 9)
    // Timing is measured from the dispatch observation to the first token chunk.
    expect(brick.metrics.ttftMs).toBe(1410)
    expect(brick.metrics.durationMs).toBe(34_200)
    expect(brick.metrics.tps).toBeCloseTo(2986 / 32.79, 6)
    // Context was frozen at dispatch, including the heuristic split.
    expect(brick.context?.pressureTokens).toBe(317_464)
    expect(brick.context?.systemTokens).toBe(18_344)
    expect(brick.context?.nodeCount).toBe(273)
    expect(brick.metrics.contextOccupancy).toBeCloseTo(0.320453, 9)
    // Request identity, and the stream kept by reference.
    expect(brick.request.headerReason).toBe('initial')
    expect(brick.request.headerEventSeq).toBe(300)
    expect(brick.request.toolsHash).toBe('tools-a')
    expect(brick.raw.streamRef).toBe('stream-1')
    // Stream counters.
    expect(brick.metrics.chunkCount).toBe(6)
    expect(brick.metrics.reasoningChars).toBe(4210)
    expect(brick.metrics.toolCallCount).toBe(1)
    expect(brick.finish?.reason).toBe('tool-calls')
  })

  it('keeps a retry as a second brick of the same step, with the failure and the recovery', () => {
    const ledger = new BrickLedger('session-1')
    // Attempt 0: dispatched, blew the cache, failed.
    ledger.observe({ kind: 'dispatch', at: 5000, options: { provider: 'p', model: 'm', toolsHash: 'tools-a' } })
    ledger.observe({ kind: 'attempt-start', at: 5000, turn: 4, step: 2, attemptId: 'a0', revision: 1 })
    ledger.observe({ kind: 'chunk', at: 5600, chunk: { type: 'usage', usage: REBUILD_USAGE } })
    ledger.observe({
      kind: 'chunk',
      at: 5700,
      chunk: { type: 'finish', reason: 'error', failure: { message: 'rate limited', code: 'rate_limit', status: 429 } },
    })
    ledger.observe({ kind: 'attempt-end', at: 5700, outcome: 'committed', eventType: 'assistant/attempt', seq: 501 })
    ledger.observe({
      kind: 'retry',
      snapshot: {
        retryId: 'retry-1',
        turn: 4,
        step: 2,
        provider: 'p',
        mode: 'normal',
        policyKey: 'policy',
        retry: 1,
        maxRetries: 3,
        delayMs: 1500,
        failureMessage: 'rate limited',
        failureCode: 'rate_limit',
      },
    })
    // Attempt 1: the retry, which cached fine and answered.
    healthyAttempt(ledger, 4, 2)

    const bricks = ledger.attemptsOf(4, 2)
    expect(bricks).toHaveLength(2)
    const [first, second] = bricks as [BrickRecord, BrickRecord]
    expect(first.identity.attemptOrdinal).toBe(0)
    expect(first.settlement).toBe('attempt')
    expect(first.finish?.reason).toBe('error')
    expect(first.metrics.cacheHitRatio).toBe(0)
    expect(first.retry?.retryId).toBe('retry-1')
    expect(first.retry?.maxRetries).toBe(3)
    expect(first.retry?.delayMs).toBe(1500)
    expect(second.identity.attemptOrdinal).toBe(1)
    expect(second.settlement).toBe('message')
    expect(second.metrics.cacheHitRatio).toBeCloseTo(0.99232, 5)
    expect(second.retry).toBeUndefined()
    // The retry leaves no durable record of its own, so the chain id is carried over:
    // it is what lets both bricks aim at the one row that shows the pair together.
    expect(second.retryChainId).toBe('retry-1')
  })

  it('resolves a late settlement by identity, not by being newest', () => {
    // The live frame channel and the durable event channel are two observers of one
    // attempt, and they interleave: step 3's frames can arrive while step 2's
    // settlement is still in flight. "The newest draft" would hand step 2's verdict to
    // step 3 — and with it the wrong seq, usage and retry anchor.
    const ledger = new BrickLedger('session-1')
    ledger.observe({ kind: 'dispatch', at: 100, options: { provider: 'p', model: 'm' } })
    ledger.observe({ kind: 'attempt-start', at: 100, turn: 4, step: 2, attemptId: 'a0' })
    ledger.observe({ kind: 'dispatch', at: 200, options: { provider: 'p', model: 'm' } })
    ledger.observe({ kind: 'attempt-start', at: 200, turn: 4, step: 3, attemptId: 'a1' })

    // Step 2's durable settlement arrives last.
    ledger.observe({
      kind: 'settled',
      snapshot: { seq: 500, time: 900, turn: 4, step: 2, settlement: 'message', usage: HEALTHY_USAGE },
    })

    const [second, third] = [ledger.attemptsOf(4, 2)[0]!, ledger.attemptsOf(4, 3)[0]!]
    expect(second.settlement).toBe('message')
    expect(second.settlementSeq).toBe(500)
    expect(second.usage?.cacheReadTokens).toBe(317_992)
    // Step 3 is untouched: it was never settled, and it must not inherit step 2's log.
    expect(third.settlement).toBe('running')
    expect(third.settlementSeq).toBeUndefined()
    expect(third.usage).toBeUndefined()
  })

  it('drops what it cannot attribute, counts it, and attaches it to nobody', () => {
    // The last guess is gone: a retry with no identity and a settlement for a step this
    // ledger never saw are both holes in the record, and a hole is reported — not filled
    // with whichever draft happened to be newest.
    const ledger = new BrickLedger('session-1')
    ledger.observe({ kind: 'dispatch', at: 100, options: { provider: 'p', model: 'm' } })
    ledger.observe({ kind: 'attempt-start', at: 100, turn: 6, step: 3, attemptId: 'a' })
    ledger.observe({
      kind: 'retry',
      snapshot: { retryId: 'r1', provider: 'p', mode: 'normal', policyKey: 'k', retry: 1, delayMs: 10 },
    })
    ledger.observe({ kind: 'settled', snapshot: { seq: 99, time: 300, settlement: 'message', usage: HEALTHY_USAGE } })

    expect(ledger.unattributedCount).toBe(2)
    expect(ledger.feed().unattributed).toBe(2)
    const [only] = ledger.attemptsOf(6, 3) as [BrickRecord]
    expect(only.retry).toBeUndefined()
    expect(only.usage).toBeUndefined()
    expect(only.settlementSeq).toBeUndefined()
  })

  it('resolves a late retry by identity too', () => {
    const ledger = new BrickLedger('session-1')
    ledger.observe({ kind: 'dispatch', at: 100, options: { provider: 'p', model: 'm' } })
    ledger.observe({ kind: 'attempt-start', at: 100, turn: 4, step: 2, attemptId: 'a0' })
    ledger.observe({ kind: 'dispatch', at: 200, options: { provider: 'p', model: 'm' } })
    ledger.observe({ kind: 'attempt-start', at: 200, turn: 4, step: 3, attemptId: 'a1' })
    ledger.observe({ kind: 'attempt-end', at: 300, outcome: 'abandoned' })

    ledger.observe({
      kind: 'retry',
      snapshot: {
        retryId: 'retry-9',
        turn: 4,
        step: 2,
        provider: 'p',
        mode: 'normal',
        policyKey: 'k',
        retry: 1,
        delayMs: 500,
        failureMessage: 'rate limited',
        failureCode: 'rate_limit',
      },
    })

    // The retry belongs to the attempt the event names, and the chain it opens is
    // remembered for that step only.
    expect(ledger.attemptsOf(4, 2)[0]!.retry?.retryId).toBe('retry-9')
    expect(ledger.attemptsOf(4, 3)[0]!.retry).toBeUndefined()
  })

  it('settles a step\'s attempts in the order they started, even with two in flight', () => {
    // Fixture ① of the closure bar: A start → B start → A settlement → B settlement, all
    // on one step. Both are unsettled when A's verdict arrives, so anything that picks
    // "the newest" — or "the newest still running" — hands A's usage to B.
    const ledger = new BrickLedger('session-1')
    ledger.observe({ kind: 'dispatch', at: 100, options: { provider: 'p', model: 'm' } })
    ledger.observe({ kind: 'attempt-start', at: 100, turn: 6, step: 3, attemptId: 'a' })
    ledger.observe({ kind: 'dispatch', at: 200, options: { provider: 'p', model: 'm' } })
    ledger.observe({ kind: 'attempt-start', at: 200, turn: 6, step: 3, attemptId: 'b' })

    ledger.observe({
      kind: 'settled',
      snapshot: { seq: 11, time: 500, turn: 6, step: 3, settlement: 'attempt', usage: REBUILD_USAGE },
    })
    ledger.observe({
      kind: 'settled',
      snapshot: { seq: 12, time: 600, turn: 6, step: 3, settlement: 'message', usage: HEALTHY_USAGE },
    })

    const [first, second] = ledger.attemptsOf(6, 3) as [BrickRecord, BrickRecord]
    expect(first.identity.attemptId).toBe('a')
    expect(first.settlementSeq).toBe(11)
    expect(first.usage?.cacheReadTokens).toBe(0)
    expect(first.metrics.cacheHitRatio).toBe(0)
    expect(second.identity.attemptId).toBe('b')
    expect(second.settlementSeq).toBe(12)
    expect(second.usage?.cacheReadTokens).toBe(317_992)
  })

  it('settles by the seq the live frame reported, when an earlier attempt was never settled by the log', () => {
    // The shape a retry really has, and the one FIFO alone gets wrong: attempt 0 commits an
    // `assistant/attempt` and the collector never sees that event, while attempt 1 commits
    // an `assistant/message` that it does see. Without the seq — which the end frame reports
    // — the message would be handed to the oldest unsettled attempt, i.e. the wrong brick.
    const ledger = new BrickLedger('session-1')
    ledger.observe({ kind: 'dispatch', at: 100, options: { provider: 'p', model: 'm' } })
    ledger.observe({ kind: 'attempt-start', at: 100, turn: 9, step: 4, attemptId: 'a' })
    ledger.observe({ kind: 'attempt-end', at: 150, outcome: 'committed', eventType: 'assistant/attempt', seq: 302 })
    ledger.observe({ kind: 'dispatch', at: 200, options: { provider: 'p', model: 'm' } })
    ledger.observe({ kind: 'attempt-start', at: 200, turn: 9, step: 4, attemptId: 'b' })
    ledger.observe({ kind: 'attempt-end', at: 250, outcome: 'committed', eventType: 'assistant/message', seq: 305 })

    ledger.observe({
      kind: 'settled',
      snapshot: { seq: 305, time: 900, turn: 9, step: 4, settlement: 'message', usage: HEALTHY_USAGE },
    })

    const [failed, retried] = ledger.attemptsOf(9, 4) as [BrickRecord, BrickRecord]
    expect(failed.identity.attemptId).toBe('a')
    expect(failed.usage).toBeUndefined()
    expect(failed.settlementSeq).toBe(302)
    expect(retried.identity.attemptId).toBe('b')
    expect(retried.usage?.cacheReadTokens).toBe(317_992)
    expect(retried.settlementSeq).toBe(305)
  })

  it('drops a settlement whose step has no unsettled attempt left, rather than guessing', () => {
    const ledger = new BrickLedger('session-1')
    ledger.observe({ kind: 'dispatch', at: 100, options: { provider: 'p', model: 'm' } })
    ledger.observe({ kind: 'attempt-start', at: 100, turn: 6, step: 3, attemptId: 'a' })
    ledger.observe({
      kind: 'settled',
      snapshot: { seq: 11, time: 500, turn: 6, step: 3, settlement: 'message', usage: HEALTHY_USAGE },
    })
    // A second settlement for the same step and no second attempt: attaching it to the
    // only draft would overwrite a brick that already has its own verdict.
    ledger.observe({
      kind: 'settled',
      snapshot: { seq: 12, time: 600, turn: 6, step: 3, settlement: 'message', usage: REBUILD_USAGE },
    })
    const [only] = ledger.attemptsOf(6, 3) as [BrickRecord]
    expect(only.settlementSeq).toBe(11)
    expect(only.usage?.cacheReadTokens).toBe(317_992)
  })

  it('correlates a retry with the attempt it replaces by ordinal', () => {
    const ledger = new BrickLedger('session-1')
    ledger.observe({ kind: 'dispatch', at: 100, options: { provider: 'p', model: 'm' } })
    ledger.observe({ kind: 'attempt-start', at: 100, turn: 6, step: 3, attemptId: 'a' })
    ledger.observe({ kind: 'attempt-end', at: 150, outcome: 'abandoned' })
    ledger.observe({ kind: 'dispatch', at: 200, options: { provider: 'p', model: 'm' } })
    ledger.observe({ kind: 'attempt-start', at: 200, turn: 6, step: 3, attemptId: 'b' })
    ledger.observe({ kind: 'attempt-end', at: 250, outcome: 'abandoned' })

    // `retry: 2` replaces the attempt with ordinal 1, whatever order the drafts are in.
    ledger.observe({
      kind: 'retry',
      snapshot: {
        retryId: 'retry-2',
        turn: 6,
        step: 3,
        provider: 'p',
        mode: 'normal',
        policyKey: 'k',
        retry: 2,
        delayMs: 250,
        failureMessage: 'rate limited',
        failureCode: 'rate_limit',
      },
    })

    const [first, second] = ledger.attemptsOf(6, 3) as [BrickRecord, BrickRecord]
    expect(first.retry).toBeUndefined()
    expect(second.retry?.retryId).toBe('retry-2')
  })

  it('never lets an auxiliary call take the next attempt\'s identity', () => {
    // The failure this prevents: compaction runs between steps, so a queued
    // auxiliary dispatch would be shifted by the *next* real attempt and every
    // brick after it would describe the wrong request.
    const ledger = new BrickLedger('session-1')
    ledger.observe({
      kind: 'dispatch',
      at: 100,
      options: { provider: 'p', model: 'm', purpose: 'compaction', messageCount: 40 },
    })
    ledger.observe({
      kind: 'dispatch',
      at: 200,
      options: { provider: 'deepseek-official', model: 'deepseek-v4-flash', messageCount: 12, toolsHash: 'tools-real' },
    })
    ledger.observe({ kind: 'attempt-start', at: 200, turn: 7, step: 1, attemptId: 'a1' })
    ledger.observe({ kind: 'attempt-end', at: 300, outcome: 'committed', eventType: 'assistant/message', seq: 9 })

    const bricks = ledger.records()
    expect(bricks).toHaveLength(2)
    const auxiliary = bricks.find((brick) => brick.identity.turn === 0)!
    const real = bricks.find((brick) => brick.identity.turn === 7)!
    expect(auxiliary.route.purpose).toBe('compaction')
    expect(auxiliary.route.model).toBe('m')
    expect(auxiliary.request.messageCount).toBe(40)
    // The real attempt must describe its own request, not the compaction's.
    expect(real.route.model).toBe('deepseek-v4-flash')
    expect(real.request.messageCount).toBe(12)
    expect(real.request.toolsHash).toBe('tools-real')
  })

  it('routes an auxiliary stream\'s chunks to the auxiliary brick', () => {
    const ledger = new BrickLedger('session-1')
    ledger.observe({ kind: 'dispatch', at: 1, options: { provider: 'p', model: 'm', purpose: 'session-title' } })
    ledger.observe({ kind: 'chunk', at: 2, chunk: { type: 'text', chars: 30 }, auxiliary: true })
    ledger.observe({ kind: 'chunk', at: 3, chunk: { type: 'usage', usage: { inputTokens: 900, outputTokens: 12 } }, auxiliary: true })
    ledger.observe({ kind: 'attempt-end', at: 4, outcome: 'committed', auxiliary: true })
    const [brick] = ledger.records()
    expect(brick?.identity.turn).toBe(0)
    expect(brick?.metrics.textChars).toBe(30)
    expect(brick?.metrics.promptTokens).toBe(900)
    expect(brick?.settlement).toBe('message')
  })

  it('records which Turns the log says are finished', () => {
    const ledger = new BrickLedger('session-1')
    healthyAttempt(ledger, 1, 1)
    healthyAttempt(ledger, 2, 1)
    expect(ledger.feed().endedTurns).toEqual([])
    ledger.observe({ kind: 'turn-end', turn: 1 })
    // A settled brick is not a finished Turn: its tools may still be running.
    expect(ledger.feed().endedTurns).toEqual([1])
  })

  it('records an auxiliary call that never became a Turn attempt', () => {
    const ledger = new BrickLedger('session-1')
    ledger.observe({
      kind: 'dispatch',
      at: 10,
      options: { provider: 'p', model: 'm', purpose: 'compaction', messageCount: 9 },
    })
    ledger.observe({ kind: 'flush', at: 20 })
    const [brick] = ledger.records()
    expect(brick?.identity.turn).toBe(0)
    expect(brick?.settlement).toBe('abandoned')
    expect(brick?.route.provider).toBe('p')
  })

  it('pairs a dispatch with an attempt frame that arrives first', () => {
    const ledger = new BrickLedger('session-1')
    // The frame channel can win the race with the waterfall observation.
    ledger.observe({ kind: 'attempt-start', at: 100, turn: 1, step: 1, attemptId: 'a' })
    ledger.observe({ kind: 'dispatch', at: 101, options: { provider: 'p', model: 'm' } })
    const [brick] = ledger.records()
    // The dispatch stays pending, so the brick is honest about not knowing its route.
    expect(brick?.route.provider).toBe('unknown')
    expect(ledger.feed().bricks).toHaveLength(1)
  })

  it('attaches tool results to the attempt that called the tool', () => {
    const ledger = new BrickLedger('session-1')
    healthyAttempt(ledger, 1, 1)
    ledger.observe({ kind: 'tool-result', at: 36_000, callId: 'call-1', resultChars: 4200, resultRef: 'res-1' })
    expect(ledger.records()).toHaveLength(1)
    const call = ledger.records()[0]!.tools[0]!
    expect(call.resultAt).toBe(36_000)
    expect(call.durationMs).toBe(36_000 - 2600)
    expect(call.resultRef).toBe('res-1')
  })

  it('marks a tool failure without losing the call', () => {
    const ledger = new BrickLedger('session-1')
    healthyAttempt(ledger, 1, 1)
    ledger.observe({
      kind: 'tool-result',
      at: 36_000,
      callId: 'call-1',
      isError: true,
      error: { name: 'ToolError', code: 'ENOENT' },
    })
    const call = ledger.records()[0]!.tools[0]!
    expect(call.isError).toBe(true)
    expect(call.error?.code).toBe('ENOENT')
  })

  it('says "unknown" instead of 0% when a provider reports no cache bucket', () => {
    const ledger = new BrickLedger('session-1')
    ledger.observe({ kind: 'dispatch', at: 1, options: { provider: 'p', model: 'm' } })
    ledger.observe({ kind: 'attempt-start', at: 1, turn: 2, step: 1 })
    ledger.observe({ kind: 'chunk', at: 2, chunk: { type: 'usage', usage: { inputTokens: 900, outputTokens: 10 } } })
    ledger.observe({ kind: 'attempt-end', at: 3, outcome: 'committed', eventType: 'assistant/message', seq: 7 })
    const [brick] = ledger.records()
    expect(brick?.metrics.promptTokens).toBe(900)
    expect(brick?.metrics.cacheHitRatio).toBeUndefined()
  })

  it('shares raw payloads through the store instead of copying them per brick', () => {
    const store = new BlobStore()
    const ledger = new BrickLedger('session-1', { store })
    const request = { messages: [{ role: 'user', content: 'the same 600K prefix' }], tools: ['a', 'b'] }
    const ref = store.put(request)!.hash
    for (let step = 1; step <= 5; step += 1) {
      ledger.observe({ kind: 'dispatch', at: step, options: { provider: 'p', model: 'm', requestRef: ref } })
      ledger.observe({ kind: 'attempt-start', at: step, turn: 1, step })
      ledger.observe({ kind: 'attempt-end', at: step, outcome: 'committed', eventType: 'assistant/message', seq: step })
    }
    expect(ledger.records()).toHaveLength(5)
    expect(store.stats().blobs).toBe(1)
    expect(ledger.feed().store.blobs).toBe(1)
  })

  it('stays bounded on a long session', () => {
    const ledger = new BrickLedger('session-1', { maxBricks: 3 })
    for (let step = 1; step <= 10; step += 1) {
      ledger.observe({ kind: 'dispatch', at: step, options: { provider: 'p', model: 'm' } })
      ledger.observe({ kind: 'attempt-start', at: step, turn: 1, step })
      ledger.observe({ kind: 'attempt-end', at: step, outcome: 'committed', eventType: 'assistant/message', seq: step })
    }
    const bricks = ledger.records()
    expect(bricks).toHaveLength(3)
    expect(bricks.map((brick) => brick.identity.step)).toEqual([8, 9, 10])
  })

  it('never mutates what it observed', () => {
    const ledger = new BrickLedger('session-1')
    const options = { provider: 'p', model: 'm', stop: ['x'] }
    const frozen = Object.freeze({ ...options, stop: Object.freeze(['x']) })
    ledger.observe({ kind: 'dispatch', at: 1, options: frozen })
    ledger.observe({ kind: 'attempt-start', at: 1, turn: 1, step: 1 })
    expect(ledger.records()[0]?.route.stop).toEqual(['x'])
    expect(Object.isFrozen(frozen)).toBe(true)
  })
})
