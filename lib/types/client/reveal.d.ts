/**
 * Taking the reader from a brick to the request it stands for.
 *
 * **Landing is exact or it is nothing.** The Chat view publishes a node key per rendered
 * item (`[data-chat-node-key]`, `${anchorSeq}:${kind}${id}`), and every anchor this module
 * accepts on its own is a row that *is* the attempt: an `assistant-step` node whose id is
 * `${turn}:${step}`, a `tool-call` node keyed by a call the attempt made, the
 * `model-retry` node keyed by the chain the attempt belongs to, or the `compaction` node
 * keyed by the id its durable event carried. What it will not do is stop at a nearby row and
 * call that a landing: that is how this feature spent several rounds looking fixed while it
 * was not, and the fix is a type: {@link RevealOutcome.accuracy}.
 *
 * Getting the reader *to* that row is now one call, and it is not this module's to make:
 *
 * - in a long session the row is usually not mounted, because the chat view keeps a window
 *   of history and pages the rest in on demand;
 * - a collapsed process group holds its rows at zero height
 *   (`button[data-turn-process]`, and `hidden="until-found"` for browser find);
 * - the history that has to exist first is fetched by **`ISession.loadThrough(seq)`**, the
 *   official turn-jump loader, through the single entry point in `navigation.ts`. This module
 *   used to page history in by clicking the Turn navigator and the "load older" control up to
 *   eight times and hoping; those clicks are gone, and with them the ability to stop at a row
 *   that merely happened to be nearby.
 *
 * So this module owns exactly two things: **opening** what the view is holding closed, and
 * **judging** whether what it found is the brick's own row. The DOM surface is declared
 * structurally and every wait is injectable, so the whole strategy is testable without a
 * browser.
 */
