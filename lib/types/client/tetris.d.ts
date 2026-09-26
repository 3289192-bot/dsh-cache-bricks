/**
 * Board model for the falling-brick cache animation.
 *
 * **One brick per real model request attempt**, coloured by that request's cache tone.
 * Not per step: DSH can dispatch two requests for one `(turn, step)` when a retry
 * follows a failure, and those are two bills with two cache outcomes — collapsing them
 * would hide the case the board exists for. A Turn owns one column; the newest Turn is
 * anchored at the board's right edge, so every finished Turn pushes the older columns
 * exactly one cell to the left and the next Turn starts falling into the free column.
 * Bricks inside a column stack bottom-up in step order — the same "drop and pile up"
 * reading as the cache itself: a red brick lands on whatever the previous steps left
 * behind.
 *
 * Where a brick sits in the transcript is a **separate** question from what it is, and
 * it is answered by {@link Brick.target} (`./target`) rather than by re-deriving anchors
 * at the point of use.
 *
 * The pure half (columns, eviction, cell placement) is separate from the DOM so
 * the geometry can be unit-tested without a browser.
 */
import type { CacheTone } from './logic';
import type { BrickTarget } from './target';
/**
 * What one attempt actually produced.
 *
 * These are **not** mutually exclusive, because a real step is not: a single
 * `assistant-step` can reason, call tools and then answer, and rc1's content blocks
 * (`text` / `reasoning` / `image` / `file` / `tool-call`) are explicitly not a union
 * of alternatives. So each channel gets its own edge, instead of one "category"
 * colour that would have to pick a winner and would therefore lie about the rest.
 *
 * The layout is directional on purpose: **input enters on the left, output leaves
 * on the right, thinking is on top, tool work happens below** — the same way the
 * transcript reads.
 */
export interface BrickContent {
    /** Top edge: the attempt produced reasoning. */
    readonly reasoning: boolean;
    /** Bottom edge: the attempt called tools. */
    readonly tools: boolean;
    /** Right edge: the attempt produced visible output. */
    readonly output: boolean;
    /** Left edge: the model-visible input changed here (new request header or series). */
    readonly inputChange: boolean;
    /** Every edge: an auxiliary call (compaction, session-title), not an answer. */
    readonly auxiliary: boolean;
}
/**
 * How an attempt ended, when it did not end cleanly.
 *
 * Drawn as the outer ring rather than as an edge: a retry must never be mistakable
 * for reasoning, and a failure must never be mistakable for a tool call.
 */
export type BrickAbnormal = 'retry' | 'failed' | 'interrupted' | 'max-tokens';
/**
 * What kind of conversation move one attempt is — the brick's **back face**.
 *
 * Four normal types and one auxiliary, and that is the whole vocabulary. The
 * runtime offers more shapes than this (see `docs/runtime-contract.md`: text,
 * reasoning, image, file and tool-call blocks), but three of those five all mean
 * "the model produced visible output", so a board that drew them separately would
 * be asking its reader to memorise a legend before it says anything. What is left
 * is the distinction worth a glance: **thinking (purple), acting (cyan), both, or
 * neither**.
 *
 * Retry, error, abort and the output limit are deliberately **not** types: they are
 * markers painted on whichever type the attempt already is, because a failed tool
 * call is still a tool call.
 */
export type ActivityKind = 'output' | 'reasoning' | 'tool' | 'mixed' | 'auxiliary';
/**
 * The official lanes a brick body can be painted in, plus the two the board defines but
 * cannot currently produce.
 *
 * `input` and `context` are part of the trajectory's vocabulary and are painted if a target
 * ever maps to them, but **no request is an injection or a user input** — the frozen brick
 * contract says a brick is a dispatched model call, so those two stay unreachable and a test
 * asserts it rather than leaving the reader to wonder.
 */
