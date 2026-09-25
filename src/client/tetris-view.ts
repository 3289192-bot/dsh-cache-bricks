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
 *
 * The card is a **window over the whole board**, not a crop of it: the frame never
 * changes size, and the content pans inside it along two rails — Turns to the left and
 * right, rows up and down (see `boardWindow` in `./tetris`). Until a reader pans, the
 * window sits on the live corner and the board reads exactly as it did before the rails
 * existed: the newest Turn on the right edge, the floor at the bottom, a finished Turn
 * sliding the stack one cell left. Panning is whole cells, so a panned board still shows
 * the grid the bricks fell into; the rails themselves are carved out of the band, so no
 * brick ever sits under one.
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
  boardWindow,
  cellPlacement,
  clampScroll,
  fitBoard,
  liveScroll,
  railGeometry,
  windowCell,
  type BoardColumn,
  type BoardFace,
  type BoardMetrics,
  type BoardScroll,
  type BoardWindow,
  type Brick,
  type RailGeometry,
} from './tetris'
import type { LoadReport, LoadRequest } from './navigation'
import { revealBrick, rowVisible, type RevealElement, type RevealOutcome } from './reveal'
import type { BrickTarget, HistoricalStepTarget } from './target'

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
 * Thickness of the board's own scroll rails, in CSS pixels.
 *
 * Carved out of the band exactly like {@link CHROME_H}: the grid is fitted into what is
 * left, so no brick is ever underneath a rail. A rail laid *over* the grid would hide
 * the newest column's digits — the one reading the board exists for — and would swallow
 * its clicks.
 */
const RAIL = 6

/**
 * Where the grid starts inside the board's box, in CSS pixels.
 *
 * The vertical rail takes the **left** edge. The board lives in the blank gutter beside the
 * transcript, so its right edge is the one that faces the conversation: a rail there would
 * read as part of the transcript and crowd the newest column, which is the column a reader
 * is looking at. The grid is inset by exactly the rail, so the rail is the board's own
 * frame rather than an overlay — no brick is ever underneath it.
 */
const GRID_LEFT = RAIL

/** How far the edge fade reaches into the grid, in CSS pixels. */
const FADE = 9

/** The brick transition: gravity on the way down, a shorter slide when the stack shifts left. */
const SLAB_TRANSITION = 'bottom 420ms cubic-bezier(.45,.02,.95,.55), right 260ms ease-out'

/** How long a hand-driven pan keeps the bricks from animating their own moves, in milliseconds. */
const PAN_QUIET_MS = 200

/**
 * Narrowest a colour slice may get, in CSS pixels.
 *
 * A mixed brick's split follows the real ratio between thinking and acting, but a
 * ratio of 98:2 would leave the second colour a hairline nobody can see; clamping
 * it keeps both halves identifiable while still reading as "much more of one".
 */
const MIN_SEGMENT_PX = 5

/**
 * Size of the reading printed on a brick, in CSS pixels.
 *
 * **Measured, not chosen by eye.** A brick's inner box is 34x13 (36x15 minus the 1px border), the
 * label is at most five characters (`99.9%`; an exact full hit prints the shorter `100%`), and the
 * font stack resolves to a monospace whose advance is 0.55 em on this line of machines. So the
 * ceiling is `34 / (5 x 0.55) = 12.4px` by width and `13px` by height, and **12px** is the largest
 * whole size that fits with slack — 13px measures 34.4px even with the tracking below, i.e. it
 * clips. The old 9px was what a four-character label needed; the decimal is what paid for the
 * three extra pixels, and `scripts/test-scroll.mjs` measures every printed reading against its own
 * brick so a font or size regression cannot silently clip the last digit.
 *
 * On a platform whose monospace is wider (SF Mono and DejaVu are ~0.6 em, not 0.55), 12px lands
 * within half a pixel of the edge: the safe-everywhere size is 11px.
 */
const BRICK_TEXT_PX = 12

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
  layer.dataset.cacheBricksLayer = face
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
 * Where a brick came from, as the faces need it.
 *
 * `estimated` predates the distinction and meant "not from the live collector"; a replayed brick
 * is also not from the live collector, but its reading, its activity and its lifecycle are the
 * session log's own. So the two must not be painted the same way: the fold's face says "this is
 * a per-step reading", the replay's face shows the brick, dimmed, because what is missing behind
 * it is the request capture and not the measurement.
 *
 * @param brick - the brick.
 * @returns its provenance, defaulting an untagged estimated brick to the fold it came from.
 */
function provenanceOf(brick: Brick): 'live' | 'replay' | 'fold' {
  if (brick.origin !== undefined) return brick.origin
  return brick.estimated === true ? 'fold' : 'live'
}

/** How much of a replayed brick's colour is shown: dimmer than live, brighter than a fold. */
const REPLAY_OPACITY = 0.88

