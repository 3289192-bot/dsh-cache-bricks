import { describe, expect, it } from 'vitest'
import { BlobStore } from '../src/core/blob-store'
import { BrickLedger, type Observation } from '../src/core/brick-ledger'
import {
  RequestSummarizer,
  chunkObservation,
  contextObservation,
  finishFromStream,
  finishOf,
  headerObservation,
  retryObservation,
  settlementObservation,
  stableJson,
  toolCallObservation,
  toolResultObservation,
  usageFromStream,
  type ChunkLike,
  type StreamRecordLike,
} from '../src/core/observe'

/** A durable message as the runtime hands it over. */
function message(id: string, text: string): { id: string; role: string; content: unknown; source: unknown } {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

describe('RequestSummarizer', () => {
  it('reports how much of the message prefix is shared with the previous request', () => {
    const store = new BlobStore()
    const summarizer = new RequestSummarizer(store)
    const first = summarizer.summarize({
      provider: 'p',
      model: 'm',
      messages: [message('a', 'one'), message('b', 'two')],
    })
    expect(first.messageCount).toBe(2)
    // The first request of a session shares nothing with a predecessor.
    expect(first.sharedMessagePrefix).toBe(0)

    const second = summarizer.summarize({
      provider: 'p',
      model: 'm',
      messages: [message('a', 'one'), message('b', 'two'), message('c', 'three')],
    })
    expect(second.sharedMessagePrefix).toBe(2)
    expect(second.messageCount).toBe(3)
    expect(second.messagesHash).not.toBe(first.messagesHash)
  })

  it('measures the prefix against the previous request of the same kind, not an auxiliary prompt', () => {
    const summarizer = new RequestSummarizer(new BlobStore())
    const turn = summarizer.summarize({ provider: 'p', model: 'm', messages: [message('a', 'one'), message('b', 'two')] })
    // A session-title call runs between two Turn requests, on a prompt of its own.
    const title = summarizer.summarize({
      provider: 'p',
      model: 'm',
      messages: [{ id: 't1', role: 'user', content: [{ type: 'text', text: 'name this session' }], source: {} }],
      purpose: 'session-title',
    })
    const next = summarizer.summarize({
      provider: 'p',
      model: 'm',
      messages: [message('a', 'one'), message('b', 'two'), message('c', 'three')],
    })
    expect(turn.sharedMessagePrefix).toBe(0)
    expect(title.sharedMessagePrefix).toBe(0)
    // Measured against the previous Turn request: the real surviving prefix, not the 0 the
    // unrelated title prompt would have produced (which the diff would repeat as a verdict).
    expect(next.sharedMessagePrefix).toBe(2)
  })

  it('detects an edit inside the prefix rather than at its end', () => {
    const summarizer = new RequestSummarizer(new BlobStore())
    summarizer.summarize({ provider: 'p', model: 'm', messages: [message('a', 'one'), message('b', 'two')] })
    const edited = summarizer.summarize({
      provider: 'p',
      model: 'm',
      messages: [message('a', 'one'), message('b', 'TWO EDITED')],
    })
    expect(edited.sharedMessagePrefix).toBe(1)
  })

  it('gives identical requests identical refs and stores one copy', () => {
    const store = new BlobStore()
    const summarizer = new RequestSummarizer(store)
    const request = { provider: 'p', model: 'm', messages: [message('a', 'one')], tools: [{ name: 'read' }] }
    const first = summarizer.summarize(request)
    const second = summarizer.summarize({ ...request, messages: [message('a', 'one')] })
    expect(second.requestRef).toBe(first.requestRef)
    expect(second.toolsHash).toBe(first.toolsHash)
    expect(second.messagesStored).toBe(0)
  })

  it('stores only the messages a request did not share, not the whole history', () => {
    // The live instance showed the failure this prevents: six 420k-token requests
    // had grown the store to 10 MB, because the message array was stored per
    // request even though 523 of 525 messages were identical.
    const store = new BlobStore()
    const summarizer = new RequestSummarizer(store)
    const history = Array.from({ length: 60 }, (_, index) => message(`m${String(index)}`, `content ${String(index)}`))
    const first = summarizer.summarize({ provider: 'p', model: 'm', messages: history })
    expect(first.messagesStored).toBe(60)
    const afterFirst = store.stats().blobs

    const grown = [...history, message('m60', 'content 60'), message('m61', 'content 61')]
    const second = summarizer.summarize({ provider: 'p', model: 'm', messages: grown })
    expect(second.sharedMessagePrefix).toBe(60)
    expect(second.messagesStored).toBe(2)
    // The second request adds exactly: two new messages, one new ref list, and
    // one new envelope (its `messageRefs` changed). Sixty shared messages cost
    // nothing — that is the whole point, and it is what the live instance was
    // failing at before this change (10 MB for six 420k-token requests).
    expect(store.stats().blobs - afterFirst).toBe(4)

    // Every message is individually readable through the ref list.
    const refs = store.get(second.messageHashesRef!) as { refs: string[] }
    expect(refs.refs).toHaveLength(62)
    expect(store.get(refs.refs[0]!)).toMatchObject({ id: 'm0' })
    expect(store.get(refs.refs[61]!)).toMatchObject({ id: 'm61' })
  })

  it('never stores the abort signal, which is not data', () => {
    const store = new BlobStore()
    const summarizer = new RequestSummarizer(store)
    const options = summarizer.summarize({
      provider: 'p',
      model: 'm',
      messages: [message('a', 'one')],
      ...{ signal: new AbortController().signal },
    })
    const stored = store.get(options.requestRef!) as Record<string, unknown>
    expect(stored).not.toBeUndefined()
    expect('signal' in stored).toBe(false)
  })

  it('hashes identity-free one-shot inputs every time instead of trusting a memo', () => {
    const summarizer = new RequestSummarizer(new BlobStore())
    const oneShot = { role: 'user', content: [{ type: 'text', text: 'x' }] }
    const first = summarizer.summarize({ provider: 'p', model: 'm', messages: [oneShot] })
    const second = summarizer.summarize({ provider: 'p', model: 'm', messages: [{ ...oneShot, content: [{ type: 'text', text: 'y' }] }] })
    expect(second.messagesHash).not.toBe(first.messagesHash)
  })
})

describe('chunkObservation', () => {
  it('counts deltas by characters and keeps the call id', () => {
    expect(chunkObservation({ type: 'text-delta', text: 'hello' })).toEqual({ type: 'text', chars: 5 })
    expect(chunkObservation({ type: 'reasoning-delta', text: 'think' })).toEqual({ type: 'reasoning', chars: 5 })
    expect(chunkObservation({ type: 'tool-call-delta', id: 'c1', name: 'read', argumentsDelta: '{"a":1}' }))
      .toEqual({ type: 'tool-call', callId: 'c1', name: 'read', argsChars: 7 })
  })

  it('carries usage and finish, and treats everything else as bookkeeping', () => {
    expect(chunkObservation({ type: 'usage', usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7 } }))
      .toEqual({ type: 'usage', usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7 } })
    expect(chunkObservation({ type: 'finish', reason: { kind: 'tool-calls' } })).toEqual({ type: 'finish', reason: 'tool-calls' })
    expect(chunkObservation({ type: 'block-start' })).toEqual({ type: 'other' })
    expect(chunkObservation({ type: 'usage' })).toEqual({ type: 'other' })
  })
})

