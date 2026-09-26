/**
 * Where a brick goes.
 *
 * The one idea worth carrying over from the full board, unchanged because it is the product: a
 * **column is a Turn**, bricks stack up from the floor in the order they landed, the newest Turn
 * is anchored at the right edge, and a finished Turn slides its stack one cell left so the next
 * Turn drops into the freed column. That is the Tetris reading — a run of green climbing a column
 * is a cached conversation, a red brick is a prefix that had to be paid for again.
 *
 * Pure geometry, no DOM: `tests/board-geometry.spec.ts` pins it.
 */
/** One brick's slot in the gutter, in CSS pixels from the board's top-left. */
export interface BrickPlacement {
    /** Distance from the board's right edge to the brick's right edge. */
    readonly right: number;
    /** Distance from the board's bottom edge to the brick's bottom edge. */
    readonly bottom: number;
}
/** The board's brick geometry: how many fit, and how big they are. */
export interface BoardMetrics {
    readonly width: number;
    readonly height: number;
    readonly gap: number;
    /** Columns the gutter can show. */
    readonly columns: number;
    /** Rows the gutter can show. */
    readonly rows: number;
}
/** Brick size and spacing — the frozen 0.1.x brick, kept because the reading is sized to it. */
export declare const BRICK_W = 36;
export declare const BRICK_H = 15;
export declare const GAP = 3;
/**
 * Safety bound on rows. A 1080p window offers about 40; this only stops a pathological viewport
 * from reserving thousands of slots.
 */
export declare const MAX_ROWS = 60;
/** Horizontal pitch of one column. */
export declare function pitchX(metrics: BoardMetrics): number;
/** Vertical pitch of one row. */
export declare function pitchY(metrics: BoardMetrics): number;
/**
 * Fit a board into the blank gutter beside the transcript.
 * @param width - available gutter width in CSS pixels.
 * @param height - available gutter height in CSS pixels.
 * @returns metrics, or undefined when the gutter cannot hold a usable board.
 */
export declare function fitBoard(width: number, height: number): BoardMetrics | undefined;
/**
 * Where one brick sits, in cells: column 0 is the right edge, row 0 rests on the floor.
 * @param metrics - board geometry.
 * @param column - cells from the right edge.
 * @param row - rows above the floor.
 * @returns the placement in CSS pixels.
 */
export declare function cellPlacement(metrics: BoardMetrics, column: number, row: number): BrickPlacement;
/**
 * Which rows of a column are in frame.
 *
 * A Turn taller than the board used to lose its newest bricks off the top; while the board is
 * following, the window rises just far enough to keep the brick that just landed visible. Every
 * normal Turn — every Turn shorter than the board — still starts at the floor.
 *
 * @param running - bricks in the newest Turn while it is still running.
 * @param rows - rows the board can show.
 * @returns how many rows the board is raised by.
 */
export declare function liveRaise(running: number, rows: number): number;
/** How far the board is panned away from its live corner, in whole cells. */
export interface BoardScroll {
    /** Columns hidden to the right of the window; 0 puts the newest Turn on the right edge. */
    readonly back: number;
    /** Rows hidden below the window; 0 puts the floor row on screen. */
    readonly up: number;
}
/** The live corner: nothing hidden on either axis. */
export declare const LIVE_SCROLL: BoardScroll;
/** One Turn's column, oldest first in the array. */
export interface BoardColumn {
    readonly turn: number;
    readonly ended: boolean;
    readonly bricks: readonly {
        readonly step: number;
        readonly attempt: number;
    }[];
}
/** The columns inside a window panned `back` cells to the left of the live edge. */
export interface ColumnsWindow {
    readonly columns: readonly BoardColumn[];
    readonly lead: number;
    /** Columns hidden to the left of the window (older Turns). */
    readonly older: number;
    /** Columns hidden to the right of the window (newer Turns, and the live end). */
    readonly newer: number;
    /** Absolute index of the first column inside the window (inclusive). */
    readonly columnStart: number;
    /** Absolute index one past the last column inside the window (exclusive). */
    readonly columnEnd: number;
}
/** The lead cell: one free column once the newest Turn has ended. */
export declare function leadOf(columns: readonly BoardColumn[]): number;
/** The newest Turn on the board, or undefined on an empty one. */
export declare function newestTurnOf(columns: readonly BoardColumn[]): number | undefined;
/** The tallest column, in bricks. */
export declare function tallestColumn(columns: readonly BoardColumn[]): number;
/** How many columns are newer than `turn` — a binary search, because a ring has no small size. */
export declare function countNewerThan(columns: readonly BoardColumn[], turn: number): number;
/**
 * The pan a board keeps when its content changed underneath it.
 *
 * A reader who panned back must not be slid further back by the session moving: when new Turns
 * **append** at the live end, the window holds the same columns by adding the appended count to
 * `back`. The count is of columns *newer* than the newest one seen before, never of columns added
 * — the ring also ages out at the older end, and that must leave the pan exactly where it was.
 *
 * @param scroll - the pan in force, or undefined while the board follows the live end.
 * @param columns - the content as it is now.
 * @param previousNewestTurn - the newest Turn at the previous paint.
 * @returns the pan to paint with.
 */
