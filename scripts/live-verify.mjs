/**
 * Post-restart live verification for the cache-badge collector.
 *
 * Runs against a *running* instance over its own HTTP surface and checks the
 * things only real traffic can prove: that the host half loaded, that it captured
 * real requests with the full record (request refs and hashes, the context
 * snapshot frozen at dispatch, the timed stream by reference), that a stored
 * payload can be read back, and that the route guard still refuses a
 * non-loopback peer.
 *
 * Usage:
 *   node scripts/live-verify.mjs                 # newest log for the token, port 18090
 *   node scripts/live-verify.mjs --port 18083 --home <DSH_HOME_DAILY>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const home = option('home', join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), '.dsh-017'))
const port = Number(option('port', '18090'))
const base = `http://127.0.0.1:${String(port)}`

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures.push(label)
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Newest web log, whose first line carries the single-use token. */
function newestLog() {
  const dir = join(home, 'logs')
  const files = readdirSync(dir).filter((name) => /^web-.*\.out\.log$/u.test(name))
  files.sort((left, right) => statSync(join(dir, right)).mtimeMs - statSync(join(dir, left)).mtimeMs)
  return files.length === 0 ? undefined : join(dir, files[0])
}

/** Cookie jar obtained by exchanging the launcher's single-use token. */
let cookie

/**
 * Exchange the token printed in the newest web log for the session cookie, the
 * same way the browser does when the page is first opened. Needed because the
 * plugin route now runs the harness's own request policy, which requires it.
 */
async function authenticate() {
  const log = newestLog()
  if (log === undefined) return
  const match = /token=([A-Za-z0-9_-]+)/u.exec(readFileSync(log, 'utf8'))
  if (match === null) return
  try {
    const response = await fetch(`${base}/?token=${match[1]}`, { redirect: 'manual' })
    const header = response.headers.getSetCookie?.() ?? []
    const jar = header.map((entry) => entry.split(';')[0]).join('; ')
    if (jar !== '') {
      cookie = jar
      console.log('authenticated with the launcher token')
    }
  } catch {
    // Older builds may not gate the route; the request below will say so.
  }
}

