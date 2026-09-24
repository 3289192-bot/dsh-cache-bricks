/**
 * Browser-level verification of the brick board, against a running instance.
 *
 * Three of the plugin's claims can only be checked in a real browser: the board is
 * a DOM overlay built outside React (so no server render contains it), its two
 * sides are a CSS 3D flip, and clicking a brick has to move the **conversation** —
 * real layout, the real Chat view, the real `[data-chat-turn]` anchors. This script
 * drives the served GUI with Playwright and checks exactly those three, plus the
 * panel that opens with the brick.
 *
 * Playwright is deliberately **not** a dependency of this package (it is heavy and
 * only this one script needs it), so the script resolves `playwright-core` from, in
 * order: `$PLAYWRIGHT_CORE`, the local `node_modules`, the global npm root, and the
 * globally installed `@playwright/mcp`. When none of them has it — or no Chromium
 * build is cached — it says so and exits 0, so the check never fails for a reason
 * that is not the plugin's.
 *
 * Usage:
 *   node scripts/ui-verify.mjs                     # port 18090, newest log's token
 *   node scripts/ui-verify.mjs --port 18083 --home <DSH_HOME_DAILY>
 *   node scripts/ui-verify.mjs --shot C:\tmp\shots # also write before/after PNGs
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const home = option('home', join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), '.dsh-017'))
const port = Number(option('port', '18090'))
const base = `http://127.0.0.1:${String(port)}`
const shotDir = option('shot', undefined)
const requestedSession = option('session', undefined)

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures.push(label)
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Resolve `playwright-core` from wherever this machine happens to keep it. */
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
      const scoped = createRequire(join(root, 'noop.js'))
      return scoped('playwright-core')
    } catch {
      // Try the next root.
    }
  }
  try {
    return require('playwright-core')
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

/** Newest web log, whose first line carries the single-use token. */
function newestLog() {
  const dir = join(home, 'logs')
  const files = readdirSync(dir).filter((name) => /^web-.*\.out\.log$/u.test(name))
  files.sort((left, right) => statSync(join(dir, right)).mtimeMs - statSync(join(dir, left)).mtimeMs)
  return files.length === 0 ? undefined : join(dir, files[0])
}

/** Cookie jar obtained by exchanging the launcher's single-use token. */
async function authenticate() {
  const log = newestLog()
  if (log === undefined) return { cookie: undefined, token: undefined }
  const match = /token=([A-Za-z0-9_-]+)/u.exec(readFileSync(log, 'utf8'))
  if (match === null) return { cookie: undefined, token: undefined }
  const response = await fetch(`${base}/?token=${match[1]}`, { redirect: 'manual' })
  const jar = (response.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0]).join('; ')
  return { cookie: jar === '' ? undefined : jar, token: match[1] }
}

const playwright = loadPlaywright()
if (playwright === undefined) {
  console.log('playwright-core is not installed; skipping the browser check')
  console.log('  set PLAYWRIGHT_CORE to a package root that has it, or `npm i -g @playwright/mcp`')
  process.exit(0)
}

const auth = await authenticate()
if (auth.cookie === undefined) {
  console.log(`no launcher token found under ${join(home, 'logs')}; is the instance running?`)
  process.exit(0)
}

// --- pick the richest observed session --------------------------------------
const listed = await fetch(`${base}/cache-badge/sessions`, { headers: { cookie: auth.cookie } })
if (!listed.ok) {
  console.log(`the collector route answered ${String(listed.status)}; nothing to verify (is the host half loaded?)`)
  process.exit(0)
}
const { sessions } = await listed.json()
let richest = { id: requestedSession, bricks: -1, feed: undefined }
for (const id of sessions) {
  if (requestedSession !== undefined && id !== requestedSession) continue
  const feed = await fetch(`${base}/cache-badge/attempts?sessionId=${encodeURIComponent(id)}`, {
    headers: { cookie: auth.cookie },
  })
  const body = await feed.json()
  const bricks = body.bricks?.length ?? 0
  if (bricks > richest.bricks) richest = { id, bricks, feed: body }
}
if (richest.id === undefined || richest.bricks <= 0) {
  console.log('no session with observed bricks yet; run a turn and try again')
  process.exit(0)
}

// --- drive the GUI -----------------------------------------------------------
console.log(`instance ${base} · session ${richest.id} (${String(richest.bricks)} bricks)`)
let browser
try {
  browser = await playwright.chromium.launch({ headless: true })
} catch (error) {
  const executablePath = cachedChromium()
  if (executablePath === undefined) {
    console.log(`no Chromium available for Playwright (${String(error).split('\n')[0]}); skipping`)
    process.exit(0)
  }
  browser = await playwright.chromium.launch({ headless: true, executablePath })
}

const shot = async (page, name) => {
  if (shotDir === undefined) return
  mkdirSync(shotDir, { recursive: true })
  await page.screenshot({ path: join(shotDir, name) })
}

