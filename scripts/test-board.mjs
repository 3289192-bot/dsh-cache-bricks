/**
 * Browser-level verification of the Lite board.
 *
 * Everything the unit tests cannot see: that the board finds the gutter and stays in it, that a
 * brick's colour reaches the pixels, that a retry stacks as two bricks in the same column, and
 * that a dropped ring is announced rather than silently drawn.
 *
 * Playwright is deliberately **not** a dependency of this package (it is heavy and only this
 * script needs it), so it is resolved from `$PLAYWRIGHT_CORE`, the local `node_modules`, the
 * global npm root, or the globally installed `@playwright/mcp`. When none of them has it — or no
 * Chromium build is cached — the script says so and exits 0.
 *
 * Usage:
 *   node scripts/test-board.mjs
 *   node scripts/test-board.mjs --shot C:\tmp\shots
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const shotDir = args.includes('--shot') ? args[args.indexOf('--shot') + 1] : undefined

const failures = []
const results = []
const check = (name, ok, detail = '') => {
  results.push(name)
  if (ok) {
    console.log(`  PASS ${name}`)
    return
  }
  failures.push(name)
  console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Resolve `playwright-core` from wherever this machine keeps it. */
function loadPlaywright() {
  const require = createRequire(import.meta.url)
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
      // Next root.
    }
  }
  return undefined
}

/** The Chromium Playwright would launch may not be the one this machine downloaded. */
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

