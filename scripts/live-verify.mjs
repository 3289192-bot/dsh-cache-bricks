/**
 * Live verification: the plugin, running on a real instance, fed by real model calls.
 *
 * Everything else in this package runs against fixtures. This runs against the harness: the
 * host half loaded in a real process, the route served over real HTTP, the board mounted in the
 * real GUI, and bricks produced by whatever requests that instance is actually making.
 *
 * Usage:
 *   node scripts/live-verify.mjs                    # port 18090, newest log's token, this session
 *   node scripts/live-verify.mjs --port 18091 --home <path-to-DSH-home>
 *   node scripts/live-verify.mjs --session session-… --expect-brick
 *
 * `--expect-brick` makes "a brick appeared" a requirement rather than a report: use it when the
 * instance is known to be making requests (a session that is running a turn).
 *
 * Playwright is resolved the same way as in `scripts/test-board.mjs`; without it (or without a
 * cached Chromium) the browser half is skipped and the HTTP half still runs.
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
const wanted = option('session', process.env.DSH_SESSION_ID)
const expectBrick = args.includes('--expect-brick')

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

/** Newest web log, whose launcher line carries the single-use token. */
function newestLog() {
  const dir = join(home, 'logs')
  if (!existsSync(dir)) return undefined
  const files = readdirSync(dir).filter((name) => /^web-.*\.out\.log$/u.test(name))
  files.sort((left, right) => statSync(join(dir, right)).mtimeMs - statSync(join(dir, left)).mtimeMs)
  return files.length === 0 ? undefined : join(dir, files[0])
}