import type { LoadReport, LoadRequest, LoadStatus } from './navigation';
import type { BrickTarget, HistoricalStepTarget, RevealAccuracy, RevealRow } from './target';
/** The parts of an element this module uses. */
export interface RevealElement {
    getBoundingClientRect(): RevealRect;
    getAttribute?(name: string): string | null;
    click?(): void;
    /** Fire an event at the element; used for the Chat view's `beforematch` reveal. */
    dispatchEvent?(event: Event): boolean;
    readonly parentElement?: RevealElement | null;
    /**
     * Present when this element scrolls its own content.
     *
     * A long Turn's process group is one: DSH caps it (`max-height`) and lets it scroll inside, so a
     * row can be in the DOM, laid out, and still invisible — clipped by the group rather than by the
     * conversation. The reveal has to move that port too, or it "reaches" a row nobody can see.
     */
    readonly scrollHeight?: number;
    readonly clientHeight?: number;
    /** Writable: the reveal moves nested ports, not only the conversation. */
    scrollTop?: number;
    scrollTo?(options: {
        top: number;
        behavior?: 'smooth' | 'auto';
    }): void;
    readonly isConnected?: boolean;
    readonly disabled?: boolean;
    readonly textContent?: string | null;
    readonly classList?: {
        readonly length?: number;
    };
}
/** The parts of an element rect this module uses. */
export interface RevealRect {
    readonly top: number;
    /**
     * Laid-out height. A node inside a collapsed process group is in the DOM with
     * zero height, which is how "rendered but not shown" is recognised.
     */
    readonly height?: number;
}
/** The parts of the scroll container this module uses. */
export interface RevealScroller {
    querySelector(selector: string): RevealElement | null;
    querySelectorAll(selector: string): ArrayLike<RevealElement>;
    getBoundingClientRect(): {
        readonly top: number;
    };
    scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
    scrollTo(options: {
        top: number;
        behavior?: 'smooth' | 'auto';
    }): void;
}
/** The result of one attempt to reach a brick's row. */
export interface RevealOutcome {
    /**
     * How well the row that was reached stands for the brick.
     *
     * The distinction exists because the alternative — a boolean `revealed` — let a
     * landing on some *nearby* row report success, and a user who clicked a brick and saw
     * a different row flash had been told a lie by the code that was supposed to check it.
     */
    readonly accuracy: RevealAccuracy;
    /** Which kind of row was reached. */
    readonly row: RevealRow;
    /** What the official loader did on the way, repeated verbatim by the panel. */
    readonly load: LoadReport;
    /** True when a collapsed process group (or a `hidden="until-found"` row) had to be opened. */
    readonly expanded: boolean;
    /**
     * True when the row reached is the **same step's other half**.
     *
     * One `assistant-step` is published as up to two rows sharing the node key, told apart by
     * `data-chat-group-part`. When the half the attempt began in has no rendered row — a core
     * that does not draw reasoning, a preference that hides it — the step's other half is still
     * the step, and scrolling nowhere would be a worse answer than scrolling to the step. It is
     * reported rather than rounded up: `accuracy` becomes `context`, so nothing washes a row
     * that is not the brick's own, and the notice says which half was missing.
     */
    readonly fellBack?: true;
    /**
     * True when the declared row was reached and is **not visible**: something between it and the
     * conversation — in practice a capped process group whose own port would not bring it into view —
     * is clipping it. The identity matched; the reader still cannot see it, so it is not reported as
     * a successful landing and it is never highlighted.
     */
    readonly hidden?: true;
    /** The row that was reached, when one was. */
    readonly element?: RevealElement;
}
export interface RevealOptions {
    /** Sleep; injected so tests need no timers. */
    readonly wait?: (ms: number) => Promise<void>;
    /** How long to keep checking for the row once the history it needs is loaded. */
    readonly settleMs?: number;
    /** A newer click/session switch cancels this navigation before it can move the page. */
    readonly isCurrent?: () => boolean;
    /**
     * The unified loader (`ensureBrickTargetLoaded` bound to this session).
     *
     * Absent means this core has no reachable session face: the jump then reports what it
     * found in the DOM as it is, and never pretends the row was loaded.
     */
    readonly load?: (request: LoadRequest) => Promise<LoadReport>;
    /**
     * What a folded step became, asked **after** its history is loaded.
     *
     * A `historical-step` target names a step, not a row: which row that step produced (a
     * message half, a tool call, a retry chain) is written in the durable log, not in the DOM.
     * Injected here — rather than imported — so this module keeps answering exactly one
     * question ("is that element on screen?") and the log reading stays in `./navigation`.
     *
     * Returning `undefined` is a real answer: nothing in the transcript stands for that step,
     * and the reveal then lands on the Turn and reports `context`.
     */
    readonly resolve?: (target: HistoricalStepTarget) => BrickTarget | undefined;
}
/** Selector for one Turn's row. */
export declare function rowSelector(turn: number): string;
/**
 * The anchor `seq` a node key starts with, when it has one.
 *
 * Only the prefix is parsed, on purpose. A key is `[seq:]kind + id` with **no
 * separator** between the kind and its id, and node kinds are an extensible
 * registry: `tool-call` + `call_00_x` is published as `tool-callcall_00_x`, which no
 * parser can tell apart from a kind literally named `tool-callcall`. Splitting a key
 * on a known kind would therefore be a guess. Asking whether a key **ends with**
 * `assistant-step4:1` is not a guess — the answer is exact, and it is the only
 * question this module actually has.
 *
 * @param key - the value of `[data-chat-node-key]`.
 * @returns the seq, or undefined when the view published a key without one.
 */
export declare function nodeSeqOf(key: string): number | undefined;
/**
 * Every assistant-step node for one `(turn, step)`, reasoning half first.
 *
 * A step can open more than one flow slot (its reasoning and its answer are separate
 * rows sharing the key), so this returns all of them. Matching is by whole suffix, so
 * step 1 can never answer for step 11 or turn 4 for turn 14.
 *
 * @param root - the scroll container.
 * @param turn - the Turn the step belongs to.
 * @param step - the step number.
 * @returns the matching elements, reasoning first, laid out or not.
 */