export type ActivityTone = 'input' | 'model' | 'tool' | 'context' | 'system';
/**
 * The official trajectory palette — **borrowed by token, never copied as hex**.
 *
 * DSH already paints its own timeline with these exact expressions
 * (`dsh-client-ui-trajectory`: `[data-timeline-span=user|message|subtool|context]`), so the
 * board's back face speaks the vocabulary a reader has already built from the trajectory
 * view: blue input, purple model, orange tool, green context, grey system. Reading the
 * tokens instead of the resolved colours also means the bricks follow the app's theme —
 * light, dark, or whatever the design system does next — with no code change here.
 *
 * | tone | official expression |
 * |---|---|
 * | `input` | `var(--dsw-alias-state-business-primary)` |
 * | `model` | brand 60% + error-secondary |
 * | `tool` | `var(--dsw-alias-state-warn-label)` |
 * | `context` | success 68% + label-secondary |
 * | `system` | `var(--dsw-alias-label-secondary)` |
 */
export declare const TRAJECTORY_TONE: Record<ActivityTone, string>;
/** The official error colour: a state, painted on the rim — never a type of its own. */
export declare const ERROR_COLOR = "var(--dsw-alias-state-error-primary)";
/**
 * A tone at the board's weight.
 *
 * The official colours are the trajectory's *scanning* colours — full strength in a
 * one-line timeline. A board holds one or two hundred bricks at once, so the same hue is
 * mixed down towards the page background for the resting state, and the brick being read
 * wears the official colour untouched (see `faceSegments` with `highlight`).
 *
 * @param tone - the official expression.
 * @param weight - how much of it survives the mix, in percent.
 * @returns a colour expression that follows the theme.
 */
export declare function toneAt(tone: string, weight: number): string;
/** Resting weight of a tone, chosen to sit at the cache face's visual weight. */
export declare const TONE_WEIGHT_RESTING = 50;
/** Rim weight: a lit edge of the same hue. */
export declare const TONE_WEIGHT_RIM = 68;
/** Top of the bevel, and the shadowed bottom. */
export declare const TONE_WEIGHT_TOP = 58;
export declare const TONE_WEIGHT_BOTTOM = 40;
/**
 * One type's label and its official tone.
 *
 * The label names the finer thing the attempt did (thinking, answering, tool work); the
 * **tone** is the official lane it belongs to. Two labels may share one tone — `思考` and
 * `答复` are both the model lane — which is the point: the colour says which lane, the
 * label says what happened in it.
 */
export interface ActivityFace {
    /** Exactly two characters. */
    readonly label: string;
    /** Which official lane this kind is painted as. */
    readonly tone: ActivityTone;
    /** Full name, for tooltips and screen readers. */
    readonly english: string;
}
/** The back face's faces, one per kind. */
export declare const ACTIVITY: Record<ActivityKind, ActivityFace>;
/** The word the back face prints for a tone, and the tone's own label. */
export declare const TONE_MARK: Record<ActivityTone, string>;
/**
 * A slice of a brick's back face.
 *
 * A one-colour type is a single slice at full width; a `mixed` brick is two, split in
 * proportion to what the attempt actually did. The split is the point: a third colour for
 * "thinking + acting" would force the reader to learn what it meant, while a model-coloured
 * and a tool-coloured half of one brick explains itself — which is also how the official
 * timeline reads, thinking in the model lane and the calls in the tools lane.
 */
export interface FaceSegment {
    readonly tone: ActivityTone;
    readonly label: string;
    readonly color: string;
    /** Share of the slab's width, 0..1. */
    readonly share: number;
}
/**
 * Nominal characters of reasoning that one tool call is worth, for the split.
 *
 * The two quantities are not the same unit — characters of thinking against number
 * of calls — so any split needs a conversion, and this one is a **heuristic**: it is
 * the average reasoning a call is worth in the observed corpus, and it is labelled
 * as an estimate everywhere it is shown. It only ever moves the seam between two
 * colours; it never invents a number the panel would report as measured.
 */
export declare const REASONING_CHARS_PER_TOOL_CALL = 120;
/**
 * How much of a mixed brick's width goes to reasoning.
 * @param reasoningChars - characters of reasoning the attempt produced.
 * @param toolCalls - tool calls the attempt made.
 * @returns the share in `0..1`; an attempt that did neither splits evenly.
 */