/**
 * Paint the measuring side: the cache reading, in the cache tone's colours.
 *
 * @param slab - the brick element.
 * @param brick - its data.
 */
function paintCacheFace(slab: HTMLDivElement, brick: Brick): void {
  const origin = provenanceOf(brick)
  // A brick the client folded itself is one per *step*, with no attempt identity and no row
  // to navigate to. It keeps its reading and its tone — that percentage **is** measured, from
  // the session events — and says what it is through a dashed edge, a dimmed slab and the
  // board's notice, so a wall of them is never read as a wall of collected requests.
  if (origin === 'fold') {
    Object.assign(slab.style, {
      background: TONE_BRICK[brick.tone],
      border: `1px dashed ${TONE_EDGE[brick.tone]}`,
      boxShadow: 'none',
      color: TONE_TEXT[brick.tone],
      font: `${TONE_WEIGHT[brick.tone]} ${String(BRICK_TEXT_PX)}px/1 ui-monospace, SFMono-Regular, Menlo, monospace`,
      fontVariantNumeric: 'tabular-nums',
      letterSpacing: '-0.02em',
      opacity: '0.75',
    } satisfies Partial<CSSStyleDeclaration>)
    if (slab.textContent !== brick.label) slab.textContent = brick.label
    return
  }
  // A replayed brick is a real attempt from the log, drawn dimmer because nothing behind it was
  // captured; a live brick is drawn at full strength.
  slab.style.opacity = origin === 'replay' ? String(REPLAY_OPACITY) : '1'
  Object.assign(slab.style, {
    background: TONE_BRICK[brick.tone],
    border: borderCss(brick),
    // A hairline of light along the top edge: the slab reads as a block rather than
    // as a flat swatch.
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.18)',
    color: TONE_TEXT[brick.tone],
    font: `${TONE_WEIGHT[brick.tone]} ${String(BRICK_TEXT_PX)}px/1 ui-monospace, SFMono-Regular, Menlo, monospace`,
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
 * the colour had already said. The label lives in the tooltip, the accessible
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
  const origin = provenanceOf(brick)
  if (origin === 'fold') {
    // Nothing about this brick's activity was measured — the fold sees usage, not channels —
    // so this face states that instead of painting a type it cannot support. A *replayed* brick
    // is the opposite case and falls through: its channels are the log's own, so its face is
    // the type it actually was.
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
    opacity: origin === 'replay'
      ? String(REPLAY_OPACITY)
      : segments.length === 1 && tone === 'system' ? String(SPAN_OPACITY.dim) : String(SPAN_OPACITY.solid),
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
    part.dataset.cacheBricksSegment = segment.tone
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
  const existing = slab.querySelector<HTMLElement>('[data-cache-bricks-mark]')
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
  badge.dataset.cacheBricksMark = mark.glyph
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
  /**
   * What a **folded** brick's step became in the transcript, read from the durable log.
   *
   * A folded brick carries a `historical-step` target: the step is known, the row is not.
   * The board passes this straight through to the reveal, which asks it after loading — see
   * `resolveHistoricalStep`.
   */
  readonly resolve?: (target: HistoricalStepTarget) => BrickTarget | undefined
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
  /** The chrome strip's "back to the newest" control, shown only while the board is panned. */
  private liveChip: HTMLButtonElement | undefined
  /** Horizontal rail: Turns to the left and right. */
  private hRail: HTMLDivElement | undefined
  private hThumb: HTMLDivElement | undefined
  /** Vertical rail: rows up and down. */
  private vRail: HTMLDivElement | undefined
  private vThumb: HTMLDivElement | undefined
  /** Edge fades: content hidden beyond the window's left, right and top edges. */
  private fadeLeft: HTMLDivElement | undefined
  private fadeRight: HTMLDivElement | undefined
  private fadeTop: HTMLDivElement | undefined
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
  /**
   * The pan the reader asked for; `undefined` means "follow the live corner".
   *
   * Following is not the same as `{ back: 0, up: 0 }`: a running Turn taller than the
   * board raises the live window (see `liveScroll`), and a board that is following has to
   * keep doing so as that Turn grows. Only a pan that came from the reader is stored here,
   * and landing back on the live corner clears it again.
   */
  private scroll: BoardScroll | undefined
  /** Turn columns at the last paint, so a new Turn does not yank a panned window. */
  private lastColumns = 0
  /** The window of the last paint: what the rails describe and what a drag moves. */
  private view: BoardWindow | undefined
  /** The pointer drag in flight on a rail, if any. */
  private drag: {
    axis: 'x' | 'y'
    pointerId: number
    from: number
    to: number
    base: BoardScroll
    /** The thumb's own travel along the track, in pixels. */
    travel: number
    /** The pan the thumb's whole travel stands for, in cells. */
    furthest: number
  } | undefined
  /** A brick to focus once the next paint has placed it, for arrows that pan the window. */
  private revealKey: string | undefined
  /** Until this timestamp a hand-driven pan is in flight, so slabs must not animate. */
  private panUntil = 0
  private panTimer: number | undefined
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
          ...(this.options.resolve === undefined ? {} : { resolve: this.options.resolve }),
          isCurrent,
        })
      if (isCurrent() && outcome.accuracy === 'exact' && outcome.element !== undefined && scroller !== undefined) {
        // Wait for the *row* to stop moving, not for the conversation's scrollTop.
        //
        // The conversation settling says nothing about a row inside a capped process group: its
        // position changes when the group's own port scrolls, and when the host corrects the
        // layout afterwards. Watching the row covers every one of those, which is why the wait is
        // expressed in the destination's own coordinates.
        let previousRow = outcome.element.getBoundingClientRect().top
        let previousScroll = scroller.scrollTop
        let stable = 0
        for (let elapsed = 0; elapsed < 2200 && isCurrent(); elapsed += 50) {
          await new Promise<void>((resolve) => setTimeout(resolve, 50))
          const rowTop = outcome.element.getBoundingClientRect().top
          const scrollTop = scroller.scrollTop
          const moved = Math.abs(rowTop - previousRow) >= 0.5 || Math.abs(scrollTop - previousScroll) >= 0.5
          stable = moved ? 0 : stable + 1
          previousRow = rowTop
          previousScroll = scrollTop
          if (stable >= 3) break
        }
        // **Visible or it did not happen.** The row's identity is not the claim a reader acts on:
        // a row clipped by a process group is exactly the case that made a jump report `exact`
        // while the screen showed nothing. So the verdict is checked against the boxes the reader
        // has, and a clip is reported as such instead of being highlighted.
        if (isCurrent() && outcome.element.isConnected !== false) {
          if (rowVisible(outcome.element, scroller)) this.flash(outcome.element, outcome.row)
          else outcome = { ...outcome, hidden: true }
        }
      }
    } catch (error) {
      console.warn('[dsh-cache-bricks] transcript navigation failed', error)
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
    const old = element.getAttribute('data-cache-bricks-landed')
    element.setAttribute('data-cache-bricks-landed', path)
    const sheet = document.createElement('style')
    sheet.textContent = `[data-cache-bricks-landed] {
      background-color: rgba(56, 189, 248, .20) !important;
      background-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #38bdf8) 20%, transparent) !important;
      box-shadow: inset 3px 0 0 var(--dsw-alias-state-business-primary, #38bdf8) !important;
      border-radius: 6px;
    }`
    document.head.append(sheet)
    let timer: ReturnType<typeof setTimeout>
    const clear = (): void => {
      clearTimeout(timer)
      if (old === null) element.removeAttribute('data-cache-bricks-landed')
      else element.setAttribute('data-cache-bricks-landed', old)
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
    if (this.panTimer !== undefined) window.clearTimeout(this.panTimer)
    this.drag = undefined
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
    this.liveChip = undefined
    this.hRail = undefined
    this.hThumb = undefined
    this.vRail = undefined
    this.vThumb = undefined
    this.fadeLeft = undefined
    this.fadeRight = undefined
    this.fadeTop = undefined
    this.view = undefined
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
    host.dataset.cacheBricksBoard = ''
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
      // The card is the grid only: the control strip above it and the horizontal rail
      // below it never turn over.
      top: `${String(CHROME_H)}px`,
      left: `${String(GRID_LEFT)}px`,
      right: '0',
      bottom: `${String(RAIL)}px`,
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
      left: `${String(GRID_LEFT)}px`,
      right: '0',
      bottom: `${String(RAIL)}px`,
      height: '1px',
      background: 'rgba(148, 163, 184, 0.28)',
    } satisfies Partial<CSSStyleDeclaration>)

    const chip = document.createElement('button')
    chip.type = 'button'
    chip.dataset.cacheBricksFlip = ''
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

    const horizontal = this.createRail('x')
    const vertical = this.createRail('y')
    const fadeLeft = this.createFade('left')
    const fadeRight = this.createFade('right')
    const fadeTop = this.createFade('top')
    host.append(
      floor,
      rotator,
      fadeLeft,
      fadeRight,
      fadeTop,
      horizontal.rail,
      vertical.rail,
      chip,
    )
    document.body.append(host)
    this.host = host
    this.floor = floor
    this.rotator = rotator
    this.cacheLayer = cacheLayer
    this.typeLayer = typeLayer
    this.chip = chip
    this.hRail = horizontal.rail
    this.hThumb = horizontal.thumb
    this.vRail = vertical.rail
    this.vThumb = vertical.thumb
    this.fadeLeft = fadeLeft
    this.fadeRight = fadeRight
    this.fadeTop = fadeTop
    this.syncChip()
    // After the host is on the instance, or the notice would be built into nothing: the
    // strip already exists for the flip control, and the notice lives at its right end.
    this.syncNotice()
    this.syncLiveChip()
    return { host, floor }
  }

  /**
   * Build one scroll rail: a track, a thumb, and the gestures that move the window.
   *
   * The rail is a real `role="scrollbar"`: draggable by pointer, wheelable, and — when
   * there is something to move to — reachable by Tab with the arrow keys, so the board's
   * history is not pointer-only. It reports the pan in cells (`aria-valuenow` counts from
   * the **content's** start, like a native scrollbar) and says how much is hidden in words.
   *
   * @param axis - which axis this rail moves.
   * @returns the track and the thumb, both already wired.
   */
  private createRail(axis: 'x' | 'y'): { rail: HTMLDivElement; thumb: HTMLDivElement } {
    const horizontal = axis === 'x'
    const rail = document.createElement('div')
    rail.dataset.cacheBricksRail = axis
    rail.setAttribute('role', 'scrollbar')
    rail.setAttribute('aria-orientation', horizontal ? 'horizontal' : 'vertical')
    rail.setAttribute('aria-label', horizontal
      ? '板面横向滑动：向左看更早的轮次，向右看更新的轮次'
      : '板面纵向滑动：向上看更高的砖，向下回到地板')
    // Not in the tab order while there is nothing to scroll; a control that cannot act
    // should not be a stop.
    rail.tabIndex = -1
    Object.assign(rail.style, {
      position: 'absolute',
      zIndex: '3',
      pointerEvents: 'none',
      borderRadius: '2px',
      background: 'rgba(148, 163, 184, 0.14)',
      transition: 'opacity 160ms ease-out',
      ...(horizontal
        ? { left: `${String(GRID_LEFT)}px`, bottom: '1px', height: '4px' }
        : { left: '1px', width: '4px' }),
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

    rail.addEventListener('pointerenter', () => {
      thumb.style.background = 'rgba(203, 213, 225, 0.85)'
    })
    rail.addEventListener('pointerleave', () => {
      if (this.drag === undefined) thumb.style.background = 'rgba(148, 163, 184, 0.5)'
    })
    rail.addEventListener('pointerdown', (event: PointerEvent) => {
      this.beginRailDrag(axis, event)
    })
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
    // The wheel only works over the rail: the host is pointer-transparent so the wheel
    // keeps reaching the transcript everywhere else, and the bricks keep their clicks.
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
      // one to four cells per notch: a trackpad's small deltas stay precise, a mouse wheel
      // still crosses a screenful of history in a few flicks.
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
      // Positive cells move towards the older end on both axes, so the arrow keys read the
      // way the board does: left/up is further back into history.
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
      const entry = this.createSlab(source.brick, metrics, 'type', source.right, source.bottom, false, !this.isPanning())
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
    // The control strip and the two rails come out of the band before the grid is fitted,
    // so the grid is laid out between them and no brick can ever end up under a control.
    const metrics = fitBoard(gutterWidth - RAIL, gutterHeight - CHROME_H - RAIL)
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
    host.style.left = `${String(Math.round(gutterLeft + Math.max(0, gutterWidth - boardWidth - RAIL)))}px`
    host.style.width = `${String(boardWidth + RAIL)}px`
    host.style.height = `${String(boardHeight + CHROME_H + RAIL)}px`
    host.style.top = `${String(Math.round(floor - boardHeight - CHROME_H - RAIL))}px`
    this.syncBricks(metrics)
  }

  /**
   * The brick an arrow key asks for, in the board's own geometry.
   *
   * The board is a grid — a column per Turn, a row per step — and a column stacks
   * **upward**: the Turn's first step rests on the floor and every later step lands on top
   * of it. So ArrowUp means a *later* step and ArrowDown an earlier one, which is the
   * direction the brick travels on screen rather than the direction the step number does.
   *
   * @param from - the brick focus is on.
   * @param key - the key that was pressed.
   * @returns the Turn and step asked for, or undefined for any other key.
   */
  private neighbourOf(from: Brick, key: string): { turn: number; step: number } | undefined {
    switch (key) {
      case 'ArrowLeft': return { turn: from.turn - 1, step: from.step }
      case 'ArrowRight': return { turn: from.turn + 1, step: from.step }
      case 'ArrowUp': return { turn: from.turn, step: from.step + 1 }
      case 'ArrowDown': return { turn: from.turn, step: from.step - 1 }
      default: return undefined
    }
  }

  /**
   * Move focus one cell, panning the window when the cell is off screen.
   *
   * Arrows used to stop at the edge of what happened to be drawn, which is exactly the
   * wall the rails remove: the window follows the keyboard now, so the whole board is
   * walkable from the keyboard alone.
   *
   * @param from - the brick focus is on.
   * @param key - the key that was pressed.
   * @returns true when the key was one of the four arrows.
   */
  private focusNeighbour(from: Brick, key: string): boolean {
    const want = this.neighbourOf(from, key)
    if (want === undefined) return false
    for (const [candidate, live] of this.slabs[this.face]) {
      if (live.turn === want.turn && live.step === want.step && candidate !== from.key) {
        live.element.focus()
        return true
      }
    }
    this.panTo(want.turn, want.step)
    return true
  }

  /**
   * Pan the smallest amount that brings one brick inside the window, and focus it there.
   *
   * "Smallest amount" is literal: a brick one cell past the right edge comes in at the
   * right edge, one cell past the top comes in at the top, and a brick already inside
   * leaves the window where it is. The focus lands on the frame after the pan, once the
   * slab exists.
   *
   * @param turn - the brick's Turn.
   * @param step - the brick's step.
   * @returns true when such a brick exists on the board.
   */
  private panTo(turn: number, step: number): boolean {
    const metrics = this.metrics
    const view = this.view
    if (metrics === undefined || view === undefined) return false
    const index = this.columns.findIndex((column) => column.turn === turn)
    if (index < 0) return false
    const column = this.columns[index]!
    const row = column.bricks.findIndex((brick) => brick.step === step)
    if (row < 0) return false
    const distance = this.columns.length - 1 - index
    const at = distance + view.lead - view.scroll.back
    const visible = row - view.scroll.up
    const back = at < 0
      ? distance + view.lead
      : at > metrics.columns - 1
        ? distance + view.lead - (metrics.columns - 1)
        : view.scroll.back
    const up = visible < 0
      ? row
      : visible > view.limit - 1
        ? row - (view.limit - 1)
        : view.scroll.up
    const target = clampScroll({ back, up }, view.limitScroll)
    this.revealKey = column.bricks[row]!.key
    this.setScroll(target.back, target.up)
    return true
  }

  /** Reconcile brick elements with the window, animating the changes. */
  private syncBricks(metrics: BoardMetrics): void {
    const { host } = this.ensureHost()
    this.metrics = metrics
    // New Turns arrived while the reader was in history: hold the same columns on screen
    // instead of sliding the window out from under them. A following board (no pan of its
    // own) wants exactly the opposite — the stack shifts left and the new Turn drops in.
    if (this.scroll !== undefined && this.scroll.back > 0 && this.columns.length > this.lastColumns) {
      this.scroll = { back: this.scroll.back + (this.columns.length - this.lastColumns), up: this.scroll.up }
    }
    this.lastColumns = this.columns.length
    const view = boardWindow(this.columns, metrics, this.scroll, this.aux.length > 0)
    this.view = view
    // Landing back on the live corner resumes following, so the next brick arrives in view.
    if (this.scroll !== undefined && view.scroll.back === 0
      && view.scroll.up === liveScroll(this.columns, view.limit).up) this.scroll = undefined
    // A pan is a hand-driven move of the whole window: the bricks must not animate their
    // own slide while it happens, or the board would lag a drag by the drop animation.
    const smooth = !this.isPanning()
    const lane = view.lane
    const seen = new Set<string>()
    const newestIndex = this.columns.length - 1
    // The cache side is canonical and always kept current; the type side is only
    // kept current while it is the one showing.
    const faces = this.face === 'type' && this.typeLayer !== undefined ? FACES : (['cache'] as const)
    for (let index = 0; index < this.columns.length; index += 1) {
      const column = this.columns[index]!
      for (let row = 0; row < column.bricks.length; row += 1) {
        // A brick outside the window is not drawn at all: the board is a window, and a
        // brick the pan moved out is neither visible nor focusable nor announced.
        const cell = windowCell(newestIndex - index, row, view.lead, view.scroll, metrics.columns, view.limit)
        if (cell === undefined) continue
        const brick = column.bricks[row]!
        const key = brick.key
        seen.add(key)
        const { right, bottom } = cellPlacement(metrics, cell.column, cell.row)
        for (const face of faces) {
          const layer = this.layerOf(face)
          const existing = layer.get(key)
          if (existing === undefined) {
            // A brick only falls on the side the user is looking at; the hidden
            // copy is built at rest, ready for the next turn of the card.
            const entry = this.createSlab(brick, metrics, face, right, bottom, face === this.face && smooth, smooth)
            layer.set(key, entry)
            this.layerElement(face).append(entry.element)
            continue
          }
          this.updateSlab(existing, brick, metrics)
          this.syncTransition(existing, smooth)
          if (existing.right !== right) {
            existing.right = right
            existing.element.style.right = `${String(right)}px`
          }
          if (existing.bottom !== bottom) {
            existing.bottom = bottom
            existing.element.style.bottom = `${String(bottom)}px`
          }
        }
      }
    }
    // The lane: real requests that belong to no Turn, right-aligned like everything else and
    // capped by the board's width. Nothing is stacked — there is no step order to preserve —
    // and the lane is chrome at the window's top row, so panning moves Turns past it rather
    // than moving it: it belongs to no Turn and therefore to no place on the time axis.
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
            const entry = this.createSlab(brick, metrics, face, right, bottom, false, smooth)
            layer.set(key, entry)
            this.layerElement(face).append(entry.element)
            continue
          }
          this.updateSlab(existing, brick, metrics)
          this.syncTransition(existing, smooth)
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
    this.syncGhost(host, metrics, view)
    this.syncRails(metrics, view)
    this.syncFades(metrics, view)
    this.syncLiveChip(view, metrics.columns * pitchX(metrics) - metrics.gap)
    this.applyInteractivity()
    this.applyTitles()
    this.scheduleSettle()
    // An arrow key at the window's edge pans to the brick it asked for and then focuses it.
    const reveal = this.revealKey
    if (reveal !== undefined) {
      this.revealKey = undefined
      this.slabs[this.face].get(reveal)?.element.focus()
    }
  }

  /** Move the window, clamped to what the content allows right now. */
  private setScroll(back: number, up: number): void {
    const view = this.view
    if (view === undefined) return
    const requested = clampScroll({ back, up }, view.limitScroll)
    const live = liveScroll(this.columns, view.limit)
    // Landing on the live corner resumes following, so the board keeps up with the session.
    this.scroll = requested.back === 0 && requested.up === live.up ? undefined : requested
    this.markPan()
    this.schedule(true)
  }

  /**
   * Note that a hand-driven pan is in flight.
   *
   * While it is, slabs drop their transition: a pan moves every brick at once, and the
   * 420 ms drop animation would turn a drag into a rubber band. The timer restores the
   * animation afterwards, so the next real drop still falls.
   */
  private markPan(): void {
    this.panUntil = performance.now() + PAN_QUIET_MS
    if (this.panTimer !== undefined) window.clearTimeout(this.panTimer)
    this.panTimer = window.setTimeout(() => {
      this.panTimer = undefined
      this.schedule(true)
    }, PAN_QUIET_MS + 40)
  }

  /** True while a hand-driven pan is still settling. */
  private isPanning(): boolean {
    return performance.now() < this.panUntil
  }

  /** Keep a slab's animation in step with whether the window is being panned by hand. */
  private syncTransition(entry: SlabEntry, smooth: boolean): void {
    const wanted = smooth ? SLAB_TRANSITION : 'none'
    if (entry.element.style.transition !== wanted) entry.element.style.transition = wanted
  }

  /**
   * Start a drag on a rail.
   *
   * A press **on the thumb** keeps the current pan and follows the pointer; a press on the
   * track pages the window so the thumb centres under the pointer and then keeps dragging —
   * the two gestures a native scrollbar has, and the reason the track is thick enough to
   * hit (4 CSS pixels).
   *
   * @param axis - which rail was pressed.
   * @param event - the pointer event.
   */
  private beginRailDrag(axis: 'x' | 'y', event: PointerEvent): void {
    const view = this.view
    const metrics = this.metrics
    if (view === undefined || metrics === undefined) return
    const horizontal = axis === 'x'
    const furthest = horizontal ? view.limitScroll.back : view.limitScroll.up
    if (furthest <= 0) return
    const rail = horizontal ? this.hRail : this.vRail
    const thumb = horizontal ? this.hThumb : this.vThumb
    if (rail === undefined || thumb === undefined) return
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
    // The thumb follows the pointer **in track space**, not in brick pitches: dragging the
    // thumb to the end of its travel has to reach the end of the content, or the last Turns
    // would be unreachable by drag. Whole cells, so the grid never lands between bricks.
    const moved = ((drag.to - drag.from) / drag.travel) * drag.furthest
    const cells = Math.round(moved)
    // Dragging right/down moves towards the live corner, which is a smaller pan on both axes.
    this.setScroll(
      horizontal ? drag.base.back - cells : drag.base.back,
      horizontal ? drag.base.up : drag.base.up - cells,
    )
  }

  /**
   * Keep both rails telling the truth about the window.
   *
   * One rail per axis, both anchored at the live corner: at pan 0 the thumb sits at the
   * track's far end (right, bottom) — where the newest brick is — and travels towards the
   * content's start as the reader goes back. A rail with nothing to scroll is still drawn,
   * dimmed and inert, so the board's shape does not change when history outgrows it.
   *
   * @param metrics - the window's brick geometry.
   * @param view - the window this paint is showing.
   */
  private syncRails(metrics: BoardMetrics, view: BoardWindow): void {
    const gridWidth = metrics.columns * pitchX(metrics) - metrics.gap
    // The vertical rail spans the column pane only: with the lane shown, the pane starts
    // one row down, and a thumb measured against the whole grid would lie by one row.
    const paneHeight = view.limit * pitchY(metrics) - metrics.gap
    const paneTop = CHROME_H + (metrics.rows - view.limit) * pitchY(metrics)
    // The content is every Turn plus the lead cell — the drop slot a finished Turn leaves
    // free is part of the board and pans with it.
    const h = railGeometry(gridWidth, metrics.columns, this.columns.length + view.lead, view.scroll.back)
    const v = railGeometry(paneHeight, view.limit, view.tallest, view.scroll.up)
    this.applyRail('x', h, view.limitScroll.back, view.limitScroll.back - view.scroll.back, view.newer > 0 || view.older > 0
      ? `已回看 ${String(view.newer)} 轮，左侧还有 ${String(view.older)} 轮`
      : '已显示全部轮次')
    this.applyRail('y', v, view.limitScroll.up, view.limitScroll.up - view.scroll.up, view.limitScroll.up > 0
      ? `下方还有 ${String(view.scroll.up)} 行未显示，上方还有 ${String(view.limitScroll.up - view.scroll.up)} 行`
      : '已显示全部行')
    const hRail = this.hRail
    if (hRail !== undefined) hRail.style.width = `${String(gridWidth)}px`
    const vRail = this.vRail
    if (vRail !== undefined) {
      vRail.style.top = `${String(Math.round(paneTop))}px`
      vRail.style.height = `${String(paneHeight)}px`
    }
  }

  /** Place one rail's thumb and publish its accessible state. */
  private applyRail(
    axis: 'x' | 'y',
    geometry: RailGeometry,
    furthest: number,
    at: number,
    text: string,
  ): void {
    const horizontal = axis === 'x'
    const rail = horizontal ? this.hRail : this.vRail
    const thumb = horizontal ? this.hThumb : this.vThumb
    if (rail === undefined || thumb === undefined) return
    if (horizontal) thumb.style.width = `${String(geometry.thumb)}px`
    else thumb.style.height = `${String(geometry.thumb)}px`
    if (horizontal) thumb.style.left = `${String(geometry.offset)}px`
    else thumb.style.top = `${String(geometry.offset)}px`
    rail.style.pointerEvents = geometry.scrollable ? 'auto' : 'none'
    rail.style.cursor = geometry.scrollable ? 'grab' : 'default'
    rail.style.opacity = geometry.scrollable ? '1' : '0.5'
    // A rail that cannot move is not a tab stop, and says so to assistive technology.
    if (rail.tabIndex !== (geometry.scrollable ? 0 : -1)) rail.tabIndex = geometry.scrollable ? 0 : -1
    rail.setAttribute('aria-disabled', geometry.scrollable ? 'false' : 'true')
    rail.setAttribute('aria-valuemin', '0')
    rail.setAttribute('aria-valuemax', String(furthest))
    rail.setAttribute('aria-valuenow', String(Math.min(Math.max(0, at), furthest)))
    rail.setAttribute('aria-valuetext', text)
  }

  /**
   * Show an edge fade in every direction the window has hidden content.
   *
   * The rails say how much; the fades say **where**, at a glance, without moving anything:
   * older Turns to the left, newer ones to the right, higher rows above.
   */
  private syncFades(metrics: BoardMetrics, view: BoardWindow): void {
    const gridWidth = metrics.columns * pitchX(metrics) - metrics.gap
    const paneHeight = view.limit * pitchY(metrics) - metrics.gap
    const paneTop = CHROME_H + (metrics.rows - view.limit) * pitchY(metrics)
    const show = (fade: HTMLDivElement | undefined, visible: boolean, style: Partial<CSSStyleDeclaration>): void => {
      if (fade === undefined) return
      fade.style.display = visible ? 'block' : 'none'
      if (!visible) return
      Object.assign(fade.style, style)
    }
    show(this.fadeLeft, view.older > 0, { left: `${String(GRID_LEFT)}px`, width: `${String(FADE)}px`, top: `${String(Math.round(paneTop))}px`, height: `${String(paneHeight)}px` })
    show(this.fadeRight, view.newer > 0, { left: `${String(GRID_LEFT + gridWidth - FADE)}px`, width: `${String(FADE)}px`, top: `${String(Math.round(paneTop))}px`, height: `${String(paneHeight)}px` })
    show(this.fadeTop, view.limitScroll.up > view.scroll.up, { left: `${String(GRID_LEFT)}px`, width: `${String(gridWidth)}px`, top: `${String(Math.round(paneTop))}px`, height: `${String(FADE)}px` })
  }

  /**
   * Show the way back while the board is showing history.
   *
   * A panned board is the one state that can be misread: old Turns look exactly like the
   * current ones. So the strip grows a control that names the state and undoes it in one
   * click — and it is absent, not merely dimmed, while the board is live.
   */
  private syncLiveChip(view?: BoardWindow, gridWidth = 0): void {
    const host = this.host
    if (host === undefined) return
    if (this.liveChip === undefined) {
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
        font: '700 9px/1 ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
        letterSpacing: '0.02em',
      } satisfies Partial<CSSStyleDeclaration>)
      chip.addEventListener('click', (event: MouseEvent) => {
        event.stopPropagation()
        this.setScroll(0, 0)
      })
      host.append(chip)
      this.liveChip = chip
    }
    const chip = this.liveChip
    // "Following" is the honest test, not the offsets: a board that follows a Turn taller
    // than the window is at `up > 0` and is still live.
    const panned = this.scroll !== undefined
    chip.style.display = panned ? 'block' : 'none'
    if (!panned || view === undefined) return
    const label = gridWidth < 140 ? '⤓' : '⤓ 最新'
    if (chip.textContent !== label) chip.textContent = label
    const hidden = [
      view.newer > 0 ? `右侧 ${String(view.newer)} 轮` : undefined,
      view.limitScroll.up > view.scroll.up ? `上方 ${String(view.limitScroll.up - view.scroll.up)} 行` : undefined,
    ].filter((part): part is string => part !== undefined).join('、')
    chip.title = hidden === '' ? '回到最新：右侧已无更新的轮次' : `回看中：${hidden} 未显示 · 点击回到最新`
    chip.setAttribute('aria-label', hidden === '' ? '回到最新' : `回看中，${hidden}未显示；回到最新`)
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
      rule.dataset.cacheBricksLane = 'rule'
      Object.assign(rule.style, {
        position: 'absolute',
        left: `${String(GRID_LEFT)}px`,
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
      label.dataset.cacheBricksLane = 'label'
      label.textContent = 'SYS'
      Object.assign(label.style, {
        position: 'absolute',
        left: `${String(GRID_LEFT + 2)}px`,
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
      notice.dataset.cacheBricksNotice = ''
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
   * @param smooth - true when the slab should animate its own moves; false during a pan, when
   *   every brick moves at once and the drop animation would read as lag.
   * @returns the live entry, already wired to its gestures.
   */
  private createSlab(
    brick: Brick,
    metrics: BoardMetrics,
    face: BoardFace,
    right: number,
    bottom: number,
    falling: boolean,
    smooth: boolean,
  ): SlabEntry {
    const element = document.createElement('div')
    element.dataset.cacheBricksBrick = brick.key
    element.dataset.cacheBricksFace = face
    element.dataset.cacheBricksKind = brick.kind
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
      transition: smooth ? SLAB_TRANSITION : 'none',
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
    // A brick that was open before the pan moved it out and back keeps its mark: the slab is
    // new, the record it stands for is not.
    if (this.selectedKey === brick.key) {
      entry.filter = element.style.filter
      element.style.filter = SELECTED_FILTER
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
    entry.element.dataset.cacheBricksKind = brick.kind
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
      if (this.focusNeighbour(entry.brick, event.key)) event.preventDefault()
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
   *
   * The slot belongs to the **live** corner: a panned window is a reading of the past,
   * and a dashed "the next brick lands here" cell drawn inside it would be a lie about
   * where the session is.
   *
   * @param host - the board's own element.
   * @param metrics - board geometry.
   * @param view - the window this paint is showing.
   */
  private syncGhost(host: HTMLDivElement, metrics: BoardMetrics, view: BoardWindow): void {
    const newest = this.columns[this.columns.length - 1]
    const running = this.scroll === undefined && this.face === 'cache' && newest !== undefined && !newest.ended
    const cell = running
      ? windowCell(0, newest.bricks.length, view.lead, view.scroll, metrics.columns, view.limit)
      : undefined
    if (cell === undefined) {
      if (this.ghost !== undefined) this.ghost.style.display = 'none'
      return
    }
    if (this.ghost === undefined) {
      const ghost = document.createElement('div')
      ghost.dataset.cacheBricksGhost = ''
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
    const { right, bottom } = cellPlacement(metrics, cell.column, cell.row)
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
        // Three provenances, three sentences: the reader is owed the difference between a
        // captured request, a log-reconstructed one, and a per-step reading.
        const origin = provenanceOf(entry.brick)
        const estimate = origin === 'fold'
          ? 'estimated step (folded on the client; this collector process has no attempt for it)'
          : origin === 'replay'
            ? 'reconstructed from the session log (one brick per settled attempt; no request capture)'
            : undefined
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
