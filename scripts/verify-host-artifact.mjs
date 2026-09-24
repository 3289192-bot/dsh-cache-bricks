/**
 * Artifact-level end-to-end check for the host half.
 *
 * The unit tests exercise the collector's source; this script exercises the
 * **built** `lib/index.js` the way the loader will: import it, install it on a
 * context double, replay one session through the real event names and payload
 * shapes, then ask the registered route for the feed — the same path the browser
 * takes. It exists because the host half can only be proved live after a process
 * restart, and this narrows that gap to "the wiring is right, only the runtime
 * differs".
 *
 * Usage: `node scripts/verify-host-artifact.mjs` (run `pnpm run build` first).
 */
import { fileURLToPath, pathToFileURL } from 'node:url'

const HOST = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const HOST_URL = pathToFileURL(HOST).href

/** Failures are collected so the whole picture prints before the exit code. */
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures.push(label)
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

console.log(`host artifact: ${HOST}`)
const host = await import(HOST_URL)

// --- install on a context double -----------------------------------------
const listeners = new Map()
const routes = []
const ctx = {
  on(name, listener) {
    listeners.set(name, listener)
    return undefined
  },
  get() {
    return undefined
  },
  inject(_names, callback) {
    callback(ctx)
    return undefined
  },
  effect(callback) {
    return callback()
  },
}
const webServer = {
  register(route) {
    routes.push(route)
    return () => undefined
  },
}
// A separate context for the webserver injection, since inject() runs inline.
const webCtx = { ...ctx, get: (name) => (name === 'webServer' ? webServer : undefined) }
const originalInject = ctx.inject
ctx.inject = (names, callback) => originalInject.call(ctx, names, () => callback(webCtx))

console.log('\ninstall')
check('exports a name and apply()', typeof host.name === 'string' && typeof host.apply === 'function')
host.apply(ctx)
check('subscribes to llm/stream', listeners.has('llm/stream'))
check('subscribes to agent/assistant-stream', listeners.has('agent/assistant-stream'))
check('subscribes to session/event', listeners.has('session/event'))
check('registers exactly one route', routes.length === 1, `got ${String(routes.length)}`)
check('serves its own namespace', routes[0]?.path === '/cache-badge', routes[0]?.path)

// --- replay one session with a retried step ------------------------------
console.log('\nreplay')
const stream = listeners.get('llm/stream')
const frames = listeners.get('agent/assistant-stream')
const events = listeners.get('session/event')
const agent = { session: { id: 'verify-session' } }
const request = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'max',
  maxTokens: 256_000,
  messages: Object.freeze([
    Object.freeze({ id: 'm1', role: 'user', content: Object.freeze([{ type: 'text', text: 'hello' }]), source: Object.freeze({ kind: 'user' }) }),
  ]),
  sessionId: 'verify-session',
  signal: new AbortController().signal,
})

/**
 * The retry's request, shaped the way 0.1.7-rc.2 builds one.
 *
 * From rc.2 the loop attaches `toolHistory` to every request it builds, and a declaration may
 * be flagged `deferLoading` until a later developer message activates it. The retry below
 * therefore carries one declared tool plus one the history adds — the case where hashing only
 * the header's own list would report "tools identical" for a request the model can call more
 * tools in.
 */
const RETRY_TOOLS = Object.freeze([
  Object.freeze({ name: 'read', description: 'read a file', parameters: {} }),
  Object.freeze({ name: 'write', description: 'write a file', parameters: {}, deferLoading: true }),
])
const retryRequest = Object.freeze({
  ...request,
  tools: RETRY_TOOLS,
  toolHistory: Object.freeze({
    tools: Object.freeze([RETRY_TOOLS[0]]),
    updates: Object.freeze([
      Object.freeze({ messageId: 'd1', additions: Object.freeze([RETRY_TOOLS[1]]) }),
    ]),
  }),
  messages: Object.freeze([
    ...request.messages,
    Object.freeze({ id: 'd1', role: 'developer', content: Object.freeze([{ type: 'tool-addition', toolName: 'write' }]), source: Object.freeze({ kind: 'developer' }) }),
  ]),
})

const marker = { marker: 'the adapter stream' }
check('the tap returns the downstream stream by identity', stream(request, () => marker) === marker)
check('the tap returns the downstream stream by identity when tool history is present', stream(retryRequest, () => marker) === marker)

events({ id: 'verify-session' }, {
  type: 'request/header',
  seq: 300,
  time: Date.now(),
  data: {
    reason: 'initial',
    header: {
      config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max', maxTokens: 256_000 },
      adapterDefaults: { maxTokens: true },
      tools: [{ name: 'read', description: 'read a file', parameters: {} }],
    },
  },
})
events({ id: 'verify-session' }, {
  type: 'request/context',
  seq: 301,
  time: Date.now(),
  data: { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 1_000_000 },
})