export declare function reasoningShare(reasoningChars: number, toolCalls: number): number;
/** Options for {@link faceSegments}. */
export interface FaceOptions {
    /** How much width reasoning gets, for a mixed brick. */
    readonly portion?: number;
    /** Smallest share a slice may take, so neither colour can vanish. */
    readonly floor?: number;
    /** Use the full-strength colours, for the brick being pointed at or read. */
    readonly highlight?: boolean;
}
/**
 * The slices a brick's back face is drawn from.
 * @param kind - the attempt's activity type.
 * @param options - the split's proportions, its clamp, and whether to light up.
 * @returns one slice for a one-colour type, two for `mixed`.
 */
export declare function faceSegments(kind: ActivityKind, options?: FaceOptions): readonly FaceSegment[];
/** The corner radius the official trajectory spans use. */
export declare const SPAN_RADIUS = "1px";
/** Official span opacity: background lanes are dimmed, the lanes that matter are not. */
export declare const SPAN_OPACITY: {
    readonly dim: 0.78;
    readonly solid: 1;
};
/**
 * The fill of a type face, drawn the way the official timeline draws a span.
 *
 * Flat, one-pixel corners, no rim and no shadow — the whole appearance is the fill, exactly
 * as `dsh-client-ui-trajectory` paints `.span` (measured: `height: 8px; border-radius: 1px;
 * opacity: .78`, with `[data-timeline-span=message|tool|subtool]` overriding the opacity to
 * 1). Two stops are added only where the official view adds them too: a model span carries a
 * horizontal TTFT gradient, the first `ttft` share of its width in the lighter
 * decoding-adjacent colour.
 *
 * @param color - the tone at the weight this brick should wear.
 * @param options - the official extras: the TTFT share, and the lighter colour for it.
 * @returns the CSS the face needs.
 */
export declare function spanMaterial(color: string, options?: {
    readonly ttftShare?: number;
    readonly ttftColor?: string;
}): {
    readonly background: string;
    readonly radius: string;
};
/**
 * The lighter colour an official model span starts with, for the waiting part of the call.
 *
 * The official expression is the decoding colour mixed 54% with the layer behind it, so the
 * same shape is used here on whatever colour the brick is wearing.
 *
 * @param color - the model tone at this brick's weight.
 * @returns a lighter version of it.
 */
export declare function spanTtftColor(color: string): string;
/**
 * The full name of a brick's type, for a tooltip or a screen reader.
 * @param kind - the attempt's activity type.
 * @returns e.g. `reasoning and tool calls`.
 */
export declare function faceEnglish(kind: ActivityKind): string;
/**
 * The lane a brick is painted in, named as the official timeline names it.
 * @param kind - the attempt's activity type.
 * @returns e.g. `MODEL`.
 */
export declare function toneMark(kind: ActivityKind): string;
/**
 * The two characters that name a brick's type — for the places that have room.
 *
 * The board itself prints nothing on this face: at 36x15 a brick is read by its
 * colour (and by the seam between two colours), so a label on some bricks but not
 * on others would make the board look inconsistent while telling nobody anything
 * the colour had not. The label lives where there *is* room — the tooltip, the
 * accessible name, and the panel's chip.
 *
 * @param kind - the attempt's activity type.
 * @returns two characters; a `mixed` brick is named by both halves.
 */
export declare function faceLabel(kind: ActivityKind): string;
/**
 * The marker a non-clean ending wears, painted in the brick's corner.
 *
 * A glyph rather than a colour of its own: lifecycle is a different question from
 * content, so it must not be able to change what colour a brick is.
 */
export interface LifecycleMark {
    readonly glyph: string;
    readonly english: string;
}
/** One glyph per unclean ending. Clean attempts carry none. */
export declare const LIFECYCLE: Record<BrickAbnormal, LifecycleMark>;
/**
 * Which side of the board is showing.
 *
 * The board is a single 2D card turned over as a whole: `cache` is the reading the
 * plugin exists for, `type` is the same grid read as conversation types. Turning
 * the whole board (rather than one brick) is what makes the second face a *view*
 * of the session — "what has this task been made of" — instead of a per-brick
 * detail that a hovering pointer reveals one at a time.
 */
