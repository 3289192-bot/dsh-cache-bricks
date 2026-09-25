import { describe, expect, it, vi } from 'vitest'
import { installCollector, type HostContextLike } from '../src/host/collect'
import { createCacheBricksRouter, type RouteRequestLike, type RouteResponseLike } from '../src/host/routes'

/** A response fake that records what the router did. */
function fakeResponse(): RouteResponseLike & { body: string; headers: Record<string, string>; status?: number; events: string[] } {
  const headers: Record<string, string> = {}
  const state = {
    statusCode: 0,
    headers,
    body: '',
    events: [] as string[],
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
      return undefined
    },
    writeHead(status: number, extra: Record<string, string>) {
      state.statusCode = status
      for (const [name, value] of Object.entries(extra)) headers[name.toLowerCase()] = value
      return undefined
    },
    write(chunk: string) {
      state.events.push(chunk)
      return undefined
    },
    end(body?: string) {
      if (body !== undefined) state.body = body
      return undefined
    },
    on() {
      return undefined
    },
  }
  return state
}

/** A request fake. */
function fakeRequest(url: string, method = 'GET', headers: Record<string, string> = {}): RouteRequestLike {
  return { method, url, headers: { host: '127.0.0.1:18090', ...headers }, socket: { remoteAddress: '127.0.0.1' } }
}

describe('the route namespace', () => {
  const deps = {
    feed: (sessionId: string) => (sessionId === 's1' ? { sessionId, bricks: [], store: { blobs: 0, bytes: 0 } } : undefined),
    sessions: () => ['s1'],
    blob: (ref: string) => (ref === 'abc' ? { value: 1 } : undefined),
    subscribe: () => () => undefined,
  }

  it('serves the sessions and the feed of one session', () => {
    const { handler, path } = createCacheBricksRouter(deps)
    expect(path).toBe('/cache-bricks')
    const sessions = fakeResponse()
    handler(fakeRequest('/cache-bricks/sessions'), sessions)
    expect(JSON.parse(sessions.body)).toEqual({ sessions: ['s1'] })

    const feed = fakeResponse()
    handler(fakeRequest('/cache-bricks/attempts?sessionId=s1'), feed)
    expect(feed.statusCode).toBe(200)
    expect(JSON.parse(feed.body).sessionId).toBe('s1')
  })

  it('says 404 rather than inventing a feed for an unobserved session', () => {
    const { handler } = createCacheBricksRouter(deps)
    const response = fakeResponse()
    handler(fakeRequest('/cache-bricks/attempts?sessionId=nope'), response)
    expect(response.statusCode).toBe(404)
  })

  it('requires a session id and refuses an unknown route', () => {
    const { handler } = createCacheBricksRouter(deps)
    const missing = fakeResponse()
    handler(fakeRequest('/cache-bricks/attempts'), missing)
    expect(missing.statusCode).toBe(400)
    const unknown = fakeResponse()
    handler(fakeRequest('/cache-bricks/nope'), unknown)
    expect(unknown.statusCode).toBe(404)
  })

  it('resolves a blob by ref and reports an evicted one', () => {
    const { handler } = createCacheBricksRouter(deps)
    const ok = fakeResponse()
    handler(fakeRequest('/cache-bricks/blob?ref=abc'), ok)
    expect(JSON.parse(ok.body)).toEqual({ ref: 'abc', value: { value: 1 } })
    const gone = fakeResponse()
    handler(fakeRequest('/cache-bricks/blob?ref=zzz'), gone)
    expect(gone.statusCode).toBe(404)
  })

  it('honours a configured base path instead of slicing a hardcoded one', () => {
    const { handler, path } = createCacheBricksRouter(deps, { basePath: '/badge/v2' })
    expect(path).toBe('/badge/v2')
    const response = fakeResponse()
    handler(fakeRequest('/badge/v2/sessions'), response)
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ sessions: ['s1'] })
  })

  it('defers to the harness request policy when one is available', () => {
    const seen: unknown[] = []
    const { handler } = createCacheBricksRouter(deps, {
      guard: (request) => {
        seen.push(request)
        return 401
      },
    })
    const response = fakeResponse()
    handler(fakeRequest('/cache-bricks/sessions'), response)
    expect(seen).toHaveLength(1)
    expect(response.statusCode).toBe(401)
  })

  it('treats an unidentifiable peer as remote, not as local', () => {
    const { handler } = createCacheBricksRouter(deps)
    const response = fakeResponse()
    handler({ method: 'GET', url: '/cache-bricks/sessions', headers: { host: '127.0.0.1:18090' } }, response)
    expect(response.statusCode).toBe(403)
  })

  it('refuses anything that is not a local, same-origin GET', () => {
    const { handler } = createCacheBricksRouter(deps)
    const remote = fakeResponse()
    handler({ ...fakeRequest('/cache-bricks/sessions'), socket: { remoteAddress: '10.0.0.9' } }, remote)
    expect(remote.statusCode).toBe(403)

    const crossOrigin = fakeResponse()
    handler(fakeRequest('/cache-bricks/sessions', 'GET', { origin: 'https://evil.example' }), crossOrigin)
    expect(crossOrigin.statusCode).toBe(403)

    const posted = fakeResponse()
    handler(fakeRequest('/cache-bricks/sessions', 'POST'), posted)
    expect(posted.statusCode).toBe(405)

    // A same-origin Origin header (what the page itself sends) is allowed.
    const sameOrigin = fakeResponse()
    handler(fakeRequest('/cache-bricks/sessions', 'GET', { origin: 'http://127.0.0.1:18090' }), sameOrigin)
    expect(sameOrigin.statusCode).toBe(200)
  })

  it('opens an SSE stream with the right headers and pushes the current feed', () => {
    const { handler } = createCacheBricksRouter(deps)
    const response = fakeResponse()
    handler(fakeRequest('/cache-bricks/stream?sessionId=s1'), response)
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(response.headers['cache-control']).toContain('no-transform')
    expect(response.events.join('')).toContain('event: feed')
  })
})