describe('finishOf', () => {
  it('keeps the failure facts a retry decision uses', () => {
    expect(finishOf({
      kind: 'error',
      failure: { message: 'rate limited', code: 'rate_limit', status: 429, providerRetryAfterMs: 1500, requestId: 'req-9' },
    })).toEqual({
      reason: 'error',
      failure: { message: 'rate limited', code: 'rate_limit', status: 429, providerRetryAfterMs: 1500, requestId: 'req-9' },
    })
  })

  it('ignores an unknown kind rather than inventing one', () => {
    expect(finishOf({ kind: 'something-new' })).toBeUndefined()
    expect(finishOf(undefined)).toBeUndefined()
    expect(finishOf({ kind: 'aborted', failure: { message: 'x' } })).toEqual({ reason: 'aborted' })
  })
})

describe('durable records', () => {
  const stream: StreamRecordLike[] = [
    { type: 'text-chunks', time0: 10, index: 0, dt: [1, 2], texts: ['a', 'b', 'c'] },
    { type: 'chunk', time: 40, chunk: { type: 'usage', usage: { inputTokens: 2461, outputTokens: 2986, cacheReadTokens: 317_992 } } },
    { type: 'chunk', time: 41, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } }, replayState: { keep: true } } },
  ] as unknown as StreamRecordLike[]

  it('recovers usage from the stream, because assistant/attempt carries none', () => {
    expect(usageFromStream(stream)).toEqual({ inputTokens: 2461, outputTokens: 2986, cacheReadTokens: 317_992 })
  })

  it('recovers the finish reason from the stream, because the events do not carry it', () => {
    expect(finishFromStream(stream)).toEqual({ reason: 'error', failure: { message: 'boom', code: 'X' } })
    expect(finishFromStream(undefined)).toBeUndefined()
  })

  it('prefers the event usage over the stream and keeps the replay state', () => {
    const store = new BlobStore()
    const observation = settlementObservation({
      seq: 500,
      time: 1_700_000_000_000,
      data: { turn: 27, step: 6, usage: { inputTokens: 1, outputTokens: 2 }, stream },
    }, store) as Extract<Observation, { kind: 'settled' }>
    expect(observation.snapshot.usage).toEqual({ inputTokens: 1, outputTokens: 2 })
    expect(observation.snapshot.settlement).toBe('message')
    expect(observation.snapshot.seq).toBe(500)
    expect(store.get(observation.snapshot.replayRef!)).toEqual({ keep: true })
    expect(store.get(observation.snapshot.streamRef!)).toHaveLength(3)
  })

  it('falls back to the stream usage for a failed attempt', () => {
    const store = new BlobStore()
    const observation = settlementObservation({
      seq: 501,
      time: 10,
      data: { turn: 4, step: 2, stream },
    }, store) as Extract<Observation, { kind: 'settled' }>
    expect(observation.snapshot.usage?.cacheReadTokens).toBe(317_992)
    expect(observation.snapshot.finishReason).toBe('error')
  })
})

