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
import { RAIL_MIN_THUMB, type BoardColumn } from './board-geometry';
import { type BrickFeed, type CacheBrick } from '../shared/cache-brick';
/**
 * Group bricks into Turn columns, oldest first.
 *
 * @param feed - one session's bricks, oldest first.
 * @returns the columns, each column's bricks in the order they landed.
 */
export declare function columnsOf(feed: BrickFeed): BoardColumn[];
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
export declare function titleOf(brick: CacheBrick): string;
/**
 * The gutter board.
 *
 * Owns its host element, its bricks, its window and the two measurements it needs (the
 * conversation's scrollport and the blank column beside it). Everything else — what a brick is,
 * how many there are, what colour they are — arrives in `setFeed`.
 */
export declare class CacheBoard {
    private readonly host;
    private readonly notice;
    private readonly liveChip;
    private readonly grid;
    private readonly floor;
    private readonly ghost;
    private readonly fadeLeft;
    private readonly fadeRight;
    private readonly fadeTop;
    private readonly hRail;
    private readonly hThumb;
    private readonly vRail;
    private readonly vThumb;
    private readonly slabs;
    private feed;
    private columns;
    private metrics;
    private view;
    private scroll;
    private lastNewestTurn;
    private tallestCache;
    private frame;
    private settle;
    private observer;
    private panUntil;
    private panTimer;
    private drag;
    private disposed;
    constructor();
    /** Start watching the layout, so the board follows the conversation it sits beside. */
    start(): void;
    /**
     * Replace the bricks.
     * @param feed - one session's bricks, or undefined when the collector has not answered yet.
     */
    setFeed(feed: BrickFeed | undefined): void;
    /** Detach everything this board owns. */
    dispose(): void;
    private readonly onLayoutChange;
    /** Coalesce repaints to one per frame. */
    private schedule;
    /** One paint: measure, window, place, and reconcile. */
    private paint;
    /** Reconcile the bricks with the window. */
    private syncBricks;
    /** A brick's identity without its session prefix, so a column lookup is cheap. */
    private shortKey;
    /** Create one brick, already wearing its face. */
    private createSlab;
    /** Move, repaint or retitle an existing brick. */
    private updateSlab;
    /** On the frame after layout, let the freshly created bricks fall into place. */
    private settleNow;
    /** The colour and the number: the whole face of a brick. */
    private paintFace;
    /**
     * The dashed slot the running Turn's next brick will land in.
     *
     * It is the one bit of chrome that says the pile is live rather than a finished chart, and it
     * belongs to the **live corner only**: a panned window is a reading of the past, and a dashed
     * "the next brick lands here" drawn inside it would be a lie about where the session is.
     */
    private syncGhost;
    /**
     * Keep both rails telling the truth about the window.
     *
     * One rail per axis, both anchored at the live corner: at pan 0 the thumb sits at the track's far
     * end (right, bottom) — where the newest brick is — and travels towards the content's start as the
     * reader goes back. A rail with nothing to scroll is still drawn, dimmed and inert, so the
     * board's shape does not change when the ring outgrows it.
     */
    private syncRails;
    /** Place one rail's thumb and publish its accessible state. */
    private applyRail;
    /**
     * Show an edge fade in every direction the window has hidden content.
     *
     * The rails say how much; the fades say **where**, at a glance, without moving anything: older
     * Turns to the left, newer ones to the right, higher rows above.
     */
    private syncFades;
    /**
     * Show the way back while the board is showing history.
     *
     * A panned board is the one state that can be misread — old Turns look exactly like the current
     * ones — so the strip grows a control that names the state and undoes it in one click. It is
     * absent, not merely dimmed, while the board is live.
     */
    private syncChip;
    /**
     * Say what is missing rather than drawing a run that looks complete.
     *
     * Two states need words: a collector that has not answered (an empty board and a cold cache look
     * identical and mean opposite things), and a ring that had to drop bricks.
     */
    private syncNotice;
    /** Move the window, clamped to what the content allows right now. */
    private setScroll;
    /**
     * Note that a hand-driven pan is in flight.
     *
     * While it is, slabs drop their transition: a pan moves every brick at once, and the 420 ms drop
     * animation would turn a drag into a rubber band. The timer restores the animation afterwards,
     * so the next real drop still falls.
     */
    private markPan;
    /** True while a hand-driven pan is still settling. */
    private isPanning;
    /** Keep the tallest column measured once per content array, not once per paint. */
    private tallestOf;
    /** The `⤓ 最新` control, built once and shown only while the board is showing history. */
    private createChip;
    /** One edge fade, so a hidden direction is visible without moving the window. */
    private createFade;
    /**
     * One rail: a track and a thumb, anchored at the live end.
     *
     * A press **on the thumb** keeps the current pan and follows the pointer; a press on the track
     * pages the window so the thumb centres under the pointer and then keeps dragging — the two
     * gestures a native scrollbar has, and the reason the track is thick enough to hit.
     */
    private createRail;
    /** Start a drag on a rail. */
    private beginRailDrag;
    /** The pan an offset along the track stands for, with the thumb centred on the pointer. */
    private railOffset;
    /** Apply the drag in flight: whole cells, so the grid never lands between bricks. */
    private applyDrag;
    /**
     * Where the board goes and how much room it has.
     *
     * The conversation sits in the middle of the window; the gutter is what is left on its left
     * side. When there is no room (a narrow window), the board stays hidden rather than drawing over
     * the conversation.
     */
    private measureBand;
    /**
     * The left edge of the transcript's own content.
     *
     * The gutter is measured from the **content**, not from the scrollport: the scrollport spans the
     * whole window, and a board anchored to it would sit on the conversation's own margin.
     */
    private transcriptEdge;
    /** The composer's height, so the board stops above it. */
    private composerHeightOf;
    /** The conversation's scrollport. */
    private resolveScroller;
}
/** The shortest a rail's thumb may be, re-exported so a test can assert the bound. */
export { RAIL_MIN_THUMB };