let browser
try {
  browser = await playwright.chromium.launch({ args: ['--no-sandbox'] })
} catch (error) {
  const executablePath = cachedChromium()
  if (executablePath === undefined) {
    console.log(`no Chromium available for Playwright (${String(error).split('\n')[0]}); skipping`)
    process.exit(0)
  }
  browser = await playwright.chromium.launch({ args: ['--no-sandbox'], executablePath })
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()) })

  // A transcript with one row, so the board can measure the gutter beside it. `--dsh-composer-height`
  // is the shell's own variable, and the fallback must not be needed here.
  const TRANSCRIPT = `<!DOCTYPE html><html><head><base href="http://brick.test/"><style>
body{margin:0;background:#151517;color:#e5e7eb;font-family:system-ui}
#scroll{position:fixed;inset:0;overflow:auto;--dsh-composer-height:80px}
.row{margin-left:520px;width:620px;height:80px;background:#202026;margin-bottom:16px}
#tail{height:2000px}
</style></head><body>
<div id="scroll" data-conversation-scroll>
  <div class="row" data-chat-turn="1" data-chat-node-key="10:assistant-step1:1">transcript</div>
  <div id="tail"></div>
</div><div id="dock"></div></body></html>`
  await page.setContent(TRANSCRIPT)

  const react = dirname(createRequire(import.meta.url).resolve('react/package.json'))
  const dom = dirname(createRequire(import.meta.url).resolve('react-dom/package.json'))
  await page.addScriptTag({ path: join(react, 'umd/react.production.min.js') })
  await page.addScriptTag({ path: join(dom, 'umd/react-dom.production.min.js') })
  const runtime = readFileSync(join(react, 'cjs/react-jsx-runtime.production.min.js'), 'utf8')
  await page.addScriptTag({
    content: `{const m={exports:{}};((module,exports,require)=>{${runtime}\n})(m,m.exports,()=>React);`
      + `window.__testExternals={'react':React,'react/jsx-runtime':m.exports};window.__ReactDOM=ReactDOM;}`,
  })
  await page.addScriptTag({ path: join(root, 'tests/fixture.js') })
  await page.addScriptTag({ path: join(root, 'lib/client.js') })

  await page.evaluate(() => window.__fixture.start())
  await page.waitForSelector('[data-cache-bricks-board]')
  await page.waitForTimeout(200)

  /** Read the board as a reader sees it. */
  const readBoard = () => page.evaluate(() => {
    const host = document.querySelector('[data-cache-bricks-board]')
    const rect = host.getBoundingClientRect()
    const slabs = [...document.querySelectorAll('[data-cache-bricks-brick]')].map((element) => {
      const box = element.getBoundingClientRect()
      return {
        id: element.dataset.cacheBricksBrick,
        tone: element.dataset.cacheBricksTone,
        text: (element.textContent ?? '').trim(),
        title: element.title,
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
        weight: getComputedStyle(element).fontWeight,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      }
    })
    const notice = document.querySelector('[data-cache-bricks-notice]')
    return {
      host: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      display: getComputedStyle(host).display,
      notice: notice === null || getComputedStyle(notice).display === 'none' ? undefined : (notice.textContent ?? ''),
      slabs,
      // Turn 0 is an auxiliary call and has no column; only real Turns count here.
      turns: [...new Set(slabs.map((slab) => Number(slab.id.split(':')[1])).filter((turn) => turn > 0))]
        .sort((left, right) => left - right),
      transcript: document.querySelector('.row').getBoundingClientRect().x,
    }
  })

  /** Push a feed and wait for one paint. */
  const push = async (bricks, extra = {}) => {
    await page.evaluate(([list, more]) => {
      window.__fixture.push({ sessionId: 'S', bricks: list, dropped: 0, endedTurns: [], backfilled: 0, dispatched: list.length, ...more })
    }, [bricks, extra])
    await page.waitForTimeout(220)
  }

  const empty = await readBoard()
  check('the board mounts in the gutter, left of the transcript',
    empty.display === 'block' && empty.host.x >= 0 && empty.host.x + empty.host.width <= empty.transcript,
    JSON.stringify([empty.host.x, empty.host.width, empty.transcript]))
  // The board hugs the conversation, it is not pinned to the window: a board anchored to the
  // window's left edge would put its panel under the sidebar (measured live — the first build did).
  check('its right edge sits against the transcript it belongs to',
    Math.abs(empty.host.x + empty.host.width - (empty.transcript - 12)) <= 2,
    JSON.stringify([empty.host.x + empty.host.width, empty.transcript - 12]))
  // The collector is answering and has simply seen nothing yet: the board says which of the two
  // silences this is (see the old-session check below), not "waiting".
  check('an empty board with a live collector explains itself rather than drawing nothing',
    (empty.notice ?? '').includes('不读历史'),
    String(empty.notice))
  // And the other silence: a collector that is not answering at all.
  await page.evaluate(() => { for (const stream of window.__fixture.streams) for (const handler of stream.handlers.error ?? []) handler({}) })
  await page.waitForTimeout(220)
  const noCollector = await readBoard()
  check('a board with no collector says so instead of looking like a cold cache',
    (noCollector.notice ?? '').includes('等待'),
    String(noCollector.notice))
  await page.evaluate(() => window.__fixture.push({ sessionId: 'S', bricks: [], backfilled: 0, dropped: 0, endedTurns: [], dispatched: 0 }))
  await page.waitForTimeout(200)

  // The case a reader meets on an old session: the collector is up, it has simply never seen a
  // request here. Silence would read as "nothing happened", so the board explains the contract.
  await page.evaluate(() => window.__fixture.push({ sessionId: 'S', bricks: [], backfilled: 0, dropped: 0, endedTurns: [], dispatched: 0 }))
  await page.waitForTimeout(220)
  const oldSession = await readBoard()
  check('an old session with no bricks since load says why it is empty',
    (oldSession.notice ?? '').includes('不读历史') && oldSession.slabs.length === 0,
    String(oldSession.notice))
  await page.evaluate(() => window.__fixture.push({ sessionId: 'S', bricks: [], backfilled: 0, dropped: 0, endedTurns: [], dispatched: 3 }))
  await page.waitForTimeout(220)
  const inFlight = await readBoard()
  check('a session with requests in flight counts them instead of drawing nothing',
    (inFlight.notice ?? '').includes('3') && (inFlight.notice ?? '').includes('尚未结算'),
    String(inFlight.notice))

  // ── the four colours, through the real DOM ──────────────────────────────────────────
  await page.evaluate(() => {
    const brick = window.__fixture.brick
    window.__fixture.push({
      sessionId: 'S',
      bricks: [brick(1, 1, 'good'), brick(1, 2, 'warn'), brick(1, 3, 'bad'), brick(1, 4, 'unknown')],
      backfilled: 0, dropped: 0,
      endedTurns: [1],
      dispatched: 4,
    })
  })
  await page.waitForTimeout(260)
  const tones = await readBoard()
  const byId = (id) => tones.slabs.find((slab) => slab.id === id)
  check('one settled request is one brick',
    tones.slabs.length === 4, JSON.stringify(tones.slabs.map((slab) => slab.id)))
  check('a reused prompt is 0.1.3\'s quiet green and prints its share',
    byId('S:1:1:0')?.tone === 'good'
    && byId('S:1:1:0')?.background === 'rgba(34, 197, 94, 0.18)'
    && byId('S:1:1:0')?.text === '99.0%',
    JSON.stringify(byId('S:1:1:0')))
  // The band a reader noticed missing: 0.1.3's amber, with its dark digits and bold weight.
  check('a tenth re-billed is 0.1.3\'s amber, with dark digits',
    byId('S:1:2:0')?.tone === 'warn'
    && byId('S:1:2:0')?.background === 'rgba(234, 179, 8, 0.85)'
    && byId('S:1:2:0')?.color === 'rgb(42, 28, 0)'
    && byId('S:1:2:0')?.weight === '700',
    JSON.stringify(byId('S:1:2:0')))
  check('a re-billed prompt is red',
    byId('S:1:3:0')?.tone === 'bad' && byId('S:1:3:0')?.background === 'rgb(220, 38, 38)',
    JSON.stringify(byId('S:1:3:0')))
  check('a provider that reported nothing is grey and says n/a, not 0%',
    byId('S:1:4:0')?.tone === 'unknown'
    && byId('S:1:4:0')?.background === 'rgba(100, 116, 139, 0.35)'
    && byId('S:1:4:0')?.text === 'n/a'
    // …and the hover text says which silence it was: no usage was billed at all.
    && (byId('S:1:4:0')?.title ?? '').includes('no usage was billed'),
    JSON.stringify(byId('S:1:4:0')))
  check('every brick is the frozen size',
    tones.slabs.every((slab) => slab.width === 36 && slab.height === 15),
    JSON.stringify(tones.slabs.map((slab) => [slab.width, slab.height])))
  check('a brick carries its reading in the hover text',
    (byId('S:1:1:0')?.title ?? '').includes('turn 1') && (byId('S:1:1:0')?.title ?? '').includes('step 1'),
    String(byId('S:1:1:0')?.title))

  // ── the stack: turns are columns, retries stack in the same one ─────────────────────
  await push([
    { ...(await page.evaluate(() => window.__fixture.brick(1, 1, 'good'))), id: 'S:1:1:0' },
    { ...(await page.evaluate(() => window.__fixture.brick(1, 1, 'unknown', 1))), id: 'S:1:1:1' },
    await page.evaluate(() => window.__fixture.brick(1, 2, 'good')),
  ], { endedTurns: [1] })
  const stacked = await readBoard()
  const attempt0 = stacked.slabs.find((slab) => slab.id === 'S:1:1:0')
  const attempt1 = stacked.slabs.find((slab) => slab.id === 'S:1:1:1')
  check('a retry is a second brick in the same column, above the attempt it replaced',
    attempt0 !== undefined && attempt1 !== undefined
    && attempt1.y < attempt0.y && attempt0.x === attempt1.x,
    JSON.stringify([attempt0?.id, attempt0?.y, attempt1?.id, attempt1?.y]))
  check('the two attempts of a retried step can disagree about the cache',
    attempt0.tone === 'good' && attempt0.text === '99.0%' && attempt1.tone === 'unknown' && attempt1.text === 'n/a',
    JSON.stringify([attempt0?.tone, attempt0?.text, attempt1?.tone, attempt1?.text]))

  // A finished Turn steps one cell left for the next stack: the newest column is not on the edge.
  const lead = stacked.slabs.find((slab) => slab.id === 'S:1:2:0')
  check('a finished Turn reserves the drop column on the right',
    Math.round(lead.x + lead.width) <= Math.round(stacked.host.x + stacked.host.width - 36),
    JSON.stringify([lead.x, stacked.host.x + stacked.host.width]))
  await push([
    await page.evaluate(() => window.__fixture.brick(1, 1, 'good')),
    await page.evaluate(() => window.__fixture.brick(2, 1, 'good')),
  ], { endedTurns: [1] })
  const twoColumns = await readBoard()
  const first = twoColumns.slabs.find((slab) => slab.id === 'S:1:1:0')
  const second = twoColumns.slabs.find((slab) => slab.id === 'S:2:1:0')
  check('turns are columns: Turn 2 sits one cell right of Turn 1',
    Math.round(second.x - first.x) === 39, JSON.stringify([first.x, second.x]))

  // ── the ring says what it forgot ────────────────────────────────────────────────────
  await page.evaluate(() => {
    const brick = window.__fixture.brick
    window.__fixture.push({
      sessionId: 'S',
      bricks: [brick(9, 1, 'good'), brick(9, 2, 'good')],
      dropped: 1_022,
      endedTurns: [],
      backfilled: 0,
      dispatched: 1_024,
    })
  })
  await page.waitForTimeout(220)
  const dropped = await readBoard()
  check('a ring that had to drop old bricks says so',
    (dropped.notice ?? '').includes('1022') && (dropped.notice ?? '').includes('丢弃'),
    String(dropped.notice))
  // A session read out of its own log: the board says how much of it is history.
  await push([
    await page.evaluate(() => window.__fixture.brick(3, 1, 'good')),
    await page.evaluate(() => window.__fixture.brick(3, 2, 'good')),
  ], { backfilled: 2 })
  const fromLog = await readBoard()
  check('a board filled from the session log says so',
    (fromLog.notice ?? '').includes('来自历史日志') && (fromLog.notice ?? '').includes('2'),
    String(fromLog.notice))
  await push([
    await page.evaluate(() => window.__fixture.brick(9, 1, 'good')),
    await page.evaluate(() => window.__fixture.brick(9, 2, 'good')),
  ], { dropped: 1_022, backfilled: 0 })
  await page.waitForTimeout(200)

  check('the old Turns fall off the left instead of piling up',
    dropped.slabs.every((slab) => slab.id.startsWith('S:9:')), JSON.stringify(dropped.slabs.map((slab) => slab.id)))

  // Twenty Turns against a ten-column gutter: the board draws the newest columns and nothing
  // else, which is the other half of "极低开销" — the ring may hold a thousand bricks, but the
  // DOM holds what fits.
  await page.evaluate(() => {
    const brick = window.__fixture.brick
    const bricks = []
    for (let turn = 1; turn <= 20; turn += 1) {
      for (let step = 1; step <= 3; step += 1) bricks.push(brick(turn, step, step === 2 ? 'bad' : 'good'))
    }
    window.__fixture.push({
      sessionId: 'S',
      bricks,
      dropped: 0,
      endedTurns: Array.from({ length: 19 }, (_, index) => index + 1),
      dispatched: 60,
    })
  })
  await page.waitForTimeout(260)
  const deep = await readBoard()
  const drawnTurns = [...new Set(deep.slabs.map((slab) => Number(slab.id.split(':')[1])))].sort((left, right) => left - right)
  // The capacity is read off the board's own box rather than assumed: the invariant is "no more
  // columns than the gutter can hold", which is what keeps a thousand-brick session as cheap to
  // draw as a ten-brick one.
  const capacity = Math.floor((deep.host.width - 6 + 3) / 39)
  check('a sixty-brick session draws only the columns that fit',
    drawnTurns.length <= capacity && drawnTurns[drawnTurns.length - 1] === 20 && drawnTurns[0] > 1,
    `capacity ${String(capacity)} · ${JSON.stringify(drawnTurns)}`)
  check('the bricks it does not draw are not in the DOM at all',
    deep.slabs.length < 60, `${String(deep.slabs.length)} of 60 bricks`)
  check('every drawn brick is inside the board box',
    deep.slabs.every((slab) => slab.x >= deep.host.x - 1 && slab.x + slab.width <= deep.host.x + deep.host.width + 1
      && slab.y >= deep.host.y - 1 && slab.y + slab.height <= deep.host.y + deep.host.height + 1),
    JSON.stringify(deep.slabs.filter((slab) => slab.x + slab.width > deep.host.x + deep.host.width + 1).map((slab) => slab.id)))

  // ── 0.1.3's material, on the bricks themselves ──────────────────────────────────────
  const material = await page.evaluate(() => {
    const slab = document.querySelector('[data-cache-bricks-brick][data-cache-bricks-tone="good"]')
    const bad = document.querySelector('[data-cache-bricks-brick][data-cache-bricks-tone="bad"]')
    const style = getComputedStyle(slab)
    const badStyle = getComputedStyle(bad)
    return {
      background: style.backgroundColor,
      border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
      color: style.color,
      shadow: style.boxShadow,
      font: `${style.fontWeight} ${style.fontSize}/${style.lineHeight}`,
      numeric: style.fontVariantNumeric,
      radius: style.borderRadius,
      transition: style.transitionProperty.includes('bottom') ? 'bottom' : style.transitionProperty,
      badBackground: badStyle.backgroundColor,
      badColor: badStyle.color,
      badWeight: badStyle.fontWeight,
    }
  })
  check('a healthy brick is 0.1.3\'s quiet green, not a loud swatch',
    material.background === 'rgba(34, 197, 94, 0.18)' && material.color === 'rgba(74, 222, 128, 0.75)',
    JSON.stringify([material.background, material.color]))
  check('a brick keeps its hairline of light and its tone edge',
    material.shadow.includes('inset') && material.border === '1px solid rgba(34, 197, 94, 0.28)',
    JSON.stringify([material.border, material.shadow]))
  check('the reading is tabular monospace at the size the digits were measured for',
    material.font === '500 12px/12px' && material.numeric === 'tabular-nums' && material.radius === '3px',
    JSON.stringify([material.font, material.numeric, material.radius]))
  check('the brick falls on 0.1.3\'s curve, and only red is set bold',
    material.transition.includes('bottom') && material.badBackground === 'rgb(220, 38, 38)'
    && material.badColor === 'rgb(255, 255, 255)' && material.badWeight === '700',
    JSON.stringify([material.transition, material.badBackground, material.badWeight]))

  // ── the window: rails, pan, fades, the way back ─────────────────────────────────────
  await page.evaluate(() => {
    const brick = window.__fixture.brick
    const bricks = []
    for (let turn = 1; turn <= 20; turn += 1) {
      for (let step = 1; step <= 3; step += 1) bricks.push(brick(turn, step, step === 2 ? 'bad' : 'good'))
    }
    window.__fixture.push({
      sessionId: 'S',
      bricks,
      dropped: 0,
      endedTurns: Array.from({ length: 19 }, (_, index) => index + 1),
      dispatched: 60,
    })
  })
  await page.waitForTimeout(260)

  const readRails = () => page.evaluate(() => {
    const rail = (axis) => {
      const element = document.querySelector(`[data-cache-bricks-rail="${axis}"]`)
      const handle = element.firstElementChild
      const box = element.getBoundingClientRect()
      const thumb = handle.getBoundingClientRect()
      return {
        role: element.getAttribute('role'),
        orientation: element.getAttribute('aria-orientation'),
        tabIndex: element.tabIndex,
        disabled: element.getAttribute('aria-disabled'),
        pointerEvents: getComputedStyle(element).pointerEvents,
        opacity: Number(getComputedStyle(element).opacity),
        valueNow: Number(element.getAttribute('aria-valuenow')),
        valueMax: Number(element.getAttribute('aria-valuemax')),
        valueText: element.getAttribute('aria-valuetext') ?? '',
        x: box.x, y: box.y, width: box.width, height: box.height,
        thumbX: thumb.x, thumbY: thumb.y, thumbWidth: thumb.width, thumbHeight: thumb.height,
      }
    }
    const host = document.querySelector('[data-cache-bricks-board]').getBoundingClientRect()
    const chip = document.querySelector('[data-cache-bricks-live]')
    const ghost = document.querySelector('[data-cache-bricks-ghost]')
    const fade = (edge) => getComputedStyle(document.querySelector(`[data-cache-bricks-fade="${edge}"]`)).display !== 'none'
    return {
      host: { x: host.x, y: host.y, width: host.width, height: host.height },
      x: rail('x'),
      y: rail('y'),
      chip: chip === null || getComputedStyle(chip).display === 'none' ? undefined : { text: chip.textContent, title: chip.title },
      ghost: ghost === null || getComputedStyle(ghost).display === 'none' ? undefined : {
        x: ghost.getBoundingClientRect().x, y: ghost.getBoundingClientRect().y,
        width: ghost.getBoundingClientRect().width, borderStyle: getComputedStyle(ghost).borderTopStyle,
      },
      fades: { left: fade('left'), right: fade('right'), top: fade('top') },
      chatScroll: document.querySelector('#scroll').scrollTop,
    }
  })

  const live = await readRails()
  check('both rails are scrollbars and both sit inside the board',
    live.x.role === 'scrollbar' && live.y.role === 'scrollbar'
    && live.x.orientation === 'horizontal' && live.y.orientation === 'vertical'
    && live.x.y > live.host.y + live.host.height - 12 && live.y.x < live.host.x + 12,
    JSON.stringify([live.x.y, live.host.y + live.host.height, live.y.x, live.host.x]))
  check('the horizontal rail offers travel, and its thumb starts at the live end',
    live.x.valueMax > 0 && live.x.tabIndex === 0 && live.x.disabled === 'false'
    && Math.abs(live.x.thumbX + live.x.thumbWidth - (live.x.x + live.x.width)) <= 1,
    JSON.stringify([live.x.valueMax, live.x.valueNow, live.x.thumbX + live.x.thumbWidth, live.x.x + live.x.width]))
  check('the vertical rail is inert on a short session, and says so',
    live.y.valueMax === 0 && live.y.tabIndex === -1 && live.y.disabled === 'true' && live.y.pointerEvents === 'none',
    JSON.stringify([live.y.valueMax, live.y.tabIndex, live.y.pointerEvents]))
  check('the drop slot is drawn while the newest Turn is running',
    live.ghost !== undefined && live.ghost.borderStyle === 'dashed' && live.ghost.width === 36,
    JSON.stringify(live.ghost))
  check('the fades say which way there is more: nothing newer to the right, older to the left',
    live.fades.left === true && live.fades.right === false && live.fades.top === false,
    JSON.stringify(live.fades))

  /** Drag the horizontal thumb back by whole cells, the way a reader does. */
  const dragBack = async (cells) => {
    const rail = await page.locator('[data-cache-bricks-rail="x"]').boundingBox()
    const thumb = await page.locator('[data-cache-bricks-rail="x"] > div').first().boundingBox()
    const furthest = Number(await page.locator('[data-cache-bricks-rail="x"]').getAttribute('aria-valuemax'))
    const travel = rail.width - thumb.width
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2)
    await page.mouse.down()
    await page.mouse.move(thumb.x + thumb.width / 2 - (travel * cells) / Math.max(1, furthest), thumb.y + thumb.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(260)
  }

  const beforeDrag = await readBoard()
  await dragBack(4)
  const panned = await readBoard()
  const pannedRails = await readRails()
  check('dragging the thumb pages the window back through whole Turns',
    panned.turns.length > 0 && panned.turns[0] < beforeDrag.turns[0]
    && pannedRails.x.valueNow > 0,
    `${beforeDrag.turns.join(',')} → ${panned.turns.join(',')} · pan ${String(pannedRails.x.valueNow)}`)
  check('a panned brick keeps its grid: every column moved by a whole number of pitches',
    panned.slabs.every((slab) => {
      const was = beforeDrag.slabs.find((entry) => entry.id === slab.id)
      return was === undefined || Math.abs((was.x - slab.x) % 39) < 0.5
    }))
  check('the reader is told they are in history, and offered the way back',
    pannedRails.chip !== undefined && (pannedRails.chip.text ?? '').includes('最新')
    && (pannedRails.chip.title ?? '').includes('回看中'),
    JSON.stringify(pannedRails.chip))
  // Four columns of history are hidden on the left and four newer ones on the right: both fades
  // are on, which is exactly what they are for — the rails say how much, the fades say where.
  check('both fades are on while the window sits in the middle of the ring',
    pannedRails.fades.left === true && pannedRails.fades.right === true, JSON.stringify(pannedRails.fades))
  check('the drop slot is not drawn in history: the next brick lands at the live corner',
    pannedRails.ghost === undefined)

  // The way back, in one click.
  await page.locator('[data-cache-bricks-live]').click()
  await page.waitForTimeout(260)
  const backLive = await readRails()
  const liveBricks = await readBoard()
  // At the live corner the thumb sits at the far end of its track, which the rail reports as
  // "pan 0 from the content's start" — i.e. valuenow equals valuemax.
  check('the way back returns to the live corner and the control disappears',
    backLive.chip === undefined && backLive.x.valueNow === backLive.x.valueMax
    && liveBricks.turns[liveBricks.turns.length - 1] === 20,
    JSON.stringify([backLive.chip, backLive.x.valueNow, backLive.x.valueMax, liveBricks.turns[liveBricks.turns.length - 1]]))

  // Keyboard: the rail is a tab stop and Home/End reach both ends of the content.
  await page.locator('[data-cache-bricks-rail="x"]').focus()
  await page.keyboard.press('Home')
  await page.waitForTimeout(200)
  const atStart = await readBoard()
  check('Home reaches the oldest Turn the ring still holds',
    atStart.turns[0] === 1 && atStart.turns.length > 0, JSON.stringify(atStart.turns))
  await page.keyboard.press('End')
  await page.waitForTimeout(200)
  const atEnd = await readBoard()
  check('End comes back to the newest', atEnd.turns[atEnd.turns.length - 1] === 20, JSON.stringify(atEnd.turns))

  // The wheel over the rail pans the board; everywhere else it still reaches the transcript.
  const beforeWheel = await readRails()
  const railBox = await page.locator('[data-cache-bricks-rail="x"]').boundingBox()
  await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + railBox.height / 2)
  await page.mouse.wheel(-120, 0)
  await page.waitForTimeout(200)
  const wheeled = await readRails()
  // A negative deltaY asks for earlier content, which moves the thumb away from the live end —
  // so the reported pan-from-the-start goes *down*, and the transcript does not move at all.
  check('the wheel over the rail pans the board, and does not move the conversation',
    wheeled.x.valueNow < beforeWheel.x.valueNow && wheeled.chatScroll === beforeWheel.chatScroll,
    JSON.stringify([beforeWheel.x.valueNow, wheeled.x.valueNow, beforeWheel.chatScroll, wheeled.chatScroll]))
  const offRail = await page.locator('[data-cache-bricks-grid]').boundingBox()
  await page.mouse.move(offRail.x + 5, offRail.y + 5)
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(200)
  const afterOffRail = await readRails()
  check('the wheel off the rail still scrolls the conversation',
    afterOffRail.chatScroll > wheeled.chatScroll,
    JSON.stringify([wheeled.chatScroll, afterOffRail.chatScroll]))

  // The vertical rail earns its travel from a Turn taller than the board.
  await page.evaluate(() => {
    const brick = window.__fixture.brick
    const bricks = []
    for (let step = 1; step <= 60; step += 1) bricks.push(brick(1, step, step % 7 === 0 ? 'bad' : 'good'))
    window.__fixture.push({ sessionId: 'S', bricks, backfilled: 0, dropped: 0, endedTurns: [], dispatched: 60 })
  })
  await page.waitForTimeout(260)
  const tall = await readRails()
  const tallState = await page.evaluate(() => {
    const steps = [...document.querySelectorAll('[data-cache-bricks-brick]')]
      .map((el) => Number(el.dataset.cacheBricksBrick.split(':')[2])).sort((a, b) => a - b)
    return { first: steps[0], last: steps[steps.length - 1], count: steps.length }
  })
  // Following means the brick that just landed is in frame: the window rises by exactly what the
  // Turn cannot fit, so the newest step is drawn and the floor rows are the ones left out.
  const rowsFit = Math.floor((tall.host.height - 16 - 6 + 3) / 18)
  check('while following a Turn taller than the board, the newest brick is in frame',
    tallState.last === 60 && tallState.count === rowsFit && tallState.first === 60 - rowsFit + 1,
    `${JSON.stringify(tallState)} · rows ${String(rowsFit)}`)
  check('a Turn taller than the board gives the vertical rail travel',
    tall.y.valueMax > 0 && tall.y.tabIndex === 0 && tall.y.disabled === 'false',
    JSON.stringify([tall.y.valueMax, tall.y.tabIndex]))
  // Raised to the top of the column: the rail's thumb sits at the newest end, and no fade claims
  // rows above — because there are none, the rest of the Turn is *below* the window.
  check('a running Turn taller than the board raises the window to its own newest brick',
    tall.y.valueNow === 0 && tall.fades.top === false,
    JSON.stringify([tall.y.valueNow, tall.fades.top]))
  await page.locator('[data-cache-bricks-rail="y"]').focus()
  const focused = await page.evaluate(() => document.activeElement?.dataset?.cacheBricksRail ?? 'none')
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(200)
  const lowered = await readRails()
  // ArrowDown walks towards the floor, i.e. a smaller pan from the start of the content, so the
  // rail reports a *larger* value-now; ArrowUp is the one that goes further back.
  check('the vertical rail answers the arrow keys, and then a fade says what is above',
    focused === 'y' && lowered.y.valueNow > tall.y.valueNow && lowered.fades.top === true,
    JSON.stringify([focused, tall.y.valueNow, lowered.y.valueNow, lowered.fades.top]))

  check('no unhandled browser error', pageErrors.length === 0, pageErrors.join(' | '))

  // A reader who asked for less motion gets no transitions at all: the brick is simply there.
  const calm = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  try {
    await calm.setContent(TRANSCRIPT)
    await calm.addScriptTag({ path: join(react, 'umd/react.production.min.js') })
    await calm.addScriptTag({ path: join(dom, 'umd/react-dom.production.min.js') })
    await calm.addScriptTag({
      content: `{const m={exports:{}};((module,exports,require)=>{${runtime}\n})(m,m.exports,()=>React);`
        + `window.__testExternals={'react':React,'react/jsx-runtime':m.exports};window.__ReactDOM=ReactDOM;}`,
    })
    await calm.addScriptTag({ path: join(root, 'tests/fixture.js') })
    await calm.addScriptTag({ path: join(root, 'lib/client.js') })
    await calm.evaluate(() => {
      window.__fixture.start()
      window.__fixture.push({ sessionId: 'S', bricks: [window.__fixture.brick(1, 1, 'good')], backfilled: 0, dropped: 0, endedTurns: [1], dispatched: 1 })
    })
    await calm.waitForTimeout(300)
    const still = await calm.evaluate(() => {
      const slab = document.querySelector('[data-cache-bricks-brick]')
      const ghost = document.querySelector('[data-cache-bricks-ghost]')
      return {
        transition: getComputedStyle(slab).transitionProperty,
        ghostTransition: getComputedStyle(ghost).transitionProperty,
        text: (slab.textContent ?? '').trim(),
      }
    })
    check('prefers-reduced-motion draws the same bricks with no animation at all',
      still.transition === 'none' && still.ghostTransition === 'none' && still.text === '99.0%',
      JSON.stringify(still))
  } finally {
    await calm.close()
  }

  // A public screenshot of the board itself: the gutter only, no conversation text.
  if (shotDir !== undefined) {
    mkdirSync(shotDir, { recursive: true })
    const board = page.locator('[data-cache-bricks-board]')
    await board.screenshot({ path: join(shotDir, 'lite-board.png') })
  }

  console.log(`\n${results.length - failures.length}/${results.length} checks passed (Chromium, React 18; mocked host, real layout).`)
  if (failures.length > 0) {
    console.log(`failures:\n${failures.map((name) => `  ✗ ${name}`).join('\n')}`)
    process.exitCode = 1
  }
} finally {
  await browser.close()
}
