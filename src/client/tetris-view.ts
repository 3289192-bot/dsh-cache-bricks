/**
 * The falling-brick board: a body-level overlay parked in the blank gutter
 * beside the transcript, where each real model request attempt drops a brick onto its
 * Turn's column.
 *
 * It is an overlay rather than a slot occupant because no seat exists in that
 * blank area, and it stays outside React's DOM tree so the animation is never
 * re-created by a render. The board re-anchors itself to the conversation
 * scrollport ([data-conversation-scroll]) and the rendered rows
 * ([data-chat-turn]) on every layout change, and hides itself when the gutter is
 * too narrow to hold a readable board.
 *
 * The board is a **two-sided card**. One side is the cache reading the plugin
 * exists for; the other is the same grid read as conversation types — what each
 * request did in the conversation, in two characters and a colour (see
 * `KIND_FACE`). The card turns over as a whole rather than brick by brick: the
 * second face answers a question about the *session* ("what has this task been
 * made of?") and answers it in one gesture instead of a pointer hovering forty
 * tiny slabs. Both layers carry a brick at the same grid position, so a column
 * stays the column it was when the card comes back.
 */
import {
  ACTIVITY,
  brickAriaLabel,
  ERROR_COLOR,
  spanMaterial,
  spanTtftColor,
  SPAN_OPACITY,
  SPAN_RADIUS,
  faceSegments,
  flipTransform,
  FLIP_LABEL,
  LIFECYCLE,
  toggledFace,
  TONE_BRICK,
  TONE_TEXT,
  TONE_WEIGHT,
  TONE_EDGE,
  pitchX,
  pitchY,
  COMPOSER_FALLBACK,
  auxLaneRow,
  cellPlacement,
  columnRowLimit,
  fitBoard,
  visibleColumns,
  type BoardColumn,
  type BoardFace,
  type BoardMetrics,
  type Brick,
} from './tetris'
import type { LoadReport, LoadRequest } from './navigation'
import { revealBrick, type RevealElement, type RevealOutcome } from './reveal'

/** Both sides of the card, in the order that keeps cache-first everywhere. */
const FACES: readonly BoardFace[] = ['cache', 'type']

/**
 * Height of the board's own control strip, in CSS pixels.
 *
 * The flip control used to sit on top of the grid, which meant it swallowed the click
 * of whichever brick happened to be in the top-left cell — a brick that could not be
 * opened at all. The strip is carved out of the board's band instead: the grid is laid
 * out below it, the control lives in it, and no brick can ever be underneath. The cost
 * is one row of brick capacity, which at fifteen pixels a row is not a cost.
 */
const CHROME_H = 16

/**
 * Narrowest a colour slice may get, in CSS pixels.
 *
 * A mixed brick's split follows the real ratio between thinking and acting, but a
 * ratio of 98:2 would leave the second colour a hairline nobody can see; clamping
 * it keeps both halves identifiable while still reading as "much more of one".
 */
const MIN_SEGMENT_PX = 5

/**
 * Border for a brick.
 *
 * Deliberately the cache tone's own edge and nothing else. The four-channel version
 * this replaced was accurate and unreadable at the same time: in this harness almost
 * every step reasons, calls a tool and answers, so nearly every brick was "rich" and
 * the colours stopped distinguishing anything. The channels are still computed — the
 * hover summary names them — but they no longer paint the board.
 *
 * @param brick - the brick to draw.
 * @returns the CSS border.
 */
function borderCss(brick: Brick): string {
  return `1px solid ${TONE_EDGE[brick.tone]}`
}

/**
 * One side of the card: a flat layer holding one slab per brick.
 *
 * `backface-visibility: hidden` is what makes the card work: the layer facing away
 * is not painted, so the two sides never bleed through each other mid-turn.
 *
 * @param face - which side this layer is.
 * @returns the layer element.
 */
function createLayer(face: BoardFace): HTMLDivElement {
  const layer = document.createElement('div')
  layer.dataset.cacheBadgeLayer = face
  Object.assign(layer.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    right: '0',
    bottom: '0',
    backfaceVisibility: 'hidden',
  } satisfies Partial<CSSStyleDeclaration>)
  return layer
}

/**
 * Paint the measuring side: the cache reading, in the cache tone's colours.
 *
 * @param slab - the brick element.
 * @param brick - its data.
 */
function paintCacheFace(slab: HTMLDivElement, brick: Brick): void {
  // A brick the client folded itself is one per *step*, with no attempt identity and no row
  // to navigate to. It keeps its reading and its tone — that percentage **is** measured, from
  // the session events — and says what it is through a dashed edge, a dimmed slab and the
  // board's notice, so a wall of them is never read as a wall of collected requests.
  if (brick.estimated === true) {
    Object.assign(slab.style, {
      background: TONE_BRICK[brick.tone],
      border: `1px dashed ${TONE_EDGE[brick.tone]}`,
      boxShadow: 'none',
      color: TONE_TEXT[brick.tone],
      font: `${TONE_WEIGHT[brick.tone]} 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace`,
      fontVariantNumeric: 'tabular-nums',
      letterSpacing: '-0.02em',
      opacity: '0.75',
    } satisfies Partial<CSSStyleDeclaration>)
    if (slab.textContent !== brick.label) slab.textContent = brick.label
    return
  }
  slab.style.opacity = '1'
  Object.assign(slab.style, {
    background: TONE_BRICK[brick.tone],
    border: borderCss(brick),
    // A hairline of light along the top edge: the slab reads as a block rather than
    // as a flat swatch.
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.18)',
    color: TONE_TEXT[brick.tone],
    font: `${TONE_WEIGHT[brick.tone]} 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace`,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: '-0.02em',
  } satisfies Partial<CSSStyleDeclaration>)
  if (slab.textContent !== brick.label) slab.textContent = brick.label
}

/**
 * Paint the activity face: one colour, or the reasoning/tool split.
 *
 * The face prints **nothing**. At 36x15 the colour is the reading — and the seam
 * between two colours is the reading for a mixed brick — so a two-character label on
 * the one-colour types would make the board look inconsistent while saying nothing
 * the colour had not already said. The label lives in the tooltip, the accessible
 * name and the panel's chip, which all have room for words.
 *
 * @param slab - the brick element.
 * @param brick - its data.
 * @param metrics - board geometry, so the split can be clamped to a visible minimum.
 * @param highlight - true for the brick under the pointer or holding the open record,
 *   which is the only brick that wears the full-strength colours.
 */
