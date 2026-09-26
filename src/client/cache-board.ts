/**
 * The board: bricks in the gutter beside the conversation.
 *
 * The art direction is 0.1.3's, kept whole, because it is the part a reader feels:
 *
 * - **the material** — a brick is a flat slab in its tone's colour with a 1px edge of the same hue
 *   and a hairline of light along the top, reading `99.9%` in tabular monospace at 12px. A wall of
 *   healthy bricks is deliberately quiet (18% green): the one that is red is the one to look at;
 * - **the chrome** — a rounded panel tinted like the app's own surfaces, a 1px floor line under the
 *   bricks, a dashed **drop slot** where the running Turn's next brick will land;
 * - **the window** — two rails, one under the grid and one down its left edge, with the thumb
 *   anchored at the live corner; edge fades that say which way there is more; a `⤓ 最新` chip that
 *   appears only while the board is showing history;
 * - **the motion** — a brick falls in on `bottom 420ms cubic-bezier(.45,.02,.95,.55)`, a finished
 *   Turn's stack slides left on `right 260ms ease-out`, and a hand-driven pan turns both off so a
 *   drag is not a rubber band. `prefers-reduced-motion` turns them off for good.
 *
 * What is **not** here, because a Lite brick has nothing to show for it: the flip, the type face,
 * the inspector, navigation, the auxiliary lane. One brick, one colour, one number.
 */
import {
  BRICK_H,
  BRICK_W,
  RAIL_MIN_THUMB,
  boardWindow,
  cellPlacement,
  clampScroll,
  fitBoard,
  heldScroll,
  newestTurnOf,
  pitchX,
  pitchY,
  railGeometry,
  tallestColumn,
  windowCell,
  type BoardColumn,
  type BoardMetrics,
  type BoardScroll,
  type BoardWindow,
  type RailGeometry,
} from './board-geometry'
import { brickLabel, type BrickFeed, type BrickTone, type CacheBrick } from '../shared/cache-brick'

/**
 * Height of the board's own strip, in CSS pixels.
 *
 * The strip is carved out of the band rather than laid over the grid, so no brick is ever under
 * the control that names the board's state.
 */
const CHROME_H = 16

/**
 * Thickness of the board's own rails, in CSS pixels — also carved out of the band: a rail laid
 * *over* the grid would hide the newest column's digits and swallow its clicks.
 */
const RAIL = 6

/** Where the grid starts inside the board's box: the vertical rail takes the left edge. */
const GRID_LEFT = RAIL

/** How far an edge fade reaches into the grid, in CSS pixels. */
const FADE = 9

/** The brick transition: gravity on the way down, a shorter slide when the stack shifts left. */
const SLAB_TRANSITION = 'bottom 420ms cubic-bezier(.45,.02,.95,.55), right 260ms ease-out'

/** How long a hand-driven pan keeps the bricks from animating their own moves, in milliseconds. */
const PAN_QUIET_MS = 200

/** Size of the reading printed on a brick: five characters fit a 34px inner box at this size. */
const BRICK_TEXT_PX = 12

/** Fallback composer height when the shell has not published its variable yet. */
const COMPOSER_FALLBACK = 152

/** A hovered brick is the one being read: brighter, with no frame around it. */
const FOCUS_FILTER = 'brightness(1.35)'

/**
 * The cache face's palette — 0.1.3's tables, unchanged.
 *
 * The green is deliberately quiet (18% fill, 75% digits): a board holds a hundred bricks at once,
 * and a hundred loud bricks stop distinguishing anything. Amber is the middle reading — a tenth of
 * the prefix re-billed — and red is the one that shouts, because it is the one worth walking over
 * to.
 */
const TONE_BRICK: Record<BrickTone, string> = {
  good: 'rgba(34, 197, 94, 0.18)',
  warn: 'rgba(234, 179, 8, 0.85)',
  bad: '#dc2626',
  unknown: 'rgba(100, 116, 139, 0.35)',
}

/** Text colour per tone: quiet green digits, white on red, readable grey on slate. */
const TONE_TEXT: Record<BrickTone, string> = {
  good: 'rgba(74, 222, 128, 0.75)',
  // Dark on amber: the only band whose fill is bright enough to need it.
  warn: '#2a1c00',
  bad: '#ffffff',
  unknown: 'rgba(203, 213, 225, 0.8)',
}

/** Brick outline: barely there for healthy bricks, firm once a tone alarms. */
const TONE_EDGE: Record<BrickTone, string> = {
  good: 'rgba(34, 197, 94, 0.28)',
  warn: '#ca8a04',
  bad: '#ef4444',
  unknown: 'rgba(148, 163, 184, 0.35)',
}

/** Digit weight: only the alarming bricks are set bold. */
const TONE_WEIGHT: Record<BrickTone, string> = {
  good: '500',
  // The two alarming bands are set bold; the two quiet ones are not.
  warn: '700',
  bad: '700',
  unknown: '500',
}

/** The app's own quiet strip font, used for the board's notice and its chip. */
const CHIP_FONT = '700 9px/1 ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif'

/** Whether the reader asked for less motion. */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** One drawn brick. */
interface Slab {
  readonly element: HTMLDivElement
  /** The slot this brick is drawn in; a change animates, a same-value repaint does not. */
  right: number
  bottom: number
  tone: BrickTone
  label: string
  title: string
}

/**
 * Group bricks into Turn columns, oldest first.
 *
 * @param feed - one session's bricks, oldest first.
 * @returns the columns, each column's bricks in the order they landed.
 */