// Attempt 0: the cache blows and the request fails.
stream(request, () => marker)
frames({ agent, frame: { type: 'start', attemptId: 'verify-session:1', revision: 1, turn: 9, step: 4 } })
frames({ agent, frame: { type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage: { inputTokens: 321_844, outputTokens: 0, cacheReadTokens: 0 } } } })
frames({ agent, frame: { type: 'chunk', time: Date.now(), chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'rate_limit', status: 429 } } } } })
frames({ agent, frame: { type: 'end', revision: 2, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 302 } } })
events({ id: 'verify-session' }, {
  type: 'llm/retry',
  seq: 303,
  time: Date.now(),
  data: { retryId: 'retry-1', turn: 9, step: 4, provider: 'deepseek-official', mode: 'normal', policyKey: 'k', retry: 1, maxRetries: 3, delayMs: 1500, failure: { message: 'rate limited', code: 'rate_limit' } },
})

// Attempt 1: the retry finds a warm prefix and answers with a tool call.
const firstTokenAt = Date.now() + 120
stream(retryRequest, () => marker)
frames({ agent, frame: { type: 'start', attemptId: 'verify-session:2', revision: 3, turn: 9, step: 4 } })
frames({ agent, frame: { type: 'chunk', time: firstTokenAt, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking about it' } } })
frames({ agent, frame: { type: 'chunk', time: Date.now(), chunk: { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'read', argumentsDelta: '{"path":"a.ts"}' } } })
frames({ agent, frame: { type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage: { inputTokens: 2461, outputTokens: 2986, cacheReadTokens: 317_992, cacheWriteTokens: 0, reasoningTokens: 1421 } } } })
frames({ agent, frame: { type: 'chunk', time: Date.now(), chunk: { type: 'finish', reason: { kind: 'tool-calls' } } } })
events({ id: 'verify-session' }, { type: 'tool/call', seq: 304, time: Date.now(), data: { turn: 9, step: 4, callId: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' } })
frames({ agent, frame: { type: 'end', revision: 4, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 305 } } })
events({ id: 'verify-session' }, {
  type: 'assistant/message',
  seq: 305,
  time: Date.now(),
  data: {
    turn: 9,
    step: 4,
    message: { id: 'a1', role: 'assistant', content: [], source: { kind: 'assistant' } },
    usage: { inputTokens: 2461, outputTokens: 2986, cacheReadTokens: 317_992, cacheWriteTokens: 0 },
    stream: [
      { type: 'reasoning-chunks', time0: firstTokenAt, index: 0, dt: [20], texts: ['thinking ', 'about it'] },
      { type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage: { inputTokens: 2461, outputTokens: 2986, cacheReadTokens: 317_992, cacheWriteTokens: 0 } } },
      { type: 'chunk', time: Date.now(), chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
    ],
  },
})
events({ id: 'verify-session' }, {
  type: 'tool/result',
  seq: 306,
  time: Date.now(),
  data: { turn: 9, step: 4, message: { toolCallId: 'call-1', content: [{ type: 'text', text: 'file contents' }], isError: false } },
})

// --- read the feed back through the registered route --------------------
console.log('\nserve')
const response = {
  statusCode: 0,
  headers: {},
  body: '',
  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value
  },
  writeHead(status, headers) {
    this.statusCode = status
    Object.assign(this.headers, headers)
  },
  write() {},
  end(body) {
    if (body !== undefined) this.body = body
  },
  on() {},
}
const request_ = {
  method: 'GET',
  url: '/cache-badge/attempts?sessionId=verify-session',
  headers: { host: '127.0.0.1:18090' },
  socket: { remoteAddress: '127.0.0.1' },
}
routes[0].handler(request_, response)
check('answers 200 for an observed session', response.statusCode === 200, String(response.statusCode))
const feed = JSON.parse(response.body)
check('returns two bricks for the retried step', feed.bricks?.length === 2, String(feed.bricks?.length))

const [failed, retried] = feed.bricks ?? []
check('the failed attempt is kept, with its failure', failed?.finish?.reason === 'error' && failed?.settlement === 'attempt')
check('the failed attempt records the retry that replaced it', failed?.retry?.retryId === 'retry-1')
// The retry leaves no durable record of its own, so the chain id is carried over by
// the ledger — that is what lets both bricks aim at the one chat row showing them.
check('the retry carries the chain id of the failure it replaced', retried?.retryChainId === 'retry-1')
check('the failed attempt reads 0% cached', failed?.metrics?.cacheHitRatio === 0)
check('the retry is a separate brick of the same step', retried?.identity?.attemptOrdinal === 1 && retried?.identity?.step === 4)
check('the retry reads a warm prefix', Math.abs((retried?.metrics?.cacheHitRatio ?? 0) - 0.99232) < 0.001)
check('prompt is the sum of the disjoint buckets', retried?.metrics?.promptTokens === 320_453)
check('TTFT is dispatch to first token', (retried?.metrics?.ttftMs ?? 0) >= 120)
check('the adapter-defaulted maxTokens is flagged', retried?.route?.maxTokensDefaulted === true)
check('the tool call is attached, with its raw arguments by ref', retried?.tools?.[0]?.argumentsRef !== undefined)
check('the tool result is attached, with a duration', retried?.tools?.[0]?.durationMs !== undefined)
check('the durable stream is kept by ref', retried?.raw?.streamRef !== undefined)
// rc.2's history-relative declaration list: the request header already lists the complete set
// (with the not-yet-activated entry flagged), and the history's addition activates one of
// them — so the set must be counted once, and the activation reported as an activation.
check('the effective declaration list is counted once, not twice',
  retried?.request?.toolSchemaCount === 2 && retried?.request?.toolSchemaActivated === 1 && retried?.request?.toolSchemaAdded === undefined,
  JSON.stringify({ count: retried?.request?.toolSchemaCount, activated: retried?.request?.toolSchemaActivated, added: retried?.request?.toolSchemaAdded }))
check('a deferred declaration is reported rather than counted as offered', retried?.request?.deferredToolCount === 1)
check('the developer message that changed the tools is counted',
  retried?.request?.developerMessageCount === 1 && retried?.request?.toolUpdateMessages === 1)
check('the tool history is kept by reference', retried?.request?.toolHistoryRef !== undefined)
check('the store deduplicated payloads', (feed.store?.blobs ?? 0) > 0 && (feed.store?.bytes ?? 0) > 0)

const blobResponse = { ...response, body: '', statusCode: 0 }
routes[0].handler({ ...request_, url: `/cache-badge/blob?ref=${String(retried?.raw?.streamRef)}` }, blobResponse)
const blob = JSON.parse(blobResponse.body)
check('a stored payload can be fetched back by ref', Array.isArray(blob.value) && blob.value.length === 3)

// The declaration list the hash covers has to be readable back, additions included: that is
// what makes "the tools hash moved" explainable rather than merely alarming.
const envelopeResponse = { ...response, body: '', statusCode: 0 }
routes[0].handler({ ...request_, url: `/cache-badge/blob?ref=${String(retried?.request?.requestRef)}` }, envelopeResponse)
const envelope = JSON.parse(envelopeResponse.body)
check('the request envelope records the split it hashed',
  envelope.value?.toolSchemaCount === 2 && envelope.value?.toolSchemaActivated === 1 && envelope.value?.deferredToolCount === 1,
  JSON.stringify(envelope.value))
const toolsResponse = { ...response, body: '', statusCode: 0 }
routes[0].handler({ ...request_, url: `/cache-badge/blob?ref=${String(envelope.value?.toolsRef)}` }, toolsResponse)
const toolsBlob = JSON.parse(toolsResponse.body)
check('the stored declaration list holds each tool once, without the dispatch-only flag',
  Array.isArray(toolsBlob.value?.tools) && toolsBlob.value.tools.length === 2
  && toolsBlob.value.tools.every((tool) => tool.deferLoading === undefined),
  JSON.stringify(toolsBlob.value?.tools?.map((tool) => tool.name)))

const forbidden = { ...response, body: '', statusCode: 0 }
routes[0].handler({ ...request_, socket: { remoteAddress: '10.1.2.3' } }, forbidden)
check('a non-loopback peer is refused', forbidden.statusCode === 403, String(forbidden.statusCode))

console.log(`\nstore: ${String(feed.store.blobs)} blobs, ${String(feed.store.bytes)} bytes`)
for (const brick of feed.bricks ?? []) {
  const cache = brick.metrics.cacheHitRatio === undefined ? 'n/a' : `${(brick.metrics.cacheHitRatio * 100).toFixed(2)}%`
  console.log(
    `brick ${brick.identity.id} · turn ${String(brick.identity.turn)} step ${String(brick.identity.step)}`
    + ` · attempt ${String(brick.identity.attemptOrdinal)} · cache ${cache}`
    + ` · ttft ${String(brick.metrics.ttftMs ?? '—')}ms · ${brick.settlement}`
    + ` · ${brick.finish?.reason ?? 'no finish'} · tools ${String(brick.tools.length)}`,
  )
}

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} check(s) failed: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
