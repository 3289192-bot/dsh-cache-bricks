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
import { type BoardColumn, type Brick } from './tetris';
import type { LoadReport, LoadRequest } from './navigation';
import { type RevealOutcome } from './reveal';
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
    private neighbour;
    /** Reconcile brick elements with the visible columns, animating the changes. */
    private syncBricks;
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