export function columnsOf(feed: BrickFeed): BoardColumn[] {
  const columns = new Map<number, { turn: number; bricks: CacheBrick[] }>()
  for (const brick of feed.bricks) {
    // Turn 0 has no column: those are auxiliary calls (a compaction, a session title), which are
    // real requests but belong to no Turn and would otherwise stack in a phantom column.
    if (brick.turn <= 0) continue
    const column = columns.get(brick.turn) ?? { turn: brick.turn, bricks: [] }
    column.bricks.push(brick)
    columns.set(brick.turn, column)
  }
  const ended = new Set(feed.endedTurns)
  return [...columns.values()]
    .sort((left, right) => left.turn - right.turn)
    .map((column) => ({
      turn: column.turn,
      ended: ended.has(column.turn),
      bricks: [...column.bricks].sort((left, right) => left.step - right.step || left.attempt - right.attempt),
    }))
}

/**
 * Hover text for one brick: the reading, then what produced it.
 *
 * Two different silences both come out as `n/a`, and they are not the same fact:
 *
 * - **no usage at all** — the attempt failed or was superseded before anything was billed, which
 *   is what a retry chain looks like (measured live: five of them, then the attempt that worked);
 * - **usage but no cache field** — the provider billed the call and said nothing about caching.
 *
 * Saying "the provider reported no cache fields" for the first case would blame the provider for a
 * request that never got far enough to have an opinion.
 */
export function titleOf(brick: CacheBrick): string {
  const prompt = brick.inputTokens + brick.cacheReadTokens + brick.cacheWriteTokens
  const silence = prompt === 0
    ? 'no usage was billed for this request (a failed or superseded attempt)'
    : 'the provider reported no cache fields for it'
  const reading = brick.hitRatio === null
    ? silence
    : `${brickLabel(brick)} of this prompt came from the cache`
  const attempt = brick.attempt > 0 ? ` · attempt ${String(brick.attempt)} (a retry)` : ''
  return `turn ${String(brick.turn)} · step ${String(brick.step)}${attempt} · ${reading} · prompt ${String(prompt)} tokens`
}

/**
 * The gutter board.
 *
 * Owns its host element, its bricks, its window and the two measurements it needs (the
 * conversation's scrollport and the blank column beside it). Everything else — what a brick is,
 * how many there are, what colour they are — arrives in `setFeed`.
 */
export class CacheBoard {
  private readonly host: HTMLDivElement
  private readonly notice: HTMLDivElement
  private readonly liveChip: HTMLButtonElement
  private readonly grid: HTMLDivElement
  private readonly floor: HTMLDivElement
  private readonly ghost: HTMLDivElement
  private readonly fadeLeft: HTMLDivElement
  private readonly fadeRight: HTMLDivElement
  private readonly fadeTop: HTMLDivElement
  private readonly hRail: HTMLDivElement
  private readonly hThumb: HTMLDivElement
  private readonly vRail: HTMLDivElement
  private readonly vThumb: HTMLDivElement
  private readonly slabs = new Map<string, Slab>()
  private feed: BrickFeed | undefined
  private columns: readonly BoardColumn[] = []
  private metrics: BoardMetrics | undefined
  private view: BoardWindow | undefined
  private scroll: BoardScroll | undefined
  private lastNewestTurn: number | undefined
  private tallestCache: { columns: readonly BoardColumn[]; tallest: number } | undefined
  private frame: number | undefined
  private settle: number | undefined
  private observer: MutationObserver | undefined
  private panUntil = 0
  private panTimer: number | undefined
  private drag: {
    axis: 'x' | 'y'
    pointerId: number
    from: number
    to: number
    base: BoardScroll
    travel: number
    furthest: number
  } | undefined
  private disposed = false