export type BoardFace = 'cache' | 'type';
/** The face a flip control would show next. */
export declare function toggledFace(face: BoardFace): BoardFace;
/**
 * Two characters for the flip control: the face one click would bring up.
 *
 * It names the destination rather than the current state, because that is what a
 * control is for; the board itself already shows which face is up.
 */
export declare const FLIP_LABEL: Record<BoardFace, string>;
/** The transform the whole board carries for a given face. */
export declare function flipTransform(face: BoardFace): string;
/** Every colour in the grammar, in one place. */
export declare const CHANNEL: {
    /** Top: internal process. */
    readonly reasoning: "#A78BFA";
    /** Bottom: reaching out to tools. */
    readonly tools: "#22D3EE";
    /** Right: ordinary visible output — deliberately quiet. */
    readonly output: "#CBD5E1";
    /** Left: information entering the model. */
    readonly inputChange: "#60A5FA";
    /** Every edge: a structural event that is not an ordinary answer. */
    readonly auxiliary: "#E879F9";
    /** Outer ring: a retry, or a stop caused by a limit — a warning, not a failure. */
    readonly retry: "#F59E0B";
    readonly limit: "#F59E0B";
    /** Outer ring: the attempt failed or was interrupted. */
    readonly failure: "#FB7185";
};
/** The edges one brick should draw. Anything absent stays transparent. */
export interface BrickEdges {
    readonly top?: string;
    readonly right?: string;
    readonly bottom?: string;
    readonly left?: string;
    /**
     * Outer ring: lifecycle. Kept off the four content edges precisely so a retry
     * cannot be mistaken for reasoning, and a failure cannot be mistaken for a tool.
     */
    readonly ring?: string;
}
/**
 * Turn a brick's channels into edges.
 *
 * A plain answer ends up with a single quiet right edge; a step that reasoned,
 * called a tool and then answered ends up with three. **Only rich behaviour makes a
 * rich brick** — nothing is coloured "just in case", which is what keeps a screen
 * full of healthy bricks readable.
 *
 * @param brick - the brick's channels and abnormal marker.
 * @returns the edge colours to draw.
 */
export declare function brickEdges(brick: Pick<Brick, 'content' | 'abnormal'>): BrickEdges;
/**
 * One landed (or falling) brick.
 *
 * A brick is a **real model request attempt**, not a step: DSH can dispatch more
 * than one request for the same `(turn, step)` when a retry follows a failure, and
 * collapsing them would hide exactly the case worth seeing ("the first request
 * blew the cache and failed, the retry came back clean"). `attempt` is the
 * ordinal within that step; `key` is the brick's identity on the board.
 */
