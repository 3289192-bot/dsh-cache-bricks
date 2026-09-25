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
import { type BoardColumn, type Brick } from './tetris';
import type { LoadReport, LoadRequest } from './navigation';
import { type RevealOutcome } from './reveal';
import type { BrickTarget, HistoricalStepTarget } from './target';
/** Options for {@link CacheTetrisBoard}. */
export interface CacheTetrisBoardOptions {
    /** Called with a brick's key when it is clicked, so the panel can open. */
    readonly onSelect?: (key: string) => void;
    /** Close the preview and return control to the full transcript before navigating. */
    readonly onRevealStart?: (brick: Brick) => void;
    /**
     * Called after a brick is taken to its row with how the transcript jump went, so the
     * caller can tell the user when the record opened but the row could not be reached.
     */
    readonly onRevealed?: (brick: Brick, outcome: RevealOutcome) => void;
    /**
     * The unified loader (`ensureBrickTargetLoaded` bound to this session).
     *
     * One entry point for both the inspector's context and the jump: the panel calls it to
     * read the conversation around a brick without moving the chat, and the jump calls it to
     * make the row exist before scrolling to it.
     */
    readonly load?: (request: LoadRequest) => Promise<LoadReport>;
    /**
     * What a **folded** brick's step became in the transcript, read from the durable log.
     *
     * A folded brick carries a `historical-step` target: the step is known, the row is not.
     * The board passes this straight through to the reveal, which asks it after loading — see
     * `resolveHistoricalStep`.
     */
    readonly resolve?: (target: HistoricalStepTarget) => BrickTarget | undefined;
}
export declare class CacheTetrisBoard {
    private readonly options;
    private host;
    private floor;
    private ghost;
    /** The half that turns over; both layers are its children. */
    private rotator;
    private cacheLayer;
    private typeLayer;
    /** The flip control, outside the rotator so it never turns with the card. */
    private chip;
    /** The auxiliary lane's dashed rule and its `SYS` label. */
    private laneRule;
    private laneLabel;
    /** The chrome strip's "no collector" notice. */
    private notice;
    /** The chrome strip's "back to the newest" control, shown only while the board is panned. */
    private liveChip;
    /** Horizontal rail: Turns to the left and right. */
    private hRail;
    private hThumb;
    /** Vertical rail: rows up and down. */
    private vRail;
    private vThumb;
    /** Edge fades: content hidden beyond the window's left, right and top edges. */
    private fadeLeft;
    private fadeRight;
    private fadeTop;
    /** True while the bricks come from the client's own fold. */
    private estimated;
    /** One slab map per side. `cache` is canonical: it drives positions and data. */
    private readonly slabs;
    private face;
    /** The brick the keyboard is on, so a flip can carry it to the other side. */
    private focusedKey;
    /** Geometry from the last paint, so a flip can build the back at the right size. */
    private metrics;
    private columns;
    /** Auxiliary bricks: real requests that belong to no Turn, shown in the lane. */
    private aux;
    private titles;
    private scroller;
    /**
     * The pan the reader asked for; `undefined` means "follow the live corner".
     *
     * Following is not the same as `{ back: 0, up: 0 }`: a running Turn taller than the
     * board raises the live window (see `liveScroll`), and a board that is following has to
     * keep doing so as that Turn grows. Only a pan that came from the reader is stored here,
     * and landing back on the live corner clears it again.
     */
    private scroll;
    /** Turn columns at the last paint, so a new Turn does not yank a panned window. */
    private lastColumns;
    /** The window of the last paint: what the rails describe and what a drag moves. */
    private view;
    /** The pointer drag in flight on a rail, if any. */
    private drag;
    /** A brick to focus once the next paint has placed it, for arrows that pan the window. */
    private revealKey;
    /** Until this timestamp a hand-driven pan is in flight, so slabs must not animate. */
    private panUntil;
    private panTimer;
    private frame;
    private settle;
    private trailing;
    private lastPaint;
    private observer;
    private pendingClick;
    private navigationGeneration;
    private clearHighlight;
    private selectedKey;
    private resizer;
    private disposed;
    constructor(options?: CacheTetrisBoardOptions);
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
    goToBrick(brick: Brick): Promise<RevealOutcome>;
    /** Scoped CSS leaves the host's inline styles intact and is removed on a new selection. */
    private flash;
    private cancelPendingClick;
    /**
     * Mark one brick as the open one, and clear the previous mark.
     *
     * Expressed as brightness, not as a frame: an outline around a 36x15 slab is the
     * loudest thing on the board, and "which record is open" does not deserve that.
     * Both copies are marked, so the mark survives a flip.
     *
     * @param key - the brick to mark, or undefined to clear.
     */
    setSelected(key: string | undefined): void;
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
    private syncLit;
    /**
     * Say whether these bricks were collected or folded by the client.
     *
     * The chrome strip carries a one-line notice while they are folded, because "no collector,
     * so one brick per step" is something a reader has to be told rather than left to infer
     * from a dashed outline.
     *
     * @param estimated - true for the client's own fold.
     */
    setEstimated(estimated: boolean): void;
    /**
     * Replace the board content: newest Turn is anchored at the right edge.
     *
     * @param columns - the Turn columns, oldest first.
     * @param titles - hover text by brick key.
     * @param aux - auxiliary bricks, oldest first; shown in the lane above the columns.
     */
    setColumns(columns: readonly BoardColumn[], titles: Map<string, string>, aux?: readonly Brick[]): void;
    /** Start watching layout changes. */
    start(): void;
    /** Detach everything this board owns. */
    dispose(): void;
    private onLayoutChange;
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
    private schedule;
    private scheduleFrame;
    /** The slab map of one side. */
    private layerOf;
    /** Both copies of one brick, when they exist. */
    private copies;
    private ensureHost;
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
    private createRail;
    /** One edge fade, so a hidden direction is visible without moving the window. */
    private createFade;
    /**
     * Turn the whole card over.
     *
     * The back is built at the moment of the flip and kept current while it shows,
     * so a board nobody ever flips never pays for a second copy of every brick.
     *
     * @param face - the side to show.
     */
    private setFace;
    /** Flip to the other side. */
    toggleFace(): void;
    /** Mirror the cache layer into the type layer, so the card has a back. */
    private buildTypeLayer;
    /**
     * Point the interaction at the side that is showing.
     *
     * The hidden side keeps its bricks — they are what the card turns back to — but
     * it must not be clickable, focusable or announced: a slab behind the card that
     * still answered Tab and Enter would be a ghost control.
     */
    private applyInteractivity;
    /** Keep the flip control telling the truth about what one click would show. */
    private syncChip;
    private paint;
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
    private neighbourOf;
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
    private focusNeighbour;
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
    private panTo;
    /** Reconcile brick elements with the window, animating the changes. */
    private syncBricks;
    /** Move the window, clamped to what the content allows right now. */
    private setScroll;
    /**
     * Note that a hand-driven pan is in flight.
     *
     * While it is, slabs drop their transition: a pan moves every brick at once, and the
     * 420 ms drop animation would turn a drag into a rubber band. The timer restores the
     * animation afterwards, so the next real drop still falls.
     */
    private markPan;
    /** True while a hand-driven pan is still settling. */
    private isPanning;
    /** Keep a slab's animation in step with whether the window is being panned by hand. */
    private syncTransition;
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
    private beginRailDrag;
    /** The pan an offset along the track stands for, with the thumb centred on the pointer. */
    private railOffset;
    /** Apply the drag in flight: whole cells, so the grid never lands between bricks. */
    private applyDrag;
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
    private syncRails;
    /** Place one rail's thumb and publish its accessible state. */
    private applyRail;
    /**
     * Show an edge fade in every direction the window has hidden content.
     *
     * The rails say how much; the fades say **where**, at a glance, without moving anything:
     * older Turns to the left, newer ones to the right, higher rows above.
     */
    private syncFades;
    /**
     * Show the way back while the board is showing history.
     *
     * A panned board is the one state that can be misread: old Turns look exactly like the
     * current ones. So the strip grows a control that names the state and undoes it in one
     * click — and it is absent, not merely dimmed, while the board is live.
     */
    private syncLiveChip;
    /**
     * Draw the auxiliary lane's own chrome: a dashed rule under it and a `SYS` label.
     *
     * Outside the card, so it does not turn over with the bricks — the lane is a place on the
     * board, not something the bricks carry.
     *
     * @param metrics - board geometry.
     * @param lane - the lane's row, or undefined when no auxiliary brick exists.
     */
    private syncLaneChrome;
    /** Keep the chrome strip's notice in step with what the board is showing. */
    private syncNotice;
    /** The container element of one side. */
    private layerElement;
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
    private createSlab;
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
    private updateSlab;
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
    private bindSlab;
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
    private syncGhost;
    /**
     * Attach tooltips once per paint, on both sides of the card.
     *
     * The accessible name is refreshed here too: the reading and the type both move
     * while a step streams, and a screen reader sitting on a brick must not be told
     * an older one.
     */
    private applyTitles;
    /** Let freshly spawned bricks fall on the frame after they were laid out. */
    private scheduleSettle;
    private hide;
}