describe('header, context, retry, tools', () => {
  it('records the header reason, the adapter defaults and the tool schemas by hash', () => {
    const store = new BlobStore()
    const observation = headerObservation({
      seq: 300,
      data: {
        reason: 'change',
        startsSeries: true,
        header: {
          config: { provider: 'p', model: 'm', maxTokens: 256_000 },
          adapterDefaults: { maxTokens: true },
          tools: [{ name: 'read' }, { name: 'write' }],
        },
      },
    }, store) as Extract<Observation, { kind: 'header' }>
    expect(observation.snapshot.reason).toBe('change')
    expect(observation.snapshot.startsSeries).toBe(true)
    expect(observation.snapshot.adapterDefaults).toEqual({ maxTokens: true })
    expect(observation.snapshot.toolSchemaCount).toBe(2)
    expect(store.get(observation.snapshot.headerRef!)).toBeTruthy()
  })

  it('passes through the route and capacity of a request/context record', () => {
    const observation = contextObservation({
      data: { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 1_000_000, systemPromptUpdate: 'in-history' },
    }) as Extract<Observation, { kind: 'context' }>
    expect(observation.snapshot.contextWindow).toBe(1_000_000)
    expect(observation.snapshot.systemPromptUpdate).toBe('in-history')
    expect(contextObservation({ data: {} })).toBeUndefined()
  })

  it('keeps both retry modes, including the one without a maxRetries field', () => {
    const normal = retryObservation({
      data: { retryId: 'r1', provider: 'p', mode: 'normal', policyKey: 'k', retry: 2, maxRetries: 5, delayMs: 1500, failure: { message: 'x', code: 'y' } },
    }) as Extract<Observation, { kind: 'retry' }>
    expect(normal.snapshot.maxRetries).toBe(5)
    const always = retryObservation({ data: { retryId: 'r2', provider: 'p', mode: 'always', policyKey: 'k', retry: 1, delayMs: 0 } }) as Extract<Observation, { kind: 'retry' }>
    expect(always.snapshot.mode).toBe('always')
    expect(always.snapshot.maxRetries).toBeUndefined()
  })

  it('stores raw tool arguments and result payloads by reference', () => {
    const store = new BlobStore()
    const call = toolCallObservation({ time: 100, seq: 12, data: { callId: 'c1', name: 'read', arguments: '{"path":"a.ts"}' } }, store) as Extract<Observation, { kind: 'tool-call' }>
    expect(call.argumentsChars).toBe('{"path":"a.ts"}'.length)
    expect(store.get(call.argumentsRef!)).toBe('{"path":"a.ts"}')
    const result = toolResultObservation({
      time: 250,
      data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false } },
    }, store) as Extract<Observation, { kind: 'tool-result' }>
    expect(result.callId).toBe('c1')
    expect(store.get(result.resultRef!)).toEqual([{ type: 'text', text: 'ok' }])
  })
})