/** Cookie jar obtained by exchanging the launcher's single-use token. */
async function authenticate() {
  const log = newestLog()
  if (log === undefined) return { cookie: undefined }
  const match = /token=([A-Za-z0-9_-]+)/u.exec(readFileSync(log, 'utf8'))
  if (match === null) return { cookie: undefined }
  const response = await fetch(`${base}/?token=${match[1]}`, { redirect: 'manual' })
  const jar = (response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')
  return { cookie: jar === '' ? undefined : jar }
}

const auth = await authenticate()
if (auth.cookie === undefined) {
  console.log(`no launcher token found under ${join(home, 'logs')}; is the instance running?`)
  process.exit(0)
}
const headers = { cookie: auth.cookie }

// ── the host half, over its own HTTP surface ─────────────────────────────────────────────
const sessionsResponse = await fetch(`${base}/cache-bricks/sessions`, { headers })
check('the plugin route answers over HTTP', sessionsResponse.ok, `HTTP ${String(sessionsResponse.status)}`)
if (!sessionsResponse.ok) {
  console.log('the host half is not loaded on this instance; nothing further to check')
  process.exit(1)
}
const { sessions } = await sessionsResponse.json()
check('at least one session has been observed', sessions.length > 0, `${String(sessions.length)} sessions`)

// The session this agent is running in is the most interesting one: it is making real calls.
const sessionId = wanted !== undefined && sessions.includes(wanted) ? wanted : sessions[0]
const bricksResponse = await fetch(`${base}/cache-bricks/bricks?sessionId=${encodeURIComponent(sessionId)}`, { headers })
const feed = bricksResponse.ok ? await bricksResponse.json() : undefined
console.log(`  · session ${sessionId}: ${String(feed?.bricks?.length ?? 0)} bricks, `
  + `${String(feed?.dispatched ?? 0)} requests dispatched, ${String(feed?.dropped ?? 0)} dropped`)
if (expectBrick) check('a real model call produced a brick', (feed?.bricks?.length ?? 0) > 0, JSON.stringify(feed?.bricks?.length))
else if ((feed?.bricks?.length ?? 0) === 0) console.log('  · no brick yet on this session: nothing claimed about the reading')

if (feed !== undefined && (feed.bricks ?? []).length > 0) {
  const brick = feed.bricks[feed.bricks.length - 1]
  const keys = Object.keys(brick).sort().join(',')
  check('a brick carries the reading and the identity, and nothing else',
    keys === 'attempt,cacheReadTokens,cacheWriteTokens,finishedAt,hitRatio,id,inputTokens,startedAt,step,tone,turn',
    keys)
  check('a brick has no prompt, no tools and no stored request',
    !('request' in brick) && !('tools' in brick) && !('raw' in brick) && !('route' in brick) && !('settlementSeq' in brick))
  check('the tone agrees with the ratio',
    brick.hitRatio === null
      ? brick.tone === 'unknown'
      : (brick.hitRatio >= 0.7) === (brick.tone === 'good'),
    `ratio ${String(brick.hitRatio)} tone ${String(brick.tone)}`)
  check('the ratio is the cache read over the whole prompt',
    brick.hitRatio === null
      || Math.abs(brick.hitRatio - Math.min(1, brick.cacheReadTokens / (brick.inputTokens + brick.cacheReadTokens + brick.cacheWriteTokens))) < 1e-9,
    `${String(brick.cacheReadTokens)}/${String(brick.inputTokens + brick.cacheReadTokens + brick.cacheWriteTokens)}`)
  // Printed the way a brick prints it: floored, never rounded up. A report that overstates the
  // hit is the one thing this plugin must not produce, even in its own log line.
  const reading = brick.hitRatio === null ? 'n/a' : `${(Math.floor(brick.hitRatio * 1000) / 10).toFixed(1)}%`
  console.log(`  · newest brick: turn ${String(brick.turn)} step ${String(brick.step)} attempt ${String(brick.attempt)} · `
    + `${reading} · ${String(brick.tone)}`)
}

// ── the board, in the real GUI ─────────────────────────────────────────────────────────
function loadPlaywright() {
  const require = createRequire(import.meta.url)
  const roots = [
    process.env.PLAYWRIGHT_CORE,
    join(process.cwd(), 'node_modules'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@playwright', 'mcp'),
  ].filter((entry) => typeof entry === 'string' && entry !== '')
  for (const entry of roots) {
    try {
      return createRequire(join(entry, 'noop.js'))('playwright-core')
    } catch {
      // Next root.
    }
  }
  return undefined
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

const playwright = loadPlaywright()
if (playwright === undefined) {
  console.log('  · playwright-core is not installed: skipping the board check')
} else {
  const executablePath = cachedChromium()
  const browser = await playwright.chromium.launch({
    args: ['--no-sandbox'],
    ...(executablePath === undefined ? {} : { executablePath }),
  })
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' })
    const [name, value] = auth.cookie.split('=')
    await context.addCookies([{ name, value, domain: '127.0.0.1', path: '/', httpOnly: true }])
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()) })

    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2_500)
    const row = page.locator(`div[role="treeitem"][data-row-key="session:${sessionId}"]`)
    if ((await row.count()) === 0) {
      console.log(`  · session ${sessionId} is not in this instance's sidebar: skipping the board check`)
    } else {
      await row.first().click()
      await page.waitForTimeout(3_000)
      const board = page.locator('[data-cache-bricks-board]')
      await board.first().waitFor({ timeout: 15_000 })
      check('the board is mounted beside the conversation', (await board.count()) === 1)
      const box = await board.first().boundingBox()
      check('the board has a usable gutter', box !== null && box.width >= 80 && box.height >= 60, JSON.stringify(box))
      const slabs = await page.evaluate(() => [...document.querySelectorAll('[data-cache-bricks-brick]')].map((element) => ({
        id: element.dataset.cacheBricksBrick,
        tone: element.dataset.cacheBricksTone,
        text: (element.textContent ?? '').trim(),
        background: getComputedStyle(element).backgroundColor,
      })))
      if (expectBrick) check('the board drew the bricks the collector has', slabs.length > 0, String(slabs.length))
      console.log(`  · the board is drawing ${String(slabs.length)} bricks`
        + (slabs.length === 0 ? '' : ` (${[...new Set(slabs.map((slab) => slab.tone))].join('/')})`))
      check('every drawn brick prints a reading, never a blank face',
        slabs.every((slab) => /^(?:\d{1,2}\.\d%|100%|n\/a)$/u.test(slab.text)),
        JSON.stringify(slabs.slice(0, 4).map((slab) => slab.text)))
      check('every drawn brick is painted', slabs.every((slab) => slab.background !== 'rgba(0, 0, 0, 0)'),
        JSON.stringify(slabs.slice(0, 3).map((slab) => [slab.tone, slab.background])))

      // The window: two rails, drawn as scrollbars, and honest about whether they can move.
      const window_ = await page.evaluate(() => {
        const read = (axis) => {
          const rail = document.querySelector(`[data-cache-bricks-rail="${axis}"]`)
          if (rail === null) return undefined
          const thumb = rail.firstElementChild.getBoundingClientRect()
          const box = rail.getBoundingClientRect()
          return {
            role: rail.getAttribute('role'),
            tabIndex: rail.tabIndex,
            disabled: rail.getAttribute('aria-disabled'),
            valueNow: Number(rail.getAttribute('aria-valuenow')),
            valueMax: Number(rail.getAttribute('aria-valuemax')),
            atLiveEnd: axis === 'x'
              ? Math.abs(thumb.x + thumb.width - (box.x + box.width)) <= 1
              : Math.abs(thumb.y + thumb.height - (box.y + box.height)) <= 1,
          }
        }
        return { x: read('x'), y: read('y') }
      })
      check('the board carries both rails, drawn as scrollbars',
        window_.x?.role === 'scrollbar' && window_.y?.role === 'scrollbar',
        JSON.stringify(window_))
      check('the rails agree with each other about whether they can move',
        window_.x !== undefined && window_.y !== undefined
        && (window_.x.valueMax > 0) === (window_.x.tabIndex === 0)
        && (window_.y.valueMax > 0) === (window_.y.tabIndex === 0)
        && window_.x.atLiveEnd,
        JSON.stringify(window_))
      check('no console error from the plugin itself',
        pageErrors.every((text) => !text.includes('cache-bricks')), pageErrors.slice(0, 2).join(' | '))
    }
  } finally {
    await browser.close()
  }
}

console.log(failures.length === 0
  ? '\nlive checks passed.'
  : `\n${String(failures.length)} check(s) failed: ${failures.join(', ')}`)
if (failures.length > 0) process.exitCode = 1