export declare function findStepNodes(root: RevealScroller, turn: number, step: number): RevealElement[];
/**
 * The disclosure control for one Turn's process group.
 *
 * While a Turn's process is collapsed its steps are in the DOM with zero height, so
 * this button is what stands between a brick and the row it points at. It is the *view's own*
 * control, clicked through — not a substitute for loading, which is the loader's job.
 *
 * @param root - the scroll container.
 * @param turn - the Turn whose disclosure to find.
 * @returns the button, or undefined when that Turn has no process group on screen.
 */
export declare function findProcessToggle(root: RevealScroller, turn: number): RevealElement | undefined;
/**
 * The capped process group a row sits inside, when it has one.
 *
 * DSH gives a long Turn's process group its own scrollport — `[data-step-process-body]`, capped by
 * `max-height` — so scrolling the *conversation* moves the group onto the screen and leaves the row
 * exactly where it was inside the group. That is how a jump came to report `exact` while the reader
 * saw nothing: the row was reached, highlighted, and clipped.
 *
 * The anchor is the official attribute. A rename degrades to the structural fallback — the
 * innermost scrollable ancestor that is not the conversation itself — so the chain keeps working
 * without depending on a name that may move.
 *
 * @param row - the row that was found.
 * @param root - the conversation's own scrollport.
 * @returns the port to scroll first, or undefined when the row is not inside one.
 */
export declare function processScrollport(row: RevealElement, root: RevealScroller): RevealElement | undefined;
/**
 * Whether a reader can actually see this row: inside the conversation's viewport **and** inside
 * every scrollport between the two.
 *
 * `exact` used to mean "the declared row was found in the DOM", which is not the same claim. On a
 * capped process group the two came apart, so the verdict is now checked against the boxes the
 * reader actually has.
 *
 * @param row - the row that was reached.
 * @param root - the conversation's own scrollport.
 * @returns true when nothing between the row and the conversation clips it.
 */
export declare function rowVisible(row: RevealElement, root: RevealScroller): boolean;
/**
 * Every tool-call node for one call id.
 *
 * A step that only called tools produces no assistant message, so the chat view
 * renders no step row for it — but it does publish one row per tool call, keyed
 * `[seq:]tool-call + callId`, and the brick carries the call ids it made. Matching
 * the whole suffix is exact for the same reason the step match is.
 *
 * @param root - the scroll container.
 * @param callId - the tool call id, as the durable `tool/call` event carried it.
 * @returns the matching elements, laid out or not.
 */
export declare function findCallNodes(root: RevealScroller, callId: string): RevealElement[];
/**
 * The retry row for one retry chain.
 *
 * The official `model-retry` Definition is keyed by the `retryId` the durable
 * `llm/retry` event carried (`client.js:9315-9330`), which is the same id the
 * collector records on the attempt that failed and stamps on the one that followed.
 *
 * @param root - the scroll container.
 * @param retryId - the retry chain id.
 * @returns the matching elements, laid out or not.
 */
export declare function findRetryNodes(root: RevealScroller, retryId: string): RevealElement[];
/**
 * The transcript's compaction row for one compaction id.
 *
 * Matched by the id the row ends with, exactly as the retry chain and the tool calls are:
 * the node key is `${anchorSeq}:${kind}${id}`, and the anchor seq is the compaction's own
 * checkpoint — which is why the id, not a seq, is what a brick can carry.
 *
 * @param root - the scroll container.
 * @param compactionId - the id the durable `compaction/start` event carried.
 * @returns the matching elements, laid out or not.
 */