let exitCode = 0
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await page.goto(`${base}/?token=${auth.token}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  const row = page.locator(`div[role="treeitem"][data-row-key="session:${richest.id}"]`)
  if (await row.count() === 0) {
    console.log(`session ${richest.id} is not in the sidebar of this instance; skipping`)
    await browser.close()
    process.exit(0)
  }
  await row.first().click()
  await page.waitForTimeout(3500)
  // Park the pointer away from the sidebar: its hover preview would otherwise sit
  // on top of the board and swallow the click this script is about to make.
  await page.mouse.move(1200, 700)
  await page.waitForTimeout(400)

  const board = page.locator('[data-cache-badge-board]')
  await board.first().waitFor({ timeout: 10_000 }).catch(() => {})
  check('the board is mounted in the gutter', await board.count() === 1)
  const box = await board.first().boundingBox().catch(() => null)
  check('the board has a usable size', box !== null && box.width >= 70 && box.height >= 45, JSON.stringify(box))

  const cacheSlabs = page.locator('[data-cache-badge-layer="cache"] > div')
  const cacheCount = await cacheSlabs.count()
  check('the cache side carries one slab per visible brick', cacheCount > 0, String(cacheCount))

  // The reading is the slab's own text node; a lifecycle mark is a child span, so
  // reading `firstChild` keeps a marked brick from looking like a malformed reading.
  const labels = await cacheSlabs.evaluateAll((els) => els.map((el) => (el.firstChild?.textContent ?? '').trim()))
  check('every reading is a percentage or an honest n/a',
    labels.length > 0 && labels.every((text) => /^(\d+(\.\d+)?%|n\/a)$/u.test(text)), JSON.stringify(labels.slice(0, 4)))

  const marks = await cacheSlabs.evaluateAll((els) => els
    .flatMap((el) => [...el.querySelectorAll('[data-cache-badge-mark]')])
    .map((el) => el.textContent))
  // The four glyphs `LIFECYCLE` defines: retry ↻, failure !, interrupted ⏹, output limit ⌁.
  check('lifecycle is drawn as glyphs, never as a colour of its own',
    marks.every((glyph) => ['↻', '!', '⏹', '⌁'].includes(String(glyph))), JSON.stringify([...new Set(marks)]))

  const kinds = await cacheSlabs.evaluateAll((els) => els.map((el) => el.dataset.cacheBadgeKind))
  check('every brick already knows its activity type',
    kinds.every((kind) => ['output', 'reasoning', 'tool', 'mixed', 'auxiliary'].includes(String(kind))))

  // The type side is built on demand: it must not exist until the card is flipped.
  check('the type side is not built while it faces away', await page.locator('[data-cache-badge-layer="type"] > div').count() === 0)

  const chip = page.locator('[data-cache-badge-flip]')
  check('the flip control is on the board', await chip.count() === 1, await chip.first().textContent().catch(() => ''))
  const rotator = page.locator('[data-cache-badge-layer="cache"]').first()
  check('the card starts on its cache side',
    (await rotator.evaluate((el) => el.parentElement.style.transform)) === 'rotateY(0deg)')
  await shot(page, 'board-cache.png')

  await chip.first().click()
  await page.waitForTimeout(900)
  check('the flip turns the whole card over',
    (await rotator.evaluate((el) => el.parentElement.style.transform)) === 'rotateY(180deg)')
  check('the control now offers the way back', (await chip.first().textContent()) === '缓存')
  const typeSlabs = page.locator('[data-cache-badge-layer="type"] > div')
  const typeCount = await typeSlabs.count()
  check('the activity side mirrors the bricks', typeCount === cacheCount, `${String(typeCount)} vs ${String(cacheCount)}`)
  const faces = await typeSlabs.evaluateAll((els) => els.map((el) => ({
    kind: el.dataset.cacheBadgeKind,
    text: (el.textContent ?? '').trim(),
    segments: el.querySelectorAll('[data-cache-badge-segment]').length,
  })))
  check('a split face is exactly the model/tool pair (the official thinking + acting lanes)',
    await typeSlabs.evaluateAll((els) => els
      .filter((el) => el.querySelectorAll('[data-cache-badge-segment]').length > 0)
      .every((el) => [...el.querySelectorAll('[data-cache-badge-segment]')]
        .map((part) => part.dataset.cacheBadgeSegment).join('+') === 'model+tool')))
  // The type face is drawn the way the official timeline draws a span: flat, one-pixel
  // corners, no rim and no shadow, opacity .78 for a background lane and 1 for the lanes that
  // matter. The only gradient the official view has is the model lane's TTFT one — so any
  // other vertical gradient here means the invented "material" came back.
  const look = await typeSlabs.evaluateAll((els) => els.slice(0, 16).map((el) => {
    const style = getComputedStyle(el)
    const fill = style.backgroundImage === 'none' ? style.backgroundColor : style.backgroundImage
    return {
      kind: el.dataset.cacheBadgeKind,
      radius: style.borderTopLeftRadius,
      shadow: style.boxShadow,
      opacity: style.opacity,
      fill,
      bevel: /linear-gradient\((?![^)]*to right)/u.test(fill),
      parts: [...el.querySelectorAll('[data-cache-badge-segment]')].map((part) => ({
        tone: part.dataset.cacheBadgeSegment,
        fill: getComputedStyle(part).backgroundImage === 'none'
          ? getComputedStyle(part).backgroundColor
          : getComputedStyle(part).backgroundImage,
      })),
    }
  }))
  check('every type face is an official span: flat, 1px corners, no shadow',
    look.length > 0 && look.every((entry) => entry.radius === '1px' && entry.shadow === 'none' && !entry.bevel
      // A split face is transparent on purpose: its halves carry the fill.
      && (entry.kind === 'mixed' ? entry.parts.length === 2 : entry.fill !== 'rgba(0, 0, 0, 0)')),
    JSON.stringify(look.slice(0, 3)))
  check('a split face is two flat halves, and only the model lane may carry a gradient',
    look.every((entry) => entry.kind !== 'mixed'
      || (entry.parts.length === 2 && entry.parts.every((part) => part.fill !== 'rgba(0, 0, 0, 0)'
        && (part.tone !== 'model' || part.fill !== 'none')))))
  // The seam direction is part of the reading — the model half is always on the left and the
  // tools half on the right — so a vertical split is a defect, not a variation. This is also
  // the guard for the transition a streaming brick makes (reasoning only, then a tool call).
  const seams = await typeSlabs.evaluateAll((els) => els
    .filter((el) => el.querySelectorAll('[data-cache-badge-segment]').length === 2)
    .map((el) => {
      const parts = [...el.querySelectorAll('[data-cache-badge-segment]')]
      const rects = parts.map((part) => part.getBoundingClientRect())
      return {
        tones: parts.map((part) => part.dataset.cacheBadgeSegment).join('+'),
        direction: getComputedStyle(el).flexDirection,
        sideBySide: Math.abs(rects[0].top - rects[1].top) < 1.5,
        stacked: Math.abs(rects[0].left - rects[1].left) < 1.5,
      }
    }))
  check(`every split brick is split left/right, never top/bottom (${String(seams.length)} checked)`,
    seams.every((seam) => seam.direction === 'row' && seam.sideBySide && !seam.stacked
      && seam.tones === 'model+tool'),
    JSON.stringify(seams.filter((seam) => !seam.sideBySide).slice(0, 3)))

  check('official opacity: background lanes are dimmed, the lanes that matter are not',
    look.every((entry) => (entry.kind === 'auxiliary' ? entry.opacity === '0.78' : entry.opacity === '1')),
    JSON.stringify(look.map((entry) => [entry.kind, entry.opacity])))
  check('the cache face keeps its own translucent tone',
    !(await cacheSlabs.first().evaluate((el) => getComputedStyle(el).backgroundImage)).includes('linear-gradient'))

  // The face is colour only. The lane word and the specific still exist — in the tooltip and
  // the panel — so this checks both halves of that: nothing printed, and nothing lost.
  //
  // The lifecycle corner mark is excluded on purpose: it is a glyph that both faces carry by
  // design (`paintBadge`: "a request that failed is worth seeing from the cache side too"), and
  // it is not a type label. Reading `textContent` whole would fail this check the first time an
  // interrupted or output-limited brick lands on the board.
  const spoken = await typeSlabs.evaluateAll((els) => els.slice(0, 24).map((el) => {
    const clone = el.cloneNode(true)
    for (const mark of clone.querySelectorAll('[data-cache-badge-mark]')) mark.remove()
    return {
      kind: el.dataset.cacheBadgeKind,
      text: (clone.textContent ?? '').trim(),
      spoken: `${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`,
    }
  }))
  check('no type face prints anything: the colour is the reading',
    spoken.length > 0 && spoken.every((entry) => entry.text === ''), JSON.stringify(spoken.filter((entry) => entry.text !== '').slice(0, 4)))
  check('every face still names its lane and its specific where there is room',
    spoken.every((entry) => ['MODEL', 'TOOL', 'SYS'].some((word) => entry.spoken.includes(word))),
    JSON.stringify(spoken.slice(0, 2).map((entry) => entry.spoken.slice(0, 70))))

  const typeKinds = faces.map((face) => face.kind)
  check('the two sides agree on every brick',
    JSON.stringify([...typeKinds].sort()) === JSON.stringify([...kinds].sort()))
  check('the visible side is interactive and the hidden one is not',
    (await typeSlabs.first().evaluate((el) => el.style.pointerEvents)) === 'auto'
    && (await cacheSlabs.first().evaluate((el) => el.style.pointerEvents)) === 'none')

  // The board is muted at the cache face's visual weight; the one brick being pointed
  // at is the only one that wears the full-strength colour.
  // Every lane lights up under the pointer: the brick being read is the one that wears its
  // official colour at full strength, whatever lane it is in.
  /** The painted fill of a face: a gradient when it has one, the colour otherwise. */
  const fillOf = (locator) => locator.evaluate((el) => {
    const style = getComputedStyle(el)
    return style.backgroundImage === 'none' ? style.backgroundColor : style.backgroundImage
  })

  const litIndex = await typeSlabs.evaluateAll((els) => els.findIndex((el) => ['reasoning', 'tool'].includes(el.dataset.cacheBadgeKind)))
  if (litIndex >= 0) {
    const slab = typeSlabs.nth(litIndex)
    const quiet = await fillOf(slab)
    await slab.hover()
    await page.waitForTimeout(250)
    const lit = await fillOf(slab)
    await page.mouse.move(1250, 700)
    await page.waitForTimeout(250)
    const settled = await fillOf(slab)
    check(`the pointed-at brick lights up and settles back (${quiet} → ${lit} → ${settled})`,
      quiet === settled && lit !== quiet)
    // What it lights up *to* is the official trajectory colour itself, resolved by the page —
    // the tokens are the contract, and this is what proves they reached the browser.
    const official = await page.evaluate((expr) => {
      const probe = document.createElement('div')
      document.body.append(probe)
      probe.style.backgroundImage = `linear-gradient(${expr}, ${expr})`
      const resolved = getComputedStyle(probe).backgroundImage
      probe.remove()
      return resolved
    }, 'var(--dsw-alias-state-warn-label)')
    const isTool = await slab.evaluate((el) => el.dataset.cacheBadgeKind === 'tool')
    if (isTool) {
      // The zone is a material, so its gradient holds three stops — the tone itself is the
      // middle one, next to the lit top and the shadowed bottom. Comparing painted pixels,
      // because the two are serialized differently (`color(srgb …)` and `rgb(…)`).
      const stops = lit.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)/gu) ?? []
      const officialColour = /rgba?\([^)]*\)|color\(srgb[^)]*\)/u.exec(official)?.[0]
      const wears = stops.length > 0 && officialColour !== undefined && await page.evaluate(([candidates, target]) => {
        const ctx = document.createElement('canvas').getContext('2d')
        const painted = (value) => {
          ctx.clearRect(0, 0, 1, 1)
          ctx.fillStyle = '#000'
          ctx.fillStyle = value
          ctx.fillRect(0, 0, 1, 1)
          return [...ctx.getImageData(0, 0, 1, 1).data].join(',')
        }
        return candidates.some((candidate) => painted(candidate) === painted(target))
      }, [stops, officialColour])
      check(`the lit brick wears the official tool colour (${String(officialColour)})`,
        wears, `${JSON.stringify(stops)} vs ${String(officialColour)}`)
    }
  }
  // The same must hold for the other lanes — an answer, and an auxiliary call — so the rule
  // is "the brick under the pointer lights up", not "purple and orange do".
  const otherIndex = await typeSlabs.evaluateAll((els) => els
    .findIndex((el) => ['output', 'auxiliary'].includes(el.dataset.cacheBadgeKind) && el.querySelectorAll('[data-cache-badge-segment]').length === 0))
  if (otherIndex >= 0) {
    const slab = typeSlabs.nth(otherIndex)
    const kind = await slab.evaluate((el) => el.dataset.cacheBadgeKind)
    const before = await fillOf(slab)
    await slab.hover()
    await page.waitForTimeout(250)
    const after = await fillOf(slab)
    await page.mouse.move(1250, 700)
    await page.waitForTimeout(200)
    const settled = await fillOf(slab)
    check(`a ${kind} brick lights up too, and settles back`, before !== after && before === settled)
  }
  await shot(page, 'board-type.png')

  await chip.first().click()
  await page.waitForTimeout(700)
  check('the card turns back to the readings',
    (await rotator.evaluate((el) => el.parentElement.style.transform)) === 'rotateY(0deg)')

  // --- click bricks: each must land on its OWN row, or say it did not -------------
  // The bar is exact, deliberately. Accepting a nearby row as a pass is what let this
  // feature look fixed for several rounds while it was not: a brick whose row cannot be
  // produced must report `none`, and this script must fail on it rather than shrug.
  const pageLog = []
  page.on('console', (message) => { pageLog.push(message.text()) })

  // Sample **settled** bricks, chosen from the collector's own feed rather than from the
  // DOM: a brick whose attempt is still streaming has no committed row yet, so requiring
  // it to land exactly would be testing the runtime's timing rather than this plugin.
  const settled = (richest.feed?.bricks ?? []).filter((brick) => brick.settlement !== 'running')
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-chat-node-key]')]
    .map((el) => ({ key: el.dataset.chatNodeKey ?? '', laidOut: el.getBoundingClientRect().height > 0 })))
  const boardKeys = await page.locator('[data-cache-badge-layer="cache"] > div').evaluateAll((els) => els.map((el) => el.dataset.cacheBadgeBrick))
  const onBoard = settled.filter((brick) => boardKeys.includes(brick.identity.id))

  // The anchors a brick's **declared target** maps to: its retry chain, its step's row,
  // the rows of the calls it made. At least one must exist for the brick to be locatable at
  // all — a brick whose target resolves to nothing is a real, countable failure. Note this
  // is *not* "a row nobody else can point at": a retried step's two bricks share one row.
  const anchorsOf = (brick) => {
    const callIds = (brick.tools ?? []).map((call) => call.callId)
    const retryId = brick.retry?.retryId ?? brick.retryChainId
    const content = (brick.metrics?.reasoningChars ?? 0) > 0 || (brick.metrics?.textChars ?? 0) > 0
    return [
      retryId === undefined ? undefined : `model-retry${String(retryId)}`,
      content || callIds.length === 0
        ? `assistant-step${String(brick.identity.turn)}:${String(brick.identity.step)}`
        : undefined,
      callIds.length === 0 ? undefined : `tool-call${String(callIds[0])}`,
    ].filter((anchor) => anchor !== undefined)
  }
  const width = (suffix, laid) => rows.some((row) => row.key.endsWith(suffix) && (!laid || row.laidOut))
  // A brick whose attempt produced neither assistant content nor a tool call has **nothing in
  // the transcript to point at** — the view renders no row for it at all (measured: a step
  // observed mid-flight at a collector restart, `chunkCount: 0`). `none` is then the correct
  // landing, not a defect — so the census counts those separately rather than letting them
  // hide a real miss, and the click proof below checks that they behave honestly.
  const hasVisibleArtifact = (brick) => (brick.metrics?.reasoningChars ?? 0) > 0
    || (brick.metrics?.textChars ?? 0) > 0
    || (brick.tools ?? []).length > 0
    || brick.retry !== undefined
    || brick.retryChainId !== undefined
  /**
   * A brick the plugin **itself** declares unreachable, by contract.
   *
   * An auxiliary call belongs to no Turn, so it has no `assistant-step` row to reach: a
   * compaction aims at the row keyed by its `compactionId`, and a session title — which the
   * transcript never renders — declares `none` outright (`targetOf`, and the target table in
   * `docs/brick-contract.md`). Counting those as misses would report the plugin's own honest
   * answer as a defect, so they are counted separately, exactly like a brick with no artifact.
   */
  const declaresItselfUnreachable = (brick) => (brick.identity?.turn ?? 0) <= 0
    && (brick.route?.purpose === 'session-title' || brick.compactionId === undefined)
  const withRow = onBoard.filter((brick) => anchorsOf(brick).some((anchor) => width(anchor, false)))
  const contractUnreachable = onBoard.filter((brick) => !withRow.includes(brick) && declaresItselfUnreachable(brick))
  const missing = onBoard
    .filter((brick) => !withRow.includes(brick))
    .filter((brick) => !declaresItselfUnreachable(brick))
    .filter(hasVisibleArtifact)
  const noArtifact = onBoard.filter((brick) => !withRow.includes(brick) && !hasVisibleArtifact(brick) && !declaresItselfUnreachable(brick))
  const collapsed = withRow.filter((brick) => !anchorsOf(brick).some((anchor) => width(anchor, true)))
  console.log(`  · census: ${String(onBoard.length)} settled bricks on the board — `
    + `${String(withRow.length)} with a row, ${String(collapsed.length)} needing a group opened, `
    + `${String(noArtifact.length)} with no visible artifact at all, `
    + `${String(contractUnreachable.length)} auxiliary call(s) with no row by contract`)
  if (contractUnreachable.length > 0) {
    console.log(`  · no row is expected for these (session title, or a compaction with no id): `
      + `${contractUnreachable.slice(0, 3).map((brick) => `${brick.identity.id} (${String(brick.route?.purpose ?? 'auxiliary')})`).join(', ')}`)
  }
  // A brick whose row is not in the DOM is no longer a defect by itself: the chat view holds a
  // window, and the unified loader is what brings the rest in. What *is* a defect is a brick
  // that produced something, has no row, **and** carries no log position to load through — that
  // one can never be reached, whatever the reader does.
  const loadable = missing.filter((brick) => (brick.settlementSeq ?? 0) > 0)
  const unreachable = missing.filter((brick) => (brick.settlementSeq ?? 0) === 0)
  if (loadable.length > 0) {
    console.log(`  · ${String(loadable.length)} brick(s) are behind history the chat has not loaded yet: `
      + `${loadable.slice(0, 3).map((brick) => brick.identity.id).join(', ')}`)
  }
  check('every settled brick that produced something can be reached: a row, or a log position to load through',
    unreachable.length === 0, unreachable.slice(0, 3).map((brick) => brick.identity.id).join(', '))
  if (noArtifact.length > 0) {
    console.log(`  · a brick with no artifact lands as none by contract: ${noArtifact.slice(0, 2).map((brick) => brick.identity.id).join(', ')}`)
  }

  // Then prove the plumbing end to end on a couple of them, preferring rows that need
  // nothing opened so the check stays quick.
  const sample = []
  const seenTurns = new Set()
  for (const brick of [...onBoard].reverse()) {
    if (seenTurns.has(brick.identity.turn)) continue
    if (!anchorsOf(brick).some((anchor) => width(anchor, true))) continue
    seenTurns.add(brick.identity.turn)
    sample.push({
      key: brick.identity.id,
      turn: brick.identity.turn,
      step: brick.identity.step,
      anchors: anchorsOf(brick),
    })
    if (sample.length >= 2) break
  }
  check('there are settled bricks on the board whose row is already visible', sample.length >= 1,
    `${String(onBoard.length)} on the board`)
  // And the bricks whose row is *not* loaded: those are the ones the acceptance bar is about.
  // They are clicked too — the loader has to bring the history in and the landing still has to
  // be exact, which is the whole point of routing both through one entry point.
  for (const brick of loadable.slice(0, 2)) {
    sample.push({
      key: brick.identity.id,
      turn: brick.identity.turn,
      step: brick.identity.step,
      anchors: anchorsOf(brick),
      needsLoad: true,
    })
  }
  if (sample.some((brick) => brick.needsLoad === true)) {
    console.log(`  · sampling ${String(sample.filter((brick) => brick.needsLoad === true).length)} brick(s) that need history loaded first`)
  }

  // A landing is exact when the marked row is one its declared target maps to — its step's
  // row, a call it made, or its retry chain — which is the same set the census checked for
  // existence.
  const landingOf = (anchors) => page.evaluate((suffixes) => {
    const marked = [...document.querySelectorAll('[data-chat-node-key][data-cache-badge-landed]')]
    const own = marked.find((el) => suffixes.some((suffix) => (el.dataset.chatNodeKey ?? '').endsWith(suffix)))
    return { key: own?.dataset.chatNodeKey ?? null, marked: marked.length }
  }, anchors)

  const onBoardKeysRecheck = await page.locator('[data-cache-badge-layer="cache"] > div').evaluateAll((els) => els.map((el) => el.dataset.cacheBadgeBrick))
  /** Bricks whose page the core loaded and then failed to render — with the log as evidence. */
  const coreRenderFailures = []
  /** How long each load-then-land took, in seconds, for the report. */
  const loadTimings = []
  // The assembler failure is a session-level condition, not a per-brick one: the first loaded
  // page that fails leaves the conversation without any of the turns it carried, so later
  // bricks in that stretch are already "loaded and undrawn" before they are clicked.
  let coreRenderFailureSeen = false
  const tally = { exact: 0, context: 0, none: 0 }
  const misses = []
  // One click is the inspector, and it must leave the conversation exactly where it was:
  // loading history and scrolling the transcript on every click is what made the board feel
  // like it was yanking the page out from under the reader.
  /**
   * Click one brick, resolved **fresh by key** every time.
   *
   * Two things make caching an element here wrong: the board is an overlay anchored to the
   * conversation's scrollport, so a jump or a page load moves every brick; and the board
   * re-lays-out when a turn grows. A stale handle therefore points at where the brick used to
   * be — `element is outside of the viewport`, intermittently, for reasons that have nothing to
   * do with the code under test. So: query by key, scroll it to the middle, let the frame
   * settle, then click.
   *
   * @param key - the brick's key (`session:turn:step:attempt`).
   * @param kind - `click` for the inspector, `dblclick` for the jump.
   */
  /**
   * Whether this runtime carries the `system-message` no-withdrawal patch.
   *
   * The plugin is not allowed to patch a built-in Definition, so whether a jump can land on a
   * turn that has to be paged in is a property of the *host* — and a report that does not say
   * which host it measured is a report nobody can reproduce.
   */
  const hostPatchState = () => {
    try {
      const bundle = readFileSync(join(home, 'runtime/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'), 'utf8')
      return bundle.includes('may never be withdrawn')
        ? 'patched (system-message keeps a materialized node; loaded pages project)'
        : 'unpatched — a loaded page may be dropped by the assembler (see host-patches/)'
    } catch {
      return 'unknown (client bundle not readable)'
    }
  }

  const clickBrick = async (key, kind = 'dblclick') => {
    const slab = page.locator(`[data-cache-badge-brick="${key}"][data-cache-badge-face="cache"]`)
    await slab.waitFor({ state: 'visible', timeout: 20000 })
    await slab.evaluate((el) => { el.scrollIntoView({ block: 'center', behavior: 'instant' }) })
    await page.waitForTimeout(120)
    await slab.evaluate((el) => { el.scrollIntoView({ block: 'center', behavior: 'instant' }) })
    if (kind === 'click') await slab.click({ timeout: 20000 })
    else await slab.dblclick({ timeout: 20000 })
  }

  const before = await page.locator('[data-conversation-scroll]').first().evaluate((el) => el.scrollTop)
  const firstKey = sample[0]?.key
  if (firstKey !== undefined) {
    await clickBrick(firstKey, 'click')
    await page.waitForTimeout(900)
    const afterOpen = await page.locator('[data-conversation-scroll]').first().evaluate((el) => el.scrollTop)
    const panel = await page.locator('[data-cache-badge-panel]').count()
    check('one click opens the record and does not move the conversation', panel === 1 && afterOpen === before,
      `panel=${String(panel)} scrollTop ${String(before)} → ${String(afterOpen)}`)
    await page.locator('[data-cache-badge-panel] button[aria-label="close"]').first().click()
    await page.waitForTimeout(300)
  }

  for (const brick of sample) {
    const { turn, step } = brick
    pageLog.length = 0
    try {
      // A double click is the jump: it is the one gesture that loads history and scrolls.
      await clickBrick(brick.key)
    } catch (error) {
      misses.push(`turn ${String(turn)} step ${String(step)} → the double click never landed: ${String(error).split('\n')[0]}`)
      tally.none += 1
      continue
    }

    // The board reports what it reached in one console line; wait for it rather than
    // guessing a delay, because paging a Turn in can take a moment.
    // A brick that needs history paged in waits on the loader, so the budget has to cover a
    // real load (and the settle window that follows it) rather than a DOM read.
    // Wait on the **report the reader sees**, not on console text: the panel's jump block only
    // exists after a jump and is overwritten by the next one, so it is a completion signal as
    // well as the thing under test. (Polling the console instead was fragile: a long run has
    // plenty of other plugin lines, and a text match is not evidence about the UI.)
    const budgetMs = brick.needsLoad === true ? 60000 : 10000
    let accuracy = undefined
    const startedAt = Date.now()
    for (let waited = 0; waited < budgetMs && accuracy === undefined; waited += 200) {
      await page.waitForTimeout(200)
      const reported = await page.locator('[data-cache-badge-jump]').first().getAttribute('data-cache-badge-jump').catch(() => null)
      if (reported === 'exact' || reported === 'context' || reported === 'none') accuracy = reported
    }
    const landedAfterMs = Date.now() - startedAt
    if (brick.needsLoad === true && accuracy !== undefined) {
      loadTimings.push(`${String(turn)}:${String(step)} ${String((landedAfterMs / 1000).toFixed(1))}s`)
    }
    if (accuracy === undefined) {
      const tail = pageLog.filter((entry) => entry.includes('[dsh-cache-badge]')).slice(-2).join(' ‖ ')
      misses.push(`turn ${String(turn)} step ${String(step)} → no jump report in ${String(budgetMs / 1000)}s (${tail || 'no plugin output'})`)
      tally.none += 1
      continue
    }
    tally[accuracy ?? 'none'] += 1
    if (accuracy !== 'exact') {
      // A brick that had to be paged in can miss for a reason that is not this plugin's: on
      // 0.1.7-rc.1 the conversation's own assembler throws while flushing the loaded page
      // (`Definition "system-message" withdrew materialized target "chat"`), so no row is ever
      // drawn — and the harness's turn navigator fails identically (reproduced below). The
      // excuse is only accepted with that exact error in the log, and it is counted, not hidden.
      const core = pageLog.some((entry) => entry.includes('withdrew materialized target'))
      if (core) coreRenderFailureSeen = true
      const loadHappened = /loaded|already covered/u.test(pageLog.join(' '))
      if (brick.needsLoad === true && coreRenderFailureSeen && loadHappened) {
        coreRenderFailures.push({ turn, step, key: brick.key })
      } else {
        misses.push(`turn ${String(turn)} step ${String(step)} → ${String(accuracy)}`)
      }
      continue
    }

    const locate = await page.locator('[data-cache-badge-locate]').first().getAttribute('data-cache-badge-locate')
    if (locate !== 'exact') misses.push(`turn ${String(turn)} step ${String(step)} → locate=${String(locate)}`)
    const landed = await landingOf(brick.anchors)
    if (landed.key === null) misses.push(`turn ${String(turn)} step ${String(step)} → marked ${String(landed.marked)} row(s), none of them on its target`)
    const panel = page.locator('[data-cache-badge-panel]')
    if (await panel.count() !== 1) misses.push(`turn ${String(turn)} step ${String(step)} → the record did not open`)
    const reported = await page.locator('[data-cache-badge-jump]').first().getAttribute('data-cache-badge-jump')
    if (reported !== 'exact') misses.push(`turn ${String(turn)} step ${String(step)} → the panel reported ${String(reported)}`)
  }

  // A brick the transcript cannot show must say so and stay put — that is the behaviour the
  // removed `nearest` fallback used to fake. Two different reasons produce the same honest
  // answer, so both are sampled: an attempt that produced nothing at all, and an auxiliary
  // call that declares itself unreachable by contract (a session title, or a compaction with
  // no id to match its row by).
  const unshowable = [
    ...noArtifact.map((brick) => ({ brick, why: 'no visible artifact' })),
    ...contractUnreachable.map((brick) => ({ brick, why: 'an auxiliary call with no transcript row' })),
  ]
  for (const { brick, why } of unshowable.slice(0, 2)) {
    if (!onBoardKeysRecheck.includes(brick.identity.id)) continue
    pageLog.length = 0
    const position = await page.locator('[data-conversation-scroll]').first().evaluate((el) => el.scrollTop)
    // Markers from the sampled exact landings above may still be fading; what matters is that
    // *this* click marks nothing new.
    const markedBefore = await page.locator('[data-cache-badge-landed]').count()
    try {
      await clickBrick(brick.identity.id)
    } catch {
      // The board may have moved the brick; the landing checks below already ran on the sample.
      continue
    }
    // The board names an auxiliary call as such rather than inventing a turn for it.
    const needle = brick.identity.turn > 0
      ? `turn ${String(brick.identity.turn)} step ${String(brick.identity.step)}:`
      : 'an auxiliary call:'
    let accuracy = undefined
    for (let waited = 0; waited < 6000 && accuracy === undefined; waited += 200) {
      await page.waitForTimeout(200)
      const line = pageLog.find((entry) => entry.includes(needle))
      accuracy = /: (exact|context|none) landing/u.exec(line ?? '')?.[1]
    }
    const moved = await page.locator('[data-conversation-scroll]').first().evaluate((el) => el.scrollTop)
    const markedAfter = await page.locator('[data-cache-badge-landed]').count()
    check(`a brick the transcript cannot show reports none, marks nothing and does not move (${why}; ${brick.identity.id})`,
      accuracy === 'none' && markedAfter <= markedBefore && moved === position,
      `accuracy=${String(accuracy)} marked ${String(markedBefore)} → ${String(markedAfter)}, `
      + `scrollTop ${String(position)} → ${String(moved)}`)
    break
  }

  console.log(`  · landings: ${String(tally.exact)} exact, ${String(tally.context)} context, ${String(tally.none)} none`)
  console.log(`  · host: ${hostPatchState()}`)
  if (loadTimings.length > 0) {
    console.log(`  · load-then-land: ${loadTimings.join(', ')} (official loader paging a long session)`)
  }
  if (coreRenderFailures.length > 0) {
    console.log(`  · NOTE: ${String(coreRenderFailures.length)} brick(s) were loaded and still drew no row — `
      + "the conversation assembler threw while flushing the loaded page (the harness's own "
      + `turn navigator fails the same way): ${coreRenderFailures.map((entry) => `${String(entry.turn)}:${String(entry.step)}`).join(', ')}`)
  }
  check('every sampled brick that was already rendered landed target-exact',
    tally.exact + coreRenderFailures.length === sample.length && misses.length === 0,
    misses.join(' | ') || `target-exact ${String(tally.exact)}/${String(sample.length)}`)

  // The excuse above is worth exactly as much as this reproduction: if the harness's own turn
  // navigator also fails to render that turn, the failure is the core's and not the plugin's.
  if (coreRenderFailures.length > 0) {
    const missed = coreRenderFailures[0]
    // The turn navigator's buttons are numbered badges with the turn in their accessible
    // name, so the name is what to match — matching text content would match nothing.
    const button = page.getByRole('button', { name: new RegExp(`第\\s*${String(missed.turn)}\\s*轮`, 'u') })
    if (await button.count() > 0) {
      const turnsBefore = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-chat-turn]')]
        .map((el) => Number(el.dataset.chatTurn)))].sort((a, b) => a - b))
      pageLog.length = 0
      await button.first().click()
      await page.waitForTimeout(9000)
      const turnsAfter = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-chat-turn]')]
        .map((el) => Number(el.dataset.chatTurn)))].sort((a, b) => a - b))
      // What matters is the observable failure, not which click logs the error: the assembler
      // throw happens on the *first* rebuild after a prepend, so a later click on the same turn
      // is silent while its rows stay missing. The claim being proven here is that the harness's
      // own control cannot draw that turn either — the same thing a reader would see.
      const sameError = pageLog.some((entry) => entry.includes('withdrew materialized target'))
      const unchanged = JSON.stringify(turnsAfter) === JSON.stringify(turnsBefore)
      check(`the harness's own navigator cannot draw turn ${String(missed.turn)} either `
        + '(the loaded rows never appear)',
        unchanged && turnsAfter.includes(missed.turn) === false,
        `assembler error this click=${String(sameError)} · turns ${JSON.stringify(turnsBefore)} → ${JSON.stringify(turnsAfter)}`)
    }
  }
  // --- the auxiliary lane, whenever this session has an auxiliary call to show ------
  // Compaction and session titles are real requests with real bricks; they belong to no
  // Turn, so they get the board's top row. The check is conditional only because such a
  // call has to have happened — it is not optional when one has.
  const auxBricks = (richest.feed?.bricks ?? []).filter((brick) => brick.identity.turn <= 0)
  if (auxBricks.length === 0) {
    console.log('  · lane: no auxiliary brick in this session yet (compaction / session title)')
  } else {
    const lane = await page.evaluate((keys) => {
      const label = document.querySelector('[data-cache-badge-lane="label"]')
      const rule = document.querySelector('[data-cache-badge-lane="rule"]')
      const shown = (el) => el !== null && el !== undefined && getComputedStyle(el).display !== 'none'
      const rendered = keys.map((key) => {
        const el = document.querySelector(`[data-cache-badge-brick="${key}"][data-cache-badge-face="cache"]`)
        return el === null
          ? { key, present: false, bottom: null }
          : { key, present: true, bottom: Math.round(el.getBoundingClientRect().bottom), height: Math.round(el.getBoundingClientRect().height) }
      })
      const others = [...document.querySelectorAll('[data-cache-badge-layer="cache"] > div')]
        .filter((el) => !keys.includes(el.dataset.cacheBadgeBrick))
        .map((el) => Math.round(el.getBoundingClientRect().bottom))
      return {
        label: label?.textContent ?? null,
        labelShown: shown(label),
        ruleShown: shown(rule),
        rendered,
        highestTurnBrick: others.length === 0 ? null : Math.min(...others),
      }
    }, auxBricks.map((brick) => brick.identity.id))
    const laidOut = lane.rendered.every((entry) => entry.present && (entry.height ?? 0) > 0)
    const above = lane.highestTurnBrick === null
      || lane.rendered.every((entry) => entry.bottom !== null && entry.bottom <= lane.highestTurnBrick)
    check(`the auxiliary lane shows ${String(auxBricks.length)} auxiliary brick(s), above every Turn column`,
      lane.label === 'SYS' && lane.labelShown && lane.ruleShown && laidOut && above, JSON.stringify(lane))
  }

  // The panel's button is the same act as the double click, and the transcript tab it sits
  // next to is the *other* half of the unified entry point: it loads the history a brick needs
  // and then reads the conversation from the log — without scrolling anything.
  // The panel's button is the double click, so it is proved on a brick the chat *has* drawn.
  if (firstKey !== undefined) {
    await page.locator(`[data-cache-badge-brick="${firstKey}"][data-cache-badge-face="cache"]`).click()
    await page.waitForTimeout(400)
    const panel = page.locator('[data-cache-badge-panel]')
    const locateButton = panel.getByRole('button', { name: '在主对话中定位' })
    check('the inspector offers the trip to the transcript', await locateButton.count() === 1)
    if (await locateButton.count() === 1) {
      pageLog.length = 0
      const position = await page.locator('[data-conversation-scroll]').first().evaluate((el) => el.scrollTop)
      await locateButton.click()
      let accuracy = undefined
      for (let waited = 0; waited < 10000 && accuracy === undefined; waited += 200) {
        await page.waitForTimeout(200)
        const line = pageLog.find((entry) => entry.includes('landing'))
        accuracy = /: (exact|context|none) landing/u.exec(line ?? '')?.[1]
      }
      const moved = await page.locator('[data-conversation-scroll]').first().evaluate((el) => el.scrollTop)
      const reported = await page.locator('[data-cache-badge-jump]').first().getAttribute('data-cache-badge-jump')
      check(`the panel's button lands the same row the double click does (${String(accuracy)})`,
        accuracy === 'exact' && reported === 'exact',
        `accuracy=${String(accuracy)} reported=${String(reported)} moved=${String(moved !== position)}`)
    }
    await page.locator('[data-cache-badge-panel] button[aria-label="close"]').first().click()
    await page.waitForTimeout(300)
  }

  // The transcript tab is proved on a brick whose step committed text — preferring one the
  // chat could *not* draw, because reading *that* conversation is what proves the inspector
  // works off the session log instead of off whatever rows happen to be rendered.
  const undrawnKey = coreRenderFailures
    .map((entry) => onBoard.find((brick) => brick.identity.id === entry.key))
    .find((brick) => brick !== undefined && (brick.metrics?.textChars ?? 0) > 0)?.identity.id
  const texty = onBoard.find((brick) => brick.identity.id === undrawnKey)
    ?? onBoard.find((brick) => (brick.metrics?.textChars ?? 0) > 0 && (brick.metrics?.reasoningChars ?? 0) > 0)
    ?? onBoard.find((brick) => (brick.metrics?.textChars ?? 0) > 0)
  const talkKey = texty?.identity.id ?? firstKey
  if (talkKey !== undefined) {
    // Read before selecting: the read is now triggered by the selection itself, so the
    // "did it move the chat" question has to be asked across the whole gesture.
    const scrollBeforeRead = await page.locator('[data-conversation-scroll]').first().evaluate((el) => el.scrollTop)
    const markedBeforeClick = await page.locator('[data-chat-node-key][data-cache-badge-landed]').count()
    await page.locator(`[data-cache-badge-brick="${talkKey}"][data-cache-badge-face="cache"]`).click()
    const panel = page.locator('[data-cache-badge-panel]')

    // The interaction contract changed with 1.7.1-clickfix.1: a single click **is** the request
    // to read — the panel opens on 对话 and loads this brick's log itself — so there is no
    // "read the conversation" button left to press. What must not change is that the read
    // never moves the main conversation, and that a single click never marks a row (marking is
    // what a double click, i.e. the locate, does): the two are checked across the click itself.
    let state = 'loading'
    for (let waited = 0; waited < 12000 && state === 'loading'; waited += 200) {
      await page.waitForTimeout(200)
      state = await page.locator('[data-cache-badge-transcript-state]').first().getAttribute('data-cache-badge-transcript-state')
    }
    // Past the 300 ms single/double-click discriminator: if the click had been read as a
    // locate, its highlight would be on the row by now.
    await page.waitForTimeout(600)
    const markedAfterClick = await page.locator('[data-chat-node-key][data-cache-badge-landed]').count()
    const scrollAfterRead = await page.locator('[data-conversation-scroll]').first().evaluate((el) => el.scrollTop)
    check(`selecting a brick reads its conversation without a second click (${state})`,
      state === 'ready' || state === 'unavailable', String(state))
    check('a single click previews without marking a row',
      markedAfterClick <= markedBeforeClick, `${String(markedBeforeClick)} → ${String(markedAfterClick)} marked row(s)`)
    check('reading the conversation leaves the chat where it was', scrollAfterRead === scrollBeforeRead,
      `scrollTop ${String(scrollBeforeRead)} → ${String(scrollAfterRead)}`)
    if (state === 'ready') {
      const blocks = await page.locator('[data-cache-badge-transcript]').evaluateAll((els) => els
        .map((el) => [el.dataset.cacheBadgeTranscript ?? '', (el.textContent ?? '').trim()]))
      const labels = blocks.map((block) => block[0])
      check(`the transcript tab reads the log, not the DOM: labelled verbatim blocks (${String(talkKey)})`,
        blocks.length > 0 && labels.some((label) => label.startsWith('input')) && labels.includes('assistant'),
        JSON.stringify(labels.slice(0, 6)))
      const assistantBlock = blocks.find((block) => block[0] === 'assistant')
      const assistant = assistantBlock === undefined ? '' : assistantBlock[1]
      check('the assistant block holds the text the log committed for this step', assistant !== '' && assistant !== '(empty)',
        assistant.slice(0, 60))
    }
  }

  await shot(page, 'brick-jump.png')
} finally {
  await browser.close()
}

console.log(failures.length === 0 ? '\nall checks passed' : `\n${String(failures.length)} check(s) failed`)
exitCode = failures.length === 0 ? 0 : 1
process.exit(exitCode)
