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
    // The ring is painted, not shown: it lives just outside the grid so a fractional pan never
    // exposes an edge, and the face clips it. Every "what the reader sees" assertion reads the
    // un-ringed set; the ring is counted separately, and checked on its own.
    const slabs = [...document.querySelectorAll('[data-cache-bricks-brick][data-cache-bricks-face="cache"]:not([data-cache-bricks-ring])')].map((element) => {
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
    const plane = document.querySelector('[data-cache-bricks-plane="cache"]')
    const transformOf = (element) => {
      if (element === null) return ''
      const value = getComputedStyle(element).transform
      return value === 'none' ? '' : value
    }
    return {
      host: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      rails: { x: rail('x'), y: rail('y') },
      // The motion plane: the one element a pan moves, and its offset in pixels.
      plane: (() => {
        if (plane === null) return undefined
        const matrix = new DOMMatrixReadOnly(transformOf(plane) === '' ? undefined : transformOf(plane))
        return { transform: transformOf(plane), x: Math.round(matrix.m41 * 100) / 100, y: Math.round(matrix.m42 * 100) / 100 }
      })(),
      ring: document.querySelectorAll('[data-cache-bricks-brick][data-cache-bricks-ring]').length,
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
    const type = [...document.querySelectorAll('[data-cache-bricks-brick][data-cache-bricks-face="type"]:not([data-cache-bricks-ring])')]
    return { count: type.length, keys: type.map((element) => element.dataset.cacheBricksBrick).sort() }
  })
  const cacheKeys = beforeFlip.slabs.map((slab) => slab.key).sort()
  check('the back face mirrors exactly the window that is panned',
    flipped.count === cacheKeys.length && flipped.keys.join(',') === cacheKeys.join(','),
    `${String(flipped.count)} vs ${String(cacheKeys.length)} · only-type ${flipped.keys.filter((key) => !cacheKeys.includes(key)).join(',')} · only-cache ${cacheKeys.filter((key) => !flipped.keys.includes(key)).join(',')}`)

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
  // A page landing is growth: the window gains events at the older end and nothing already indexed
  // changes meaning. The index has to be extended by the page, not rebuilt from the whole window —
  // this is the check that would have caught 0.1.4.b re-scanning every loaded event per page.
  const indexAfterPage = await page.evaluate(() => window.__dshCacheBricksStats?.()?.scene)
  check('a page landing indexes the page, not the window',
    indexAfterPage !== undefined && (indexAfterPage.windowDeltas ?? 0) >= 1
    && (indexAfterPage.indexDeltaEvents ?? 0) < 200,
    JSON.stringify({ deltas: indexAfterPage?.windowDeltas, deltaEvents: indexAfterPage?.indexDeltaEvents, full: indexAfterPage?.windows }))
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
    slabs: document.querySelectorAll('[data-cache-bricks-brick]:not([data-cache-bricks-ring])').length,
    ring: document.querySelectorAll('[data-cache-bricks-brick][data-cache-bricks-ring]').length,
    turns: [...new Set([...document.querySelectorAll('[data-cache-bricks-brick][data-cache-bricks-face="cache"]:not([data-cache-bricks-ring])')]
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
    slabs: document.querySelectorAll('[data-cache-bricks-brick]:not([data-cache-bricks-ring])').length,
    turns: [...new Set([...document.querySelectorAll('[data-cache-bricks-brick][data-cache-bricks-face="cache"]:not([data-cache-bricks-ring])')]
      .map((element) => Number(element.dataset.cacheBricksBrick.split(':')[1])).filter((turn) => turn > 0))].sort((a, b) => a - b),
  }))
  check('the oldest Turn of two thousand costs the same paint as the newest',
    atTheStart.slabs <= 10 * 40 * 2 && atTheStart.turns[0] === 1 && atTheStart.turns.length <= 10,
    JSON.stringify([atTheStart.turns[0], atTheStart.turns.length, atTheStart.slabs]))
  await backToLive()
  await shot('08-scene-and-scale')

  // ── a drag costs the scene it lands on, not the session it crosses ──────────────────
  //
  // 0.1.4 draws a window and pans by arithmetic, so a drag *looks* like pure geometry. It was not:
  // every painted frame of a drag cut a new scene, and answering that scene — replaying the log
  // slice, then re-rendering the board from it — happened inside the frame that asked. The unit
  // tests could not see it (they pin the shape of the window) and neither could this script (no
  // counter in the DOM says how often the board asked for a scene). What is pinned here is the
  // timing: a drag asks for **nothing** while the pointer is down and **once** when it comes up,
  // and the thing it asks for is a slice of the log rather than the log.
  //
  // The counters come from `window.__dshCacheBricksStats` (see `docs/verification.md`). A build
  // that does not publish them fails the first check rather than passing silently.
  await page.evaluate(() => {
    const page = window.__page
    // A frozen world: two thousand Turns of durable history (ten events each), the same Turns in
    // the fold, and no page left to land — a landing window clears every scene, and this check is
    // about the cost of a drag rather than of history arriving.
    page.entries.length = 0
    page.seq = 3
    page.front = 0
    page.pending.length = 0
    page.hasMore = false
    for (let turn = 1; turn <= 2_000; turn += 1) page.addTurn(turn)
    page.fold = Array.from({ length: 2_000 }, (_, index) => index + 1)
    page.revision += 1
    for (const listener of page.listeners) listener()
  })
  await page.evaluate(() => {
    const fixture = window.__fixture
    const jsx = window.__testExternals['react/jsx-runtime'].jsx
    const perf = { renders: 0, frames: [], sampling: false, longtasks: 0, longtasksSupported: false }
    window.__perf = perf
    // A render of the board is the one thing the DOM cannot show. `useChat` is called during every
    // render of the plugin's component, so counting its calls counts the renders — which is what
    // makes this check readable against a build with no counters at all.
    // The real hook is zustand's `useStore(selector)`, which memoizes the selection: the same store
    // snapshot hands back the *same* array. The fixture used to build a fresh `nodes` array on every
    // call, which made the data layer believe the fold had changed on every render — an artifact
    // that hid the very difference these checks measure. Cache it on the fold's own shape.
    let nodesCache
    let nodesKey
    const nodesOf = () => {
      const fold = window.__page.fold
      const key = `${String(fold.length)}:${String(fold[0] ?? '')}:${String(fold[fold.length - 1] ?? '')}`
      if (nodesKey !== key) {
        nodesKey = key
        nodesCache = window.__page.nodes()
      }
      return nodesCache
    }
    // ...and `useSyncExternalStoreWithSelector` memoizes the *selection* too: the same snapshot
    // yields the same selected value, so a render that changed nothing hands the component the very
    // array it had. Without this the fixture rebuilt the fold on every render, which is exactly the
    // cost the world is meant to keep off the pan path.
    let selectionCache
    let selectionKey
    fixture.renderFold = () => {
      const useChat = (selector) => {
        perf.renders += 1
        const nodes = nodesOf()
        if (selectionKey !== nodes) {
          selectionKey = nodes
          selectionCache = selector({ nodes })
        }
        return selectionCache
      }
      fixture.root.render(jsx(fixture.Component, { sessionId: 'S', useChat }))
    }
    perf.longtasksSupported = Array.isArray(PerformanceObserver.supportedEntryTypes)
      && PerformanceObserver.supportedEntryTypes.includes('longtask')
    if (perf.longtasksSupported) {
      new PerformanceObserver((list) => { perf.longtasks += list.getEntries().length })
        .observe({ entryTypes: ['longtask'] })
    }
  })
  await page.evaluate(() => window.__fixture.renderFold())
  await page.waitForTimeout(700)

  const readStats = () => page.evaluate(() => {
    const stats = window.__dshCacheBricksStats?.()
    return {
      published: stats !== undefined,
      board: stats?.board ?? { demands: 0, deferred: 0, flushed: 0 },
      scene: stats?.scene ?? { windows: 0, demands: 0, cached: 0, replays: 0, sliceEvents: 0, replayMs: 0 },
      window: stats?.window ?? { asked: 0, materialized: 0 },
      raw: stats?.raw ?? { hashes: 0, skipped: 0 },
      renders: window.__perf.renders,
      longtasks: window.__perf.longtasks,
      longtasksSupported: window.__perf.longtasksSupported,
      windowEvents: window.__page.entries.length,
    }
  })
  const startFrames = () => page.evaluate(() => {
    window.__perf.frames = []
    window.__perf.sampling = true
    const tick = (time) => {
      if (!window.__perf.sampling) return
      window.__perf.frames.push(time)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const stopFrames = () => page.evaluate(() => {
    window.__perf.sampling = false
    const frames = window.__perf.frames
    let maxGap = 0
    for (let index = 1; index < frames.length; index += 1) {
      maxGap = Math.max(maxGap, frames[index] - frames[index - 1])
    }
    return { count: frames.length, maxGap: Math.round(maxGap) }
  })

  // A render that does not move the window must not copy it. `renderFold` re-renders the tree from
  // the top, which is what a panel opening or a tab switching does to this component; the window
  // is twenty thousand events, and walking and sorting it per render is exactly the cost the
  // revision counter in `windowKeyOfSnapshot` exists to avoid.
  const beforeNoop = await readStats()
  await page.evaluate(() => window.__fixture.renderFold())
  // A React root render is scheduled, not synchronous: give the commit a frame before reading.
  await page.waitForTimeout(100)
  const afterNoop = await readStats()
  check('a render that does not move the window does not copy it',
    afterNoop.window.asked > beforeNoop.window.asked
    && afterNoop.window.materialized === beforeNoop.window.materialized,
    `asked ${beforeNoop.window.asked}→${afterNoop.window.asked}, copied ${beforeNoop.window.materialized}→${afterNoop.window.materialized}`)

  // The drag itself: press exactly on the thumb (a press on the track pages first), drag half the
  // rail's travel in 120 moves, and read the counters **while the pointer is still down**.
  const trackBox = await page.locator('[data-cache-bricks-rail="x"]').boundingBox()
  const thumbBox = await page.locator('[data-cache-bricks-rail="x"] > div').first().boundingBox()
  const beforeDrag = await readStats()
  const boardBefore = await readBoard()
  await startFrames()
  const centre = { x: thumbBox.x + thumbBox.width / 2, y: thumbBox.y + thumbBox.height / 2 }
  await page.mouse.move(centre.x, centre.y)
  await page.mouse.down()
  await page.mouse.move(centre.x - (trackBox.width - thumbBox.width) / 2, centre.y, { steps: 120 })
  const duringDrag = await readStats()
  await page.mouse.up()
  const frames = await stopFrames()
  await page.waitForTimeout(500)
  const afterDrag = await readStats()
  const boardAfter = await readBoard()

  check('the drag really panned (the check is not measuring a still board)',
    boardAfter.turns.join(',') !== boardBefore.turns.join(','),
    `${boardBefore.turns.join(',')} → ${boardAfter.turns.join(',')}`)
  check('the board publishes what a pan cost',
    duringDrag.published && afterDrag.published,
    JSON.stringify(duringDrag.board))
  check('a drag asks the data layer for nothing while the pointer is down',
    duringDrag.published
    && duringDrag.board.demands === beforeDrag.board.demands
    && duringDrag.scene.demands === beforeDrag.scene.demands,
    `board ${beforeDrag.board.demands}→${duringDrag.board.demands}, scene ${beforeDrag.scene.demands}→${duringDrag.scene.demands}`)
  check('a drag re-renders the board zero times while the pointer is down',
    duringDrag.renders === beforeDrag.renders,
    `renders ${beforeDrag.renders}→${duringDrag.renders}`)
  check('the scenes the drag crossed were deferred, not dropped',
    duringDrag.board.deferred > beforeDrag.board.deferred + 1,
    `deferred ${beforeDrag.board.deferred}→${duringDrag.board.deferred}`)
  // On release the deferred demand goes out — exactly one, and exactly one replay behind it. The
  // board may ask once more immediately after, because materializing a scene changes the bricks the
  // board is drawing and a scene plan is made of bricks: the re-cut converges on the first retry.
  // What must not survive is the old shape of the cost — an ask per painted frame, for as long as
  // the reader keeps moving.
  const released = afterDrag.board.demands - duringDrag.board.demands
  // Scenes are assembled out of steps now, so the *step* replays are not the unit this check is
  // about: what must not happen is a second scene cut after the hand let go (`assembled` counts
  // those). The step count rides along in the detail.
  const replayedAfter = afterDrag.scene.assembled - duringDrag.scene.assembled
  const stepsAfter = afterDrag.scene.replays - duringDrag.scene.replays
  check('the scene the drag landed on is materialized once, on release',
    afterDrag.board.flushed - duringDrag.board.flushed === 1
    && released >= 1 && released <= 2
    && replayedAfter <= 2,
    `demands ${duringDrag.board.demands}→${afterDrag.board.demands}, flushed ${duringDrag.board.flushed}→${afterDrag.board.flushed}, scenes cut ${String(replayedAfter)}, steps replayed ${String(stepsAfter)}`)
  // The replay it triggers is handed the slice the window shows, not the window: a scene is a few
  // screens, so a twenty-thousand-event session must not be replayed whole.
  const sliced = afterDrag.scene.sliceEvents - beforeDrag.scene.sliceEvents
  // The other half of a replay's cost: it is *lazy* about raw payloads. Every scene cut in this
  // drag would have canonicalized and SHA-256'd each settled attempt's stream, each tool result and
  // each header into the blob store — work nobody asked for while a board is being drawn. The
  // payloads are not lost: they are the session's own events, read by seq when a reader opens one
  // (`logRawPayload`). This is the check that keeps "raw hashes: 0" honest.
  const hashes = afterDrag.raw.hashes - beforeDrag.raw.hashes
  const skipped = afterDrag.raw.skipped - beforeDrag.raw.skipped
  console.log(`  · raw payloads: hashed ${String(hashes)}, unhashed ${String(skipped)}`)
  check('a scene replay hashes no raw payloads, and skips the hashing it would have done',
    hashes === 0 && skipped > 0,
    `hashes +${String(hashes)}, unhashed +${String(skipped)}`)

  check('the scene replay is handed a slice of the log, not the log',
    afterDrag.scene.replays > beforeDrag.scene.replays && sliced <= afterDrag.windowEvents / 8,
    `${sliced} of ${afterDrag.windowEvents} events, in ${Math.round(afterDrag.scene.replayMs - beforeDrag.scene.replayMs)} ms`)
  // A guard rail, not a benchmark: the frame budget of a headless machine is not a fact about the
  // board, but a drag that stalls the input thread for a quarter of a second is one.
  check('the drag painted frames instead of stalling the input thread',
    frames.count >= 5 && frames.maxGap <= 250,
    JSON.stringify({ ...frames, longtasks: afterDrag.longtasks - beforeDrag.longtasks, longtasksSupported: afterDrag.longtasksSupported }))

  // ── the motion model: one plane per face, and no position property ever animated ─────
  //
  // The data layer only knows whole cells; the *view* moves by fractions of one. That fraction is
  // carried by a single element per face — `translate3d` on the motion plane — so a pan costs the
  // compositor a transform and costs the main thread nothing at all: no style recalc, no layout, no
  // paint per pointer event. What is pinned here is that split, measured with the browser's own
  // counters: `LayoutCount` across a drag against the number of whole cells that drag actually
  // crossed. Before this model, a hundred-brick board re-laid-out the grid on every pointer move.
  await backToLive()
  const structure = await page.evaluate(() => {
    const planes = [...document.querySelectorAll('[data-cache-bricks-plane]')].map((plane) => plane.dataset.cacheBricksPlane)
    const turnBrick = document.querySelector('[data-cache-bricks-brick]:not([data-cache-bricks-ring])')
    return {
      planes,
      brickRides: turnBrick === null ? undefined : turnBrick.parentElement?.dataset.cacheBricksPlane,
      brickStops: turnBrick === null ? 0 : (() => { let depth = 0; let node = turnBrick.parentElement; while (node !== null && node.dataset.cacheBricksBoard === undefined) { depth += 1; node = node.parentElement } return depth })(),
    }
  })
  check('each face carries one motion plane, and every brick rides the plane of its own side',
    structure.planes.join(',') === 'cache,type' && structure.brickRides === 'cache' && structure.brickStops > 0,
    JSON.stringify(structure))

  const offenders = await page.evaluate(() => {
    const board = document.querySelector('[data-cache-bricks-board]')
    const forbidden = new Set(['top', 'left', 'right', 'bottom', 'width', 'height', 'all'])
    const found = []
    for (const element of [board, ...board.querySelectorAll('*')]) {
      const style = getComputedStyle(element)
      const property = style.transitionProperty
      if (property === 'none') continue
      const durations = style.transitionDuration.split(',').map((value) => Number.parseFloat(value) || 0)
      if (durations.every((value) => value === 0)) continue
      for (const part of property.split(',').map((value) => value.trim())) {
        if (forbidden.has(part)) found.push(`${element.tagName}[${element.dataset.cacheBricksBrick ?? element.dataset.cacheBricksPlane ?? element.dataset.cacheBricksLayer ?? ''}]:${part}`)
      }
    }
    return found
  })
  check('no element in the board transitions a position property (the invariant)',
    offenders.length === 0, offenders.slice(0, 4).join(' | '))

  const planeOf = () => page.evaluate(() => {
    const plane = document.querySelector('[data-cache-bricks-plane="cache"]')
    if (plane === null) return undefined
    const style = getComputedStyle(plane)
    if (style.transform === 'none') return { x: 0, y: 0 }
    const matrix = new DOMMatrixReadOnly(style.transform)
    return { x: Math.round(matrix.m41 * 100) / 100, y: Math.round(matrix.m42 * 100) / 100 }
  })

  // A drag sampled at every step: the plane has to move on each one, and the pan has to commit
  // whole cells only. `LayoutCount` is the browser's own count of layout runs.
  const sampled = []
  // Style mutations are the main thread's actual work in a pan: 0.1.4.a wrote `right` and `bottom`
  // on every visible brick each time the pan committed, 0.1.4.b writes one `transform` on the plane
  // per frame and touches the bricks only on a commit. Counted, not argued.
  await page.evaluate(() => {
    window.__styleWrites = 0
    const board = document.querySelector('[data-cache-bricks-board]')
    window.__styleObserver?.disconnect()
    window.__styleObserver = new MutationObserver((records) => { window.__styleWrites += records.length })
    window.__styleObserver.observe(board, { attributes: true, attributeFilter: ['style'], subtree: true })
  })
  // The browser's own counters, over CDP: `LayoutCount` is the number of layout runs, which is the
  // honest measure of "did this drag touch layout?" (`page.metrics()` is gone from playwright-core).
  const cdp = await page.context().newCDPSession(page).catch(() => undefined)
  await cdp?.send('Performance.enable').catch(() => undefined)
  const counters = async () => {
    if (cdp === undefined) return undefined
    try {
      const { metrics } = await cdp.send('Performance.getMetrics')
      const map = Object.fromEntries(metrics.map((entry) => [entry.name, entry.value]))
      return { layout: map.LayoutCount ?? 0, recalc: map.RecalcStyleCount ?? 0 }
    } catch {
      return undefined
    }
  }
  const motionBefore = await counters()
  const railTrack = await page.locator('[data-cache-bricks-rail="x"]').boundingBox()
  const railThumb = await page.locator('[data-cache-bricks-rail="x"] > div').first().boundingBox()
  const railWanted = await page.locator('[data-cache-bricks-rail="x"]').getAttribute('aria-valuenow')
  await page.mouse.move(railThumb.x + railThumb.width / 2, railThumb.y + railThumb.height / 2)
  await page.mouse.down()
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(railThumb.x + railThumb.width / 2 - (railTrack.width - railThumb.width) * (step / 24), railThumb.y + railThumb.height / 2)
    await page.waitForTimeout(40)
    sampled.push({
      plane: await planeOf(),
      pan: Number(await page.locator('[data-cache-bricks-rail="x"]').getAttribute('aria-valuenow')),
      motion: await page.evaluate(() => window.__dshCacheBricksStats?.()?.motion),
    })
  }
  const motionDuring = await counters()
  const styleWrites = await page.evaluate(() => { window.__styleObserver?.disconnect(); return window.__styleWrites })
  await page.mouse.up()
  await page.waitForTimeout(400)
  const settled = { plane: await planeOf(), pan: Number(await page.locator('[data-cache-bricks-rail="x"]').getAttribute('aria-valuenow')) }
  const motionAfter = await counters()

  const xs = sampled.map((sample) => sample.plane?.x ?? 0)
  const distinct = new Set(xs.map((value) => value.toFixed(1))).size
  // A drag in either direction has to be monotone; which direction is the pointer's business.
  const monotone = xs.every((value, index) => index === 0 || value <= xs[index - 1] + 0.01)
    || xs.every((value, index) => index === 0 || value >= xs[index - 1] - 0.01)
  const betweenCells = xs.filter((value) => Math.abs(value) > 0.5).every((value) => Math.abs((Math.abs(value) % PITCH_X)) > 0.5)
  check('the board follows the pointer by the pixel, not by the cell',
    distinct >= 10 && monotone && betweenCells && Math.max(...xs.map((value) => Math.abs(value))) > PITCH_X / 2,
    `plane x ${xs.map((value) => value.toFixed(1)).join(' ')} · pans ${sampled.map((sample) => String(sample.pan)).join(' ')} · motion ${JSON.stringify(sampled.map((sample) => sample.motion))}`)
  check('the whole-cell pan commits only when a cell is crossed, and never mid-cell on release',
    settled.plane !== undefined && Math.abs(settled.plane.x) < 0.75 && Math.abs(settled.plane.y) < 0.75
    && Number.isInteger(settled.pan) && railWanted !== undefined,
    `settled plane ${JSON.stringify(settled.plane)} pan ${String(settled.pan)}`)
  const layout = motionBefore === undefined || motionDuring === undefined
    ? undefined
    : motionDuring.layout - motionBefore.layout
  const crossed = Math.abs(settled.pan - Number(railWanted))
  console.log(`  · motion: 12 pointer moves, ${String(crossed)} whole cells crossed, style writes ${String(styleWrites)}, LayoutCount +${String(layout)}`
    + ` (recalcStyle +${String(motionBefore === undefined || motionDuring === undefined ? '?' : motionDuring.recalc - motionBefore.recalc)}),`
    + ` plane carried ${xs.map((value) => value.toFixed(1)).join(' ')}`)
  check('a twelve-step drag costs about one layout per cell crossed, not per pointer event',
    layout === undefined || layout <= crossed + 6,
    `LayoutCount +${String(layout)} for ${String(crossed)} cells over 12 moves (release: +${String(motionAfter === undefined || motionDuring === undefined ? '?' : motionAfter.layout - motionDuring.layout)})`)

  // A pan must not rewrite the grid: the plane carries it, and the bricks are touched only when a
  // whole cell is committed. The fixture's drag is deliberately brutal (each move crosses ~83
  // cells), so this is the worst case: one commit per frame, ~200 style writes per commit if every
  // brick were repositioned, against two per frame for the plane.
  check('a pan writes the plane and the chrome, not a hundred bricks',
    styleWrites !== undefined && styleWrites < 400,
    `${String(styleWrites)} attached style mutations over 12 moves × ${String(Math.round(crossed / 12))} cells each`)

  // A new Turn is the other half of the motion model. 0.1.4.a slid the stack by transitioning `right`
  // on every visible brick — a layout-property animation, so every frame of it re-ran layout on a
  // hundred elements. 0.1.4.b paints the new cells once and animates **one** transform on the plane,
  // which the compositor carries. Counted with the browser's own LayoutCount.
  await backToLive()
  const beforeTurn = await counters()
  await page.evaluate(() => {
    const feed = window.__fixture.feed
    const turn = (Number(feed.bricks[feed.bricks.length - 1].identity.turn) || 18) + 1
    const brick = {
      observedBy: 'host',
      identity: { id: `S:${String(turn)}:1:0`, sessionId: 'S', turn, step: 1, attemptOrdinal: 0 },
      settlement: 'message', settlementSeq: turn * 100 + 1,
      route: { provider: 'fixture', model: 'fixture' },
      usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 },
      metrics: { promptTokens: 1_000, cacheHitRatio: 0.9, chunkCount: 3, textChars: 10, reasoningChars: 0, toolCallCount: 0 },
      request: {}, tools: [], raw: {},
    }
    const bricks = [...feed.bricks, brick]
    window.__pushFeed({
      sessionId: 'S',
      bricks,
      endedTurns: bricks.map((entry) => Number(entry.identity.turn)).slice(0, -1),
      store: { blobs: 0, bytes: 0 },
    })
  })
  await page.waitForTimeout(450)
  const afterTurn = await counters()
  const turnLayout = beforeTurn === undefined || afterTurn === undefined ? undefined : afterTurn.layout - beforeTurn.layout
  const turnRecalc = beforeTurn === undefined || afterTurn === undefined ? undefined : afterTurn.recalc - beforeTurn.recalc
  console.log(`  · new Turn: LayoutCount +${String(turnLayout)} · recalcStyle +${String(turnRecalc)}`)
  check('a new Turn slides the plane instead of re-laying-out every brick',
    turnLayout === undefined || turnLayout <= 3,
    `LayoutCount +${String(turnLayout)} for one new column`)

  // The ring: painted outside the grid so a fractional pan cannot expose an edge, clipped by the
  // face, and never offered to the reader.
  const ring = await page.evaluate(() => {
    const bricks = [...document.querySelectorAll('[data-cache-bricks-brick][data-cache-bricks-ring]')]
    const plane = document.querySelector('[data-cache-bricks-plane="cache"]')?.getBoundingClientRect()
    const inside = bricks.filter((brick) => {
      const box = brick.getBoundingClientRect()
      return plane !== undefined && box.x >= plane.x && box.right <= plane.right && box.y >= plane.y && box.bottom <= plane.bottom
    })
    return {
      count: bricks.length,
      inside: inside.length,
      interactive: bricks.filter((brick) => brick.tabIndex === 0 || getComputedStyle(brick).pointerEvents !== 'none' || brick.getAttribute('aria-hidden') !== 'true').length,
    }
  })
  check('the motion ring is painted outside the grid and never offered to the reader',
    ring.count > 0 && ring.inside === 0 && ring.interactive === 0,
    JSON.stringify(ring))

  // ── reviewing old bricks costs the scene, not the session ────────────────────────────
  //
  // The board is a window and the pan is arithmetic, but the *data* layer used to rebuild the whole
  // session's board every time the scene on screen was re-cut: every fold reading re-folded, every
  // Turn's column rebuilt and sorted. On the six-thousand-brick world this section builds, panning
  // across ten screens is ten scene changes, and each of them used to be O(session). What is pinned
  // here is that a pan moves only what it touched — and, because a count is not a cost, the script
  // time the browser spent doing it.
  const worldStats = () => page.evaluate(() => window.__dshCacheBricksStats?.()?.world)
  // Thirty thousand steps, which is the size the "reviewing history is O(session)" complaint is
  // about: three bricks per Turn, ten thousand Turns.
  await page.evaluate(() => {
    const bricks = []
    for (let turn = 1; turn <= 10_000; turn += 1) {
      for (let step = 1; step <= 3; step += 1) {
        bricks.push({
          observedBy: 'host',
          identity: { id: `S:${String(turn)}:${String(step)}:0`, sessionId: 'S', turn, step, attemptOrdinal: 0 },
          settlement: 'message', settlementSeq: turn * 100 + step,
          route: { provider: 'fixture', model: 'fixture' },
          usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 },
          metrics: { promptTokens: 1_000, cacheHitRatio: 0.9, chunkCount: 3, textChars: 10, reasoningChars: 0, toolCallCount: 0 },
          request: {}, tools: [], raw: {},
        })
      }
    }
    window.__fixture.records.S = bricks
    window.__pushFeed({ sessionId: 'S', bricks, endedTurns: Array.from({ length: 9_999 }, (_, index) => index + 1), store: { blobs: 0, bytes: 0 } })
    // The durable window has to cover what the reader pans through, or the board has nothing to
    // replay and a scene change never happens. Two events per Turn keeps the window at the same
    // size the earlier sections used while covering all ten thousand Turns.
    const page = window.__page
    page.entries.length = 0
    page.seq = 3
    page.front = 0
    page.pending.length = 0
    page.hasMore = false
    for (let turn = 1; turn <= 10_000; turn += 1) {
      for (const type of ['step/start', 'step/end']) {
        page.entries.push({ type: 'event', event: { seq: page.seq, type, time: page.seq * 100, data: { turn, step: 1 } } })
        page.seq += 1
      }
    }
    page.fold = Array.from({ length: 10_000 }, (_, index) => index + 1)
    page.revision += 1
    for (const listener of page.listeners) listener()
  })
  await page.waitForTimeout(1200)
  const cdp2 = await page.context().newCDPSession(page).catch(() => undefined)
  await cdp2?.send('Performance.enable').catch(() => undefined)
  const scriptSeconds = async () => {
    if (cdp2 === undefined) return undefined
    try {
      const { metrics } = await cdp2.send('Performance.getMetrics')
      return Object.fromEntries(metrics.map((entry) => [entry.name, entry.value])).ScriptDuration ?? 0
    } catch {
      return undefined
    }
  }
  const beforeWorld = await worldStats()
  const beforeScript = await scriptSeconds()
  const rail = page.locator('[data-cache-bricks-rail="x"]')
  const railBox = await rail.boundingBox()
  const worldThumb = await page.locator('[data-cache-bricks-rail="x"] > div').first().boundingBox()
  const worldTravel = railBox.width - worldThumb.width
  const maxPan = Number(await rail.getAttribute('aria-valuemax'))
  const pans = []
  // Ten *separate* gestures: each one is released, so each one lands on a screen the board has not
  // cut yet and pays for whatever that costs — which is the reading this section exists for.
  for (let screen = 1; screen <= 10; screen += 1) {
    const handle = await page.locator('[data-cache-bricks-rail="x"] > div').first().boundingBox()
    const track = await rail.boundingBox()
    const span = track.width - handle.width
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    // One screenful of Turns per gesture, so the view lands somewhere new every time.
    await page.mouse.move(handle.x + handle.width / 2 - span / 14, handle.y + handle.height / 2, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(260)
    pans.push({ pan: Number(await rail.getAttribute('aria-valuenow')), stats: await worldStats() })
  }
  const afterWorld = await worldStats()
  const lastSample = pans[pans.length - 1]?.stats
  console.log('  · on release: ' + JSON.stringify({
    fold: (afterWorld?.foldRebuilds ?? 0) - (lastSample?.foldRebuilds ?? 0),
    live: (afterWorld?.livePatches ?? 0) - (lastSample?.livePatches ?? 0),
    exact: (afterWorld?.exactPatches ?? 0) - (lastSample?.exactPatches ?? 0),
    exactSteps: afterWorld?.exactSteps,
    columns: (afterWorld?.columnsRebuilt ?? 0) - (lastSample?.columnsRebuilt ?? 0),
    boards: (afterWorld?.boards ?? 0) - (lastSample?.boards ?? 0),
    order: (afterWorld?.orderBuilds ?? 0) - (lastSample?.orderBuilds ?? 0),
  }))
  const afterScript = await scriptSeconds()
  const scriptMs = beforeScript === undefined || afterScript === undefined ? undefined : (afterScript - beforeScript) * 1000
  console.log(`  · ten screen-pans over 10,000 Turns: script ${String(scriptMs === undefined ? '?' : Math.round(scriptMs))} ms`
    + ` · fold rebuilds +${String((afterWorld?.foldRebuilds ?? 0) - (beforeWorld?.foldRebuilds ?? 0))}`
    + ` · columns rebuilt +${String((afterWorld?.columnsRebuilt ?? 0) - (beforeWorld?.columnsRebuilt ?? 0))}`
    + ` · order builds +${String((afterWorld?.orderBuilds ?? 0) - (beforeWorld?.orderBuilds ?? 0))}`
    + ` · scene patches +${String((afterWorld?.exactPatches ?? 0) - (beforeWorld?.exactPatches ?? 0))}`)
  // The pans themselves: this is where the session used to be rebuilt. Nothing at all may happen
  // while the hand moves — the scene is deferred to the release (0.1.4.a) and the world is only
  // patched when a new scene actually arrives.
  const panDeltas = pans.map((entry, index) => {
    const before = index === 0 ? beforeWorld : pans[index - 1].stats
    return {
      pan: entry.pan,
      fold: (entry.stats?.foldRebuilds ?? 0) - (before?.foldRebuilds ?? 0),
      live: (entry.stats?.livePatches ?? 0) - (before?.livePatches ?? 0),
      exact: (entry.stats?.exactPatches ?? 0) - (before?.exactPatches ?? 0),
      columns: (entry.stats?.columnsRebuilt ?? 0) - (before?.columnsRebuilt ?? 0),
      boards: (entry.stats?.boards ?? 0) - (before?.boards ?? 0),
      order: (entry.stats?.orderBuilds ?? 0) - (before?.orderBuilds ?? 0),
    }
  })
  check('ten screen-pans across a ten-thousand-Turn world never rebuild the fold or the session-sized order list',
    beforeWorld !== undefined && panDeltas.length === 10
    && panDeltas.every((delta) => delta.fold === 0 && delta.live === 0 && delta.order === 0)
    // Each gesture patches the scene it landed on: a screenful of Turns, never the 2,000 on the board.
    && panDeltas.every((delta) => delta.columns < 260 && delta.boards <= 3),
    JSON.stringify(panDeltas.map((delta) => [delta.pan, delta.fold, delta.columns, delta.boards])))
  // And the release: exactly one new scene, and it costs that scene. `exactSteps` is the number of
  // steps the patch replaced — a screenful, never the session (the world holds 2,000 Turns here).
  // Pan back over ground already covered: the screens are in the scene LRU only if they were the
  // last three, but every *step* of them is still cached, so a re-read costs lookups rather than
  // replays. This is the "second look at the same area" the step cache exists for.
  const stepStatsOf = () => page.evaluate(() => window.__dshCacheBricksStats?.()?.steps)
  const beforeReturn = await stepStatsOf()
  const returnScriptBefore = await scriptSeconds()
  for (let back = 1; back <= 3; back += 1) {
    const handle = await page.locator('[data-cache-bricks-rail="x"] > div').first().boundingBox()
    const track = await rail.boundingBox()
    const span = track.width - handle.width
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 + span / 14, handle.y + handle.height / 2, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(260)
  }
  const afterReturn = await stepStatsOf()
  const returnScriptAfter = await scriptSeconds()
  const returnScriptMs = returnScriptBefore === undefined || returnScriptAfter === undefined
    ? undefined
    : (returnScriptAfter - returnScriptBefore) * 1000
  const returnHits = (afterReturn?.hits ?? 0) - (beforeReturn?.hits ?? 0)
  const returnMisses = (afterReturn?.misses ?? 0) - (beforeReturn?.misses ?? 0)
  console.log(`  · panning back over three screens: step hits +${String(returnHits)}, step misses +${String(returnMisses)}`
    + `, script ${String(returnScriptMs === undefined ? '?' : Math.round(returnScriptMs))} ms`)
  check('a screen already read is answered from the step cache, not replayed',
    beforeReturn !== undefined && afterReturn !== undefined
    && returnHits >= 20 && returnMisses === 0,
    `hits +${String(returnHits)}, misses +${String(returnMisses)}`)

  check('the scene a pan lands on is patched, not rebuilt, and the session-sized order list stays unbuilt',
    afterWorld !== undefined && (afterWorld.exactPatches - (lastSample?.exactPatches ?? 0)) <= 2
    && (afterWorld.exactSteps ?? 0) <= 200
    && afterWorld.orderBuilds === beforeWorld.orderBuilds,
    JSON.stringify({ exactSteps: afterWorld?.exactSteps, order: afterWorld?.orderBuilds }))
  // A count is not a cost: the same ten pans, in the browser's own script clock. 2,000 Turns and
  // 6,000 steps are on the board, so anything proportional to the session shows up here.
  check('ten screen-pans cost the scene, not the session',
    scriptMs === undefined || scriptMs < 3_000,
    `${String(scriptMs === undefined ? '?' : Math.round(scriptMs))} ms of script for 10 scene changes`)
  console.log('  · per-pan world deltas: ' + pans.map((entry, index) => {
    const before = index === 0 ? beforeWorld : pans[index - 1].stats
    return `${String(entry.pan)}:f${String((entry.stats?.foldRebuilds ?? 0) - (before?.foldRebuilds ?? 0))}`
      + `,b${String((entry.stats?.boards ?? 0) - (before?.boards ?? 0))}`
      + `,l${String((entry.stats?.livePatches ?? 0) - (before?.livePatches ?? 0))}`
      + `,e${String((entry.stats?.exactPatches ?? 0) - (before?.exactPatches ?? 0))}`
      + `,c${String((entry.stats?.columnsRebuilt ?? 0) - (before?.columnsRebuilt ?? 0))}`
  }).join(' '))
  void maxPan
  void pans
  await backToLive()

  // The dashed ghost names the cell the running Turn's next brick will land in. It used to be an
  // overlay in the host's coordinates, moving itself with a position transition; it is a child of
  // the cache plane now, so it rides the same transform the bricks do — no animation of its own, no
  // position property touched, and it sits on the cell it names. A Turn in flight is what asks for
  // it, so this stands a one-Turn world up from scratch rather than inheriting a finished one.
  await page.evaluate(() => {
    const turn = 30_001
    const page = window.__page
    page.fold = [turn]
    page.nodes = () => new Map([[`fold-${String(turn)}`, {
      kind: 'cache-bricks',
      data: { turn, ended: false, steps: [{ step: 1, seq: 9_200_000, provider: 'fixture', usage: { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 10 } }] },
    }]])
    for (const listener of page.listeners) listener()
    window.__fixture.renderFold()
    window.__pushFeed({
      sessionId: 'S',
      bricks: [{
        observedBy: 'host',
        identity: { id: `S:${String(turn)}:1:0`, sessionId: 'S', turn, step: 1, attemptOrdinal: 0 },
        settlement: 'message', settlementSeq: 9_200_001,
        route: { provider: 'fixture', model: 'fixture' },
        usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 },
        metrics: { promptTokens: 1_000, cacheHitRatio: 0.9, chunkCount: 3, textChars: 10, reasoningChars: 0, toolCallCount: 0 },
        request: {}, tools: [], raw: {},
      }],
      endedTurns: [],
      store: { blobs: 0, bytes: 0 },
    })
  })
  await page.waitForTimeout(400)
  await backToLive()
  await page.waitForTimeout(250)
  const ghost = await page.evaluate(() => {
    const element = document.querySelector('[data-cache-bricks-ghost]')
    const plane = document.querySelector('[data-cache-bricks-plane="cache"]')
    if (element === null || plane === null) return { present: false }
    const box = element.getBoundingClientRect()
    const grid = plane.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      present: true,
      visible: style.display !== 'none' && box.width > 0,
      onThePlane: element.parentElement === plane,
      firstChild: plane.firstElementChild === element,
      insideTheGrid: box.x >= grid.x - 0.5 && box.right <= grid.right + 0.5 && box.y >= grid.y - 0.5 && box.bottom <= grid.bottom + 0.5,
      dashed: style.borderTopStyle === 'dashed',
      ownMovements: style.transitionProperty,
    }
  })
  check('the dashed next-cell ghost rides the plane, on the cell it names',
    ghost.present === true && ghost.visible === true && ghost.onThePlane === true && ghost.firstChild === true
    && ghost.insideTheGrid === true && ghost.dashed === true
    && (ghost.ownMovements === 'none' || ghost.ownMovements === 'all'),
    JSON.stringify(ghost))

  // ── the motion the reader feels: the fall, and the slide ────────────────────────────
  //
  // The board asks for reduced motion, so nothing here had ever run in this suite: the fall and the
  // slide are both skipped when `prefers-reduced-motion` is set, which is right for a reader who
  // asked for it and a blind spot for a test that did not. So this section asks for motion, drives
  // one brick and one Turn, and **seeks the animations themselves** rather than timing a sampler —
  // a rAF loop is at the mercy of the page's frame production, while `Animation.currentTime` puts
  // the motion at an exact moment. What is pinned is the motion 0.1.4 had, since that is the feel
  // being kept: a brick spawns one brick-height up and falls for 420 ms on
  // `cubic-bezier(.45,.02,.95,.55)`, and a new Turn slides the stack one cell in 260 ms ease-out.
  await backToLive()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForTimeout(120)
  const pushed = await page.evaluate(() => {
    const feed = window.__fixture.feed
    const turn = (Number(feed.bricks[feed.bricks.length - 1].identity.turn) || 18) + 1
    const brick = {
      observedBy: 'host',
      identity: { id: `S:${String(turn)}:1:0`, sessionId: 'S', turn, step: 1, attemptOrdinal: 0 },
      settlement: 'message', settlementSeq: turn * 100 + 1,
      route: { provider: 'fixture', model: 'fixture' },
      usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 },
      metrics: { promptTokens: 1_000, cacheHitRatio: 0.9, chunkCount: 3, textChars: 10, reasoningChars: 0, toolCallCount: 0 },
      request: {}, tools: [], raw: {},
    }
    window.__pushed = brick.identity.id
    window.__pushFeed({ sessionId: 'S', bricks: [...feed.bricks, brick], endedTurns: feed.endedTurns ?? [], store: { blobs: 0, bytes: 0 } })
    return brick.identity.id
  })
  const fall = await (async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const found = await page.evaluate(() => {
        const element = document.querySelector(`[data-cache-bricks-brick="${window.__pushed}"]`)
        if (element === null || element.getAnimations().length === 0) return undefined
        const animation = element.getAnimations()[0]
        const duration = Number(animation.effect?.getTiming().duration ?? 0)
        if (!(duration > 0)) return undefined
        animation.pause()
        const seek = (time) => {
          animation.currentTime = time
          return Math.round(element.getBoundingClientRect().top * 10) / 10
        }
        const rest = seek(duration)
        const curve = []
        for (let time = 0; time <= duration; time += 15) {
          curve.push([time, Math.round((rest - seek(time)) * 10) / 10])
        }
        animation.currentTime = duration
        return { duration, easing: animation.effect?.getTiming().easing, curve }
      })
      if (found !== undefined) return found
      await page.waitForTimeout(50)
    }
    return undefined
  })()
  const fallAt = (ms) => {
    const curve = fall?.curve ?? []
    let value = curve[0]?.[1] ?? 0
    for (const [time, offset] of curve) if (time <= ms) value = offset
    return value
  }
  console.log(`  · fall: ${String(fall?.duration)}ms ${String(fall?.easing)} · start ${String(fallAt(0))}px`
    + ` · curve ${[0, 100, 200, 300, 400].map((ms) => `${String(ms)}:${String(fallAt(ms))}`).join(' ')}`)
  check('a new brick falls on 0.1.4\'s own motion: one brick-height, 420 ms, its curve, no bounce',
    fall !== undefined && fall.duration === 420
    && (fall.easing ?? '').replaceAll(' ', '') === 'cubic-bezier(0.45,0.02,0.95,0.55)'
    && Math.abs(fallAt(0) - 15) <= 0.5
    // A falling brick only ever moves down towards its cell, and it is there when the clock is.
    && (fall.curve ?? []).every(([, offset]) => offset >= -0.5)
    && Math.abs(fallAt(415)) <= 2.5,
    JSON.stringify({ duration: fall?.duration, easing: fall?.easing, start: fallAt(0), end: fallAt(415) }))

  // The new Turn, which the push above also added while the board was following: the plane carries
  // the whole stack one cell in 260 ms ease-out, the clock the old `right` transition used.
  const slide = await page.evaluate(() => {
    const plane = document.querySelector('[data-cache-bricks-plane="cache"]')
    if (plane === null) return undefined
    const animation = plane.getAnimations().find((entry) => Number(entry.effect?.getTiming().duration ?? 0) > 100)
    if (animation === undefined) return undefined
    const duration = Number(animation.effect?.getTiming().duration ?? 0)
    animation.pause()
    const seek = (time) => {
      animation.currentTime = time
      const value = getComputedStyle(plane).transform
      return value === 'none' ? 0 : Math.round(new DOMMatrixReadOnly(value).m41 * 10) / 10
    }
    const from = seek(0)
    const middle = seek(duration / 2)
    const end = seek(duration)
    animation.currentTime = duration
    return { duration, easing: animation.effect?.getTiming().easing, from, middle, end }
  })
  console.log(`  · new Turn slide: ${String(slide?.duration)}ms ${String(slide?.easing)} · ${String(slide?.from)}px -> ${String(slide?.end)}px`)
  check('a new Turn slides the stack one cell on the clock it always used (260 ms, ease-out)',
    slide !== undefined && slide.duration === 260 && (slide.easing ?? '') === 'ease-out'
    && slide.from > 30 && Math.abs(slide.end) < 1 && (slide.middle ?? 0) < slide.from && (slide.middle ?? 0) > 0,
    JSON.stringify(slide))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  void pushed

  // ── a brick's two drops: born a draft, settled as a reading ─────────────────────────
  //
  // The life a reader watches: a request starts, its brick is born as a draft (`n/a`, because no
  // usage has landed) and drops into its cell; the dashed box marks the cell above it; the request
  // settles, and the brick drops again — now wearing its reading. Both drops are the same motion on
  // `transform`, so the second one costs exactly what the first did.
  const DROP_TURN = 40_001
  const dropBrick = (settled) => ({
    observedBy: 'host',
    identity: { id: `S:${String(DROP_TURN)}:1:0`, sessionId: 'S', turn: DROP_TURN, step: 1, attemptOrdinal: 0 },
    settlement: settled ? 'message' : 'running',
    settlementSeq: settled ? DROP_TURN * 100 + 1 : 0,
    route: { provider: 'fixture', model: 'fixture' },
    ...(settled ? { usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 } } : {}),
    metrics: settled
      ? { promptTokens: 1_000, cacheHitRatio: 0.9, chunkCount: 3, textChars: 10, reasoningChars: 0, toolCallCount: 0 }
      : { promptTokens: 0, cacheHitRatio: 0, chunkCount: 0, textChars: 0, reasoningChars: 0, toolCallCount: 0 },
    request: {}, tools: [], raw: {},
  })
  const pushFeed = (bricks) => page.evaluate((list) => {
    window.__pushFeed({ sessionId: 'S', bricks: list, endedTurns: [], store: { blobs: 0, bytes: 0 } })
  }, bricks)
  const watch = (frames) => page.evaluate((count) => {
    window.__drop = []
    window.__dropOn = true
    const key = 'S:40001:1:0'
    const tick = () => {
      if (!window.__dropOn) return
      const element = document.querySelector(`[data-cache-bricks-brick="${key}"]`)
      if (element !== null) {
        const animations = element.getAnimations()
        const properties = animations.length === 0
          ? []
          : Object.keys(animations[0].effect?.getKeyframes?.()[0] ?? {}).filter((name) => name !== 'offset' && name !== 'computedOffset' && name !== 'easing')
        window.__drop.push([
          Math.round(performance.now()),
          Math.round(element.getBoundingClientRect().top * 10) / 10,
          animations.length,
          properties.join(','),
          (element.textContent ?? '').trim(),
        ])
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    void count
  }, frames)
  const stopWatch = () => page.evaluate(() => { window.__dropOn = false; return window.__drop })

  // Deliberately left on the suite's reduced-motion default: 0.1.4 dropped bricks without ever
  // consulting the preference, and this check exists because a board that honours it here reads as
  // bricks appearing out of nowhere.
  await watch()
  await pushFeed([dropBrick(false)])
  await page.waitForTimeout(560)
  const birth = await stopWatch()
  await watch()
  await pushFeed([dropBrick(true)])
  await page.waitForTimeout(560)
  const settle = await stopWatch()

  const rest = birth.length === 0 ? 0 : Math.max(...birth.map((frame) => frame[1]))
  const lifted = (frames) => frames.filter((frame) => frame[1] <= rest - 13 && frame[2] > 0)
  // The animation must move the brick on the compositor: `transform`, and never a layout property.
  const transformOnly = (frames) => frames.filter((frame) => frame[2] > 0).every((frame) => {
    const properties = frame[3].split(',')
    return properties.includes('transform')
      && !properties.some((name) => ['bottom', 'right', 'top', 'left', 'width', 'height'].includes(name))
  })
  check('a brick drops when it is born and drops again when it settles',
    birth.length > 0 && settle.length > 0
    && lifted(birth).length > 0 && lifted(settle).length > 0
    && settle.some((frame) => frame[4].includes('%') && frame[2] > 0)
    && transformOnly(birth) && transformOnly(settle),
    `rest ${String(rest)} · birth lifted ${String(lifted(birth).length)}/${String(birth.length)} · settle lifted ${String(lifted(settle).length)}/${String(settle.length)} · settle label ${String(settle.find((frame) => frame[2] > 0)?.[4] ?? '')}`)

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