export interface Brick {
    /** Stable identity: the attempt id from the collector, or `turn:step` as a fallback. */
    readonly key: string;
    readonly turn: number;
    readonly step: number;
    /** 0 for the first dispatch of this step, 1 for the first retry, ... */
    readonly attempt: number;
    readonly tone: CacheTone;
    /** Text printed on the brick: `99%`, `8.7%`, or `n/a` for a silent provider. */
    readonly label: string;
    /** What the step did in the conversation: the brick's back face. */
    readonly kind: ActivityKind;
    /**
     * True for a brick the client folded itself, with no host collector running.
     *
     * Such a brick is one per **step**, has no attempt identity, and cannot navigate — so it
     * must not be mistakable for a real request brick at a glance. It keeps its reading and its
     * tone (that percentage is measured, from the session events) and is drawn with a dashed
     * edge and a dimmed slab, with a notice on the board saying why.
     */
    readonly estimated?: true;
    /**
     * Where this brick came from — what the board is allowed to paint and to claim.
     *
     * - `live`: the collector watched the request. Full face, full record.
     * - `replay`: the session's own log was folded by the same observations (`../core/replay`),
     *   so the reading, the activity and the lifecycle are the log's own — the type face is
     *   real. What is missing is the request capture, not the brick.
     * - `fold`: the browser's reduced per-step fold, which measured usage and nothing else.
     *   Its activity face stays blank (`~`) because claiming a type here would be a guess.
     *
     * Absent means the brick predates the distinction; the board treats that as `live`, which is
     * what the only source of such bricks was.
     */
    readonly origin?: 'live' | 'replay' | 'fold';
    /**
     * For a `mixed` brick: how much of the face goes to reasoning rather than to tool
     * work. Absent on every other type, which is drawn as one colour.
     */
    readonly activityShare?: number;
    /**
     * How much of the attempt was spent waiting for the first token, in `0..1`.
     *
     * The official model span starts with this fraction of its width in a lighter colour
     * (`[data-timeline-span=message][data-assistant-timing=true]`), and the type face mirrors
     * it: the one piece of the official appearance that carries information rather than taste.
     */
    readonly ttftShare?: number;
    /**
     * The specific behind the type, for the back face's second line.
     *
     * The tone says which official lane the brick is in; this says what it was doing there —
     * the tool it called, the model it ran on, the purpose it served. Short on purpose: it is
     * read at six pixels, and the tooltip carries the full name.
     */
    readonly detail?: string;
    /**
     * Where this attempt belongs in the transcript.
     *
     * Deliberately separate from the brick's identity: a brick is one request **attempt**,
     * while the transcript publishes rows per **step**, so the mapping between them is
     * N:1 and belongs in one explicit place (see `./target`). The board reads it, and only
     * it decides whether the jump can be exact.
     */
    readonly target: BrickTarget;
    /** True when a retry was scheduled after this attempt failed. */
    readonly retried?: boolean;
    /** True when this attempt ended in an error. */
    readonly failed?: boolean;
    /** Which channels this attempt produced: drawn as the four edges. */
    readonly content?: BrickContent;
    /** A non-clean ending: drawn as the outer ring, never on a content edge. */
    readonly abnormal?: BrickAbnormal;
}
/**
 * Where to scroll so a Turn's row lands in view.
 *
 * Pure so the arithmetic can be tested: the target puts the row's top about a
 * quarter of the way down the scrollport — enough context above it to read what
 * led there — and never scrolls past either end.
 *
 * @param rowTop - the row's offset within the scroller's content, in pixels.
 * @param scrollHeight - total scrollable content height.
 * @param viewportHeight - visible height of the scrollport.
 * @returns the scrollTop to move to.
 */
export declare function revealTarget(rowTop: number, scrollHeight: number, viewportHeight: number): number;
/** Brick key for the fallback source: one brick per *step* — see `./bricks` for why that
 * is a degradation and not the model. Stable across repaints. */
export declare function brickKey(turn: number, step: number): string;
/** One Turn's column of bricks, in step order (oldest step first). */
export interface BoardColumn {
    readonly turn: number;
    readonly ended: boolean;
    readonly bricks: readonly Brick[];
}
/** Board geometry in device-independent CSS pixels. */
export interface BoardMetrics {
    /** Brick width, in CSS pixels. */
    readonly width: number;
    /** Brick height, in CSS pixels. */
    readonly height: number;
    /** Gap between bricks, in CSS pixels. */
    readonly gap: number;
    /** Columns the board can show. */
    readonly columns: number;
    /** Rows the board can show. */
    readonly rows: number;
}
/**
 * Brick size and spacing. The brick is a slab wide enough to print its own
 * reading (`99.2%` at 9px monospace): the number is what makes the pile up
 * readable at a glance, and the colour is what makes it scannable.
 */
export declare const BRICK_W = 36;
export declare const BRICK_H = 15;
export declare const GAP = 3;
/**
 * Safety bound on board rows. The board fills whatever height the visible band
 * offers (a 1080p window is ~40 rows); this only stops a pathological viewport
 * from reserving thousands of brick slots.
 */