export declare function findCompactionNodes(root: RevealScroller, compactionId: string): RevealElement[];
/**
 * Ask the Chat view to reveal a node it is holding collapsed.
 *
 * Compact mode keeps process rows in the DOM as `hidden="until-found"`, and the view
 * registers the official `beforematch` listener on exactly those elements
 * (`client.js:1594-1602`). Dispatching that event is therefore the supported way to
 * open one: stripping the attribute would fight React's own state, which is what the
 * view's listener exists to avoid.
 *
 * @param elements - the candidate rows, laid out or not.
 * @returns true when a hidden element was asked to reveal itself.
 */
export declare function revealUntilFound(elements: readonly RevealElement[], visited?: Set<RevealElement>): boolean;
/**
 * Every laid-out step row of one Turn, in step order.
 *
 * A step number is read off the end of the node key, which is exact for the same
 * reason the suffix match is — and it is only ever read from keys already known to
 * carry this Turn's step prefix.
 *
 * @param root - the scroll container.
 * @param turn - the Turn whose steps to collect.
 * @returns the steps on screen, each with the row that shows it.
 */
export declare function stepsInTurn(root: RevealScroller, turn: number): {
    step: number;
    element: RevealElement;
}[];
/**
 * What a brick's location question actually answered — the four outcomes, as a type.
 *
 * The panel renders these as three rows ("transcript loaded", "chat projection", "reason") and
 * the live checks assert on them, because the difference between them is the difference
 * between "this plugin is broken" and "the host did not draw the page it was given":
 *
 * - `exact` — the brick's own row is on screen;
 * - `step-other-half` — the step is on screen, but the half the attempt began in has no
 *   rendered row, so the step's other half was reached and reported as such (never `exact`,
 *   never highlighted);
 * - `loaded-awaiting-render` — the history is covered and the exact row is still unavailable.
 *   The cause is **not** established here: a late React commit, a subtree the view keeps
 *   hidden, a stale target and a host that drew none of the page all look the same from the
 *   DOM. (On an unpatched 0.1.7 core the last of those is real and reproduced — the
 *   `system-message` Definition withdrawing a materialized node and taking the whole flush
 *   with it; `host-patches/system-message-never-withdraw/`. That is a reason to check the
 *   host, not a conclusion this plugin can draw from a missing row.)
 * - `host-projection-blocked` — retained in the type for compatibility; no longer emitted,
 *   because "the loader confirmed coverage and no row appeared" is not proof of a host
 *   failure;
 * - `target-unavailable` — nothing in the transcript can stand for this brick, or the history
 *   could not be asked for at all. The reason says which.
 */
export type BrickLocateResult = {
    readonly status: 'exact';
    readonly row: RevealRow;
    readonly element: RevealElement;
}
/**
 * The declared row was found, and the reader cannot see it.
 *
 * Kept apart from `exact` on purpose: reporting a landing the reader cannot see is the one lie
 * this whole module exists to prevent, and it is what a capped process group produced.
 */
 | {
    readonly status: 'exact-not-visible';
    readonly row: RevealRow;
    readonly element: RevealElement;
} | {
    readonly status: 'step-other-half';
    readonly row: RevealRow;
    readonly element: RevealElement;
} | {
    readonly status: 'host-projection-blocked';
    readonly seq: number;
} | {
    readonly status: 'loaded-awaiting-render';
} | {
    readonly status: 'target-unavailable';
    readonly reason: LoadStatus;
};
/**
 * Classify one reveal outcome. Pure, so the meaning of a jump is testable on its own.
 *
 * @param outcome - what the reveal reached and what the loader did.
 * @returns the locate status the panel and the console report.
 */
export declare function locateResultOf(outcome: RevealOutcome): BrickLocateResult;
/**
 * Take the reader to the request a brick stands for.
 *
 * @param root - the scroll container.
 * @param target - where the brick belongs.
 * @param options - injected timing and the unified loader.
 * @returns what was reached, how well it stands for the brick, and what the load did.
 */
export declare function revealBrick(root: RevealScroller, target: BrickTarget, options?: RevealOptions): Promise<RevealOutcome>;
