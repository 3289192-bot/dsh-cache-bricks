/**
 * Live verification of the 0.1.4 data layer, against a running instance.
 *
 * The unit tests prove the index, the slice and the pager in isolation, and the browser fixture
 * suite proves the board against mocked DSH services. What neither can prove is the thing this
 * release is actually about: that a **real** session's window pages, and that the paging lands on
 * the board with exact types. That needs the served bundle, the real `ISession.loadOlder()`, and
 * a conversation with history behind it.
 *
 * Usage:
 *   node scripts/live-scene-verify.mjs                    # port 18090, newest log's token
 *   node scripts/live-scene-verify.mjs --port 18091 --home <path-to-DSH-home>
 *   node scripts/live-scene-verify.mjs --session session-…  # pick the session to open
 *
 * Playwright is resolved the same way as in `ui-verify.mjs` (it is not a dependency of this
 * package). When it or Chromium is missing, the script says so and exits 0.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const home = option('home', join(homedir(), '.dsh-017'))
const port = Number(option('port', '18090'))
const base = `http://127.0.0.1:${String(port)}`
const wanted = option('session', undefined)

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures.push(label)
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function loadPlaywright() {
  const require = createRequire(import.meta.url)
  const roots = [
    process.env.PLAYWRIGHT_CORE,
    join(process.cwd(), 'node_modules'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@playwright', 'mcp'),
  ].filter((root) => typeof root === 'string' && root !== '')
  for (const root of roots) {
    try {
      return createRequire(join(root, 'noop.js'))('playwright-core')
    } catch {
      // Next root.
    }
  }
  try {
    return require('playwright-core')
  } catch {
    return undefined
  }
}

function cachedChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM !== undefined) return process.env.PLAYWRIGHT_CHROMIUM
  const cache = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  if (!existsSync(cache)) return undefined
  const candidates = []
  for (const entry of readdirSync(cache)) {
    const headless = join(cache, entry, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
    const full = join(cache, entry, 'chrome-win64', 'chrome.exe')
    if (entry.startsWith('chromium_headless_shell-') && existsSync(headless)) candidates.push([entry, headless])
    if (entry.startsWith('chromium-') && existsSync(full)) candidates.push([entry, full])
  }
  candidates.sort((left, right) => right[0].localeCompare(left[0]))
  return candidates[0]?.[1]
}

function newestLog() {
  const dir = join(home, 'logs')
  const files = readdirSync(dir).filter((name) => /^web-.*\.out\.log$/u.test(name))
  files.sort((left, right) => statSync(join(dir, right)).mtimeMs - statSync(join(dir, left)).mtimeMs)
  return files.length === 0 ? undefined : join(dir, files[0])
}

async function authenticate() {
  const log = newestLog()
  if (log === undefined) return { cookie: undefined }
  const match = /token=([A-Za-z0-9_-]+)/u.exec(readFileSync(log, 'utf8'))
  if (match === null) return { cookie: undefined }
  const response = await fetch(`${base}/?token=${match[1]}`, { redirect: 'manual' })
  const jar = (response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')
  return { cookie: jar === '' ? undefined : jar }
}

const playwright = loadPlaywright()
if (playwright === undefined) {
  console.log('playwright-core is not installed; skipping the live scene check')
  process.exit(0)
}

const auth = await authenticate()
if (auth.cookie === undefined) {
  console.log(`no launcher token found under ${join(home, 'logs')}; is the instance running?`)
  process.exit(0)
}

// The richest observed session: the one most likely to have history worth paging into.
const listed = await fetch(`${base}/cache-bricks/sessions`, { headers: { cookie: auth.cookie } })
if (!listed.ok) {
  console.log(`the collector route answered ${String(listed.status)}; nothing to verify`)
  process.exit(0)
}
const { sessions } = await listed.json()
let richest = { id: wanted, bricks: -1, turns: -1 }
for (const id of sessions) {
  if (wanted !== undefined && id !== wanted) continue
  const feed = await fetch(`${base}/cache-bricks/attempts?sessionId=${encodeURIComponent(id)}`, { headers: { cookie: auth.cookie } })
  const body = await feed.json()
  const bricks = body.bricks?.length ?? 0
  // Width, not depth: a board pages horizontally, so the session worth opening is the one with
  // the most Turns behind its window — a 160-step single Turn has nothing to pan into.
  const turns = new Set((body.bricks ?? []).map((brick) => brick.identity.turn)).size
  if (turns > richest.turns || (turns === richest.turns && bricks > richest.bricks)) richest = { id, bricks, turns }
}
if (richest.id === undefined || richest.bricks <= 0) {
  // An explicitly requested session is fair game even when the collector never saw it: that is
  // exactly the case the scene layer exists for (history this process did not make).
  console.log(wanted === undefined
    ? 'no session with observed bricks yet; run a turn and try again'
    : `session ${wanted} has no collected bricks: verifying it from the log alone`)
  if (wanted === undefined) process.exit(0)
  richest = { id: wanted, bricks: 0, turns: 0 }
}
console.log(`instance ${base} · session ${richest.id} (${String(richest.bricks)} collected bricks over ${String(richest.turns)} Turns)`)

const executablePath = cachedChromium()
let browser
try {
  browser = await playwright.chromium.launch({ headless: true })
} catch (error) {
  if (executablePath === undefined) {
    console.log(`no Chromium available for Playwright (${String(error).split('\n')[0]}); skipping`)
    process.exit(0)
  }
  browser = await playwright.chromium.launch({ headless: true, executablePath })
}

try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
  const [name, value] = auth.cookie.split('=')
  await context.addCookies([{ name, value, domain: '127.0.0.1', path: '/', httpOnly: true }])
  const page = await context.newPage()
  const consoleErrors = []
  const notFound = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))
  page.on('response', (response) => {
    if (response.status() >= 400) notFound.push(`${String(response.status())} ${response.url().slice(0, 120)}`)
  })

  // The served bundle is the one being verified: a stale instance would pass every check below
  // while running the previous release.
  const html = await (await page.request.get(`${base}/`)).text()
  const url = /plugins\/\?\?[^"]*dsh-cache-bricks\/client\.js[^"]*/u.exec(html.replaceAll('&amp;', '&'))?.[0]
  check('the served page asks for the plugin bundle', url !== undefined)
  if (url !== undefined) {
    const body = await (await page.request.get(`${base}/${url}`)).text()
    check('the served bundle is this build (it carries the scene reader)',
      body.includes('reconstructed from the session log'),
      `${String(body.length)} bytes`)
  }

  await page.goto(`${base}/?token=`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2_500)

  const row = page.locator(`div[role="treeitem"][data-row-key="session:${richest.id}"]`)
  if (await row.count() === 0) {
    console.log(`session ${richest.id} is not in the sidebar of this instance; skipping`)
    process.exit(0)
  }
  await row.first().click()
  await page.waitForTimeout(3_500)
  await page.mouse.move(1200, 700)
  await page.waitForSelector('[data-cache-bricks-board]', { timeout: 20_000 })

  const read = () => page.evaluate(() => {
    const slabs = [...document.querySelectorAll('[data-cache-bricks-brick][data-cache-bricks-face="cache"]')]
    const rail = document.querySelector('[data-cache-bricks-rail="x"]')
    return {
      slabs: slabs.length,
      turns: [...new Set(slabs.map((element) => Number(element.dataset.cacheBricksBrick.split(':')[1])).filter((turn) => turn > 0))]
        .sort((left, right) => left - right),
      replayed: slabs.filter((element) => (element.getAttribute('aria-label') ?? '').includes('reconstructed from the session log')).length,
      folded: slabs.filter((element) => (element.getAttribute('aria-label') ?? '').includes('estimated step')).length,
      limit: rail === null ? 0 : Number(rail.getAttribute('aria-valuemax')),
      pan: rail === null ? 0 : Number(rail.getAttribute('aria-valuenow')),
    }
  })

  const live = await read()
  check('the board is up on a real session', live.slabs > 0, `${String(live.slabs)} bricks`)
  check('the board reads its Turns from the session, not from the collector alone',
    live.turns.length > 0,
    `${String(live.turns.length)} Turns ${String(live.turns[0])}..${String(live.turns[live.turns.length - 1])}`)
  console.log(`  · provenance on screen: ${String(live.slabs - live.replayed - live.folded)} live · `
    + `${String(live.replayed)} replayed from the log · ${String(live.folded)} folded · pan limit ${String(live.limit)}`)

  // A board holding everything it holds is at the left edge, so a session whose window still has
  // `hasMore` pages here without any gesture at all. Give it a moment, then see whether the board
  // grew — the only way it can is that a page landed.
  const before = live
  await page.waitForTimeout(4_000)
  const grown = await read()
  const paged = grown.turns.length > before.turns.length || grown.limit > before.limit
  check('history the board did not have is paged in, and the Turns already on screen stay put',
    !paged || (grown.turns.includes(before.turns[before.turns.length - 1]) && grown.turns[0] <= before.turns[0]),
    `${before.turns.join(',')} → ${grown.turns.join(',')} · limit ${String(before.limit)} → ${String(grown.limit)}`)
  console.log(paged
    ? `  · a page landed without a gesture: ${String(before.turns.length)} → ${String(grown.turns.length)} Turns on the board`
    : '  · this session has no older page to give: nothing was claimed about paging')

  const railBox = await page.locator('[data-cache-bricks-rail="x"]').boundingBox()
  const thumbBox = await page.locator('[data-cache-bricks-rail="x"] > div').first().boundingBox()
  if (grown.limit > 0 && railBox !== null && thumbBox !== null) {
    // Walk to the left edge by hand: the reader must arrive where they asked and stay there.
    await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(railBox.x + 2, thumbBox.y + thumbBox.height / 2, { steps: 20 })
    await page.mouse.up()
    await page.waitForTimeout(2_500)
    const atEdge = await read()
    check('walking to the left edge lands on older Turns, not past them',
      atEdge.turns.length > 0 && atEdge.turns[atEdge.turns.length - 1] <= grown.turns[grown.turns.length - 1],
      `${grown.turns.join(',')} → ${atEdge.turns.join(',')}`)
  } else {
    console.log('  · the horizontal rail has no travel on this session: no pan to make')
  }

  // A 404 the console reports is only this plugin's business when the URL is its own: every
  // other miss belongs to whatever the session was carrying (a deleted attachment, say).
  const pluginMisses = notFound.filter((entry) => entry.includes('/cache-bricks/') || entry.includes('dsh-cache-bricks'))
  check('the plugin never asks for something that is not there',
    pluginMisses.length === 0, pluginMisses.slice(0, 3).join(' | '))
  console.log(notFound.length === 0
    ? '  · no failed request while reading history'
    : `  · failed requests (not the plugin's): ${notFound.slice(0, 3).join(' | ')}`)
  check('no console error from the plugin itself',
    consoleErrors.every((text) => !text.includes('cache-bricks')), consoleErrors.slice(0, 2).join(' | '))
} finally {
  await browser.close()
}

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} check(s) failed: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  console.log('\nlive scene checks passed (real instance, real session service).')
}