export declare const MAX_ROWS = 60;
/** Fallback composer height when the shell has not published its variable yet. */
export declare const COMPOSER_FALLBACK = 152;
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
/** The columns the board shows, oldest first, with the overflow count. */
export interface VisibleColumns {
    readonly columns: readonly BoardColumn[];
    /** Columns pushed off the left edge by newer Turns. */
    readonly evicted: number;
    /**
     * Columns reserved to the right of the newest Turn: 1 once the newest Turn has
     * ended, so a finished task's stack slides one cell left immediately and the
     * next task drops into the freed column. 0 while a Turn is still running.
     */
    readonly lead: number;
}
/**
 * Keep the newest columns that fit; the newest is anchored at the right edge,
 * or one cell left of it while the newest Turn has ended.
 * @param columns - every known Turn column, oldest first.
 * @param capacity - columns the board can show.
 * @returns the visible window, how many columns fell off the left, and the lead.
 */
export declare function visibleColumns(columns: readonly BoardColumn[], capacity: number): VisibleColumns;
/**
 * How far the board is panned away from its live corner.
 *
 * The live corner is the newest Turn at the right edge with the floor (row 0) on
 * screen. Both offsets are **whole cells**, so a panned board still lands on the
 * same grid the bricks fell into, and both count *hidden* cells: `back` columns
 * to the right of the window, `up` rows below it.
 */