describe('end to end through the ledger, using only mapped observations', () => {
  it('produces the brick the UI will show for a retried step', () => {
    const store = new BlobStore()
    const ledger = new BrickLedger('s1', { store })
    const summarizer = new RequestSummarizer(store)
    const push = (observation: Observation | undefined): void => {
      if (observation !== undefined) ledger.observe(observation)
    }

    // Durable records land first, as they do in a real step.
    push(headerObservation({
      seq: 300,
      data: { reason: 'initial', header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, tools: [{ name: 'read' }] } },
    }, store))
    push(contextObservation({ data: { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 1_000_000 } }))

    // Attempt 0: dispatch, stream, failure, retry.
    ledger.observe({
      kind: 'dispatch',
      at: 1000,
      options: summarizer.summarize({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [message('a', 'hi')] }),
    })
    ledger.observe({ kind: 'attempt-start', at: 1000, turn: 1, step: 1, attemptId: 's1:1', revision: 1 })
    ledger.observe({ kind: 'chunk', at: 1200, chunk: chunkObservation({ type: 'usage', usage: { inputTokens: 300, outputTokens: 10, cacheReadTokens: 0 } } as ChunkLike) })
    ledger.observe({ kind: 'chunk', at: 1210, chunk: chunkObservation({ type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'rate_limit' } } } as ChunkLike) })
    ledger.observe({ kind: 'attempt-end', at: 1210, outcome: 'committed', eventType: 'assistant/attempt', seq: 301 })
    // The mapped observation keeps the identity the durable event carries: `turn`/`step`.
    push(retryObservation({ data: { retryId: 'r1', turn: 1, step: 1, provider: 'deepseek-official', mode: 'normal', policyKey: 'k', retry: 1, maxRetries: 3, delayMs: 1000, failure: { message: 'rate limited', code: 'rate_limit' } } }))

    // Attempt 1: the retry succeeds with a cached prefix.
    ledger.observe({
      kind: 'dispatch',
      at: 3000,
      options: summarizer.summarize({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [message('a', 'hi'), message('b', 'there')] }),
    })
    ledger.observe({ kind: 'attempt-start', at: 3000, turn: 1, step: 1, attemptId: 's1:2', revision: 2 })
    ledger.observe({ kind: 'chunk', at: 3200, chunk: chunkObservation({ type: 'reasoning-delta', text: 'thinking' } as ChunkLike) })
    ledger.observe({ kind: 'chunk', at: 3400, chunk: chunkObservation({ type: 'tool-call-delta', id: 'c1', name: 'read', argumentsDelta: '{"path":"a"}' } as ChunkLike) })
    ledger.observe({ kind: 'chunk', at: 4000, chunk: chunkObservation({ type: 'usage', usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 318_000 } } as ChunkLike) })
    ledger.observe({ kind: 'chunk', at: 4010, chunk: chunkObservation({ type: 'finish', reason: { kind: 'tool-calls' } } as ChunkLike) })
    push(toolCallObservation({ time: 4020, seq: 302, data: { callId: 'c1', name: 'read', arguments: '{"path":"a"}' } }, store))
    ledger.observe({ kind: 'attempt-end', at: 4030, outcome: 'committed', eventType: 'assistant/message', seq: 303 })

    const bricks = ledger.attemptsOf(1, 1)
    expect(bricks).toHaveLength(2)
    const [failed, retried] = bricks
    expect(failed!.settlement).toBe('attempt')
    expect(failed!.finish?.reason).toBe('error')
    expect(failed!.retry?.maxRetries).toBe(3)
    expect(failed!.metrics.cacheHitRatio).toBe(0)
    expect(retried!.settlement).toBe('message')
    expect(retried!.metrics.promptTokens).toBe(318_200)
    expect(retried!.metrics.ttftMs).toBe(200)
    expect(retried!.request.sharedMessagePrefix).toBe(1)
    expect(retried!.request.messageHashesRef).toBeTruthy()
    expect(retried!.tools[0]?.argumentsRef).toBeTruthy()
    expect(retried!.request.headerReason).toBe('initial')
    expect(retried!.context?.contextWindow).toBe(1_000_000)
  })
})

