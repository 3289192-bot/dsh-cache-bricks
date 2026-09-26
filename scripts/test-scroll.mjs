/**
 * Real-browser verification of the board's window and its two scroll rails.
 *
 * What cannot be checked anywhere else lives here: the rails are DOM chrome built outside
 * React, dragging one has to move **the board** (and nothing else), the bricks must never
 * sit underneath a rail, and a panned window has to keep showing the same Turns when the
 * session grows. The DSH services, the collector feed and the session log are fixtures —
 * this is Chromium + React 18 + the real built bundle, not a live DSH instance.
 *
 * Usage:
 *   pnpm run build && node scripts/test-scroll.mjs
 *   node scripts/test-scroll.mjs --shot C:\tmp\shots      # also write PNGs of each state
 *   node scripts/test-scroll.mjs --shot C:\tmp\shots --showcase  # capture a synthetic release board
 *
 * `playwright-core` is resolved from `$PLAYWRIGHT_CORE`, then the local/global npm roots,
 * the same way `ui-verify.mjs` finds it; without it the script says so and exits 0.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const shotDir = option('shot', undefined)

/** Resolve `playwright-core` from wherever this machine keeps it. */
function loadPlaywright() {
  const scoped = createRequire(import.meta.url)
  const roots = [
    process.env.PLAYWRIGHT_CORE,
    join(root, 'node_modules'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@playwright', 'mcp'),
  ].filter((entry) => typeof entry === 'string' && entry !== '')
  for (const entry of roots) {
    try {
      return createRequire(join(entry, 'noop.js'))('playwright-core')
    } catch {
      // Try the next root.
    }
  }
  try {
    return scoped('playwright-core')
  } catch {
    return undefined
  }
}

/** The browser Playwright would launch may not be the one this machine downloaded. */
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
  console.log('playwright-core is not installed; skipping the browser check')
  console.log('  set PLAYWRIGHT_CORE to a package root that has it, or `npm i -g @playwright/mcp`')
  process.exit(0)
}

/** The brick geometry the board's own contract states; hard-coded on purpose, so the
 * expectations below cannot be derived from the code under test. */
const BRICK_W = 36
const BRICK_H = 15
const PITCH_X = 39
const PITCH_Y = 18
/** 18 Turns, three bricks each, except Turn 9 which does not fit the board vertically. */
const TURNS = 18
const TALL_TURN = 9
const TALL_BRICKS = 45

