/**
 * The built host artifact, checked the way the harness loads it.
 *
 * The unit tests run the TypeScript. This runs `lib/index.js` — the file a profile actually
 * imports — with a fake Cordis context, and asserts the two things that would be catastrophic and
 * invisible if they broke: the tap returns the model's stream untouched, and a settled request
 * really does become one brick in the served feed.
 *
 * Usage: node scripts/verify-host.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const { apply, name } = await import(pathToFileURL(join(root, 'lib/index.js')).href)
check('the built entry exports its plugin name', name === 'dsh-cache-bricks', String(name))

/** A host context that records the taps and can emit on them. */
function makeHost() {
  const listeners = new Map()
  const routes = []
  const services = new Map()
  return {
    routes,
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
    },
    get: (key) => services.get(key),
    inject(names, callback) {
      callback({
        on: () => undefined,
        get: (key) => (key === 'webServer'
          ? { register: (route) => { routes.push(route); return () => {} } }
          : undefined),
        inject: () => undefined,
        effect: (callback) => { callback() },
      })
    },
    effect: (callback) => { callback() },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }
}

const host = makeHost()
apply(host, {})
check('the host half registers its route', host.routes.some((route) => route.path === '/cache-bricks'))

// A real request, settled: dispatch, identity, usage, settlement.
const stream = { id: 'the-model-stream' }
let returned
host.emit('llm/stream', { sessionId: 'verify' }, () => { returned = stream; return stream })
check('the tap returns the model stream untouched', returned === stream)
host.emit('agent/assistant-stream', {
  agent: { session: { id: 'verify' } },
  frame: { type: 'start', turn: 9, step: 4, attemptId: 'a1', time: 1_000 },
})
host.emit('agent/assistant-stream', {
  agent: { session: { id: 'verify' } },
  frame: { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1_635, cacheReadTokens: 7_168, cacheWriteTokens: 0 } } },
})
host.emit('session/event', { id: 'verify' }, {
  type: 'assistant/message',
  time: 2_000,
  data: { turn: 9, step: 4, usage: { inputTokens: 1_635, cacheReadTokens: 7_168, cacheWriteTokens: 0 } },
})

// Read it back through the route the browser uses.
const route = host.routes.find((entry) => entry.path === '/cache-bricks')
let body = ''
let status = 0
route.handler(
  { url: '/cache-bricks/bricks?sessionId=verify', method: 'GET', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } },
  {
    set statusCode(value) { status = value },
    get statusCode() { return status },
    setHeader() {},
    end(chunk) { body += chunk ?? '' },
  },
)
const feed = JSON.parse(body)
check('the route answers 200', status === 200, String(status))
check('one settled request is one brick', feed.bricks?.length === 1, JSON.stringify(feed.bricks?.length))
const brick = feed.bricks?.[0]
check('the brick carries the reading, not the request',
  brick?.hitRatio !== undefined && brick?.inputTokens === 1_635 && brick?.cacheReadTokens === 7_168,
  JSON.stringify(brick))
check('the brick carries no prompt, no tools and no refs',
  brick !== undefined && !('request' in brick) && !('tools' in brick) && !('raw' in brick) && !('route' in brick),
  JSON.stringify(Object.keys(brick ?? {})))
// 7,168 of 8,803 prompt tokens cached is 81.4% — 0.1.3's amber band, and a nice accident: the
// numbers in this check are the ones the 0.1.3 verification run recorded.
check('the brick is amber: a tenth of this prompt was re-billed', brick?.tone === 'warn', String(brick?.tone))
check('its identity is the attempt', brick?.id === 'verify:9:4:0', String(brick?.id))

console.log(failures.length === 0
  ? '\nthe built host artifact passes every check.'
  : `\n${String(failures.length)} check(s) failed: ${failures.join(', ')}`)
if (failures.length > 0) process.exitCode = 1