  constructor() {
    this.host = document.createElement('div')
    this.host.dataset.cacheBricksBoard = ''
    Object.assign(this.host.style, {
      position: 'fixed',
      overflow: 'hidden',
      // The board is pointer-transparent so the wheel and the touch pan keep reaching the
      // transcript behind it; the slabs, the rails and the chip opt back in.
      pointerEvents: 'none',
      zIndex: '5',
      borderRadius: '10px',
      background: 'rgba(148, 163, 184, 0.06)',
      boxSizing: 'border-box',
      transition: 'height 200ms ease-out, top 200ms ease-out',
      contain: 'layout paint style',
      display: 'none',
    } satisfies Partial<CSSStyleDeclaration>)
    this.host.setAttribute('role', 'group')
    this.host.setAttribute('aria-label', 'Cache bricks: one brick per settled model request, newest turn on the right')

    this.notice = document.createElement('div')
    this.notice.dataset.cacheBricksNotice = ''
    Object.assign(this.notice.style, {
      position: 'absolute',
      top: '2px',
      left: '2px',
      zIndex: '2',
      display: 'none',
      height: '12px',
      lineHeight: '12px',
      color: 'rgba(148, 163, 184, 0.95)',
      font: CHIP_FONT,
      letterSpacing: '0.02em',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>)

    this.liveChip = this.createChip()
    this.grid = document.createElement('div')
    this.grid.dataset.cacheBricksGrid = ''
    Object.assign(this.grid.style, {
      position: 'absolute',
      left: `${String(GRID_LEFT)}px`,
      top: `${String(CHROME_H)}px`,
      right: '0',
      bottom: `${String(RAIL)}px`,
    } satisfies Partial<CSSStyleDeclaration>)

    this.floor = document.createElement('div')
    Object.assign(this.floor.style, {
      position: 'absolute',
      left: `${String(GRID_LEFT)}px`,
      right: '0',
      bottom: `${String(RAIL)}px`,
      height: '1px',
      background: 'rgba(148, 163, 184, 0.28)',
    } satisfies Partial<CSSStyleDeclaration>)

    this.ghost = document.createElement('div')
    this.ghost.dataset.cacheBricksGhost = ''
    Object.assign(this.ghost.style, {
      position: 'absolute',
      boxSizing: 'border-box',
      display: 'none',
      borderRadius: '3px',
      border: '1px dashed rgba(148, 163, 184, 0.35)',
      transition: prefersReducedMotion() ? 'none' : 'bottom 260ms ease-out, right 260ms ease-out',
    } satisfies Partial<CSSStyleDeclaration>)

    this.fadeLeft = this.createFade('left')
    this.fadeRight = this.createFade('right')
    this.fadeTop = this.createFade('top')
    const horizontal = this.createRail('x')
    const vertical = this.createRail('y')
    this.hRail = horizontal.rail
    this.hThumb = horizontal.thumb
    this.vRail = vertical.rail
    this.vThumb = vertical.thumb

    this.host.append(
      this.floor,
      this.grid,
      this.ghost,
      this.fadeLeft,
      this.fadeRight,
      this.fadeTop,
      this.hRail,
      this.vRail,
      this.notice,
      this.liveChip,
    )
    document.body.append(this.host)
  }

  /** Start watching the layout, so the board follows the conversation it sits beside. */
  start(): void {
    if (this.disposed) return
    window.addEventListener('scroll', this.onLayoutChange, { capture: true, passive: true })
    window.addEventListener('resize', this.onLayoutChange)
    this.observer = new MutationObserver(this.onLayoutChange)
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden'],
    })
    this.schedule()
  }

  /**
   * Replace the bricks.
   * @param feed - one session's bricks, or undefined when the collector has not answered yet.
   */
  setFeed(feed: BrickFeed | undefined): void {
    this.feed = feed
    this.schedule()
  }

  /** Detach everything this board owns. */
  dispose(): void {
    this.disposed = true
    window.removeEventListener('scroll', this.onLayoutChange, { capture: true })
    window.removeEventListener('resize', this.onLayoutChange)
    this.observer?.disconnect()
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    if (this.settle !== undefined) cancelAnimationFrame(this.settle)
    if (this.panTimer !== undefined) window.clearTimeout(this.panTimer)
    this.host.remove()
    this.slabs.clear()
  }

  private readonly onLayoutChange = (): void => { this.schedule() }

  /** Coalesce repaints to one per frame. */
  private schedule(): void {
    if (this.disposed || this.frame !== undefined) return
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined
      this.paint()
    })
  }

  // ── the paint ─────────────────────────────────────────────────────────────────────────

  /** One paint: measure, window, place, and reconcile. */
  private paint(): void {
    const scroller = this.resolveScroller()
    if (scroller === undefined) {
      this.host.style.display = 'none'
      return
    }
    const band = this.measureBand(scroller)
    if (band === undefined) {
      this.host.style.display = 'none'
      return
    }
    // The rails and the strip are carved out of the band, so the grid is fitted into what is left.
    const metrics = fitBoard(band.width - GRID_LEFT, band.height - CHROME_H - RAIL)
    if (metrics === undefined) {
      this.host.style.display = 'none'
      return
    }
    this.metrics = metrics
    // The board hugs the conversation rather than the window: 0.1.3 anchored it to the *right* of
    // the gutter, and a board pinned to the window's left edge sits under the sidebar — which is
    // where a reader's attention is not, and where its panel covers the session list.
    const boardWidth = metrics.columns * pitchX(metrics) - metrics.gap + GRID_LEFT
    const left = Math.max(band.left, band.right - boardWidth)

    const columns = this.feed === undefined ? [] : columnsOf(this.feed)
    // Hold a panned window still when the session appends; the ring ageing out at the older end
    // must leave the pan exactly where it was.
    this.scroll = heldScroll(this.scroll, columns, this.lastNewestTurn)
    this.lastNewestTurn = newestTurnOf(columns)
    this.columns = columns

    const tallest = this.tallestOf(columns)
    let view = boardWindow(columns, metrics, this.scroll, tallest)
    // A pan the content cannot honour is a leftover, not a reading. The ring drops its oldest
    // Turns, so a window can find itself panned over content that no longer exists — and then the
    // board must resume following, or a running Turn taller than the board would keep its newest
    // brick off the top of the frame while claiming to be showing history.
    if (this.scroll !== undefined && this.scroll.back !== 0 && view.scroll.back === 0) {
      this.scroll = undefined
      view = boardWindow(columns, metrics, undefined, tallest)
    }
    this.view = view
    // Landing back on the live corner resumes following. "Following" is the honest test, not the
    // offsets: a board following a Turn taller than the window is at `up > 0` and still live.
    if (this.scroll !== undefined && view.scroll.back === 0 && view.scroll.up === boardWindow(columns, metrics, undefined, tallest).scroll.up) {
      this.scroll = undefined
    }

    const gridWidth = metrics.columns * pitchX(metrics) - metrics.gap
    const gridHeight = metrics.rows * pitchY(metrics) - metrics.gap
    Object.assign(this.host.style, {
      display: 'block',
      left: `${String(Math.round(left))}px`,
      top: `${String(Math.round(band.top))}px`,
      width: `${String(boardWidth)}px`,
      height: `${String(gridHeight + CHROME_H + RAIL)}px`,
    } satisfies Partial<CSSStyleDeclaration>)

    this.syncBricks(metrics, view)
    this.syncRails(metrics, view, gridWidth)
    this.syncFades(metrics, view, gridWidth)
    this.syncGhost(metrics, view)
    this.syncChip(view, gridWidth)
    this.syncNotice()
    this.settleNow()
  }

  /** Reconcile the bricks with the window. */
  private syncBricks(metrics: BoardMetrics, view: BoardWindow): void {
    const smooth = !this.isPanning()
    const seen = new Set<string>()
    const newestIndex = this.columns.length - 1
    const bricks = this.feed?.bricks ?? []
    const byKey = new Map<string, CacheBrick>()
    for (const brick of bricks) byKey.set(this.shortKey(brick), brick)
    for (let index = view.columnStart; index < view.columnEnd; index += 1) {
      const column = this.columns[index]!
      const lastRow = Math.min(column.bricks.length, view.rowEnd)
      for (let row = view.rowStart; row < lastRow; row += 1) {
        // A brick outside the window is not drawn at all: the board is a window, and a brick the
        // pan moved out is neither visible nor hoverable nor announced.
        const cell = windowCell(newestIndex - index, row, view.lead, view.scroll, metrics.columns, view.limit)
        if (cell === undefined) continue
        const slot = column.bricks[row]
        if (slot === undefined) continue
        const brick = byKey.get(`${String(column.turn)}:${String(slot.step)}:${String(slot.attempt)}`)
        if (brick === undefined) continue
        const { right, bottom } = cellPlacement(metrics, cell.column, cell.row)
        seen.add(brick.id)
        const existing = this.slabs.get(brick.id)
        if (existing === undefined) this.createSlab(brick, metrics, right, bottom, smooth)
        else this.updateSlab(existing, brick, right, bottom, smooth)
      }
    }
    for (const [key, slab] of this.slabs) {
      if (seen.has(key)) continue
      slab.element.remove()
      this.slabs.delete(key)
    }
  }

  /** A brick's identity without its session prefix, so a column lookup is cheap. */
  private shortKey(brick: CacheBrick): string {
    return `${String(brick.turn)}:${String(brick.step)}:${String(brick.attempt)}`
  }

  /** Create one brick, already wearing its face. */
  private createSlab(brick: CacheBrick, metrics: BoardMetrics, right: number, bottom: number, smooth: boolean): void {
    const element = document.createElement('div')
    element.dataset.cacheBricksBrick = brick.id
    Object.assign(element.style, {
      position: 'absolute',
      boxSizing: 'border-box',
      width: `${String(BRICK_W)}px`,
      height: `${String(BRICK_H)}px`,
      borderRadius: '3px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'auto',
      transition: smooth && !prefersReducedMotion() ? SLAB_TRANSITION : 'none',
    } satisfies Partial<CSSStyleDeclaration>)
    const label = brickLabel(brick)
    this.paintFace(element, brick.tone, label)
    const title = titleOf(brick)
    element.title = title
    element.setAttribute('aria-label', title)
    element.addEventListener('pointerenter', () => { element.style.filter = FOCUS_FILTER })
    element.addEventListener('pointerleave', () => { element.style.filter = '' })
    this.grid.append(element)
    // Start one row higher, then settle on the next frame so the fall has a start.
    element.style.right = `${String(right)}px`
    element.style.bottom = `${String(bottom + pitchY(metrics))}px`
    this.slabs.set(brick.id, { element, right, bottom, tone: brick.tone, label, title })
  }

  /** Move, repaint or retitle an existing brick. */
  private updateSlab(slab: Slab, brick: CacheBrick, right: number, bottom: number, smooth: boolean): void {
    const label = brickLabel(brick)
    if (slab.tone !== brick.tone || slab.label !== label) {
      this.paintFace(slab.element, brick.tone, label)
      slab.tone = brick.tone
      slab.label = label
    }
    const title = titleOf(brick)
    if (slab.title !== title) {
      slab.element.title = title
      slab.element.setAttribute('aria-label', title)
      slab.title = title
    }
    const wanted = smooth && !prefersReducedMotion() ? SLAB_TRANSITION : 'none'
    if (slab.element.style.transition !== wanted) slab.element.style.transition = wanted
    if (slab.right !== right) {
      slab.right = right
      slab.element.style.right = `${String(right)}px`
    }
    if (slab.bottom !== bottom) {
      slab.bottom = bottom
      slab.element.style.bottom = `${String(bottom)}px`
    }
  }

  /** On the frame after layout, let the freshly created bricks fall into place. */
  private settleNow(): void {
    if (this.settle !== undefined) return
    this.settle = requestAnimationFrame(() => {
      this.settle = undefined
      for (const slab of this.slabs.values()) slab.element.style.bottom = `${String(slab.bottom)}px`
    })
  }

  /** The colour and the number: the whole face of a brick. */
  private paintFace(element: HTMLDivElement, tone: BrickTone, label: string): void {
    element.dataset.cacheBricksTone = tone
    Object.assign(element.style, {
      background: TONE_BRICK[tone],
      border: `1px solid ${TONE_EDGE[tone]}`,
      // A hairline of light along the top edge: the slab reads as a block, not a flat swatch.
      boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.18)',
      color: TONE_TEXT[tone],
      font: `${TONE_WEIGHT[tone]} ${String(BRICK_TEXT_PX)}px/1 ui-monospace, SFMono-Regular, Menlo, monospace`,
      fontVariantNumeric: 'tabular-nums',
      letterSpacing: '-0.02em',
    } satisfies Partial<CSSStyleDeclaration>)
    if (element.textContent !== label) element.textContent = label
  }

  // ── the drop slot, the rails, the fades, the chip ────────────────────────────────────

  /**
   * The dashed slot the running Turn's next brick will land in.
   *
   * It is the one bit of chrome that says the pile is live rather than a finished chart, and it
   * belongs to the **live corner only**: a panned window is a reading of the past, and a dashed
   * "the next brick lands here" drawn inside it would be a lie about where the session is.
   */
  private syncGhost(metrics: BoardMetrics, view: BoardWindow): void {
    const newest = this.columns[this.columns.length - 1]
    const running = this.scroll === undefined && newest !== undefined && !newest.ended
    const cell = running
      ? windowCell(0, newest.bricks.length, view.lead, view.scroll, metrics.columns, view.limit)
      : undefined
    if (cell === undefined) {
      this.ghost.style.display = 'none'
      return
    }
    const { right, bottom } = cellPlacement(metrics, cell.column, cell.row)
    Object.assign(this.ghost.style, {
      display: 'block',
      width: `${String(metrics.width)}px`,
      height: `${String(metrics.height)}px`,
      right: `${String(right)}px`,
      bottom: `${String(bottom)}px`,
    } satisfies Partial<CSSStyleDeclaration>)
  }

  /**
   * Keep both rails telling the truth about the window.
   *
   * One rail per axis, both anchored at the live corner: at pan 0 the thumb sits at the track's far
   * end (right, bottom) — where the newest brick is — and travels towards the content's start as the
   * reader goes back. A rail with nothing to scroll is still drawn, dimmed and inert, so the
   * board's shape does not change when the ring outgrows it.
   */
  private syncRails(metrics: BoardMetrics, view: BoardWindow, gridWidth: number): void {
    const gridHeight = view.limit * pitchY(metrics) - metrics.gap
    // The content is every Turn plus the lead cell — the drop slot a finished Turn leaves free is
    // part of the board and pans with it.
    const h = railGeometry(gridWidth, metrics.columns, this.columns.length + view.lead, view.scroll.back)
    const v = railGeometry(gridHeight, view.limit, view.tallest, view.scroll.up)
    this.applyRail('x', h, view.limitScroll.back, view.limitScroll.back - view.scroll.back, view.newer > 0 || view.older > 0
      ? `已回看 ${String(view.newer)} 轮，左侧还有 ${String(view.older)} 轮`
      : '已显示全部轮次')
    this.applyRail('y', v, view.limitScroll.up, view.limitScroll.up - view.scroll.up, view.limitScroll.up > 0
      ? `下方还有 ${String(view.scroll.up)} 行未显示，上方还有 ${String(view.limitScroll.up - view.scroll.up)} 行`
      : '已显示全部行')
    this.hRail.style.width = `${String(gridWidth)}px`
    this.vRail.style.height = `${String(gridHeight)}px`
  }

  /** Place one rail's thumb and publish its accessible state. */
  private applyRail(axis: 'x' | 'y', geometry: RailGeometry, furthest: number, at: number, text: string): void {
    const horizontal = axis === 'x'
    const rail = horizontal ? this.hRail : this.vRail
    const thumb = horizontal ? this.hThumb : this.vThumb
    if (horizontal) {
      thumb.style.width = `${String(geometry.thumb)}px`
      thumb.style.left = `${String(geometry.offset)}px`
    }
    else {
      thumb.style.height = `${String(geometry.thumb)}px`
      thumb.style.top = `${String(geometry.offset)}px`
    }
    rail.style.pointerEvents = geometry.scrollable ? 'auto' : 'none'
    rail.style.cursor = geometry.scrollable ? 'grab' : 'default'
    rail.style.opacity = geometry.scrollable ? '1' : '0.5'
    // A rail that cannot move is not a tab stop, and says so to assistive technology.
    const tabIndex = geometry.scrollable ? 0 : -1
    if (rail.tabIndex !== tabIndex) rail.tabIndex = tabIndex
    rail.setAttribute('aria-disabled', geometry.scrollable ? 'false' : 'true')
    rail.setAttribute('aria-valuemin', '0')
    rail.setAttribute('aria-valuemax', String(furthest))
    rail.setAttribute('aria-valuenow', String(Math.min(Math.max(0, at), furthest)))
    rail.setAttribute('aria-valuetext', text)
  }

  /**
   * Show an edge fade in every direction the window has hidden content.
   *
   * The rails say how much; the fades say **where**, at a glance, without moving anything: older
   * Turns to the left, newer ones to the right, higher rows above.
   */
  private syncFades(metrics: BoardMetrics, view: BoardWindow, gridWidth: number): void {
    const gridHeight = view.limit * pitchY(metrics) - metrics.gap
    const show = (fade: HTMLDivElement, visible: boolean, style: Partial<CSSStyleDeclaration>): void => {
      fade.style.display = visible ? 'block' : 'none'
      if (visible) Object.assign(fade.style, style)
    }
    const paneTop = CHROME_H
    show(this.fadeLeft, view.older > 0, { left: `${String(GRID_LEFT)}px`, width: `${String(FADE)}px`, top: `${String(paneTop)}px`, height: `${String(gridHeight)}px` })
    show(this.fadeRight, view.newer > 0, { left: `${String(GRID_LEFT + gridWidth - FADE)}px`, width: `${String(FADE)}px`, top: `${String(paneTop)}px`, height: `${String(gridHeight)}px` })
    show(this.fadeTop, view.limitScroll.up > view.scroll.up, { left: `${String(GRID_LEFT)}px`, width: `${String(gridWidth)}px`, top: `${String(paneTop)}px`, height: `${String(FADE)}px` })
  }

  /**
   * Show the way back while the board is showing history.
   *
   * A panned board is the one state that can be misread — old Turns look exactly like the current
   * ones — so the strip grows a control that names the state and undoes it in one click. It is
   * absent, not merely dimmed, while the board is live.
   */
  private syncChip(view: BoardWindow, gridWidth: number): void {
    const panned = this.scroll !== undefined
    this.liveChip.style.display = panned ? 'block' : 'none'
    if (!panned) return
    const label = gridWidth < 140 ? '⤓' : '⤓ 最新'
    if (this.liveChip.textContent !== label) this.liveChip.textContent = label
    const hidden = [
      view.newer > 0 ? `右侧 ${String(view.newer)} 轮` : undefined,
      view.limitScroll.up > view.scroll.up ? `上方 ${String(view.limitScroll.up - view.scroll.up)} 行` : undefined,
    ].filter((part): part is string => part !== undefined).join('、')
    this.liveChip.title = hidden === '' ? '回到最新：右侧已无更新的轮次' : `回看中：${hidden} 未显示 · 点击回到最新`
    this.liveChip.setAttribute('aria-label', hidden === '' ? '回到最新' : `回看中，${hidden}未显示；回到最新`)
  }

  /**
   * Say what is missing rather than drawing a run that looks complete.
   *
   * Two states need words: a collector that has not answered (an empty board and a cold cache look
   * identical and mean opposite things), and a ring that had to drop bricks.
   */
  private syncNotice(): void {
    const feed = this.feed
    if (feed === undefined) {
      this.notice.textContent = '等待宿主采集器…'
      this.notice.style.display = 'block'
      return
    }
    if (feed.bricks.length === 0) {
      // An empty gutter on an old session is the *design* — this build counts the requests made
      // since it loaded and never reads a session's history — and a reader who is not told that
      // reads the emptiness as "nothing ever happened here". So the board says it, in the two
      // shapes it comes in: a request in flight, or nothing at all since the process started.
      this.notice.textContent = feed.dispatched > 0
        ? `${String(feed.dispatched)} 个请求已派发，尚未结算`
        : '暂无砖块：只统计插件加载之后的请求，不读历史'
      this.notice.style.display = 'block'
      return
    }
    // Where the bricks came from, when it is not "all of them, live": a board that quietly mixed
    // the session's recorded past with this process's traffic would be claiming more than it saw.
    const parts: string[] = []
    if (feed.backfilled > 0) parts.push(`${String(feed.bricks.length)} 块 · ${String(feed.backfilled)} 块来自历史日志`)
    if (feed.dropped > 0) parts.push(`更早的 ${String(feed.dropped)} 块已丢弃`)
    if (parts.length === 0) {
      this.notice.style.display = 'none'
      return
    }
    this.notice.textContent = parts.join(' · ')
    this.notice.style.display = 'block'
  }

  // ── moving the window ────────────────────────────────────────────────────────────────

  /** Move the window, clamped to what the content allows right now. */
  private setScroll(back: number, up: number): void {
    const view = this.view
    const metrics = this.metrics
    if (view === undefined || metrics === undefined) return
    const requested = clampScroll({ back, up }, view.limitScroll)
    const live = boardWindow(this.columns, metrics, undefined, view.tallest).scroll
    // Landing on the live corner resumes following, so the board keeps up with the session.
    this.scroll = requested.back === 0 && requested.up === live.up ? undefined : requested
    this.markPan()
    this.schedule()
  }

  /**
   * Note that a hand-driven pan is in flight.
   *
   * While it is, slabs drop their transition: a pan moves every brick at once, and the 420 ms drop
   * animation would turn a drag into a rubber band. The timer restores the animation afterwards,
   * so the next real drop still falls.
   */
  private markPan(): void {
    this.panUntil = performance.now() + PAN_QUIET_MS
    if (this.panTimer !== undefined) window.clearTimeout(this.panTimer)
    this.panTimer = window.setTimeout(() => {
      this.panTimer = undefined
      this.schedule()
    }, PAN_QUIET_MS + 40)
  }

  /** True while a hand-driven pan is still settling. */
  private isPanning(): boolean {
    return performance.now() < this.panUntil
  }

  /** Keep the tallest column measured once per content array, not once per paint. */
  private tallestOf(columns: readonly BoardColumn[]): number {
    if (this.tallestCache?.columns !== columns) this.tallestCache = { columns, tallest: tallestColumn(columns) }
    return this.tallestCache.tallest
  }

  // ── the chrome elements ──────────────────────────────────────────────────────────────

  /** The `⤓ 最新` control, built once and shown only while the board is showing history. */
  private createChip(): HTMLButtonElement {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.dataset.cacheBricksLive = ''
    Object.assign(chip.style, {
      position: 'absolute',
      top: '1px',
      left: '30px',
      zIndex: '2',
      display: 'none',
      height: '13px',
      padding: '0 4px',
      pointerEvents: 'auto',
      cursor: 'pointer',
      borderRadius: '4px',
      border: '1px solid rgba(251, 191, 36, 0.5)',
      background: 'rgba(15, 23, 42, 0.82)',
      color: 'rgba(251, 191, 36, 0.95)',
      font: CHIP_FONT,
      letterSpacing: '0.02em',
    } satisfies Partial<CSSStyleDeclaration>)
    chip.addEventListener('click', (event: MouseEvent) => {
      event.stopPropagation()
      this.setScroll(0, 0)
    })
    return chip
  }

  /** One edge fade, so a hidden direction is visible without moving the window. */
  private createFade(edge: 'left' | 'right' | 'top'): HTMLDivElement {
    const fade = document.createElement('div')
    fade.dataset.cacheBricksFade = edge
    const towards = edge === 'left' ? 'to right' : edge === 'right' ? 'to left' : 'to bottom'
    Object.assign(fade.style, {
      position: 'absolute',
      zIndex: '1',
      display: 'none',
      pointerEvents: 'none',
      background: `linear-gradient(${towards}, `
        + 'color-mix(in srgb, var(--dsw-alias-bg-base, #0f172a) 88%, transparent), transparent)',
      ...(edge === 'top' ? { height: `${String(FADE)}px` } : { width: `${String(FADE)}px` }),
    } satisfies Partial<CSSStyleDeclaration>)
    return fade
  }

  /**
   * One rail: a track and a thumb, anchored at the live end.
   *
   * A press **on the thumb** keeps the current pan and follows the pointer; a press on the track
   * pages the window so the thumb centres under the pointer and then keeps dragging — the two
   * gestures a native scrollbar has, and the reason the track is thick enough to hit.
   */
  private createRail(axis: 'x' | 'y'): { rail: HTMLDivElement; thumb: HTMLDivElement } {
    const horizontal = axis === 'x'
    const rail = document.createElement('div')
    rail.dataset.cacheBricksRail = axis
    rail.setAttribute('role', 'scrollbar')
    rail.setAttribute('aria-orientation', horizontal ? 'horizontal' : 'vertical')
    Object.assign(rail.style, {
      position: 'absolute',
      zIndex: '1',
      borderRadius: '2px',
      background: 'rgba(148, 163, 184, 0.14)',
      transition: 'opacity 160ms ease-out',
      ...(horizontal
        ? { left: `${String(GRID_LEFT)}px`, bottom: '1px', height: '4px' }
        : { left: '1px', width: '4px', top: `${String(CHROME_H)}px` }),
    } satisfies Partial<CSSStyleDeclaration>)
    const thumb = document.createElement('div')
    Object.assign(thumb.style, {
      position: 'absolute',
      borderRadius: '2px',
      background: 'rgba(148, 163, 184, 0.5)',
      transition: 'background 120ms ease-out',
      ...(horizontal ? { top: '0', bottom: '0', left: '0', width: '0' } : { left: '0', right: '0', top: '0', height: '0' }),
    } satisfies Partial<CSSStyleDeclaration>)
    rail.append(thumb)

    rail.addEventListener('pointerenter', () => { thumb.style.background = 'rgba(203, 213, 225, 0.85)' })
    rail.addEventListener('pointerleave', () => {
      if (this.drag === undefined) thumb.style.background = 'rgba(148, 163, 184, 0.5)'
    })
    rail.addEventListener('pointerdown', (event: PointerEvent) => { this.beginRailDrag(axis, event) })
    rail.addEventListener('pointermove', (event: PointerEvent) => {
      if (this.drag === undefined || this.drag.pointerId !== event.pointerId) return
      this.drag.to = horizontal ? event.clientX : event.clientY
      this.applyDrag()
    })
    const finish = (event: PointerEvent): void => {
      if (this.drag === undefined || this.drag.pointerId !== event.pointerId) return
      this.drag = undefined
      if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId)
      rail.style.cursor = 'grab'
      thumb.style.background = 'rgba(148, 163, 184, 0.5)'
    }
    rail.addEventListener('pointerup', finish)
    rail.addEventListener('pointercancel', finish)
    // Back to the live corner: the gesture a reader reaches for after reading history.
    rail.addEventListener('dblclick', (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      this.setScroll(0, 0)
    })
    // The wheel only works over the rail: the host is pointer-transparent, so everywhere else the
    // wheel keeps reaching the transcript.
    rail.addEventListener('wheel', (event: WheelEvent) => {
      const view = this.view
      const metrics = this.metrics
      if (view === undefined || metrics === undefined) return
      const primary = horizontal ? (event.deltaX === 0 ? event.deltaY : event.deltaX) : event.deltaY
      if (primary === 0) return
      const furthest = horizontal ? view.limitScroll.back : view.limitScroll.up
      if (furthest <= 0) return
      event.preventDefault()
      event.stopPropagation()
      const pitch = horizontal ? pitchX(metrics) : pitchY(metrics)
      // One to four cells per notch: a trackpad's small deltas stay precise, a mouse wheel still
      // crosses a screenful of history in a few flicks.
      const cells = Math.min(4, Math.max(1, Math.round(Math.abs(primary) / pitch)))
      const step = primary > 0 ? -cells : cells
      this.setScroll(
        horizontal ? view.scroll.back + step : view.scroll.back,
        horizontal ? view.scroll.up : view.scroll.up + step,
      )
    }, { passive: false })
    rail.addEventListener('keydown', (event: KeyboardEvent) => {
      const view = this.view
      const metrics = this.metrics
      if (view === undefined || metrics === undefined) return
      const furthest = horizontal ? view.limitScroll.back : view.limitScroll.up
      const page = horizontal ? metrics.columns : Math.max(1, view.limit - 1)
      const towards = (cells: number): void => {
        this.setScroll(
          horizontal ? view.scroll.back + cells : view.scroll.back,
          horizontal ? view.scroll.up : view.scroll.up + cells,
        )
      }
      // Positive cells move towards the older end on both axes, so the keys read the way the board
      // does: left/up is further back into a ring's history.
      if (horizontal && event.key === 'ArrowLeft') towards(1)
      else if (horizontal && event.key === 'ArrowRight') towards(-1)
      else if (!horizontal && event.key === 'ArrowUp') towards(1)
      else if (!horizontal && event.key === 'ArrowDown') towards(-1)
      else if (event.key === 'PageUp') towards(horizontal ? -page : page)
      else if (event.key === 'PageDown') towards(horizontal ? page : -page)
      else if (event.key === 'Home') towards(furthest)
      else if (event.key === 'End') towards(-furthest)
      else return
      event.preventDefault()
      event.stopPropagation()
    })
    return { rail, thumb }
  }

  /** Start a drag on a rail. */
  private beginRailDrag(axis: 'x' | 'y', event: PointerEvent): void {
    const view = this.view
    const metrics = this.metrics
    if (view === undefined || metrics === undefined) return
    const horizontal = axis === 'x'
    const furthest = horizontal ? view.limitScroll.back : view.limitScroll.up
    if (furthest <= 0) return
    const rail = horizontal ? this.hRail : this.vRail
    const thumb = horizontal ? this.hThumb : this.vThumb
    event.preventDefault()
    event.stopPropagation()
    const rect = rail.getBoundingClientRect()
    const thumbRect = thumb.getBoundingClientRect()
    const track = horizontal ? rect.width : rect.height
    const length = horizontal ? thumbRect.width : thumbRect.height
    const pointer = horizontal ? event.clientX - rect.left : event.clientY - rect.top
    const onThumb = event.target === thumb
    const paged = onThumb ? undefined : this.railOffset(pointer, track, length, furthest)
    const base: BoardScroll = {
      back: horizontal && paged !== undefined ? paged : view.scroll.back,
      up: !horizontal && paged !== undefined ? paged : view.scroll.up,
    }
    rail.setPointerCapture(event.pointerId)
    rail.style.cursor = 'grabbing'
    thumb.style.background = 'rgba(203, 213, 225, 0.9)'
    this.drag = {
      axis,
      pointerId: event.pointerId,
      from: horizontal ? event.clientX : event.clientY,
      to: horizontal ? event.clientX : event.clientY,
      base,
      travel: Math.max(1, track - length),
      furthest,
    }
    if (paged !== undefined) this.setScroll(base.back, base.up)
  }

  /** The pan an offset along the track stands for, with the thumb centred on the pointer. */
  private railOffset(pointer: number, track: number, thumb: number, furthest: number): number {
    const travel = Math.max(1, track - thumb)
    const fraction = Math.min(1, Math.max(0, (pointer - thumb / 2) / travel))
    // The thumb's far end is the live corner, so a pointer at the end is pan 0.
    return Math.round((1 - fraction) * furthest)
  }

  /** Apply the drag in flight: whole cells, so the grid never lands between bricks. */
  private applyDrag(): void {
    const drag = this.drag
    if (drag === undefined) return
    const horizontal = drag.axis === 'x'
    // The thumb follows the pointer **in track space**, not in brick pitches: dragging the thumb to
    // the end of its travel has to reach the end of the content, or the last Turns would be
    // unreachable by drag.
    const moved = ((drag.to - drag.from) / drag.travel) * drag.furthest
    const cells = Math.round(moved)
    // Dragging right/down moves towards the live corner, which is a smaller pan on both axes.
    this.setScroll(
      horizontal ? drag.base.back - cells : drag.base.back,
      horizontal ? drag.base.up : drag.base.up - cells,
    )
  }

  // ── the band ─────────────────────────────────────────────────────────────────────────

  /**
   * Where the board goes and how much room it has.
   *
   * The conversation sits in the middle of the window; the gutter is what is left on its left
   * side. When there is no room (a narrow window), the board stays hidden rather than drawing over
   * the conversation.
   */
  private measureBand(scroller: HTMLElement): { left: number; right: number; top: number; width: number; height: number } | undefined {
    const rect = scroller.getBoundingClientRect()
    const composer = this.composerHeightOf()
    const top = Math.max(rect.top, 0) + 8
    const height = Math.max(0, rect.height - composer - 16)
    const right = this.transcriptEdge(scroller, rect)
    const left = Math.min(rect.left, right)
    const width = Math.max(0, right - left)
    if (width < 80 || height < 60) return undefined
    return { left, right, top, width, height }
  }

  /**
   * The left edge of the transcript's own content.
   *
   * The gutter is measured from the **content**, not from the scrollport: the scrollport spans the
   * whole window, and a board anchored to it would sit on the conversation's own margin.
   */
  private transcriptEdge(scroller: HTMLElement, rect: DOMRect): number {
    const row = scroller.querySelector<HTMLElement>('[data-chat-turn], [data-chat-node-key]')
    if (row !== null) {
      const rowRect = row.getBoundingClientRect()
      if (rowRect.width > 0) return rowRect.left - 12
    }
    // No row rendered yet: fall back to a centred column of a readable width.
    return Math.max(0, rect.left + (rect.width - Math.min(720, rect.width * 0.6)) / 2 - 12)
  }

  /** The composer's height, so the board stops above it. */
  private composerHeightOf(): number {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--dsh-composer-height')
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : COMPOSER_FALLBACK
  }

  /** The conversation's scrollport. */
  private resolveScroller(): HTMLElement | undefined {
    const found = document.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (found !== null) return found
    // Structural fallback: the scrollable ancestor of the transcript's own rows.
    const row = document.querySelector<HTMLElement>('[data-chat-turn], [data-chat-node-key]')
    let node = row?.parentElement ?? undefined
    while (node !== undefined && node !== document.body) {
      const style = getComputedStyle(node)
      if (/(auto|scroll)/u.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node
      node = node.parentElement ?? undefined
    }
    return undefined
  }
}

/** The shortest a rail's thumb may be, re-exported so a test can assert the bound. */
export { RAIL_MIN_THUMB }