const failures = []
const results = []
const check = (name, ok, detail = '') => {
  results.push({ test: name, passed: Boolean(ok) })
  if (ok) {
    console.log(`  PASS ${name}`)
    return
  }
  failures.push(name)
  console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

let browser
try {
  browser = await playwright.chromium.launch({ args: ['--no-sandbox'] })
} catch (error) {
  const executablePath = cachedChromium()
  if (executablePath === undefined) {
    console.log(`no Chromium available for Playwright (${String(error).split('\n')[0]}); skipping the browser check`)
    process.exit(0)
  }
  browser = await playwright.chromium.launch({ args: ['--no-sandbox'], executablePath })
}
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
const pageErrors = []

try {
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  // The page: a real scrollport with a real gutter to the left of the transcript column,
  // plus the composer height the board reads to find its floor. Copied from
  // `test-clickfix.mjs`, which is the same fixture contract.
  await page.setContent(`<!DOCTYPE html><html><head><base href="http://brick.test/"><style>
body{margin:0;background:#151517;color:#e5e7eb;font-family:system-ui;--dsw-alias-state-business-primary:#38bdf8;--dsw-alias-bg-base:#151517;--dsw-alias-bg-layer-1:#202026;--dsw-alias-bg-layer-2:#26262c;--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#9ca3af;--dsw-alias-state-error-primary:#f87171;--dsw-alias-state-error-secondary:#7f1d1d;--dsw-alias-brand-primary-new-colorprimary-new-color:#a78bfa;--dsw-alias-state-warn-label:#f59e0b;--dsw-alias-state-success-primary:#22c55e}
#scroll{position:fixed;inset:50px 0 0;overflow:auto;--dsh-composer-height:80px}
.row{margin-left:450px;width:600px;height:60px;padding:20px;box-sizing:border-box;background:#202026;margin-bottom:20px}
#tail{height:2000px}
</style></head><body><div id="scroll" data-conversation-scroll><div class="row" data-chat-turn="1" data-chat-node-key="10:assistant-step1:1" data-chat-group-part="response">transcript row</div><div id="tail"></div></div><div id="dock"></div></body></html>`)

  const react = dirname(require.resolve('react/package.json'))
  const dom = dirname(require.resolve('react-dom/package.json'))
  await page.addScriptTag({ path: join(react, 'umd/react.production.min.js') })
  await page.addScriptTag({ path: join(dom, 'umd/react-dom.production.min.js') })
  const runtime = readFileSync(join(react, 'cjs/react-jsx-runtime.production.min.js'), 'utf8')
  await page.addScriptTag({
    content: `{const m={exports:{}};((module,exports,require)=>{${runtime}\n})(m,m.exports,()=>React);`
      + `window.__testExternals={'react':React,'react/jsx-runtime':m.exports};window.__ReactDOM=ReactDOM;}`,
  })
  await page.addScriptTag({ path: join(root, 'tests/clickfix.fixture.js') })
  await page.addScriptTag({ path: join(root, 'lib/client.js') })

  // The long session: 18 Turns, so the rail has history to reach, and one Turn (9) that has
  // outgrown the board's rows, so the vertical rail has something to reach too.
  await page.evaluate(([turns, tallTurn, tallBricks]) => {
    // Turn 12 step 1 stands for a provider that reported no cache fields at all: its brick
    // must read `n/a`, and a percentage must never be invented for it.
    const silent = (turn, step) => turn === 12 && step === 1
    // Three bands, one per step, so the palette is exercised through the real mapping
    // (`badgeStatus` -> tone -> fill) rather than by hand-set tones. 0.1.0.a: >=90 green,
    // 70-90 amber, <70 red.
    const ratioOf = (step) => (step === 1 ? 0.99 : step === 2 ? 0.85 : 0.6)
    const record = (turn, step) => ({
      observedBy: 'host',
      identity: { id: `S:${turn}:${step}:0`, sessionId: 'S', turn, step, attemptOrdinal: 0 },
      settlement: 'message',
      settlementSeq: turn * 100 + step,
      route: { provider: silent(turn, step) ? 'silent' : 'fixture', model: 'fixture' },
      usage: silent(turn, step) ? { inputTokens: 500 } : { inputTokens: Math.round(2000 * (1 - ratioOf(step))), cacheReadTokens: Math.round(2000 * ratioOf(step)), outputTokens: 20 },
      metrics: {
        promptTokens: silent(turn, step) ? 500 : 2000,
        ...(silent(turn, step) ? {} : { cacheHitRatio: ratioOf(step) }),
        chunkCount: 3, textChars: 10,
        reasoningChars: step === 1 ? 10 : 0, toolCallCount: 0,
      },
      request: {}, tools: [], raw: {},
    })
    const bricks = []
    const ended = []
    for (let turn = 1; turn <= turns; turn += 1) {
      if (turn < turns) ended.push(turn)
      const count = turn === tallTurn ? tallBricks : 3
      for (let step = 1; step <= count; step += 1) bricks.push(record(turn, step))
    }
    window.__fixture.records.S = bricks
    window.__fixture.feed = { sessionId: 'S', bricks, endedTurns: ended, store: { blobs: 0, bytes: 0 } }
    // The collector's snapshot and its live stream, both under the test's control.
    window.fetch = async (url) => {
      const parsed = new URL(url, 'http://brick.test/')
      if (parsed.pathname.endsWith('/attempts')) return { ok: true, json: async () => window.__fixture.feed }
      return { ok: false, status: 404 }
    }
    window.__streams = []
    window.EventSource = class {
      constructor(url) { this.url = url; this.handlers = {}; window.__streams.push(this) }
      addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler) }
      close() {}
    }
    window.__pushFeed = (feed) => {
      window.__fixture.feed = feed
      for (const stream of window.__streams) {
        for (const handler of stream.handlers.feed ?? []) handler({ data: JSON.stringify(feed) })
      }
    }
  }, [TURNS, TALL_TURN, TALL_BRICKS])

  await page.evaluate(() => window.__fixture.start())
  const board = page.locator('[data-cache-bricks-board]')
  await board.waitFor()
  await page.locator('[data-cache-bricks-brick="S:18:1:0"][data-cache-bricks-face="cache"]').waitFor()
  await page.waitForTimeout(400)

  /** Read the board's own state through the DOM, the way a reader sees it. */
  const readBoard = () => page.evaluate(() => {
    const host = document.querySelector('[data-cache-bricks-board]')
    const rect = host.getBoundingClientRect()
    const rail = (axis) => {
      const element = document.querySelector(`[data-cache-bricks-rail="${axis}"]`)
      const thumb = element.firstElementChild
      const box = element.getBoundingClientRect()
      const handle = thumb.getBoundingClientRect()
      return {
        x: box.x, y: box.y, width: box.width, height: box.height,
        thumbLength: axis === 'x' ? handle.width : handle.height,
        thumbOffset: axis === 'x' ? handle.x - box.x : handle.y - box.y,
        pointerEvents: getComputedStyle(element).pointerEvents,
        tabIndex: element.tabIndex,
        opacity: Number(getComputedStyle(element).opacity),
        valueNow: element.getAttribute('aria-valuenow'),
        valueMax: element.getAttribute('aria-valuemax'),
        valueText: element.getAttribute('aria-valuetext'),
      }
    }
    const slabs = [...document.querySelectorAll('[data-cache-bricks-brick][data-cache-bricks-face="cache"]')].map((element) => {
      const box = element.getBoundingClientRect()
      const style = element.style
      // The reading is a text node of its own (the lifecycle mark is a child span), so its
      // width is measurable without touching the layout.
      const text = [...element.childNodes]
        .find((child) => child.nodeType === 3 && (child.textContent ?? '').trim() !== '')
      let readingWidth = 0
      if (text !== undefined) {
        const range = document.createRange()
        range.selectNode(text)
        readingWidth = Math.round(range.getBoundingClientRect().width * 10) / 10
      }
      return {
        key: element.dataset.cacheBricksBrick,
        right: Number.parseFloat(style.right),
        bottom: Number.parseFloat(style.bottom),
        x: box.x, y: box.y, width: box.width, height: box.height,
        transition: style.transition,
        focused: document.activeElement === element,
        reading: text === undefined ? '' : (text.textContent ?? '').trim(),
        readingWidth,
        inner: element.clientWidth,
        fontSize: getComputedStyle(element).fontSize,
        clipped: element.scrollWidth > element.clientWidth + 1,
      }
    })
    const fade = (edge) => {
      const element = document.querySelector(`[data-cache-bricks-fade="${edge}"]`)
      return element === null ? undefined : getComputedStyle(element).display !== 'none'
    }
    return {
      host: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      rails: { x: rail('x'), y: rail('y') },
      slabs,
      // Turn 0 is the auxiliary lane, which is not a Turn: only real columns count here.
      turns: [...new Set(slabs
        .map((slab) => Number(slab.key.split(':')[1]))
        .filter((turn) => turn > 0))].sort((left, right) => left - right),
      fades: { left: fade('left'), right: fade('right'), top: fade('top') },
      live: (() => {
        const chip = document.querySelector('[data-cache-bricks-live]')
        return chip === null || getComputedStyle(chip).display === 'none'
          ? undefined
          : { text: chip.textContent, title: chip.title }
      })(),
      chatScroll: document.querySelector('#scroll').scrollTop,
    }
  })

  /** Return to the live corner, if the board is not already there. */
  const backToLive = async () => {
    const chip = page.locator('[data-cache-bricks-live]')
    if (await chip.isVisible()) await chip.click()
    await page.waitForTimeout(200)
  }

  const shot = async (name) => {
    if (shotDir === undefined) return
    mkdirSync(shotDir, { recursive: true })
    await board.screenshot({ path: join(shotDir, `${name}.png`) })
    await page.screenshot({ path: join(shotDir, `${name}-page.png`) })
  }

  /** Crops of the two rails, because a 4-pixel track is invisible in a whole-board shot. */
  const railShots = async (name) => {
    if (shotDir === undefined) return
    const box = (await board.boundingBox())
    mkdirSync(shotDir, { recursive: true })
    await page.screenshot({
      path: join(shotDir, `${name}-left-edge.png`),
      clip: { x: box.x, y: box.y, width: 34, height: box.height },
    })
    await page.screenshot({
      path: join(shotDir, `${name}-bottom-rail.png`),
      clip: { x: box.x, y: box.y + box.height - 22, width: box.width, height: 22 },
    })
  }

  /** The pitch the board actually used, so a metric regression is caught by geometry. */
  const live = await readBoard()
  const gridWidth = 10 * PITCH_X - 3
  const gridHeight = 40 * PITCH_Y - 3
  check('the board is up in the gutter with a 10 x 40 grid', live.host.width === gridWidth + 6 && live.host.height === gridHeight + 22,
    `host ${live.host.width}x${live.host.height}`)
  check('every reading carries one decimal — or an exact 100%, or an honest n/a',
    live.slabs.length > 0 && live.slabs.every((slab) => /^(?:\d{1,2}\.\d%|100%|n\/a)$/u.test(slab.reading)),
    JSON.stringify([...new Set(live.slabs.map((slab) => slab.reading))].slice(0, 6)))
  check('a provider that reported nothing reads n/a, not a number',
    live.slabs.some((slab) => slab.key === 'S:12:1:0' && slab.reading === 'n/a'),
    JSON.stringify(live.slabs.filter((slab) => slab.key === 'S:12:1:0').map((slab) => slab.reading)))
  // The typographic promise: five characters at 12px inside a 34px-wide inner box. Measured,
  // so a font or size regression cannot silently clip the last digit.
  const clipped = live.slabs.filter((slab) => slab.fontSize !== '12px' || slab.clipped || slab.readingWidth > slab.inner)
  check('every printed reading fits inside its own brick at 12px',
    live.slabs.length > 0 && clipped.length === 0,
    JSON.stringify(clipped.slice(0, 4).map((slab) => [slab.reading, slab.readingWidth, slab.inner, slab.fontSize])))
  check('the newest Turn rests against the right edge of the grid',
    live.slabs.some((slab) => slab.key === 'S:18:1:0' && slab.right === 0 && slab.bottom === 0))
  check('a finished Turn is one cell in from the right, leaving the drop slot',
    live.slabs.some((slab) => slab.key === 'S:17:1:0' && slab.right === PITCH_X))
  check('the window holds exactly the ten newest Turns at the live corner',
    live.turns.join(',') === '9,10,11,12,13,14,15,16,17,18', live.turns.join(','))
  check('the tall Turn shows its floor rows and keeps the rest for the rail',
    live.slabs.filter((slab) => slab.key.startsWith(`S:${TALL_TURN}:`)).length === 40
    && live.slabs.every((slab) => slab.bottom <= (40 - 1) * PITCH_Y))
  await shot('01-live')
  await railShots('01-live')

  // ── the rails themselves ────────────────────────────────────────────────────────────
  const h = live.rails.x
  const v = live.rails.y
  check('the horizontal rail is a thin track under the grid, starting at the grid',
    Math.round(h.width) === gridWidth && Math.round(h.height) === 4
    && Math.round(h.x) === Math.round(live.host.x + 6)
    && Math.round(h.y + h.height) === Math.round(live.host.y + live.host.height - 1),
    `${h.width}x${h.height} @${h.x},${h.y}`)
  check('the vertical rail runs the column pane down the left edge',
    Math.round(v.height) === gridHeight && Math.round(v.x) === Math.round(live.host.x + 1)
    && Math.round(v.y) === Math.round(live.host.y + 16),
    `${v.width}x${v.height} @${v.x},${v.y}`)
  check('the horizontal thumb is sized by the fraction of Turns that fit',
    Math.abs(h.thumbLength - Math.round(gridWidth * (10 / TURNS))) <= 1, `${h.thumbLength}`)
  check('both thumbs start at the live end of their track',
    Math.abs(h.thumbOffset + h.thumbLength - gridWidth) <= 1 && Math.abs(v.thumbOffset + v.thumbLength - gridHeight) <= 1,
    `${h.thumbOffset}/${v.thumbOffset}`)
  check('the vertical thumb reflects 40 visible rows of a 45-row content',
    Math.abs(v.thumbLength - Math.round(gridHeight * (40 / TALL_BRICKS))) <= 1, `${v.thumbLength}`)
  check('the rails report the pan in cells, counting from the content start',
    h.valueNow === '8' && h.valueMax === '8' && v.valueNow === '5' && v.valueMax === '5',
    `x ${h.valueNow}/${h.valueMax} · y ${v.valueNow}/${v.valueMax}`)
  check('a rail with travel is a tab stop, and its text says what is hidden',
    h.tabIndex === 0 && v.tabIndex === 0 && h.valueText.includes('轮') && v.valueText.includes('行'), `${h.valueText} | ${v.valueText}`)

  /** No brick may sit under a rail: the rails are carved out of the band, not laid over it. */
  const overlaps = (board) => board.slabs.filter((slab) => {
    const inH = slab.y + slab.height > board.rails.x.y && slab.y < board.rails.x.y + board.rails.x.height
    const inV = slab.x + slab.width > board.rails.y.x && slab.x < board.rails.y.x + board.rails.y.width
    return inH || inV
  }).map((slab) => slab.key)
  check('no brick is under a rail at the live corner', overlaps(live).length === 0, overlaps(live).join(' '))

  // ── panning by drag: the thumb follows the pointer in track space ───────────────────
  const hThumbBox = await page.locator('[data-cache-bricks-rail="x"] > div').first().boundingBox()
  const travel = gridWidth - h.thumbLength
  await page.mouse.move(hThumbBox.x + hThumbBox.width / 2, hThumbBox.y + hThumbBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(hThumbBox.x + hThumbBox.width / 2 - (travel * 3) / 8, hThumbBox.y + hThumbBox.height / 2, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  const panned = await readBoard()
  check('dragging the thumb three eighths of its travel pages exactly three Turns back',
    panned.turns.join(',') === '6,7,8,9,10,11,12,13,14,15', panned.turns.join(','))
  check('a panned brick keeps its grid: every column moved by exactly three pitches',
    panned.slabs.some((slab) => slab.key === 'S:15:1:0' && slab.right === 0)
    && panned.slabs.some((slab) => slab.key === `S:${TALL_TURN}:1:0` && slab.right === 6 * PITCH_X))
  check('the pan is announced and reversible: the strip grows a control back to the newest',
    panned.live !== undefined && panned.live.text.includes('最新'), panned.live?.text ?? 'no control')
  check('the newest Turns are now hidden to the right, and the fade says so',
    panned.fades.right === true && panned.fades.left === true)
  check('no brick is under a rail while panned', overlaps(panned).length === 0, overlaps(panned).join(' '))
  await shot('02-panned-back')

  // The thumb's whole travel has to reach the oldest Turn, or history is unreachable by drag.
  const pannedThumb = await page.locator('[data-cache-bricks-rail="x"] > div').first().boundingBox()
  const pannedTrack = await page.locator('[data-cache-bricks-rail="x"]').boundingBox()
  await page.mouse.move(pannedThumb.x + pannedThumb.width / 2, pannedThumb.y + pannedThumb.height / 2)
  await page.mouse.down()
  await page.mouse.move(pannedTrack.x + 2, pannedThumb.y + pannedThumb.height / 2, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  const oldest = await readBoard()
  check('dragging the thumb to the start of the track reaches the oldest Turn',
    oldest.turns.join(',') === '1,2,3,4,5,6,7,8,9,10' && oldest.fades.left === false, oldest.turns.join(','))
  await shot('03-oldest')

  // ── back to the live corner ─────────────────────────────────────────────────────────
  await backToLive()
  const returned = await readBoard()
  check('the strip\'s control returns the board to the newest Turn',
    returned.turns.join(',') === '9,10,11,12,13,14,15,16,17,18' && returned.live === undefined)
  check('coming back restores the drop slot and the newest column',
    returned.slabs.some((slab) => slab.key === 'S:18:1:0' && slab.right === 0))

  // ── the wheel belongs to the rail, and only there ───────────────────────────────────
  const beforeWheel = returned.chatScroll
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
  // Wheel-up walks back into history, the same direction the thumb travels.
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(150)
  const wheeled = await readBoard()
  check('the wheel over the rail pans the board',
    wheeled.turns.join(',') === '6,7,8,9,10,11,12,13,14,15', wheeled.turns.join(','))
  check('the wheel over the rail does not move the conversation', wheeled.chatScroll === beforeWheel)
  await backToLive()

  // Off the rail the wheel must keep reaching the transcript: the board is pointer-transparent.
  const beforeTranscript = (await readBoard()).chatScroll
  await page.mouse.move(1000, 600)
  await page.mouse.wheel(0, 300)
  await page.waitForTimeout(200)
  check('the wheel off the rail still scrolls the conversation',
    (await readBoard()).chatScroll > beforeTranscript)
  await page.evaluate(() => { document.querySelector('#scroll').scrollTop = 0 })
  await page.waitForTimeout(150)

  // ── the vertical rail ───────────────────────────────────────────────────────────────
  const vThumb = await page.locator('[data-cache-bricks-rail="y"] > div').first().boundingBox()
  const vTravel = gridHeight - v.thumbLength
  await page.mouse.move(vThumb.x + vThumb.width / 2, vThumb.y + vThumb.height / 2)
  await page.mouse.down()
  await page.mouse.move(vThumb.x + vThumb.width / 2, vThumb.y + vThumb.height / 2 - vTravel, { steps: 16 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  const raised = await readBoard()
  const tall = raised.slabs.filter((slab) => slab.key.startsWith(`S:${TALL_TURN}:`))
  check('dragging the vertical thumb to the top reaches the tall Turn\'s highest brick',
    tall.some((slab) => slab.key === `S:${TALL_TURN}:${TALL_BRICKS}:0` && slab.bottom === 39 * PITCH_Y),
    `${tall.length} bricks, top bottom=${Math.max(...tall.map((slab) => slab.bottom))}`)
  check('raising the window hides the floor rows of every column',
    raised.slabs.every((slab) => !slab.key.endsWith(':1:0') || slab.bottom > 0 || slab.key.startsWith('S:18'))
    && raised.fades.top === false, raised.fades.top === false ? '' : 'top fade still on')
  check('the vertical rail is announced as a control back to the newest',
    raised.live !== undefined, 'no control')
  check('no brick is under a rail while raised', overlaps(raised).length === 0, overlaps(raised).join(' '))
  await shot('04-raised')

  // A rail press on the track pages the window rather than starting a drag from nowhere.
  const vTrack = await page.locator('[data-cache-bricks-rail="y"]').boundingBox()
  await page.mouse.move(vTrack.x + vTrack.width / 2, vTrack.y + vTrack.height - 6)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(200)
  const paged = await readBoard()
  check('pressing the vertical track pages back towards the floor',
    paged.slabs.some((slab) => slab.key === `S:${TALL_TURN}:1:0` && slab.bottom === 0), 'floor row of the tall Turn not back')

  // ── the keyboard ────────────────────────────────────────────────────────────────────
  await backToLive()
  await page.locator('[data-cache-bricks-rail="x"]').focus()
  const beforeKey = await readBoard()
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(150)
  const keyed = await readBoard()
  check('the horizontal rail answers the arrow keys',
    keyed.turns[0] < beforeKey.turns[0], `${beforeKey.turns[0]} → ${keyed.turns[0]}`)
  await page.keyboard.press('Home')
  await page.waitForTimeout(150)
  check('Home goes to the oldest Turn on the board',
    (await readBoard()).turns.join(',') === '1,2,3,4,5,6,7,8,9,10')
  await page.keyboard.press('End')
  await page.waitForTimeout(150)
  check('End comes back to the newest', (await readBoard()).turns.join(',') === '9,10,11,12,13,14,15,16,17,18')

  // An arrow on a brick at the window's edge pans to the neighbour instead of stopping.
  await page.locator('[data-cache-bricks-brick="S:9:1:0"][data-cache-bricks-face="cache"]').focus()
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(250)
  const walked = await readBoard()
  check('an arrow at the window edge pans the window to the neighbour and focuses it',
    walked.slabs.some((slab) => slab.key === 'S:8:1:0' && slab.focused) && walked.turns[0] === 8,
    `focused=${walked.slabs.find((slab) => slab.focused)?.key ?? 'none'}`)
  // And up/down walk the stack the way it is drawn: later steps are higher up.
  await backToLive()
  await page.locator('[data-cache-bricks-brick="S:18:1:0"][data-cache-bricks-face="cache"]').focus()
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(150)
  check('ArrowUp moves to the brick drawn above (a later step)',
    (await readBoard()).slabs.some((slab) => slab.key === 'S:18:2:0' && slab.focused))
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(150)
  check('ArrowDown moves back to the brick drawn below',
    (await readBoard()).slabs.some((slab) => slab.key === 'S:18:1:0' && slab.focused))

  // ── following: a session that grows must not move a reader who is reading history ───
  await backToLive()
  await page.evaluate(() => {
    const feed = window.__fixture.feed
    const last = { ...feed.bricks[feed.bricks.length - 1] }
    const record = {
      ...last,
      identity: { ...last.identity, id: 'S:19:1:0', turn: 19, step: 1 },
      metrics: { ...last.metrics },
      usage: { ...last.usage },
    }
    window.__pushFeed({ ...feed, bricks: [...feed.bricks.filter((brick) => brick.identity.turn < 19), record], endedTurns: [...feed.endedTurns, 18] })
  })
  await page.waitForTimeout(300)
  const grown = await readBoard()
  check('a new Turn arrives in view while the board is following',
    grown.turns.includes(19) && grown.slabs.some((slab) => slab.key === 'S:19:1:0' && slab.right === 0))
  // Pan back, then let the session grow again: the window must hold its Turns.
  const hThumb2 = await page.locator('[data-cache-bricks-rail="x"] > div').first().boundingBox()
  await page.mouse.move(hThumb2.x + hThumb2.width / 2, hThumb2.y + hThumb2.height / 2)
  await page.mouse.down()
  await page.mouse.move(hThumb2.x + hThumb2.width / 2 - 60, hThumb2.y + hThumb2.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  const reading = await readBoard()
  await page.evaluate(() => {
    const feed = window.__fixture.feed
    const last = feed.bricks[feed.bricks.length - 1]
    const record = {
      ...last,
      identity: { ...last.identity, id: 'S:20:1:0', turn: 20, step: 1 },
      metrics: { ...last.metrics },
      usage: { ...last.usage },
    }
    window.__pushFeed({ ...feed, bricks: [...feed.bricks, record], endedTurns: [...feed.endedTurns, 19] })
  })
  await page.waitForTimeout(300)
  const held = await readBoard()
  check('a growing session does not move a reader who is in history',
    held.turns.join(',') === reading.turns.join(','), `${reading.turns.join(',')} → ${held.turns.join(',')}`)
  check('the pan is still announced after the session grew', held.live !== undefined)
  await shot('05-history-while-growing')

  // ── the auxiliary lane is chrome: it stays put while the Turns pan past it ──────────
  // An auxiliary call (compaction, session title) is a real request that belongs to no Turn,
  // so it gets the board's own lane instead of a fabricated column. The lane is chrome pinned
  // to the window's top row: panning moves Turns past it, never through it.
  await backToLive()
  await page.evaluate(() => {
    const feed = window.__fixture.feed
    const template = feed.bricks[0]
    const aux = [1, 2].map((step) => ({
      ...template,
      identity: { ...template.identity, id: `S:0:${step}:0`, turn: 0, step },
      route: { provider: 'fixture', model: 'fixture', purpose: 'session-title' },
      metrics: { ...template.metrics },
      usage: { ...template.usage },
    }))
    window.__pushFeed({ ...feed, bricks: [...feed.bricks, ...aux] })
  })
  await page.waitForTimeout(300)
  /** Drag the horizontal thumb to the far end of the track, where the oldest Turns are. */
  const dragThumbToStart = async () => {
    const track = await page.locator('[data-cache-bricks-rail="x"]').boundingBox()
    const thumb = await page.locator('[data-cache-bricks-rail="x"] > div').first().boundingBox()
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
    await page.mouse.down()
    await page.mouse.move(track.x + 2, thumb.y + thumb.height / 2, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(250)
  }
  await dragThumbToStart()
  const withLane = await readBoard()
  const auxSlabs = withLane.slabs.filter((slab) => slab.key.startsWith('S:0:'))
  const laneLabel = await page.locator('[data-cache-bricks-lane="label"]').isVisible()
  check('auxiliary calls take the board\'s own lane on its top row, not a Turn column',
    laneLabel && auxSlabs.length === 2
    && auxSlabs.every((slab) => slab.bottom === 39 * PITCH_Y)
    && withLane.slabs.every((slab) => slab.key.startsWith('S:0:') || slab.bottom !== 39 * PITCH_Y),
    `${String(auxSlabs.length)} aux, bottoms ${auxSlabs.map((slab) => String(slab.bottom)).join(',')}`)
  check('the lane costs the Turn columns exactly one row',
    withLane.slabs.filter((slab) => slab.key.startsWith(`S:${TALL_TURN}:`)).length === 39
    && withLane.slabs.filter((slab) => slab.key.startsWith(`S:${TALL_TURN}:`)).every((slab) => slab.bottom <= 38 * PITCH_Y),
    `${String(withLane.slabs.filter((slab) => slab.key.startsWith(`S:${TALL_TURN}:`)).length)} bricks of the tall Turn`)
  // One cell towards the newest: every Turn column moves a pitch, the lane does not.
  const laneTrack = await page.locator('[data-cache-bricks-rail="x"]').boundingBox()
  const laneThumb = await page.locator('[data-cache-bricks-rail="x"] > div').first().boundingBox()
  await page.mouse.move(laneThumb.x + laneThumb.width / 2, laneThumb.y + laneThumb.height / 2)
  await page.mouse.down()
  // Two cells of travel, so the pan is unambiguous against the cell rounding.
  await page.mouse.move(laneThumb.x + laneThumb.width / 2 + 25, laneThumb.y + laneThumb.height / 2, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(250)
  const pannedWithLane = await readBoard()
  const auxKept = pannedWithLane.slabs.filter((slab) => slab.key.startsWith('S:0:'))
  check('the lane stays pinned while the Turns pan past it',
    auxKept.length === 2
    && auxKept.every((slab) => auxSlabs.some((was) => was.key === slab.key && was.right === slab.right && was.bottom === slab.bottom))
    && pannedWithLane.turns[0] > withLane.turns[0],
    `${withLane.turns[0]} → ${pannedWithLane.turns[0]} · aux ${JSON.stringify(auxKept.map((slab) => [slab.right, slab.bottom]))}`)
  void laneTrack
  await shot('07-lane-pinned')

  // ── the flip still works with the window panned ─────────────────────────────────────
  const beforeFlip = await readBoard()
  await board.locator('[data-cache-bricks-flip]').click()
  await page.waitForTimeout(500)
  const flipped = await page.evaluate(() => {
    const type = [...document.querySelectorAll('[data-cache-bricks-brick][data-cache-bricks-face="type"]')]
    return { count: type.length, keys: type.map((element) => element.dataset.cacheBricksBrick).sort() }
  })
  const cacheKeys = beforeFlip.slabs.map((slab) => slab.key).sort()
  check('the back face mirrors exactly the window that is panned',
    flipped.count === cacheKeys.length && flipped.keys.join(',') === cacheKeys.join(','),
    `${String(flipped.count)} vs ${String(cacheKeys.length)}`)

  // The keys the page and the last measurement agree on, so a later failure names the state.
  void held
  await shot('06-back-face')
  await board.locator('[data-cache-bricks-flip]').click()
  await page.waitForTimeout(400)

  // The palette, through the real mapping: the fixture's three steps sit in the three bands,
  // and the cache face shows the three tone materials (translucent green, amber, flat red).
  const palette = await page.evaluate(() => {
    const wanted = ['99.0%', '85.0%', '60.0%']
    const found = {}
    for (const slab of document.querySelectorAll('[data-cache-bricks-brick]')) {
      const text = (slab.textContent ?? '').trim()
      if (wanted.includes(text)) found[text] = getComputedStyle(slab).backgroundColor
    }
    return found
  })
  check('the three tone bands reach the pixels (90% green, 85% amber, 60% red)',
    palette['99.0%'] === 'rgba(34, 197, 94, 0.18)'
    && palette['85.0%'] === 'rgba(234, 179, 8, 0.85)'
    && palette['60.0%'] === 'rgb(220, 38, 38)',
    JSON.stringify(palette))

  // ══ 0.1.4: history as a scene, and a paint the size of the window ══════════════════
  //
  // The two halves of this release are invisible to a board whose feed already covers every
  // Turn, which is what every check above uses. So this section builds the shape the plugin
  // actually meets in a long session:
  //
  //   the fold   — cold geometry: one reading per step, no type, no target (`readingsOf`);
  //   the window — the durable events the session holds, enough to rebuild exact bricks;
  //   the scene  — the slice of that window the board is *showing*, replayed into bricks.
  //
  // Nothing here is measured through plugin internals: the bricks are read off the DOM, and the
  // only fixture-side counters are the ones a session would keep anyway (`loadOlder` calls).

  /** Install the paging world: a fold, a window with step brackets, and a session that pages. */
  await page.evaluate(() => {
    const fixture = window.__fixture
    const jsx = window.__testExternals['react/jsx-runtime'].jsx

    /** One fold node per Turn: a reading per step, which is all the fold ever has. */
    const foldNode = (turn) => ({
      turn,
      ended: true,
      steps: [1, 2].map((step) => ({
        step,
        seq: turn * 100 + step,
        provider: 'fixture',
        stepStartTime: 1_000,
        firstTokenTime: 1_100,
        usageTime: 1_500,
        usage: { inputTokens: 40, cacheReadTokens: 960, cacheWriteTokens: 0, outputTokens: 20 },
      })),
    })

    /** The durable events of one Turn: a bracket per step, with a tool call inside it. */
    const turnEvents = (turn) => {
      const made = []
      for (const step of [1, 2]) {
        made.push(['step/start', { turn, step }])
        made.push(['assistant/message', {
          turn,
          step,
          message: { role: 'assistant' },
          stream: [
            { type: 'tool-call-chunks', time0: 1_100, index: 0, dt: [5], id: `call-${turn}-${step}`, name: 'bash', args: ['{"cmd":"ls"}'] },
            { type: 'chunk', time: 1_300, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 } } },
            { type: 'chunk', time: 1_300, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
          ],
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0 },
        }])
        made.push(['tool/call', { turn, step, callId: `call-${turn}-${step}`, name: 'bash', arguments: '{"cmd":"ls"}' }])
        made.push(['tool/result', { turn, step, message: { role: 'tool' } }])
        made.push(['step/end', { turn, step }])
      }
      made.push(['turn/end', { turn, reason: { kind: 'completed' } }])
      return made
    }

    const page = {
      /** Durable events, oldest first, exactly as the window publishes them. */
      entries: [],
      seq: 3,
      revision: 1,
      hasMore: false,
      /** Turns the fold has rendered, oldest first. */
      fold: [],
      /** Turns whose events the window holds. */
      held: [],
      /** What the next page would give: older Turns, newest of them first. */
      pending: [],
      loads: 0,
      listeners: [],
      append(types) {
        for (const [type, data] of types) {
          page.entries.push({ type: 'event', event: { seq: page.seq, type, time: page.seq * 100, data } })
          page.seq += 1
        }
        page.revision += 1
      },
      /** Prepends count down from zero, so a second page never reuses the first page's seqs. */
      front: 0,
      addTurn(turn, at) {
        const made = turnEvents(turn)
        if (at === 'start') {
          page.front -= made.length
          page.entries.unshift(...made.map(([type, data], index) => ({
            type: 'event',
            event: { seq: page.front + index, type, time: 0, data },
          })))
        } else page.append(made)
        page.revision += 1
      },
      /** The fold's snapshot: only the Turns the conversation has rendered. */
      nodes() {
        return new Map(page.fold.map((turn) => [`fold-${turn}`, { kind: 'cache-bricks', data: foldNode(turn) }]))
      },
      /** One page, the way the runtime lands it: older Turns at the older end, one prepend. */
      land(count) {
        const older = page.pending.splice(0, count)
        for (const turn of older.slice().reverse()) page.addTurn(turn, 'start')
        page.fold = [...older, ...page.fold]
        page.hasMore = page.pending.length > 0
        page.revision += 1
        for (const listener of page.listeners) listener()
      },
    }
    window.__page = page

    // The session face gains the two things 0.1.4 reads: a pager and a subscription.
    const face = fixture.faces.S
    face.loadOlder = async () => { page.loads += 1; page.land(2) }
    face.getSnapshot = () => ({ hasMore: page.hasMore, loadingOlder: false })
    face.subscribe = (listener) => { page.listeners.push(listener); return () => {} }
    fixture.snapshots.S = {
      get entries() { return page.entries },
      get hasMore() { return page.hasMore },
      get revision() { return page.revision },
    }

    // The collector's own process: it sees the newest Turn only, as it does on a resumed session.
    const liveBrick = (turn) => ({
      observedBy: 'host',
      identity: { id: `S:${turn}:1:0`, sessionId: 'S', turn, step: 1, attemptOrdinal: 0 },
      settlement: 'message', settlementSeq: turn * 100 + 1,
      route: { provider: 'fixture', model: 'fixture' },
      usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 },
      metrics: { promptTokens: 1_000, cacheHitRatio: 0.9, chunkCount: 3, textChars: 10, reasoningChars: 0, toolCallCount: 0 },
      request: {}, tools: [], raw: {},
    })

    // Start: the window holds Turns 7..8 (the loaded tail) and the fold has rendered both.
    // Turns 5..6 and 3..4 are the two pages below it, and are not in the window until they land.
    for (const turn of [7, 8]) page.addTurn(turn)
    page.fold = [7, 8]
    fixture.records.S = [liveBrick(8)]
    window.__pushFeed({ sessionId: 'S', bricks: [liveBrick(8)], endedTurns: [1, 2, 3, 4, 5, 6, 7], store: { blobs: 0, bytes: 0 } })

    /** Render the board with a fold behind it, which is what a real seat always has. */
    fixture.renderFold = () => {
      const useChat = (selector) => selector({ nodes: page.nodes() })
      fixture.root.render(jsx(fixture.Component, { sessionId: 'S', useChat }))
    }
  })
  await page.evaluate(() => window.__fixture.renderFold())
  await page.waitForTimeout(500)

  /** Read the bricks that are on the board, with what each one says about where it came from. */
  const readTypes = () => page.evaluate(() => [...document.querySelectorAll('[data-cache-bricks-brick][data-cache-bricks-face="cache"]')]
    .map((element) => ({
      key: element.dataset.cacheBricksBrick,
      turn: Number(element.dataset.cacheBricksBrick.split(':')[1]),
      label: element.getAttribute('aria-label') ?? '',
      reading: (element.textContent ?? '').trim(),
    })))

  const typedTurnOne = await readTypes()
  const REPLAYED = 'reconstructed from the session log'
  check('the fold alone gives the board its older Turns, and the scene types them',
    typedTurnOne.filter((brick) => brick.turn === 7).length === 2
    && typedTurnOne.filter((brick) => brick.turn === 7).every((brick) => brick.label.includes(REPLAYED))
    // Turn 8's first attempt is the collector's own capture, and it stays the live brick: a
    // replaying board must not overwrite what the process actually saw.
    && typedTurnOne.some((brick) => brick.key === 'S:8:1:0' && !brick.label.includes(REPLAYED)),
    JSON.stringify(typedTurnOne.map((brick) => [brick.key, brick.label.includes(REPLAYED)])))

  // The scene is a slice, not a scan: the bricks it holds are exactly the steps of the Turns on
  // screen (two each here), so a Turn the window cannot type would be visibly missing.
  check('every step of a replayed Turn reaches the board',
    typedTurnOne.filter((brick) => brick.turn === 7).length === 2
    && typedTurnOne.filter((brick) => brick.turn === 7).every((brick) => /^\d{1,2}\.\d%$/u.test(brick.reading)),
    JSON.stringify(typedTurnOne.filter((brick) => brick.turn === 7).map((brick) => brick.reading)))

  // ── the reader reaches the left edge, and a page arrives ────────────────────────────
  await page.evaluate(() => { window.__page.pending = [6, 5]; window.__page.hasMore = true })
  await page.evaluate(() => window.__fixture.renderFold())
  await page.waitForTimeout(600)
  const pagedTypes = await readTypes()
  check('reaching the left edge asks for a page, and the page becomes board',
    (await page.evaluate(() => window.__page.loads)) === 1
    && pagedTypes.some((brick) => brick.turn === 5) && pagedTypes.some((brick) => brick.turn === 6),
    `loads ${await page.evaluate(() => window.__page.loads)} · turns ${[...new Set(pagedTypes.map((brick) => brick.turn))].join(',')}`)
  check('the paged Turns are typed from the log, not estimated by the fold',
    pagedTypes.filter((brick) => brick.turn === 5).length === 2
    && pagedTypes.filter((brick) => brick.turn === 5).every((brick) => brick.label.includes(REPLAYED)),
    JSON.stringify(pagedTypes.filter((brick) => brick.turn === 5).map((brick) => [brick.key, brick.label.includes(REPLAYED)])))

  // One more page is still due (the board shows everything it holds), and the pager stops when
  // the session says history is exhausted — the difference between paging and a request loop.
  await page.evaluate(() => { window.__page.hasMore = true; window.__page.pending = [4, 3] })
  await page.evaluate(() => window.__fixture.renderFold())
  await page.waitForTimeout(600)
  const exhausted = await page.evaluate(() => ({ loads: window.__page.loads, hasMore: window.__page.hasMore }))
  check('paging stops by itself when the session runs out of history',
    exhausted.hasMore === false && exhausted.loads === 2, JSON.stringify(exhausted))

  // ── the pan does not move when the content grows at either end ──────────────────────
  //
  // A session long enough to pan in: twenty Turns of live bricks, and the fold holding the same
  // twenty, which is what a resumed session looks like. The pager stays quiet — the reader is
  // nowhere near the left edge — so the page that lands below is one this test lands by hand.
  await page.evaluate(() => {
    const live = (turn, step) => ({
      observedBy: 'host',
      identity: { id: `S:${turn}:${step}:0`, sessionId: 'S', turn, step, attemptOrdinal: 0 },
      settlement: 'message', settlementSeq: turn * 100 + step,
      route: { provider: 'fixture', model: 'fixture' },
      usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 },
      metrics: { promptTokens: 1_000, cacheHitRatio: 0.9, chunkCount: 3, textChars: 10, reasoningChars: 0, toolCallCount: 0 },
      request: {}, tools: [], raw: {},
    })
    const bricks = []
    for (let turn = 11; turn <= 30; turn += 1) {
      bricks.push(live(turn, 1))
      bricks.push(live(turn, 2))
    }
    window.__fixture.records.S = bricks
    window.__pushFeed({ sessionId: 'S', bricks, endedTurns: Array.from({ length: 19 }, (_, index) => index + 11), store: { blobs: 0, bytes: 0 } })
    // The fold covers the same Turns, so the board's geometry is the fold's and the types are
    // the scene's — the split this release is about.
    window.__page.fold = Array.from({ length: 20 }, (_, index) => index + 11)
    window.__page.entries = []
    window.__page.seq = 3
    for (const turn of window.__page.fold) window.__page.addTurn(turn)
    window.__page.hasMore = true
    // One page ready below the loaded history: five Turns, so a landed page is unmistakable
    // against a one-cell rounding error.
    window.__page.pending = [10, 9, 8, 7, 6]
    window.__fixture.renderFold()
  })
  await page.waitForTimeout(600)

  /** Drag the horizontal thumb by whole cells, the way the rail checks above do. */
  const panBack = async (cells) => {
    const track = await page.locator('[data-cache-bricks-rail="x"]').boundingBox()
    const handle = await page.locator('[data-cache-bricks-rail="x"] > div').first().boundingBox()
    const furthest = Number(await page.locator('[data-cache-bricks-rail="x"]').getAttribute('aria-valuemax'))
    const travel = track.width - handle.width
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 - (travel * cells) / Math.max(1, furthest), handle.y + handle.height / 2, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(350)
  }

  const beforePan = await readBoard()
  await panBack(2)
  const pannedBoard = await readBoard()
  const pannedTurns = pannedBoard.turns
  check('the reader can pan back into the folded Turns',
    pannedTurns.length > 0 && pannedTurns[0] < beforePan.turns[0],
    `${beforePan.turns.join(',')} → ${pannedTurns.join(',')}`)

  // An append at the live end (a new Turn) and a prepend at the older end (a page landing), in
  // that order: neither may move the reader, and the prepend is the one 0.1.3 got wrong.
  await page.evaluate(() => {
    const page = window.__page
    page.fold = [...page.fold, 31]
    page.append([['step/start', { turn: 31, step: 1 }]])
    window.__pushFeed({
      sessionId: 'S',
      bricks: [...window.__fixture.records.S, {
        observedBy: 'host',
        identity: { id: 'S:31:1:0', sessionId: 'S', turn: 31, step: 1, attemptOrdinal: 0 },
        settlement: 'message', settlementSeq: 3_101,
        route: { provider: 'fixture', model: 'fixture' },
        usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 },
        metrics: { promptTokens: 1_000, cacheHitRatio: 0.9, chunkCount: 3, textChars: 10, reasoningChars: 0, toolCallCount: 0 },
        request: {}, tools: [], raw: {},
      }],
      endedTurns: [],
      store: { blobs: 0, bytes: 0 },
    })
    // Now the page: five older Turns at the far end of everything the board holds.
    page.land(5)
  })
  await page.evaluate(() => window.__fixture.renderFold())
  await page.waitForTimeout(600)
  const afterGrowth = await readBoard()
  // The page really landed (five more cells of history to pan into), and the reader did not move.
  check('a landed page adds history without shoving the reader into it',
    afterGrowth.rails.x.valueMax > pannedBoard.rails.x.valueMax
    && afterGrowth.turns.join(',') === pannedTurns.join(','),
    `limit ${String(pannedBoard.rails.x.valueMax)} → ${String(afterGrowth.rails.x.valueMax)} · ${pannedTurns.join(',')} → ${afterGrowth.turns.join(',')}`)

  // ── a paint costs the viewport, not the session ─────────────────────────────────────
  await page.evaluate(() => {
    const bricks = []
    for (let turn = 1; turn <= 2_000; turn += 1) {
      for (let step = 1; step <= 3; step += 1) {
        bricks.push({
          observedBy: 'host',
          identity: { id: `S:${turn}:${step}:0`, sessionId: 'S', turn, step, attemptOrdinal: 0 },
          settlement: 'message', settlementSeq: turn * 100 + step,
          route: { provider: 'fixture', model: 'fixture' },
          usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 },
          metrics: { promptTokens: 1_000, cacheHitRatio: 0.9, chunkCount: 3, textChars: 10, reasoningChars: 0, toolCallCount: 0 },
          request: {}, tools: [], raw: {},
        })
      }
    }
    window.__fixture.records.S = bricks
    window.__pushFeed({ sessionId: 'S', bricks, endedTurns: Array.from({ length: 1_999 }, (_, index) => index + 1), store: { blobs: 0, bytes: 0 } })
  })
  await page.waitForTimeout(500)
  const huge = await page.evaluate(() => ({
    slabs: document.querySelectorAll('[data-cache-bricks-brick]').length,
    turns: [...new Set([...document.querySelectorAll('[data-cache-bricks-brick][data-cache-bricks-face="cache"]')]
      .map((element) => Number(element.dataset.cacheBricksBrick.split(':')[1])).filter((turn) => turn > 0))].length,
  }))
  // Six thousand bricks of history; the board may only hold the cells it can show.
  check('a six-thousand-brick session paints a window, not a session',
    huge.slabs <= 10 * 40 * 2 && huge.turns <= 10,
    JSON.stringify(huge))
  // And a jump to the far end of that history keeps it that way: the range is arithmetic, so
  // the cost of the oldest Turn is the cost of the newest.
  await page.locator('[data-cache-bricks-rail="x"]').focus()
  await page.keyboard.press('Home')
  await page.waitForTimeout(700)
  const atTheStart = await page.evaluate(() => ({
    slabs: document.querySelectorAll('[data-cache-bricks-brick]').length,
    turns: [...new Set([...document.querySelectorAll('[data-cache-bricks-brick][data-cache-bricks-face="cache"]')]
      .map((element) => Number(element.dataset.cacheBricksBrick.split(':')[1])).filter((turn) => turn > 0))].sort((a, b) => a - b),
  }))
  check('the oldest Turn of two thousand costs the same paint as the newest',
    atTheStart.slabs <= 10 * 40 * 2 && atTheStart.turns[0] === 1 && atTheStart.turns.length <= 10,
    JSON.stringify([atTheStart.turns[0], atTheStart.turns.length, atTheStart.slabs]))
  await backToLive()
  await shot('08-scene-and-scale')

  check('no unhandled browser error', pageErrors.length === 0, pageErrors.join(' | '))

  // An optional public screenshot uses synthetic records, never a person's conversation.
  // Keep it after the assertions so presentation data cannot influence the test result.
  if (args.includes('--showcase') && shotDir !== undefined) {
    await page.evaluate(() => {
      const heights = [4, 9, 6, 12, 3, 15, 7, 11, 5, 10]
      const bricks = []
      for (let turn = 1; turn <= heights.length; turn += 1) {
        for (let step = 1; step <= heights[turn - 1]; step += 1) {
          const ratio = (turn + step) % 17 === 0 ? 0.6 : (turn + step) % 5 === 0 ? 0.85 : 0.99
          bricks.push({
            observedBy: 'host',
            identity: { id: `S:${turn}:${step}:0`, sessionId: 'S', turn, step, attemptOrdinal: 0 },
            settlement: 'message', settlementSeq: turn * 100 + step,
            route: { provider: 'fixture', model: 'fixture' },
            usage: { inputTokens: Math.round(2000 * (1 - ratio)), cacheReadTokens: Math.round(2000 * ratio), outputTokens: 20 },
            metrics: { promptTokens: 2000, cacheHitRatio: ratio, chunkCount: 3, textChars: 10,
              reasoningChars: step % 3 === 0 ? 10 : 0, toolCallCount: step % 4 === 0 ? 1 : 0 },
            request: {}, tools: [], raw: {},
          })
        }
      }
      window.__fixture.records.S = bricks
      window.__pushFeed({ sessionId: 'S', bricks, endedTurns: heights.slice(0, -1).map((_, index) => index + 1), store: { blobs: 0, bytes: 0 } })
    })
    await page.waitForTimeout(300)
    const latest = board.locator('[data-cache-bricks-live]')
    if (await latest.isVisible()) await latest.click()
    await page.waitForTimeout(250)
    mkdirSync(shotDir, { recursive: true })
    const box = await board.boundingBox()
    const clip = { x: box.x, y: box.y + box.height - 340, width: box.width, height: 340 }
    await page.screenshot({ path: join(shotDir, 'showcase-cache.png'), clip })
    await board.locator('[data-cache-bricks-flip]').click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(shotDir, 'showcase-activity.png'), clip })
  }

  if (shotDir !== undefined) mkdirSync(shotDir, { recursive: true })
  if (process.env.DSH_TEST_REPORT !== undefined) {
    writeFileSync(process.env.DSH_TEST_REPORT, JSON.stringify({
      runtime: 'Chromium + React 18; DSH services and collector feed are fixtures',
      results, failures, pageErrors,
    }, null, 2))
  }
  console.log(`\n${results.length - failures.length}/${results.length} checks passed (Chromium, React 18; mocked DSH services, NOT a live DSH instance).`)
  if (failures.length > 0) {
    console.log(`failures:\n${failures.map((name) => `  ✗ ${name}`).join('\n')}`)
    process.exitCode = 1
  }
} finally {
  await browser.close()
}