export declare function heldScroll(scroll: BoardScroll | undefined, columns: readonly BoardColumn[], previousNewestTurn: number | undefined): BoardScroll | undefined;
/**
 * The columns inside a window panned `back` cells to the left of the live edge.
 *
 * The window is **computed, not scanned**: everything a loop would decide is one comparison
 * against a single cell coordinate, so the visible columns are one subtraction away and the two
 * counts follow from the same number.
 *
 * @param columns - every known Turn column, oldest first.
 * @param capacity - columns the window can hold.
 * @param back - columns hidden to the right of the window.
 * @returns the window, its counts, and its half-open index range into `columns`.
 */
export declare function windowColumns(columns: readonly BoardColumn[], capacity: number, back: number): ColumnsWindow;
/**
 * Where one brick sits inside the window, or undefined when the pan moved it out.
 *
 * @param columnDistance - cells between this column and the newest Turn (0 = newest).
 * @param row - the brick's row in its own column (0 = resting on the floor).
 * @param lead - the reserved lead cell.
 * @param scroll - the pan applied to the board.
 * @param capacity - columns the window can hold.
 * @param limit - rows a column may fill inside the window.
 * @returns the window cell (`0,0` is the window's bottom-right cell), or undefined.
 */
export declare function windowCell(columnDistance: number, row: number, lead: number, scroll: BoardScroll, capacity: number, limit: number): {
    readonly column: number;
    readonly row: number;
} | undefined;
/**
 * The largest pan the content allows on each axis.
 * @param columns - every known Turn column, oldest first.
 * @param capacity - columns the window can hold.
 * @param limit - rows a column may fill inside the window.
 * @param lead - the reserved lead cell.
 * @param tallest - the tallest column, when the caller already measured it.
 * @returns the largest `back`/`up` the content can honour.
 */
export declare function scrollLimit(columns: readonly BoardColumn[], capacity: number, limit: number, lead: number, tallest?: number): BoardScroll;
/**
 * Clamp a pan to what the content allows.
 * @param scroll - the requested pan.
 * @param limit - the largest pan this content allows.
 * @returns the pan to apply, never negative and never past the end.
 */
export declare function clampScroll(scroll: BoardScroll, limit: BoardScroll): BoardScroll;
/** One rail's geometry, in CSS pixels inside its track. */
export interface RailGeometry {
    /** The track's length along its axis. */
    readonly track: number;
    /** The thumb's length. */
    readonly thumb: number;
    /** The thumb's offset from the track's start (left for the horizontal rail, top for the vertical one). */
    readonly offset: number;
    /** True when there is more content than viewport on this axis. */
    readonly scrollable: boolean;
}
/**
 * Shortest a rail's thumb may get, in CSS pixels.
 *
 * A hundred Turns of history against ten visible columns would otherwise leave a two-pixel thumb:
 * unreadable as a position and impossible to grab. The thumb is therefore a **lower bound on the
 * grab handle**, never a claim about the ratio.
 */
export declare const RAIL_MIN_THUMB = 16;
/**
 * Where a scrollbar's thumb sits, for a track that starts at the content's **end**.
 *
 * Both rails are anchored the same way: pan 0 (the live corner) puts the thumb at the track's far
 * end — right for the horizontal rail, bottom for the vertical one — which is where a reader
 * expects "the newest brick" to be.
 *
 * @param track - the track's length in CSS pixels.
 * @param viewport - cells the window shows on this axis.
 * @param content - cells the content needs on this axis.
 * @param offset - the pan applied, in cells, 0 = live.
 * @param minimum - shortest a thumb may get, in CSS pixels.
 * @returns the thumb's length, its offset from the track's start, and whether it can move.
 */
export declare function railGeometry(track: number, viewport: number, content: number, offset: number, minimum?: number): RailGeometry;
/** A window over the board content: what is on screen, and how much is not. */
export interface BoardWindow {
    /** The Turn columns inside the window, oldest first. */
    readonly columns: readonly BoardColumn[];
    /** Absolute index of the first column inside the window (inclusive). */
    readonly columnStart: number;
    /** Absolute index one past the last column inside the window (exclusive). */
    readonly columnEnd: number;
    /** First row inside the window, and one past the last, in each column's own numbering. */
    readonly rowStart: number;
    readonly rowEnd: number;
    /** Columns reserved to the right of the newest Turn. */
    readonly lead: number;
    /** Rows a Turn column may fill inside the window. */
    readonly limit: number;
    /** The pan actually applied, after clamping to what the content allows. */
    readonly scroll: BoardScroll;
    /** The largest pan this content allows. */
    readonly limitScroll: BoardScroll;
    /** Tallest column, in bricks: the content's row count. */
    readonly tallest: number;
    /** Columns hidden to the left of the window (older Turns). */
    readonly older: number;
    /** Columns hidden to the right of the window (newer Turns, and the live end). */
    readonly newer: number;
}
/**
 * Everything the view needs to paint one board at one pan.
 *
 * The single place where "what is on screen" is decided: which columns, which rows, how far the
 * pan could still go, and how much is hidden on each side. Pure, so the viewport arithmetic is
 * unit-tested without a DOM.
 *
 * @param columns - every known Turn column, oldest first.
 * @param metrics - the window's brick geometry.
 * @param scroll - the requested pan, or undefined to follow the live edge.
 * @param tallest - the tallest column, when the caller already measured it.
 * @returns the window, the pan actually applied, and both ends of the rail.
 */
export declare function boardWindow(columns: readonly BoardColumn[], metrics: BoardMetrics, scroll: BoardScroll | undefined, tallest?: number): BoardWindow;