/** A context fake that captures listeners and services. */
function fakeContext(services: Record<string, unknown> = {}): {
  ctx: HostContextLike
  listeners: Map<string, (...args: unknown[]) => unknown>
  effects: number
} {
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const state = { effects: 0 }
  const ctx: HostContextLike = {
    on(name, listener) {
      listeners.set(name, listener as (...args: unknown[]) => unknown)
      return undefined
    },
    get(name) {
      return services[name]
    },
    inject(_names, callback) {
      callback(ctx)
      return undefined
    },
    effect(callback) {
      const dispose = callback()
      state.effects += 1
      return dispose
    },
  }
  return { ctx, listeners, get effects() { return state.effects } }
}

/** A frozen loop-built request, as the agent loop hands it to the waterfall. */
function frozenRequest(overrides: Record<string, unknown> = {}): unknown {
  return Object.freeze({
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    messages: Object.freeze([
      Object.freeze({ id: 'm1', role: 'user', content: Object.freeze([{ type: 'text', text: 'hi' }]), source: Object.freeze({ kind: 'user' }) }),
    ]),
    sessionId: 's1',
    signal: new AbortController().signal,
    ...overrides,
  })
}

describe('the collector tap on the model-call path', () => {
  it('returns the downstream stream untouched, so the request is not changed', () => {
    const { ctx, listeners } = fakeContext()
    installCollector(ctx, { serve: false })
    const tap = listeners.get('llm/stream')!
    const stream = { marker: 'the real adapter stream' }
    const next = vi.fn(() => stream)
    const returned = tap(frozenRequest(), next)
    expect(next).toHaveBeenCalledTimes(1)
    // Identity, not equality: anything else would replace the model's stream.
    expect(returned).toBe(stream)
  })

  it('still returns next() when its own observation throws', () => {
    const { ctx, listeners } = fakeContext()
    installCollector(ctx, { serve: false })
    const tap = listeners.get('llm/stream')!
    // A hostile request object that throws on every property read.
    const broken = new Proxy({}, { get() { throw new Error('boom') }, ownKeys() { throw new Error('boom') } })
    const stream = { marker: 'stream' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const returned = tap(broken as unknown, () => stream)
    warn.mockRestore()
    expect(returned).toBe(stream)
  })

  it('never writes to the request it observes', () => {
    const { ctx, listeners } = fakeContext()
    installCollector(ctx, { serve: false })
    const request = frozenRequest()
    const tap = listeners.get('llm/stream')!
    // A frozen object throws on assignment in strict mode; reaching the end is
    // the assertion.
    expect(() => tap(request, () => ({}))).not.toThrow()
    expect(Object.isFrozen(request)).toBe(true)
  })

  it('folds a whole attempt into a brick, and a retry into a second one', () => {
    const { ctx, listeners } = fakeContext()
    const collector = installCollector(ctx, { serve: false })
    const stream = listeners.get('llm/stream')!
    const frames = listeners.get('agent/assistant-stream')!
    const events = listeners.get('session/event')!
    const agent = { session: { id: 's1' } }

    events('session/event' === '' ? undefined : { id: 's1' }, {
      type: 'request/header',
      seq: 300,
      data: { reason: 'initial', header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, tools: [{ name: 'read' }] } },
    })

    // Attempt 0 fails.
    stream(frozenRequest(), () => ({}))
    frames({ agent, frame: { type: 'start', attemptId: 's1:1', revision: 1, turn: 5, step: 3 } })
    frames({ agent, frame: { type: 'chunk', time: 1000, chunk: { type: 'usage', usage: { inputTokens: 400, outputTokens: 5, cacheReadTokens: 0 } } } })
    frames({ agent, frame: { type: 'chunk', time: 1010, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'rate_limit' } } } } })
    frames({ agent, frame: { type: 'end', revision: 2, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 301 } } })
    events({ id: 's1' }, {
      type: 'llm/retry',
      // The real `LlmRetryEventData` names the attempt being replaced; the collector is not
      // allowed to guess which draft that is.
      data: { retryId: 'r1', turn: 5, step: 3, provider: 'deepseek-official', mode: 'normal', policyKey: 'k', retry: 1, maxRetries: 3, delayMs: 1000, failure: { message: 'rate limited', code: 'rate_limit' } },
    })

    // Attempt 1 succeeds with a cached prefix.
    stream(frozenRequest(), () => ({}))
    frames({ agent, frame: { type: 'start', attemptId: 's1:2', revision: 3, turn: 5, step: 3 } })
    const firstTokenAt = Date.now() + 150
    frames({ agent, frame: { type: 'chunk', time: firstTokenAt, chunk: { type: 'reasoning-delta', text: 'think' } } })
    frames({ agent, frame: { type: 'chunk', time: 2100, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 200_000 } } } })
    frames({ agent, frame: { type: 'chunk', time: 2110, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } } })
    events({ id: 's1' }, { type: 'tool/call', seq: 302, time: 2120, data: { callId: 'c1', name: 'read', arguments: '{"path":"a"}' } })
    frames({ agent, frame: { type: 'end', revision: 4, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 303 } } })
    events({ id: 's1' }, { type: 'tool/result', time: 2500, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false } } })

    const feed = collector.feed('s1')!
    expect(feed.bricks).toHaveLength(2)
    const [failed, retried] = feed.bricks
    expect(failed!.settlement).toBe('attempt')
    expect(failed!.finish?.reason).toBe('error')
    expect(failed!.retry?.maxRetries).toBe(3)
    expect(retried!.settlement).toBe('message')
    expect(retried!.identity.attemptOrdinal).toBe(1)
    expect(retried!.metrics.promptTokens).toBe(200_100)
    // TTFT is dispatch → first token, so it lands near the 150ms we waited after dispatch.
    expect(retried!.metrics.ttftMs).toBeGreaterThanOrEqual(150)
    expect(retried!.metrics.ttftMs).toBeLessThan(1000)
    expect(retried!.request.toolsHash).toBeTruthy()
    expect(retried!.request.headerReason).toBe('initial')
    expect(retried!.tools[0]?.name).toBe('read')
    expect(retried!.tools[0]?.resultAt).toBe(2500)
    expect(feed.store.blobs).toBeGreaterThan(0)
  })

  it('reads the context snapshot from the meter and the projections at dispatch', () => {
    const measured: unknown[] = []
    const services = {
      sessions: { get: (id: string) => (id === 's1' ? { id: 's1', requestHeader: () => ({ config: {} }) } : undefined) },
      tokenMeter: {
        measure: (session: unknown) => {
          measured.push(session)
          return {
            baseline: { kind: 'usage', tokens: 317_464 },
            surfaceDeltaTokens: 2947,
            totalTokens: 320_411,
            surfaceTokens: 317_229,
            nodes: [{ seq: 1 }, { seq: 2 }],
          }
        },
      },
      sessionProjections: {
        stateOf: (_session: unknown, key: string) => (key === 'contextPressure'
          ? { contextWindow: 1_000_000, pressureTokens: 317_464, surfaceTokens: 317_229, sampledSurfaceTokens: 314_282 }
          : { systemTokens: 18_344, toolsTokens: 31_221, messageTokens: 274_661 }),
      },
    }
    const { ctx, listeners } = fakeContext(services as Record<string, unknown>)
    const collector = installCollector(ctx, { serve: false })
    listeners.get('llm/stream')!(frozenRequest(), () => ({}))
    listeners.get('agent/assistant-stream')!({ agent: { session: { id: 's1' } }, frame: { type: 'start', turn: 1, step: 1 } })
    listeners.get('agent/assistant-stream')!({
      agent: { session: { id: 's1' } },
      frame: { type: 'chunk', time: 5, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 } } },
    })
    const [brick] = collector.feed('s1')!.bricks
    expect(measured).toHaveLength(1)
    expect(brick!.context?.contextWindow).toBe(1_000_000)
    expect(brick!.context?.pressureTokens).toBe(317_464)
    // projectedTokens = pressure + surface - sampledSurface
    expect(brick!.context?.projectedTokens).toBe(317_464 + 317_229 - 314_282)
    expect(brick!.context?.systemTokens).toBe(18_344)
    expect(brick!.context?.baselineKind).toBe('usage')
    expect(brick!.context?.nodeCount).toBe(2)
    expect(brick!.context?.meterRef).toBeTruthy()
    expect(collector.blob(brick!.context!.meterRef!)).toBeTruthy()
  })

  it('registers its routes through webServer, and stays inert without one', () => {
    const registered: { kind: string; path: string }[] = []
    const services = { webServer: { register: (route: { kind: string; path: string }) => { registered.push(route); return () => undefined } } }
    const withServer = fakeContext(services as Record<string, unknown>)
    installCollector(withServer.ctx)
    expect(registered).toHaveLength(1)
    expect(registered[0]!.path).toBe('/cache-bricks')
    expect(registered[0]!.kind).toBe('prefix')

    let injected = 0
    const noServer: HostContextLike = {
      on: () => undefined,
      get: () => undefined,
      inject(_names, callback) {
        injected += 1
        callback(noServer)
        return undefined
      },
      effect: () => undefined,
    }
    expect(() => installCollector(noServer)).not.toThrow()
    expect(injected).toBe(1)
  })

  it('pushes a new feed to subscribers as bricks arrive', async () => {
    const { ctx, listeners } = fakeContext()
    const collector = installCollector(ctx, { serve: false })
    const seen: number[] = []
    const unsubscribe = collector.subscribe('s1', (feed) => seen.push(feed.bricks.length))
    listeners.get('llm/stream')!(frozenRequest(), () => ({}))
    listeners.get('agent/assistant-stream')!({ agent: { session: { id: 's1' } }, frame: { type: 'start', turn: 1, step: 1 } })
    listeners.get('agent/assistant-stream')!({
      agent: { session: { id: 's1' } },
      frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } },
    })
    // Sends are coalesced to one per 100 ms, so the state after the final
    // observation arrives on the trailing timer rather than inline — and it only
    // arrives while the subscriber is still attached.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)).toBe(1)
    unsubscribe()
  })

  it('observes an auxiliary call through a pass-through wrapper', async () => {
    const { ctx, listeners } = fakeContext()
    const collector = installCollector(ctx, { serve: false })
    const tap = listeners.get('llm/stream')!
    const chunks = [
      { type: 'text-delta', index: 0, text: 'compacted summary' },
      { type: 'usage', usage: { inputTokens: 520_000, outputTokens: 300, cacheReadTokens: 1000 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    async function* upstream() {
      for (const chunk of chunks) yield chunk
    }
    const request = { ...frozenRequest() as object, purpose: 'compaction' }
    const returned = tap(request, () => upstream())

    // The wrapper is not the same object (it has to be iterated to be observed),
    // but it must deliver exactly the same chunks, in order, unmodified.
    expect(returned).not.toBe(upstream)
    const seen: unknown[] = []
    for await (const chunk of returned as AsyncIterable<unknown>) seen.push(chunk)
    expect(seen).toEqual(chunks)

    const [brick] = collector.feed('s1')!.bricks
    expect(brick?.identity.turn).toBe(0)
    expect(brick?.route.purpose).toBe('compaction')
    expect(brick?.metrics.textChars).toBe('compacted summary'.length)
    expect(brick?.metrics.promptTokens).toBe(521_000)
    expect(brick?.finish?.reason).toBe('stop')
    // Its end is observed by the wrapper, so it settles rather than hanging.
    expect(brick?.settlement).toBe('message')
  })

  it('does not wake the browser for token-level deltas', async () => {
    const { ctx, listeners } = fakeContext()
    const collector = installCollector(ctx, { serve: false })
    const seen: number[] = []
    collector.subscribe('s1', (feed) => seen.push(feed.bricks.length))
    const stream = listeners.get('llm/stream')!
    const frames = listeners.get('agent/assistant-stream')!
    const agent = { session: { id: 's1' } }
    stream(frozenRequest(), () => ({}))
    frames({ agent, frame: { type: 'start', turn: 1, step: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 150))
    const afterStart = seen.length
    // 1500 deltas must not become 1500 feeds.
    for (let index = 0; index < 1500; index += 1) {
      frames({ agent, frame: { type: 'chunk', time: index, chunk: { type: 'text-delta', index: 0, text: 'x' } } })
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(seen.length).toBe(afterStart)
  })
})