export interface BoardScroll {
    /** Columns hidden to the right of the window; 0 puts the newest Turn on the right edge. */
    readonly back: number;
    /** Rows hidden below the window; 0 puts the floor row on screen. */
    readonly up: number;
}
/** The live corner: nothing hidden on either axis. */
export declare const LIVE_SCROLL: BoardScroll;
/** A window over the board content: what is on screen, and how much is not. */
export interface BoardWindow {
    /** The Turn columns inside the window, oldest first. */
    readonly columns: readonly BoardColumn[];
    /**
     * Absolute index of the first column inside the window — an index into the **full**
     * column list, not into {@link columns}.
     *
     * This pair is what makes a paint cost the viewport instead of the session: a board
     * holding fifty thousand Turns walks the same three hundred cells it draws, because
     * the arithmetic that chose them is here, in one tested function, rather than in a
     * loop that re-derives `windowCell` for every brick in the session and throws most
     * of the answers away.
     */
    readonly columnStart: number;
    /** Absolute index one past the last column inside the window. */
    readonly columnEnd: number;
    /**
     * The first row inside the window, and one past the last, in each column's own row
     * numbering (`0` is the brick resting on the floor).
     *
     * A column shorter than `rowEnd` simply has nothing at those rows: the caller clamps
     * against `column.bricks.length`, so one range serves columns of every height.
     */
    readonly rowStart: number;
    readonly rowEnd: number;
    /**
     * Columns reserved to the right of the newest Turn: 1 once the newest Turn has
     * ended, so the next task drops into the freed column. Part of the content, so it
     * pans with it.
     */
    readonly lead: number;
    /** The auxiliary lane's row inside the window, or undefined when the lane is not shown. */
    readonly lane: number | undefined;
    /** Rows a Turn column may fill inside the window (the lane takes one when shown). */
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
/** The lead cell: one free column once the newest Turn has ended. */
export declare function leadOf(columns: readonly BoardColumn[]): number;
/** The tallest column, in bricks. */
export declare function tallestColumn(columns: readonly BoardColumn[]): number;
/**
 * The columns inside a window panned `back` cells to the left of the live edge.
 *
 * The lead cell is part of the content and pans with it: at `back === 0` the newest
 * Turn sits on the right edge (or one cell in from it while the lead is reserved),
 * and every column keeps the cell placement 1.7.1 gave it, shifted left by exactly
 * `back` cells.
 *
 * The window is **computed, not scanned**. Everything the loop below used to decide is a
 * comparison against one cell coordinate, so the visible columns are one subtraction away
 * and the two counts follow from the same number. That is what lets a session of fifty
 * thousand Turns cost the same as a session of fifty: the cost of the window is the size of
 * the window.
 *
 * @param columns - every known Turn column, oldest first.
 * @param capacity - columns the window can hold.
 * @param back - columns hidden to the right of the window.
 * @returns the columns inside the window, the lead, how many are hidden on each side, and
 *   the window's own half-open index range into `columns`.
 */
export declare function windowColumns(columns: readonly BoardColumn[], capacity: number, back: number): {
    columns: readonly BoardColumn[];
    lead: number;
    older: number;
    newer: number;
    columnStart: number;
    columnEnd: number;
};
/**
 * The pan that shows the oldest column and the top brick — in other words, the
 * largest pan the content allows on each axis.
 *
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
/**
 * The live anchor: the newest Turn at the right, and the **running Turn's own top
 * brick** in frame.
 *
 * The second half is the one deliberate difference from 1.7.1. A Turn taller than the
 * board used to lose its newest bricks off the top; while the board is following, the
 * window now rises just far enough to keep the brick that just landed visible, which
 * leaves the floor off screen only in the case where the running Turn does not fit at
 * all. Every normal session — every Turn shorter than the board — still evaluates to
 * `up: 0`, so the board reads exactly as it did.
 *
 * @param columns - every known Turn column, oldest first.
 * @param limit - rows a column may fill inside the window.
 * @returns the pan that follows the live edge.
 */
export declare function liveScroll(columns: readonly BoardColumn[], limit: number): BoardScroll;
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
 * Everything the view needs to paint one board at one pan.
 *
 * The single place where "what is on screen" is decided: which columns, which rows,
 * how far the pan could still go, and how much is hidden on each side. Pure, so the
 * viewport arithmetic is unit-tested without a DOM.
 *
 * @param columns - every known Turn column, oldest first.
 * @param metrics - the window's brick geometry.
 * @param scroll - the requested pan, or undefined to follow the live edge.
 * @param laneShown - whether the auxiliary lane takes the window's top row.
 * @param tallest - the tallest column, when the caller has already measured it (the view
 *   caches it per content array, so a repaint does not rescan the session).
 * @returns the window, the pan actually applied, and both ends of the rail.
 */
export declare function boardWindow(columns: readonly BoardColumn[], metrics: BoardMetrics, scroll: BoardScroll | undefined, laneShown: boolean, tallest?: number): BoardWindow;
/**
 * The newest Turn on the board, or undefined on an empty one.
 * @param columns - every known Turn column, oldest first.
 * @returns the newest Turn's number.
 */
export declare function newestTurnOf(columns: readonly BoardColumn[]): number | undefined;
/**
 * How many columns are newer than `turn` — a binary search, because history has no length limit.
 * @param columns - every known Turn column, oldest first.
 * @param turn - the Turn to count from.
 * @returns columns whose Turn is greater than `turn`.
 */
export declare function countNewerThan(columns: readonly BoardColumn[], turn: number): number;
/**
 * The pan a board keeps when its content changed underneath it.
 *
 * A reader who has panned back must not be slid further back by the session moving: when new
 * Turns **append** at the live end, the window holds the same columns by adding the appended
 * count to `back`. The count is of columns *newer* than the newest one seen before, never of
 * columns added — because history also grows at the **older** end, one page at a time
 * (`loadOlder`), and a prepend must leave the pan exactly where it was. Counting the delta of
 * `columns.length` cannot tell the two apart, and adding it turned every landed page into a
 * jump into the past.
 *
 * @param scroll - the pan in force, or undefined while the board follows the live end.
 * @param columns - the content as it is now.
 * @param previousNewestTurn - the newest Turn at the previous paint.
 * @returns the pan to paint with.
 */
export declare function heldScroll(scroll: BoardScroll | undefined, columns: readonly BoardColumn[], previousNewestTurn: number | undefined): BoardScroll | undefined;
/**
 * Shortest a rail's thumb may get, in CSS pixels.
 *
 * A hundred Turns of history against ten visible columns would otherwise leave a
 * two-pixel thumb: unreadable as a position and impossible to grab. The thumb is
 * therefore a **lower bound on the grab handle**, never a claim about the ratio.
 */
export declare const RAIL_MIN_THUMB = 16;
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
 * Where a scrollbar's thumb sits, for a track that starts at the content's **end**.
 *
 * Both rails are anchored the same way: pan 0 (the live corner) puts the thumb at the
 * track's far end — right for the horizontal rail, bottom for the vertical one — which
 * is where a reader expects "the newest brick" to be. The thumb never grows past the
 * track and never shrinks below `minimum`, so a board with a hundred columns of history
 * still offers something to grab.
 *
 * @param track - the track's length in CSS pixels.
 * @param viewport - cells the window shows on this axis.
 * @param content - cells the content needs on this axis.
 * @param offset - the pan applied, in cells, 0 = live.
 * @param minimum - shortest a thumb may get, in CSS pixels.
 * @returns the thumb's length, its offset from the track's start, and whether it can move.
 */
export declare function railGeometry(track: number, viewport: number, content: number, offset: number, minimum?: number): RailGeometry;
/** Cell placement of one brick: `column` counts from the newest (0 = right edge). */
export interface CellPlacement {
    /** Distance from the board's right edge, in CSS pixels. */
    readonly right: number;
    /** Distance from the board's floor, in CSS pixels. */
    readonly bottom: number;
}
/**
 * Where one brick rests.
 * @param metrics - board geometry.
 * @param columnFromNewest - 0 for the newest Turn (plus the visible lead when it
 *   has already ended), 1 for the one before it, ...
 * @param row - 0 for the brick resting on the floor.
 * @returns offsets from the board's bottom-right corner.
 */
export declare function cellPlacement(metrics: BoardMetrics, columnFromNewest: number, row: number): CellPlacement;
/** Highest row a column can fill before its bricks leave the board. */
export declare function rowLimit(metrics: BoardMetrics): number;
/**
 * The row the auxiliary lane occupies, when it is shown.
 *
 * Auxiliary calls (compaction, session title) are real model requests, so they get real
 * bricks — but they belong to no Turn, and putting them in a Turn's column would invent a
 * relationship. They get the board's top row instead, right-aligned like everything else.
 *
 * @param metrics - board geometry.
 * @param shown - whether any auxiliary brick exists to show.
 * @returns the row index, or undefined when the lane is not shown.
 */
export declare function auxLaneRow(metrics: BoardMetrics, shown: boolean): number | undefined;
/**
 * Rows the Turn columns may use, once the lane has taken one if it is shown.
 * @param metrics - board geometry.
 * @param shown - whether the auxiliary lane is shown.
 * @returns the column row limit.
 */
export declare function columnRowLimit(metrics: BoardMetrics, shown: boolean): number;
/**
 * Brick fill per tone.
 *
 * The board is a heat map, so a healthy pile has to stay quiet: `good` is a
 * low-alpha wash, and only the tones that ask for attention carry a solid fill.
 * A wall of saturated green would bury the one red brick the board exists for.
 */
export declare const TONE_BRICK: Record<CacheTone, string>;
/** Text colour per tone: quiet green digits, dark on amber, white on red. */
export declare const TONE_TEXT: Record<CacheTone, string>;
/** Brick outline: barely-there for healthy bricks, firm once a tone alarms. */
export declare const TONE_EDGE: Record<CacheTone, string>;
/** Digit weight: only the alarming bricks are set bold. */
export declare const TONE_WEIGHT: Record<CacheTone, string>;
/**
 * Tooltip for one brick: where it came from, then the reading.
 *
 * The type is named in full here (`思考 reasoning, no tool call`) because the board
 * prints no label on that face — this is where a brick has room to say what its
 * colour means — and the lifecycle marker is spelled out for the same reason.
 */
export declare function brickTitle(brick: Brick, detail: string | undefined): string;
/**
 * The accessible name of one brick.
 *
 * It says what the brick is (identity, type, reading) and what activating it
 * does, in that order: the visible face shows only the cache percentage, so a
 * screen reader has to be told the rest.
 */
export declare function brickAriaLabel(brick: Brick, detail: string | undefined): string;