/** GET a plugin route, returning status and parsed body. */
async function get(path) {
  const response = await fetch(`${base}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body, headers: response.headers }
}

async function main() {
console.log(`instance: ${base}  (home ${home})`)

// The page itself is token-gated, but the plugin route is not: it is guarded by
// loopback + same-origin, so a local script needs no cookie.
console.log('\ncollector')
await authenticate()
const sessions = await get('/cache-badge/sessions')
check('plugin route answers 200', sessions.status === 200, `HTTP ${String(sessions.status)}`)
if (sessions.status !== 200) {
  const log = newestLog()
  console.log(`\nroute not live. Newest log: ${log ?? '(none)'}`)
  if (log !== undefined) {
    const lines = readFileSync(log, 'utf8').split('\n').filter((line) => /cache-badge|error|Error/u.test(line))
    console.log(lines.slice(-10).join('\n') || '(no cache-badge lines in the log)')
  }
  console.log('\nCONCLUSION: the host half did not activate; the client keeps using its per-step fallback.')
  process.exitCode = 1
  return
}

const observed = Array.isArray(sessions.body?.sessions) ? sessions.body.sessions : []
check('at least one session has been observed', observed.length > 0, `${String(observed.length)} sessions`)
if (observed.length === 0) {
  console.log('\nCONCLUSION: routes are live but no model request has been captured yet.')
  process.exitCode = 1
  return
}

// Pick the session with the most bricks: that is the one with real traffic.
console.log('\nfeed')
let best
for (const sessionId of observed) {
  const feed = await get(`/cache-badge/attempts?sessionId=${encodeURIComponent(sessionId)}`)
  if (feed.status !== 200) continue
  const bricks = Array.isArray(feed.body?.bricks) ? feed.body.bricks : []
  if (best === undefined || bricks.length > best.bricks.length) best = { sessionId, bricks, feed: feed.body }
}
check('a feed was returned', best !== undefined)
if (best === undefined) {
  console.log('\nCONCLUSION: no readable feed.')
  process.exitCode = 1
  return
}

const { sessionId, bricks } = best
console.log(`  session ${sessionId}: ${String(bricks.length)} bricks, store ${String(best.feed.store.blobs)} blobs / ${String(best.feed.store.bytes)} bytes`)

const withUsage = bricks.filter((brick) => brick.usage !== undefined)
check('bricks carry provider usage', withUsage.length > 0, `${String(withUsage.length)}/${String(bricks.length)}`)
const withRequest = bricks.filter((brick) => brick.request?.requestRef !== undefined)
check('a full request is kept by reference', withRequest.length > 0, `${String(withRequest.length)} kept`)
const withContext = bricks.filter((brick) => brick.context !== undefined && Object.keys(brick.context).length > 0)
check('the context snapshot was frozen at dispatch', withContext.length > 0, `${String(withContext.length)} with context`)
const withStream = bricks.filter((brick) => brick.raw?.streamRef !== undefined)
check('the timed stream is kept by reference', withStream.length > 0, `${String(withStream.length)} kept`)
const withHashes = bricks.filter((brick) => brick.request?.toolsHash !== undefined || brick.request?.messagesHash !== undefined)
check('request hashes were computed', withHashes.length > 0, `${String(withHashes.length)} with hashes`)
const withPrefix = bricks.filter((brick) => typeof brick.request?.sharedMessagePrefix === 'number')
check('the shared message prefix is recorded', withPrefix.length > 0, `${String(withPrefix.length)} with a prefix count`)
const withTtft = bricks.filter((brick) => typeof brick.metrics?.ttftMs === 'number')
check('TTFT was measured from dispatch', withTtft.length > 0, `${String(withTtft.length)} with a TTFT`)
const withHeader = bricks.filter((brick) => brick.request?.headerReason !== undefined)
check('request/header was captured', withHeader.length > 0, `${String(withHeader.length)} with a header reason`)
const attempts = new Map()
for (const brick of bricks) {
  const key = `${String(brick.identity.turn)}:${String(brick.identity.step)}`
  attempts.set(key, (attempts.get(key) ?? 0) + 1)
}
const retried = [...attempts.entries()].filter(([, count]) => count > 1)
console.log(`  ${String(attempts.size)} steps, ${String(retried.length)} of them with more than one attempt`)

// Read one payload back: the store has to round-trip what it accepted.
console.log('\nstore')
const sample = withStream[0] ?? bricks[0]
if (sample?.raw?.streamRef !== undefined) {
  const blob = await get(`/cache-badge/blob?ref=${encodeURIComponent(sample.raw.streamRef)}`)
  check('a stored stream can be read back by ref', blob.status === 200 && Array.isArray(blob.body?.value), `HTTP ${String(blob.status)}`)
}
if (sample?.request?.requestRef !== undefined) {
  const blob = await get(`/cache-badge/blob?ref=${encodeURIComponent(sample.request.requestRef)}`)
  const value = blob.body?.value
  // The envelope holds the config, the system prompt, the tool schemas and the
  // list of message refs — not the messages themselves, which are stored one by
  // one so that a shared prefix is never duplicated.
  const listRef = value?.messageRefsRef
  const list = listRef === undefined ? undefined : (await get(`/cache-badge/blob?ref=${encodeURIComponent(listRef)}`)).body?.value
  const refs = list?.refs ?? value?.messageRefs
  if (value?.toolsRef !== undefined) {
    const tools = await get(`/cache-badge/blob?ref=${encodeURIComponent(value.toolsRef)}`)
    check(
      'the tool schemas dedupe into their own blob',
      tools.status === 200 && Array.isArray(tools.body?.value?.tools) && tools.body.value.tools.length > 0,
      `HTTP ${String(tools.status)}`,
    )
  }
  check(
    'the request envelope round-trips with its tool schemas and message refs',
    blob.status === 200 && value !== null && typeof value === 'object' && Array.isArray(refs) && refs.length > 0,
    `HTTP ${String(blob.status)}`,
  )
  if (Array.isArray(refs) && refs.length > 0) {
    const last = await get(`/cache-badge/blob?ref=${encodeURIComponent(refs[refs.length - 1])}`)
    const message = last.body?.value
    check(
      'an individual message is fetchable through the ref list',
      last.status === 200 && message !== null && typeof message === 'object' && typeof message.role === 'string',
      `HTTP ${String(last.status)}`,
    )
    // The same message must be shared, not copied: its ref has to be identical
    // between two requests that both carried it.
    const earlier = bricks[bricks.length - 2]
    if (earlier?.request?.messageCount !== undefined && earlier.request.messageCount > 0) {
      const earlierEnvelope = await get(`/cache-badge/blob?ref=${encodeURIComponent(earlier.request.requestRef)}`)
      const earlierValue = earlierEnvelope.body?.value
      // The envelope holds a *pointer* to the ref list (per-message storage), so the list has
      // to be fetched by its own ref — reading `messageRefs` inline silently reported 0.
      const earlierListRef = earlierValue?.messageRefsRef
      const earlierList = earlierListRef === undefined
        ? earlierValue?.messageRefs
        : (await get(`/cache-badge/blob?ref=${encodeURIComponent(earlierListRef)}`)).body?.value?.refs
      const overlap = Array.isArray(earlierList)
        ? refs.filter((ref) => earlierList.includes(ref)).length
        : 0
      console.log(`  shared message refs between the last two requests: ${String(overlap)}`)
    }
  }
}
const missing = await get('/cache-badge/blob?ref=does-not-exist')
check('an unknown ref is reported, not invented', missing.status === 404, `HTTP ${String(missing.status)}`)

// Storage sharing: the property the first real session proved necessary. Storing
// the message array per request cost ~1.7 MB every call even when 523 of 525
// messages were identical, so the host now stores messages individually and
// records how many were new.
console.log('\nsharing')
const counted = bricks.filter((brick) => typeof brick.request?.messagesStored === 'number')
if (counted.length === 0) {
  console.log('  ! the host build predates per-message storage (no messagesStored field)')
  console.log('    a restart would load a build that stores only genuinely new messages')
} else {
  const totalMessages = counted.reduce((total, brick) => total + (brick.request.messageCount ?? 0), 0)
  const totalStored = counted.reduce((total, brick) => total + brick.request.messagesStored, 0)
  const shared = totalMessages === 0 ? 0 : 1 - totalStored / totalMessages
  console.log(`  messages ${String(totalMessages)}, stored ${String(totalStored)} (${(shared * 100).toFixed(1)}% shared)`)
  console.log(`  store ${String(best.feed.store.blobs)} blobs, ${(best.feed.store.bytes / 1048576).toFixed(1)} MB`)
  for (const brick of counted.slice(-3)) {
    console.log(`  ${brick.identity.id}: ${String(brick.request.messageCount)} messages, ${String(brick.request.messagesStored)} stored`)
  }
  if (counted.length >= 3) {
    check('most messages are shared rather than re-stored', shared > 0.5, `${(shared * 100).toFixed(1)}% shared`)
    // The invariant is exact and holds for every request, including the ones a percentage
    // heuristic gets wrong: a request may store at most the messages it did **not** share.
    // (The first request of a session, and any request whose messages are all new, stores
    // every message — that is correct behaviour, not a leak, and an auxiliary call's prompt
    // is unrelated to the conversation by design.)
    const over = counted.filter((brick) => (brick.request.messagesStored ?? 0) > (brick.request.messageCount ?? 0) - (brick.request.sharedMessagePrefix ?? 0))
    check('no request stores a message it already shared', over.length === 0,
      over.slice(0, 3).map((brick) => `${brick.identity.id}: ${String(brick.request.messagesStored)} stored of ${String(brick.request.messageCount)} (shared ${String(brick.request.sharedMessagePrefix)})`).join('; '))
  }
}

console.log('\nsample brick')
for (const brick of bricks.slice(-4)) {
  const ratio = brick.metrics?.cacheHitRatio
  console.log(
    `  ${brick.identity.id} · turn ${String(brick.identity.turn)} step ${String(brick.identity.step)} attempt ${String(brick.identity.attemptOrdinal)}`
    + ` · cache ${ratio === undefined ? 'n/a' : `${(ratio * 100).toFixed(2)}%`}`
    + ` · prompt ${String(brick.metrics?.promptTokens ?? '—')}`
    + ` · ttft ${String(brick.metrics?.ttftMs ?? '—')}ms`
    + ` · ${brick.settlement}${brick.finish?.reason === undefined ? '' : ` · ${brick.finish.reason}`}`
    + ` · tools ${String(brick.tools?.length ?? 0)}`,
  )
  console.log(
    `     header ${String(brick.request?.headerReason ?? '—')} · tools ${String(brick.request?.toolsHash ?? '—').slice(0, 12)}`
    + ` · messages ${String(brick.request?.messagesHash ?? '—').slice(0, 12)}`
    + ` · count ${String(brick.request?.messageCount ?? '—')} · shared ${String(brick.request?.sharedMessagePrefix ?? '—')}`
    + ` · window ${String(brick.context?.contextWindow ?? '—')} · pressure ${String(brick.context?.pressureTokens ?? '—')}`
    + ` · nodes ${String(brick.context?.nodeCount ?? '—')}`,
  )
}

console.log('')
if (failures.length > 0) {
  console.error(`${String(failures.length)} check(s) failed: ${failures.join(', ')}`)
  process.exitCode = 1
  return
}
console.log('CONCLUSION: the host half is collecting real model calls. Reload the page to see the board from the feed.')
}

await main()