describe('tool history, the declaration list rc.2 made history-relative', () => {
  const tool = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name, description: name, parameters: {}, ...extra })
  const developer = (id: string): { id: string; role: string; content: unknown; source: unknown } => ({ id, role: 'developer', content: [], source: {} })

  it('hashes the effective declarations, so a tool added in history cannot pass as identical', () => {
    const store = new BlobStore()
    const summarizer = new RequestSummarizer(store)
    const base = summarizer.summarize({ provider: 'p', model: 'm', messages: [message('a', 'one')], tools: [tool('read')] })
    // The same header list, plus one tool a later developer message activated: the model can
    // call two tools, so the hash the diff blames on a prefix break has to move with it.
    const added = summarizer.summarize({
      provider: 'p',
      model: 'm',
      messages: [message('a', 'one')],
      tools: [tool('read')],
      toolHistory: { tools: [tool('read')], updates: [{ messageId: 'd1', additions: [tool('write')] }] },
    })
    expect(added.toolSchemaCount).toBe(2)
    expect(added.toolSchemaDeclared).toBe(1)
    expect(added.toolSchemaAdded).toBe(1)
    expect(added.toolsHash).not.toBe(base.toolsHash)
  })

  it('leaves a request without tool history exactly as it was', () => {
    // 0.1.6-alpha.1 and 0.1.7-rc.1 never send the field, and an rc.2 session that never
    // defers a tool sends an empty update list: both must read as the plain case, with no
    // extra record fields and the same hash as before.
    const store = new BlobStore()
    const summarizer = new RequestSummarizer(store)
    const plain = summarizer.summarize({ provider: 'p', model: 'm', messages: [], tools: [tool('read')] })
    const empty = summarizer.summarize({
      provider: 'p',
      model: 'm',
      messages: [],
      tools: [tool('read')],
      toolHistory: { tools: [tool('read')], updates: [] },
    })
    expect(empty.toolsHash).toBe(plain.toolsHash)
    expect(empty.toolSchemaCount).toBe(1)
    expect(plain.toolSchemaAdded).toBeUndefined()
    expect(plain.toolUpdateMessages).toBeUndefined()
    expect(plain.toolHistoryRef).toBeUndefined()
  })

  it('does not count or store a declaration twice when the header already lists it', () => {
    const store = new BlobStore()
    const summarizer = new RequestSummarizer(store)
    const summary = summarizer.summarize({
      provider: 'p',
      model: 'm',
      messages: [],
      tools: [tool('read'), tool('write', { deferLoading: true })],
      toolHistory: { tools: [tool('read')], updates: [{ messageId: 'd1', additions: [tool('write')] }] },
    })
    // rc.2's header already carries the complete list, so the history's addition *activates*
    // one of its entries rather than extending the set: the set did not grow, and the
    // dispatch-only flag (stripped by the adapter before the provider sees it) must not move
    // the hash either.
    expect(summary.toolSchemaCount).toBe(2)
    expect(summary.toolSchemaAdded).toBeUndefined()
    expect(summary.toolSchemaActivated).toBe(1)
    expect(summary.deferredToolCount).toBe(1)
    const sameSet = summarizer.summarize({ provider: 'p', model: 'm', messages: [], tools: [tool('read'), tool('write')] })
    expect(summary.toolsHash).toBe(sameSet.toolsHash)
    // And the stored list holds each tool once, without the engine's bookkeeping flag.
    const envelope = store.get(summary.requestRef!) as { toolsRef?: string }
    const stored = store.get(envelope.toolsRef!) as { tools: Record<string, unknown>[] }
    expect(stored.tools.map((entry) => entry.name)).toEqual(['read', 'write'])
    expect(stored.tools[1]!.deferLoading).toBeUndefined()
  })

  it('counts deferred declarations, developer messages and the updates that changed tools', () => {
    const store = new BlobStore()
    const summarizer = new RequestSummarizer(store)
    const summary = summarizer.summarize({
      provider: 'p',
      model: 'm',
      messages: [message('a', 'one'), developer('d1')],
      tools: [tool('read'), tool('write', { deferLoading: true })],
      toolHistory: { tools: [tool('read')], updates: [{ messageId: 'd1', additions: [tool('write')] }] },
    })
    expect(summary.deferredToolCount).toBe(1)
    expect(summary.developerMessageCount).toBe(1)
    expect(summary.toolUpdateMessages).toBe(1)
    expect(summary.toolSchemaActivated).toBe(1)
    expect(summary.toolSchemaAdded).toBeUndefined()
    // The history is kept verbatim, so the additions can be read back rather than inferred.
    expect(summary.toolHistoryRef).toBeTruthy()
    expect(store.get(summary.toolHistoryRef!)).toMatchObject({ updates: [{ messageId: 'd1' }] })
  })
})

describe('stableJson', () => {
  it('sorts keys so two equal payloads hash equally, and drops the signal', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }))
    expect(stableJson({ a: 1, signal: 'ignored' })).toBe('{"a":1}')
  })
})