function paintActivityFace(slab: HTMLDivElement, brick: Brick, metrics: BoardMetrics, highlight: boolean): void {
  const floor = MIN_SEGMENT_PX / Math.max(1, metrics.width)
  if (brick.estimated === true) {
    // Nothing about this brick's activity was measured — the fold sees usage, not channels —
    // so this face states that instead of painting a type it cannot support.
    slab.replaceChildren()
    Object.assign(slab.style, {
      background: 'transparent',
      border: '1px dashed rgba(148, 163, 184, 0.6)',
      boxShadow: 'none',
      color: 'rgba(203, 213, 225, 0.6)',
      font: '500 9px/1 ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
      letterSpacing: '0.04em',
    } satisfies Partial<CSSStyleDeclaration>)
    slab.style.flexDirection = 'row'
    slab.style.gap = '0'
    if (slab.textContent !== '~') slab.textContent = '~'
    return
  }
  const segments = faceSegments(brick.kind, { portion: brick.activityShare ?? 0.5, floor, highlight })
  const single = segments[0]!
  const tone = ACTIVITY[brick.kind].tone
  // The official appearance: a flat span with one-pixel corners. The only extras the official
  // timeline itself adds are the model lane's TTFT gradient and its opacity rule — background
  // lanes dimmed, the lanes that matter solid.
  const ttftShare = tone === 'model' ? brick.ttftShare : undefined
  const span = spanMaterial(single.color, ttftShare === undefined
    ? {}
    : { ttftShare, ttftColor: spanTtftColor(single.color) })
  slab.replaceChildren()
  // A failed attempt keeps its lane colour and takes the official error colour as a rim:
  // "it is a model call, and it failed" — never "it is a failure", which would throw the type
  // away exactly when a reader wants both facts.
  Object.assign(slab.style, {
    // One colour fills the slab with its own span; a split leaves the slab empty and gives
    // each half its own, so the seam stays a seam and not a blend.
    background: segments.length === 1 ? span.background : 'transparent',
    borderRadius: SPAN_RADIUS,
    border: brick.abnormal === 'failed' ? `1px solid ${ERROR_COLOR}` : 'none',
    boxShadow: 'none',
    opacity: segments.length === 1 && tone === 'system' ? String(SPAN_OPACITY.dim) : String(SPAN_OPACITY.solid),
  } satisfies Partial<CSSStyleDeclaration>)
  // A one-colour face prints nothing: the colour is the reading, and the lane word plus what
  // the attempt was doing there live in the tooltip and the panel. At 36x15 a printed word
  // competed with the fill it was supposed to be read against.
  if (segments.length === 1) {
    slab.style.flexDirection = 'row'
    slab.style.gap = '0'
    return
  }

  // A split is always a row: model half left, tool half right, in that order.
  slab.style.flexDirection = 'row'
  slab.style.gap = '0'
  for (const segment of segments) {
    const part = document.createElement('div')
    part.dataset.cacheBadgeSegment = segment.tone
    Object.assign(part.style, {
      flex: `${String(segment.share)} 1 0`,
      alignSelf: 'stretch',
      // Each half is a span of its own lane, so the model half carries the TTFT gradient too.
      background: spanMaterial(segment.color, segment.tone === 'model' && ttftShare !== undefined
        ? { ttftShare, ttftColor: spanTtftColor(segment.color) }
        : {}).background,
      borderRadius: SPAN_RADIUS,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>)
    slab.append(part)
  }
}

/**
 * Paint the lifecycle mark in a slab's top-right corner.
 *
 * Both faces carry it: a request that failed is worth seeing from the cache side
 * too, and the mark is a **glyph rather than a colour**, so it can never be
 * mistaken for the type or the cache tone that own the two fills. It carries no
 * `title` of its own — the slab's tooltip already spells the mark out, and an
 * 8px span that stole the tooltip would hide everything else the brick knows.
 *
 * @param slab - the brick element.
 * @param brick - its data.
 */
function paintBadge(slab: HTMLDivElement, brick: Brick): void {
  const existing = slab.querySelector<HTMLElement>('[data-cache-badge-mark]')
  if (brick.abnormal === undefined) {
    existing?.remove()
    return
  }
  const mark = LIFECYCLE[brick.abnormal]
  const badge = existing ?? document.createElement('span')
  if (existing === null) {
    Object.assign(badge.style, {
      position: 'absolute',
      top: '0',
      right: '1px',
      fontSize: '8px',
      lineHeight: '1',
      fontWeight: '700',
      color: '#ffffff',
      pointerEvents: 'none',
      textShadow: '0 0 2px rgba(0, 0, 0, 0.9)',
    } satisfies Partial<CSSStyleDeclaration>)
    slab.append(badge)
  }
  badge.dataset.cacheBadgeMark = mark.glyph
  if (badge.textContent !== mark.glyph) badge.textContent = mark.glyph
}

/**
 * Paint one slab: its body for the side it belongs to, then its lifecycle mark.
 *
 * @param slab - the brick element.
 * @param brick - its data.
 * @param face - which side of the card this slab is on.
 * @param metrics - board geometry.
 * @param highlight - true for the brick the pointer or the open record is on.
 */
function paintSlab(
  slab: HTMLDivElement,
  brick: Brick,
  face: BoardFace,
  metrics: BoardMetrics,
  highlight: boolean,
): void {
  if (face === 'cache') paintCacheFace(slab, brick)
  else paintActivityFace(slab, brick, metrics, highlight)
  paintBadge(slab, brick)
}

/**
 * Whether the user asked for less motion.
 *
 * A flip is decoration, so with the preference set the board swaps faces without
 * animating — which is exactly what the preference promises.
 */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** How long the card takes to turn over, in milliseconds. */
const FLIP_MS = 440

/** A focused brick: brighter, no frame. */
const FOCUS_FILTER = 'brightness(1.45)'
/** The brick whose record is open: brighter, but less than a focused one. */
const SELECTED_FILTER = 'brightness(1.18)'

/**
 * Everything that changes how a slab looks, in one comparable string.
 *
 * A repaint walks every visible brick of the side on show, so it has to be able to
 * decide "nothing about this brick changed" without touching the DOM: the board
 * repaints on layout noise too, and rebuilding two segments per brick on every pass
 * would be churn nobody asked for.
 */
function paintKeyOf(brick: Brick): string {
  return [brick.kind, String(brick.activityShare ?? ''), brick.tone, brick.label, brick.abnormal ?? ''].join('|')
}

/** One live brick element on one layer, and where it rests. */
interface SlabEntry {
  readonly element: HTMLDivElement
  /** Which side of the card this copy belongs to. */
  readonly face: BoardFace
  readonly turn: number
  readonly step: number
  /** The last-rendered data, so the tooltip and the accessible name stay current. */
  brick: Brick
  /** The paint key this slab currently shows. */
  paintKey: string
  /** The filter to restore when this brick stops being the selected one. */
  filter?: string
  right: number
  bottom: number
  /** True until the first resting position is applied, so it falls into place. */
  falling: boolean
  /** The pointer is on this brick. */
  hovered: boolean
  /** The activity face is currently painted at full strength. */
  lit: boolean
}

const BOARD_INSET = 10

/** Minimum gap between layout-driven repaints, in milliseconds. */
const LAYOUT_QUIET_MS = 200

/**
 * Height the composer occupies at the bottom of the scrollport, published by the
 * conversation shell as `--dsh-composer-height` on the scroller itself.
 */
function composerHeightOf(scroller: HTMLElement): number {
  const raw = getComputedStyle(scroller).getPropertyValue('--dsh-composer-height').trim()
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : COMPOSER_FALLBACK
}

/** The conversation's own scrollport, if one is on screen. */
function resolveScroller(): HTMLElement | undefined {
  let best: HTMLElement | undefined
  for (const candidate of document.querySelectorAll<HTMLElement>('[data-conversation-scroll]')) {
    if (candidate.clientHeight <= 0) continue
    if (best === undefined || candidate.clientHeight > best.clientHeight) best = candidate
  }
  return best
}

/**
 * Left/right span of the rendered Turn rows, in viewport space.
 *
 * The board needs no per-turn geometry — bricks are placed from their own data —
 * only where the transcript column sits, so that the blank gutter to its left can
 * be measured. One pass, because this runs on every layout change.
 *
 * @param scroller - the conversation scrollport.
 * @returns the column span, or undefined when no row is rendered.
 */
function measureColumn(scroller: HTMLElement): { left: number; right: number } | undefined {
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let found = false
  for (const element of scroller.querySelectorAll<HTMLElement>('[data-chat-turn]:not([hidden]):not([hidden] *)')) {
    const rect = element.getBoundingClientRect()
    if (rect.height <= 0) continue
    found = true
    if (rect.left < left) left = rect.left
    if (rect.right > right) right = rect.right
  }
  return found ? { left, right } : undefined
}

/** Options for {@link CacheTetrisBoard}. */
export interface CacheTetrisBoardOptions {
  /** Called with a brick's key when it is clicked, so the panel can open. */
  readonly onSelect?: (key: string) => void
  /** Close the preview and return control to the full transcript before navigating. */
  readonly onRevealStart?: (brick: Brick) => void
  /**
   * Called after a brick is taken to its row with how the transcript jump went, so the
   * caller can tell the user when the record opened but the row could not be reached.
   */
  readonly onRevealed?: (brick: Brick, outcome: RevealOutcome) => void
  /**
   * The unified loader (`ensureBrickTargetLoaded` bound to this session).
   *
   * One entry point for both the inspector's context and the jump: the panel calls it to
   * read the conversation around a brick without moving the chat, and the jump calls it to
   * make the row exist before scrolling to it.
   */
  readonly load?: (request: LoadRequest) => Promise<LoadReport>
}

export class CacheTetrisBoard {
  private readonly options: CacheTetrisBoardOptions
  private host: HTMLDivElement | undefined
  private floor: HTMLDivElement | undefined
  private ghost: HTMLDivElement | undefined
  /** The half that turns over; both layers are its children. */
  private rotator: HTMLDivElement | undefined
  private cacheLayer: HTMLDivElement | undefined
  private typeLayer: HTMLDivElement | undefined
  /** The flip control, outside the rotator so it never turns with the card. */
  private chip: HTMLButtonElement | undefined
  /** The auxiliary lane's dashed rule and its `SYS` label. */
  private laneRule: HTMLDivElement | undefined
  private laneLabel: HTMLDivElement | undefined
  /** The chrome strip's "no collector" notice. */
  private notice: HTMLDivElement | undefined
  /** True while the bricks come from the client's own fold. */
  private estimated = false
  /** One slab map per side. `cache` is canonical: it drives positions and data. */
  private readonly slabs: Record<BoardFace, Map<string, SlabEntry>> = { cache: new Map(), type: new Map() }
  private face: BoardFace = 'cache'
  /** The brick the keyboard is on, so a flip can carry it to the other side. */
  private focusedKey: string | undefined
  /** Geometry from the last paint, so a flip can build the back at the right size. */
  private metrics: BoardMetrics | undefined
  private columns: readonly BoardColumn[] = []
  /** Auxiliary bricks: real requests that belong to no Turn, shown in the lane. */
  private aux: readonly Brick[] = []
  private titles = new Map<string, string>()
  private scroller: HTMLElement | undefined
  private frame: number | undefined
  private settle: number | undefined
  private trailing: number | undefined
  private lastPaint = 0
  private observer: MutationObserver | undefined
  private pendingClick: ReturnType<typeof setTimeout> | undefined
  private navigationGeneration = 0
  private clearHighlight: (() => void) | undefined
  private selectedKey: string | undefined
  private resizer: ResizeObserver | undefined
  private disposed = false

  constructor(options: CacheTetrisBoardOptions = {}) {
    this.options = options
  }

  /**
   * Bring the exact request a brick describes into view — its own step row, or the
   * row of the first tool call it made when the step produced no assistant message —
   * opening the Turn's process group or paging history in if that is what it takes,
   * then flash the row so the eye lands where the click sent it.
   *
   * The board and the transcript are separate DOM trees — that is what keeps the
   * bricks out of the conversation — so the link is the node key the chat view
   * publishes (`assistant-step` + `${turn}:${step}`, `tool-call` + call id, both of
   * which a brick already carries). A brick whose row is not on screen is the
   * *normal* case in a long session, which is why this goes through `revealBrick`,
   * not a bare lookup.
   *
   * @param brick - the brick that was activated.
   * @returns a promise of how it went, so the caller can say so when it did not.
   */
  async goToBrick(brick: Brick): Promise<RevealOutcome> {
    this.cancelPendingClick()
    this.clearHighlight?.()
    const generation = ++this.navigationGeneration
    const isCurrent = (): boolean => !this.disposed && generation === this.navigationGeneration
    this.options.onRevealStart?.(brick)
    // Resolve the current scrollport at use time; a tab/session change may replace it.
    const scroller = resolveScroller()
    let outcome: RevealOutcome
    try {
      outcome = scroller === undefined
        ? { accuracy: 'none', row: 'none', load: { status: 'no-loader' }, expanded: false }
        : await revealBrick(scroller, brick.target, {
          ...(this.options.load === undefined ? {} : { load: this.options.load }),
          isCurrent,
        })
      if (isCurrent() && outcome.accuracy === 'exact' && outcome.element !== undefined && scroller !== undefined) {
        // A long smooth scroll used to outlive the entire 1.1 s highlight. Wait for motion
        // to stop, then emphasise the destination for six seconds, never an adjacent row.
        let previous = scroller.scrollTop
        let stable = 0
        for (let elapsed = 0; elapsed < 1800 && isCurrent(); elapsed += 50) {
          await new Promise<void>((resolve) => setTimeout(resolve, 50))
          const current = scroller.scrollTop
          stable = Math.abs(current - previous) < 0.5 ? stable + 1 : 0
          previous = current
          if (stable >= 3) break
        }
        if (isCurrent() && outcome.element.isConnected !== false) this.flash(outcome.element, outcome.row)
      }
    } catch (error) {
      console.warn('[dsh-cache-badge] transcript navigation failed', error)
      outcome = { accuracy: 'none', row: 'none', load: { status: 'timeout' }, expanded: false }
    }
    if (isCurrent()) this.options.onRevealed?.(brick, outcome)
    return outcome
  }

  /** Scoped CSS leaves the host's inline styles intact and is removed on a new selection. */
  private flash(row: RevealElement, path: string): void {
    const element = row as HTMLElement
    if (typeof element.setAttribute !== 'function') return
    this.clearHighlight?.()
    const old = element.getAttribute('data-cache-badge-landed')
    element.setAttribute('data-cache-badge-landed', path)
    const sheet = document.createElement('style')
    sheet.textContent = `[data-cache-badge-landed] {
      background-color: rgba(56, 189, 248, .20) !important;
      background-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #38bdf8) 20%, transparent) !important;
      box-shadow: inset 3px 0 0 var(--dsw-alias-state-business-primary, #38bdf8) !important;
      border-radius: 6px;
    }`
    document.head.append(sheet)
    let timer: ReturnType<typeof setTimeout>
    const clear = (): void => {
      clearTimeout(timer)
      if (old === null) element.removeAttribute('data-cache-badge-landed')
      else element.setAttribute('data-cache-badge-landed', old)
      sheet.remove()
      if (this.clearHighlight === clear) this.clearHighlight = undefined
    }
    timer = setTimeout(clear, 6000)
    this.clearHighlight = clear
  }

  private cancelPendingClick(): void {
    if (this.pendingClick !== undefined) clearTimeout(this.pendingClick)
    this.pendingClick = undefined
  }

  /**
   * Mark one brick as the open one, and clear the previous mark.
   *
   * Expressed as brightness, not as a frame: an outline around a 36x15 slab is the
   * loudest thing on the board, and "which record is open" does not deserve that.
   * Both copies are marked, so the mark survives a flip.
   *
   * @param key - the brick to mark, or undefined to clear.
   */
  setSelected(key: string | undefined): void {
    if (this.selectedKey === key) return
    const previous = this.selectedKey
    if (previous !== undefined) {
      for (const entry of this.copies(previous)) entry.element.style.filter = entry.filter ?? ''
    }
    this.selectedKey = key
    if (key !== undefined) {
      for (const entry of this.copies(key)) {
        entry.filter = entry.element.style.filter
        entry.element.style.filter = SELECTED_FILTER
      }
    }
    // The open record is one of the two things that light a brick up.
    if (previous !== undefined) for (const entry of this.copies(previous)) this.syncLit(entry)
    if (key !== undefined) for (const entry of this.copies(key)) this.syncLit(entry)
  }

  /**
   * Bring one brick's activity face to the strength its state calls for.
   *
   * Only the brick under the pointer, or the one whose record is open, wears the
   * full-strength colours; every other brick stays at the board's muted weight. That
   * is what keeps a wall of two hundred bricks reading as a map instead of as a light
   * panel — and it gives the pointer somewhere to land.
   *
   * @param entry - the live slab.
   */
  private syncLit(entry: SlabEntry): void {
    if (entry.face !== 'type') return
    const lit = entry.hovered || this.selectedKey === entry.brick.key
    if (entry.lit === lit) return
    entry.lit = lit
    const metrics = this.metrics
    if (metrics !== undefined) paintSlab(entry.element, entry.brick, entry.face, metrics, lit)
  }

  /**
   * Say whether these bricks were collected or folded by the client.
   *
   * The chrome strip carries a one-line notice while they are folded, because "no collector,
   * so one brick per step" is something a reader has to be told rather than left to infer
   * from a dashed outline.
   *
   * @param estimated - true for the client's own fold.
   */
  setEstimated(estimated: boolean): void {
    this.estimated = estimated
    this.syncNotice()
  }

  /**
   * Replace the board content: newest Turn is anchored at the right edge.
   *
   * @param columns - the Turn columns, oldest first.
   * @param titles - hover text by brick key.
   * @param aux - auxiliary bricks, oldest first; shown in the lane above the columns.
   */
  setColumns(columns: readonly BoardColumn[], titles: Map<string, string>, aux: readonly Brick[] = []): void {
    this.columns = columns
    this.titles = titles
    this.aux = aux
    this.schedule(true)
  }

  /** Start watching layout changes. */
  start(): void {
    if (this.disposed) return
    window.addEventListener('scroll', this.onLayoutChange, { capture: true, passive: true })
    window.addEventListener('resize', this.onLayoutChange)
    this.observer = new MutationObserver(this.onLayoutChange)
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'style', 'class'],
    })
    this.schedule(false)
  }

  /** Detach everything this board owns. */
  dispose(): void {
    this.disposed = true
    window.removeEventListener('scroll', this.onLayoutChange, { capture: true })
    window.removeEventListener('resize', this.onLayoutChange)
    this.observer?.disconnect()
    this.resizer?.disconnect()
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    if (this.settle !== undefined) cancelAnimationFrame(this.settle)
    if (this.trailing !== undefined) window.clearTimeout(this.trailing)
    this.cancelPendingClick()
    ++this.navigationGeneration
    this.clearHighlight?.()
    this.host?.remove()
    this.host = undefined
    this.floor = undefined
    this.ghost = undefined
    this.rotator = undefined
    this.laneRule = undefined
    this.laneLabel = undefined
    this.notice = undefined
    this.cacheLayer = undefined
    this.typeLayer = undefined
    this.chip = undefined
    for (const face of FACES) this.slabs[face].clear()
  }

  private onLayoutChange = (): void => {
    this.schedule(false)
  }

  /**
   * Ask for a repaint.
   *
   * A new brick must appear on the next frame, but layout noise should not: the
   * observer sees every transcript mutation while a reply streams, and each
   * repaint re-measures every rendered row. Layout-driven repaints are therefore
   * coalesced to at most one per `LAYOUT_QUIET_MS`, while content changes and
   * user-driven resizes paint immediately.
   *
   * @param immediate - true for content changes that must animate at once.
   */
  private schedule(immediate: boolean): void {
    if (this.disposed) return
    if (!immediate) {
      const wait = LAYOUT_QUIET_MS - (performance.now() - this.lastPaint)
      if (wait > 0) {
        if (this.trailing === undefined) {
          this.trailing = window.setTimeout(() => {
            this.trailing = undefined
            this.scheduleFrame()
          }, wait)
        }
        return
      }
    }
    this.scheduleFrame()
  }

  private scheduleFrame(): void {
    if (this.disposed || this.frame !== undefined) return
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined
      this.lastPaint = performance.now()
      this.paint()
    })
  }

  /** The slab map of one side. */
  private layerOf(face: BoardFace): Map<string, SlabEntry> {
    return this.slabs[face]
  }

  /** Both copies of one brick, when they exist. */
  private copies(key: string): SlabEntry[] {
    const found: SlabEntry[] = []
    for (const face of FACES) {
      const entry = this.slabs[face].get(key)
      if (entry !== undefined) found.push(entry)
    }
    return found
  }

  private ensureHost(): { host: HTMLDivElement; floor: HTMLDivElement } {
    if (this.host !== undefined && this.floor !== undefined) {
      return { host: this.host, floor: this.floor }
    }
    const host = document.createElement('div')
    host.dataset.cacheBadgeBoard = ''
    Object.assign(host.style, {
      position: 'fixed',
      overflow: 'hidden',
      // The board is pointer-transparent so the wheel and the touch pan keep
      // reaching the transcript behind it; the slabs and the flip control opt
      // back in, which is what makes a tooltip, a click or the flip work at all.
      pointerEvents: 'none',
      zIndex: '5',
      borderRadius: '10px',
      background: 'rgba(148, 163, 184, 0.06)',
      // The card needs a vanishing point of its own; 1000px turns a ~200px board
      // like a card rather than bending it like a fisheye.
      perspective: '1000px',
      transition: 'height 200ms ease-out, top 200ms ease-out',
    } satisfies Partial<CSSStyleDeclaration>)
    host.setAttribute('role', 'group')
    host.setAttribute('aria-label', 'Cache brick board: one brick per model request, newest task on the right')

    const rotator = document.createElement('div')
    Object.assign(rotator.style, {
      position: 'absolute',
      // The card is the grid only: the control strip above it never turns over.
      top: `${String(CHROME_H)}px`,
      left: '0',
      right: '0',
      bottom: '0',
      transformStyle: 'preserve-3d',
      transform: flipTransform(this.face),
      transition: prefersReducedMotion() ? 'none' : `transform ${String(FLIP_MS)}ms cubic-bezier(.4, .05, .25, 1)`,
    } satisfies Partial<CSSStyleDeclaration>)

    const cacheLayer = createLayer('cache')
    const typeLayer = createLayer('type')
    // The type side starts facing away: the card rests on its cache side.
    typeLayer.style.transform = 'rotateY(180deg)'
    rotator.append(cacheLayer, typeLayer)

    const floor = document.createElement('div')
    Object.assign(floor.style, {
      position: 'absolute',
      left: '0',
      right: '0',
      bottom: '0',
      height: '1px',
      background: 'rgba(148, 163, 184, 0.28)',
    } satisfies Partial<CSSStyleDeclaration>)

    const chip = document.createElement('button')
    chip.type = 'button'
    chip.dataset.cacheBadgeFlip = ''
    Object.assign(chip.style, {
      position: 'absolute',
      // Centred in the strip the grid was fitted without, so it overlaps no brick.
      top: '1px',
      left: '2px',
      zIndex: '2',
      width: '26px',
      height: '13px',
      padding: '0',
      pointerEvents: 'auto',
      cursor: 'pointer',
      borderRadius: '4px',
      border: '1px solid rgba(148, 163, 184, 0.45)',
      background: 'rgba(15, 23, 42, 0.82)',
      color: '#cbd5e1',
      font: '700 9px/1 ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
      letterSpacing: '0.02em',
      transition: 'opacity 160ms ease-out',
    } satisfies Partial<CSSStyleDeclaration>)
    chip.addEventListener('click', () => {
      this.toggleFace()
    })
    chip.addEventListener('pointerenter', () => {
      chip.style.opacity = '1'
    })
    chip.addEventListener('pointerleave', () => {
      chip.style.opacity = this.face === 'type' ? '1' : '0.55'
    })

    host.append(floor, rotator, chip)
    document.body.append(host)
    this.host = host
    this.floor = floor
    this.rotator = rotator
    this.cacheLayer = cacheLayer
    this.typeLayer = typeLayer
    this.chip = chip
    this.syncChip()
    // After the host is on the instance, or the notice would be built into nothing: the
    // strip already exists for the flip control, and the notice lives at its right end.
    this.syncNotice()
    return { host, floor }
  }

  /**
   * Turn the whole card over.
   *
   * The back is built at the moment of the flip and kept current while it shows,
   * so a board nobody ever flips never pays for a second copy of every brick.
   *
   * @param face - the side to show.
   */
  private setFace(face: BoardFace): void {
    if (this.face === face) return
    if (face === 'type') this.buildTypeLayer()
    this.face = face
    if (this.rotator !== undefined) this.rotator.style.transform = flipTransform(face)
    // The drop slot is a cache-side idea: the type side is a finished reading.
    if (face === 'type' && this.ghost !== undefined) this.ghost.style.display = 'none'
    this.applyInteractivity()
    this.syncChip()
    if (face === 'cache') this.schedule(false)
    // Carry the keyboard over: the slab that had focus is now on the hidden side,
    // so the same brick on the new side takes it.
    const key = this.focusedKey
    if (key !== undefined) this.slabs[face].get(key)?.element.focus()
  }

  /** Flip to the other side. */
  toggleFace(): void {
    this.setFace(toggledFace(this.face))
  }

  /** Mirror the cache layer into the type layer, so the card has a back. */
  private buildTypeLayer(): void {
    const layer = this.typeLayer
    const metrics = this.metrics
    if (layer === undefined || metrics === undefined) return
    layer.replaceChildren()
    this.slabs.type.clear()
    for (const [key, source] of this.slabs.cache) {
      const entry = this.createSlab(source.brick, metrics, 'type', source.right, source.bottom, false)
      layer.append(entry.element)
      this.slabs.type.set(key, entry)
    }
    this.applyInteractivity()
    this.applyTitles()
  }

  /**
   * Point the interaction at the side that is showing.
   *
   * The hidden side keeps its bricks — they are what the card turns back to — but
   * it must not be clickable, focusable or announced: a slab behind the card that
   * still answered Tab and Enter would be a ghost control.
   */
  private applyInteractivity(): void {
    for (const face of FACES) {
      const active = face === this.face
      for (const entry of this.slabs[face].values()) {
        entry.element.style.pointerEvents = active ? 'auto' : 'none'
        entry.element.tabIndex = active ? 0 : -1
        if (active) entry.element.removeAttribute('aria-hidden')
        else entry.element.setAttribute('aria-hidden', 'true')
      }
    }
  }

  /** Keep the flip control telling the truth about what one click would show. */
  private syncChip(): void {
    const chip = this.chip
    if (chip === undefined) return
    chip.textContent = FLIP_LABEL[this.face]
    chip.setAttribute('aria-pressed', this.face === 'type' ? 'true' : 'false')
    chip.style.opacity = this.face === 'type' ? '1' : '0.55'
    chip.title = this.face === 'cache'
      ? 'flip the board: what each brick did in the conversation (F on a brick does the same)'
      : 'flip back: the cache reading of each request (F on a brick does the same)'
    chip.setAttribute('aria-label', this.face === 'cache'
      ? 'Flip the board to the conversation-type face'
      : 'Flip the board back to the cache-reading face')
  }

  private paint(): void {
    if (this.disposed) return
    const scroller = resolveScroller()
    if (scroller === undefined) {
      this.hide()
      return
    }
    if (scroller !== this.scroller) {
      this.resizer?.disconnect()
      this.resizer = typeof ResizeObserver === 'function' ? new ResizeObserver(this.onLayoutChange) : undefined
      this.resizer?.observe(scroller)
      this.scroller = scroller
    }
    const scrollerRect = scroller.getBoundingClientRect()
    const column = measureColumn(scroller)
    if (column === undefined) {
      this.hide()
      return
    }
    // The transcript column is exactly the span of its rendered rows; the blank
    // area to its left is where the board lives.
    const columnLeft = column.left
    const gutterLeft = scrollerRect.left + BOARD_INSET
    const gutterWidth = columnLeft - BOARD_INSET * 2 - gutterLeft
    // The scrollport runs under the composer card, whose frosted panel fades
    // anything drawn there; the board stops at the composer's top edge instead,
    // read from the variable the shell publishes on the scroller itself.
    const composerHeight = composerHeightOf(scroller)
    const floor = scrollerRect.bottom - composerHeight - BOARD_INSET
    const gutterHeight = floor - (scrollerRect.top + BOARD_INSET)
    // The control strip comes out of the band before the grid is fitted, so the grid
    // is laid out below it and no brick can ever end up under the flip control.
    const metrics = fitBoard(gutterWidth, gutterHeight - CHROME_H)
    if (metrics === undefined) {
      this.hide()
      return
    }
    // Fill the visible band: the pile is meant to use the whole gutter, so a long
    // Turn has room to stack instead of clipping early.
    const boardWidth = metrics.columns * pitchX(metrics) - metrics.gap
    const boardHeight = metrics.rows * pitchY(metrics) - metrics.gap
    const { host } = this.ensureHost()
    host.style.display = 'block'
    host.style.left = `${String(Math.round(gutterLeft + Math.max(0, gutterWidth - boardWidth)))}px`
    host.style.width = `${String(boardWidth)}px`
    host.style.height = `${String(boardHeight + CHROME_H)}px`
    host.style.top = `${String(Math.round(floor - boardHeight - CHROME_H))}px`
    this.syncBricks(metrics)
  }

  /**
   * The brick an arrow key should move focus to.
   *
   * The board is a grid — a column per Turn, a row per step — so the arrows move
   * the way the grid reads: left and right between Turns at the same step, up and
   * down between steps of the same Turn.
   *
   * @param from - the brick focus is on.
   * @param key - the key that was pressed.
   * @returns the key of the brick to focus, if there is one.
   */
  private neighbour(from: Brick, key: string): string | undefined {
    const wantTurn = key === 'ArrowLeft' ? from.turn - 1 : key === 'ArrowRight' ? from.turn + 1 : from.turn
    const wantStep = key === 'ArrowUp' ? from.step - 1 : key === 'ArrowDown' ? from.step + 1 : from.step
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown') return undefined
    for (const [candidate, live] of this.slabs[this.face]) {
      if (live.turn === wantTurn && live.step === wantStep && candidate !== from.key) return candidate
    }
    return undefined
  }

  /** Reconcile brick elements with the visible columns, animating the changes. */
  private syncBricks(metrics: BoardMetrics): void {
    const { host } = this.ensureHost()
    this.metrics = metrics
    const { columns, lead } = visibleColumns(this.columns, metrics.columns)
    // The auxiliary lane takes the board's top row when there is anything in it, and the
    // Turn columns stop below it. Without that, an auxiliary brick would have to be pushed
    // into a Turn's column — a relationship it does not have.
    const lane = auxLaneRow(metrics, this.aux.length > 0)
    const limit = columnRowLimit(metrics, lane !== undefined)
    const seen = new Set<string>()
    const newestIndex = columns.length - 1
    // The cache side is canonical and always kept current; the type side is only
    // kept current while it is the one showing.
    const faces = this.face === 'type' && this.typeLayer !== undefined ? FACES : (['cache'] as const)
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index]!
      const columnFromNewest = newestIndex - index + lead
      for (let row = 0; row < column.bricks.length; row += 1) {
        const brick = column.bricks[row]!
        // A column taller than the board keeps its lowest bricks; the overflow
        // leaves the frame exactly like a stack that outgrew the well.
        if (row >= limit) break
        const key = brick.key
        seen.add(key)
        const { right, bottom } = cellPlacement(metrics, columnFromNewest, row)
        for (const face of faces) {
          const layer = this.layerOf(face)
          const existing = layer.get(key)
          if (existing === undefined) {
            // A brick only falls on the side the user is looking at; the hidden
            // copy is built at rest, ready for the next turn of the card.
            const entry = this.createSlab(brick, metrics, face, right, bottom, face === this.face)
            layer.set(key, entry)
            this.layerElement(face).append(entry.element)
            continue
          }
          this.updateSlab(existing, brick, metrics)
          if (existing.right === right && existing.bottom === bottom) continue
          existing.right = right
          existing.bottom = bottom
          existing.element.style.right = `${String(right)}px`
          existing.element.style.bottom = `${String(bottom)}px`
        }
      }
    }
    // The lane: real requests that belong to no Turn, right-aligned like everything else and
    // capped by the board's width. Nothing is stacked — there is no step order to preserve.
    if (lane !== undefined) {
      const laneBricks = this.aux.slice(-metrics.columns)
      for (let index = 0; index < laneBricks.length; index += 1) {
        const brick = laneBricks[laneBricks.length - 1 - index]!
        const key = brick.key
        seen.add(key)
        const { right, bottom } = cellPlacement(metrics, index, lane)
        for (const face of faces) {
          const layer = this.layerOf(face)
          const existing = layer.get(key)
          if (existing === undefined) {
            const entry = this.createSlab(brick, metrics, face, right, bottom, false)
            layer.set(key, entry)
            this.layerElement(face).append(entry.element)
            continue
          }
          this.updateSlab(existing, brick, metrics)
          if (existing.right === right && existing.bottom === bottom) continue
          existing.right = right
          existing.bottom = bottom
          existing.element.style.right = `${String(right)}px`
          existing.element.style.bottom = `${String(bottom)}px`
        }
      }
    }
    for (const face of FACES) {
      const layer = this.layerOf(face)
      for (const [key, entry] of layer) {
        if (seen.has(key)) continue
        entry.element.remove()
        layer.delete(key)
      }
    }
    this.syncLaneChrome(metrics, lane)
    this.syncGhost(host, metrics, columns, limit, lead)
    this.applyInteractivity()
    this.applyTitles()
    this.scheduleSettle()
  }

  /**
   * Draw the auxiliary lane's own chrome: a dashed rule under it and a `SYS` label.
   *
   * Outside the card, so it does not turn over with the bricks — the lane is a place on the
   * board, not something the bricks carry.
   *
   * @param metrics - board geometry.
   * @param lane - the lane's row, or undefined when no auxiliary brick exists.
   */
  private syncLaneChrome(metrics: BoardMetrics, lane: number | undefined): void {
    const host = this.host
    if (host === undefined) return
    if (lane === undefined) {
      if (this.laneRule !== undefined) this.laneRule.style.display = 'none'
      if (this.laneLabel !== undefined) this.laneLabel.style.display = 'none'
      return
    }
    if (this.laneRule === undefined) {
      const rule = document.createElement('div')
      rule.dataset.cacheBadgeLane = 'rule'
      Object.assign(rule.style, {
        position: 'absolute',
        left: '0',
        right: '0',
        zIndex: '1',
        borderTop: '1px dashed rgba(148, 163, 184, 0.35)',
        pointerEvents: 'none',
      } satisfies Partial<CSSStyleDeclaration>)
      host.append(rule)
      this.laneRule = rule
    }
    if (this.laneLabel === undefined) {
      const label = document.createElement('div')
      label.dataset.cacheBadgeLane = 'label'
      label.textContent = 'SYS'
      Object.assign(label.style, {
        position: 'absolute',
        left: '2px',
        zIndex: '2',
        pointerEvents: 'none',
        font: '700 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace',
        letterSpacing: '0.08em',
        color: 'rgba(148, 163, 184, 0.75)',
      } satisfies Partial<CSSStyleDeclaration>)
      host.append(label)
      this.laneLabel = label
    }
    // The lane's floor is the rule's line; the label sits just above it.
    const ruleBottom = lane * pitchY(metrics) - Math.round(metrics.gap / 2)
    this.laneRule.style.display = 'block'
    this.laneRule.style.bottom = `${String(ruleBottom)}px`
    this.laneLabel.style.display = 'block'
    this.laneLabel.style.bottom = `${String(ruleBottom + 2)}px`
  }

  /** Keep the chrome strip's notice in step with what the board is showing. */
  private syncNotice(): void {
    const host = this.host
    if (host === undefined) return
    if (this.notice === undefined) {
      const notice = document.createElement('div')
      notice.dataset.cacheBadgeNotice = ''
      Object.assign(notice.style, {
        position: 'absolute',
        top: '2px',
        right: '3px',
        zIndex: '2',
        pointerEvents: 'none',
        font: '500 8px/1 ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
        letterSpacing: '0.02em',
        color: 'rgba(251, 191, 36, 0.9)',
      } satisfies Partial<CSSStyleDeclaration>)
      host.append(notice)
      this.notice = notice
    }
    this.notice.textContent = this.estimated ? 'no attempt telemetry · estimated steps' : ''
    this.notice.style.display = this.estimated ? 'block' : 'none'
  }

  /** The container element of one side. */
  private layerElement(face: BoardFace): HTMLElement {
    return face === 'cache' ? this.cacheLayer! : this.typeLayer!
  }

  /**
   * Build one slab: a positioned brick on one side of the card.
   *
   * @param brick - the brick to draw.
   * @param metrics - board geometry.
   * @param face - which side this copy belongs to.
   * @param right - distance from the board's right edge.
   * @param bottom - distance from the board's floor.
   * @param falling - true when it should drop in from above the well.
   * @returns the live entry, already wired to its gestures.
   */
  private createSlab(
    brick: Brick,
    metrics: BoardMetrics,
    face: BoardFace,
    right: number,
    bottom: number,
    falling: boolean,
  ): SlabEntry {
    const element = document.createElement('div')
    element.dataset.cacheBadgeBrick = brick.key
    element.dataset.cacheBadgeFace = face
    element.dataset.cacheBadgeKind = brick.kind
    Object.assign(element.style, {
      position: 'absolute',
      boxSizing: 'border-box',
      width: `${String(metrics.width)}px`,
      height: `${String(metrics.height)}px`,
      borderRadius: '4px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      pointerEvents: 'auto',
      cursor: 'pointer',
      // Gravity on the way down, a shorter slide when the stack shifts left.
      transition: 'bottom 420ms cubic-bezier(.45,.02,.95,.55), right 260ms ease-out',
    } satisfies Partial<CSSStyleDeclaration>)
    paintSlab(element, brick, face, metrics, false)
    element.style.right = `${String(right)}px`
    // Spawn above the well so the first resting position is a fall.
    element.style.bottom = `${String(falling ? bottom + metrics.height : bottom)}px`

    const entry: SlabEntry = {
      element,
      face,
      turn: brick.turn,
      step: brick.step,
      brick,
      paintKey: paintKeyOf(brick),
      right,
      bottom,
      falling,
      hovered: false,
      lit: false,
    }
    this.bindSlab(entry)
    return entry
  }

  /**
   * Repaint one slab in place.
   *
   * Both the cache tone and the activity move while an attempt streams — usage
   * lands, the first tool call arrives, the running ratio settles — so a visible
   * slab is repainted whenever its paint key changes. The element itself is never
   * re-created, which is what keeps a drop animation and the focus state intact.
   *
   * @param entry - the live slab.
   * @param brick - its current data.
   * @param metrics - board geometry, for the split's minimum slice.
   */
  private updateSlab(entry: SlabEntry, brick: Brick, metrics: BoardMetrics): void {
    entry.brick = brick
    const key = paintKeyOf(brick)
    if (entry.paintKey === key) return
    entry.paintKey = key
    entry.element.dataset.cacheBadgeKind = brick.kind
    paintSlab(entry.element, brick, entry.face, metrics, entry.lit)
  }

  /**
   * Wire one slab's gestures.
   *
   * A brick is an interactive control on both sides of the card, so the same
   * gestures are bound to both copies: click (or Enter, or Space) opens the preview;
   * double click (or Shift+Enter) locates the exact row. Arrows walk the grid and F turns
   * the card over.
   *
   * @param entry - the slab to wire.
   */
  private bindSlab(entry: SlabEntry): void {
    const { element } = entry
    element.tabIndex = 0
    element.setAttribute('role', 'button')
    // A native double click is click, click, dblclick. Do not run the preview loader
    // for those first two clicks, and never call open() from the navigation action.
    const open = (): void => {
      this.cancelPendingClick()
      ++this.navigationGeneration
      this.clearHighlight?.()
      this.options.onSelect?.(entry.brick.key)
    }
    const jump = (): void => { void this.goToBrick(entry.brick) }
    element.addEventListener('click', (event: MouseEvent) => {
      event.stopPropagation()
      this.cancelPendingClick()
      if (event.detail > 1) return
      ++this.navigationGeneration
      this.clearHighlight?.()
      if (event.detail === 0) { open(); return } // keyboard / assistive activation
      this.pendingClick = setTimeout(() => {
        this.pendingClick = undefined
        if (!this.disposed && element.isConnected) open()
      }, 300)
    })
    element.addEventListener('dblclick', (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      this.cancelPendingClick()
      jump()
    })
    element.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        if (event.repeat) return
        this.cancelPendingClick()
        // Shift is the jump: it is the same modifier habit as "open" versus "open with".
        if (event.shiftKey) jump()
        else open()
        return
      }
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault()
        this.toggleFace()
        return
      }
      const target = this.neighbour(entry.brick, event.key)
      if (target !== undefined) {
        event.preventDefault()
        this.slabs[this.face].get(target)?.element.focus()
      }
    })
    // Focus is shown by brightening the slab — never by a ring, which on a 36x15
    // brick is the loudest thing on the board and is drawn by the browser the
    // moment a brick is clicked.
    element.addEventListener('focus', () => {
      this.focusedKey = entry.brick.key
      element.style.filter = FOCUS_FILTER
    })
    element.addEventListener('blur', () => {
      if (this.focusedKey === entry.brick.key) this.focusedKey = undefined
      element.style.filter = this.selectedKey === entry.brick.key ? SELECTED_FILTER : ''
    })
    // The pointer lights the brick up: its activity face moves from the board's muted
    // weight to full strength, which is the one visual reward a 36x15 slab can give.
    element.addEventListener('mouseenter', () => {
      entry.hovered = true
      this.syncLit(entry)
    })
    element.addEventListener('mouseleave', () => {
      entry.hovered = false
      this.syncLit(entry)
    })
  }

  /**
   * Outline the slot the next brick will fall into, while the newest Turn is
   * still running. It is the one bit of chrome that tells a viewer the pile is
   * live rather than a finished chart.
   */
  private syncGhost(
    host: HTMLDivElement,
    metrics: BoardMetrics,
    columns: readonly BoardColumn[],
    limit: number,
    lead: number,
  ): void {
    const newest = columns[columns.length - 1]
    const running = this.face === 'cache' && newest !== undefined && !newest.ended && newest.bricks.length < limit
    if (!running) {
      if (this.ghost !== undefined) this.ghost.style.display = 'none'
      return
    }
    if (this.ghost === undefined) {
      const ghost = document.createElement('div')
      ghost.dataset.cacheBadgeGhost = ''
      Object.assign(ghost.style, {
        position: 'absolute',
        boxSizing: 'border-box',
        width: `${String(metrics.width)}px`,
        height: `${String(metrics.height)}px`,
        borderRadius: '4px',
        border: '1px dashed rgba(148, 163, 184, 0.35)',
        transition: 'bottom 260ms ease-out, right 260ms ease-out',
      } satisfies Partial<CSSStyleDeclaration>)
      host.append(ghost)
      this.ghost = ghost
    }
    const { right, bottom } = cellPlacement(metrics, lead, newest.bricks.length)
    this.ghost.style.display = 'block'
    this.ghost.style.right = `${String(right)}px`
    this.ghost.style.bottom = `${String(bottom)}px`
  }

  /**
   * Attach tooltips once per paint, on both sides of the card.
   *
   * The accessible name is refreshed here too: the reading and the type both move
   * while a step streams, and a screen reader sitting on a brick must not be told
   * an older one.
   */
  private applyTitles(): void {
    for (const face of FACES) {
      for (const [key, entry] of this.slabs[face]) {
        const title = this.titles.get(key)
        if (title === undefined) entry.element.removeAttribute('title')
        else entry.element.setAttribute('title', title)
        const estimate = entry.brick.estimated === true ? 'estimated step (no host collector running)' : undefined
      entry.element.setAttribute('aria-label', brickAriaLabel(entry.brick, estimate ?? title))
      }
    }
  }

  /** Let freshly spawned bricks fall on the frame after they were laid out. */
  private scheduleSettle(): void {
    if (this.settle !== undefined) return
    this.settle = requestAnimationFrame(() => {
      this.settle = undefined
      for (const face of FACES) {
        for (const entry of this.slabs[face].values()) {
          if (!entry.falling) continue
          entry.falling = false
          entry.element.style.bottom = `${String(entry.bottom)}px`
        }
      }
    })
  }

  private hide(): void {
    if (this.host !== undefined) this.host.style.display = 'none'
  }
}
