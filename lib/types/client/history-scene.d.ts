/**
 * History as a scene, not as a backlog.
 *
 * 0.1.3 read the whole loaded window and replayed all of it. That worked while a window was
 * one session's tail, and stopped working the moment the window learned to grow: paging older
 * history in made the replay longer, and the ledger's fixed brick budget then dropped the
 * oldest bricks it had just built — which is why a brick far from the live edge came back with
 * its cache reading intact and its **type** degraded to `output` (the client fold's honest
 * "I cannot see the reasoning and tool channels" default).
 *
 * The fix is not a bigger budget. It is not replaying what nobody is looking at:
 *
 * - the **board** knows which Turns and which rows are on screen, and it says so
 *   ({@link SceneDemand});
 * - the **index** knows where each step's events begin and end in the window, because a step
 *   is bracketed by `step/start` and `step/end` and everything an attempt owns — its settled
 *   stream, its tool calls, its retries — sits between them;
 * - the **replay** therefore receives a window-local slice: the demanded steps, the request
 *   header and context that were in force, and the `turn/end` marks of the Turns involved.
 *   A slice that holds one screen of attempts cannot hit a 400-brick budget at all, so the
 *   budget stops deciding what a reader sees.
 *
 * The cost of a scene is the size of the scene. Fifty thousand Turns of history cost the same
 * as fifty, because nothing here walks the session: the index is scanned once per **window
 * change** (a page landing, a turn settling), and a scene is a range query over it.
 *
 * This is the data half of the same idea the board already implemented for pixels: the view
 * creates DOM only for visible cells, and now it also materializes records only for them.
 */
import type { BrickFeed } from '../shared/brick';
import { BlobStore } from '../core/blob-store';
import type { BoardColumn, BoardMetrics, BoardWindow } from './tetris';
import type { DurableEvent } from './navigation';
/** One Turn's slice of the screen: the steps its visible rows hold. */
export interface SceneTurn {
    readonly turn: number;
    /** First step the scene wants, inclusive. */
    readonly fromStep: number;
    /** Last step the scene wants, inclusive. */
    readonly toStep: number;
}
/**
 * What the board is looking at.
 *
 * Steps, not rows: a row is a rendering decision that changes when a retry adds a brick,
 * while a step is the identity the log is keyed by. Sending steps keeps the request stable
 * across exactly the changes that would otherwise make it flicker.
 */
export interface SceneDemand {
    readonly turns: readonly SceneTurn[];
}
/**
 * Step granularity of a scene request.
 *
 * A demand that moved with every row of scroll would replay a new slice for every wheel
 * notch — and, worse, a scene that adds a retry brick shifts which step sits at which row,
 * so an exact demand could ask for a slightly different slice each time it was answered.
 * Snapping both ends outward to a multiple of this makes the request a **page**: stable
 * while the reader moves inside it, and cheap to memoise.
 */
export declare const SCENE_STEP_QUANTUM = 8;
/** Snap a demand outward to the scene quantum, so small scrolls ask the same question. */
export declare function quantizeDemand(demand: SceneDemand): SceneDemand;
/** A demand's identity, for memoising the scene it produced. */
export declare function sceneKeyOf(demand: SceneDemand): string;
/** Where one step's events live in the window. */
export interface StepSpan {
    readonly turn: number;
    readonly step: number;
    /** The `step/start` seq — the earliest event that belongs to this step. */
    readonly startSeq: number;
    /**
     * The `step/end` seq, or the last event of the window while the step is still running.
     *
     * A running step is left open on purpose: the live collector owns that attempt, and a
     * replay of a step that has not settled would be a second, poorer copy of it.
     */
    readonly endSeq: number;
}
/**
 * The window's step geography: where every step is, and which events a slice must carry.
 *
 * Built by one scan of the window (see {@link indexEvents}), then queried by range. Two
 * supporting facts are kept because a slice cannot be read correctly without them:
 *
 * - **the header and context in force.** `request/header` and `request/context` are sticky in
 *   the ledger — one header governs every attempt after it — and the log writes them once per
 *   request series rather than once per step (a real 300-event window held exactly one of
 *   each). A slice that starts mid-session must therefore carry the last one written **before**
 *   it, or its bricks would lose the route, the tool declarations and the system hash that
 *   make them comparable with live ones;
 * - **`turn/end`.** A Turn's finished-ness is not a property of its bricks, and the board uses
 *   it to release the lead cell. The mark can sit thousands of events after the steps a slice
 *   asks for, so it is carried by identity rather than by proximity.
 */
export interface SceneIndex {
    /** Identity of the window this index describes. */
    readonly key: string;
    readonly events: readonly DurableEvent[];
    readonly oldestSeq: number;
    readonly newestSeq: number;
    /** Steps the scan actually bounded (a step with neither start nor end marker is not one). */
    readonly spanCount: number;
    /** The step's span, or undefined when the window does not hold that step. */
    readonly spanAt: (turn: number, step: number) => StepSpan | undefined;
    /** `turn/end` seq by Turn. */
    readonly turnEnds: ReadonlyMap<number, number>;
    /** Seqs of the `request/header` events, ascending. */
    readonly headerSeqs: readonly number[];
    /** Seqs of the `request/context` events, ascending. */
    readonly contextSeqs: readonly number[];
}
/** Identity of a durable window: what it holds, not how it was read. */
export declare function windowKeyOf(events: readonly DurableEvent[]): string;
/**
 * The mutable side of a scene index: one pass over events, and the state a second pass can extend.
 *
 * A window that only *grew* at one end does not need a new scan of everything it holds — the log is
 * append-only, and an event that was already in the window says the same thing it said before. The
 * builder is what makes that true: `indexEvents` is one `feed` followed by `freeze`, and a page
 * landing is `prepend`/`feed` of the new events followed by `freeze` again. Without it,
 * `loadOlder()` re-read the whole window to learn about one page of it.
 */
declare class SceneIndexBuilder {
    private readonly spans;
    private readonly open;
    private readonly turnEnds;
    private headerSeqs;
    private contextSeqs;
    private oldest;
    private newest;
    /** First and last seq this builder has been fed, ascending by construction. */
    get bounds(): {
        oldest: number;
        newest: number;
    };
    /**
     * Take events in ascending seq order, on top of whatever this builder already holds.
     *
     * A step's span is opened with its own start as a placeholder end: a step that is still running
     * when the window ends is closed at the window's last seq by {@link freeze}, which is the same
     * rule the one-shot scan used.
     */
    feed(events: readonly DurableEvent[]): void;
    /**
     * Take events older than everything fed so far.
     *
     * The two carried-seq lists are kept ascending by sorting after the fact: they hold one entry per
     * request series, so this is a handful of numbers, while the alternative — rebuilding the index —
     * is the whole window again.
     */
    prepend(events: readonly DurableEvent[]): void;
    /** Freeze what has been fed into an index, closing the steps the window ends inside. */
    freeze(events: readonly DurableEvent[], key: string): SceneIndex;
}
/** A builder, for a caller that keeps an index across window changes (see `HistoryScene`). */
export declare function sceneIndexBuilder(): SceneIndexBuilder;
/**
 * Scan a window once and remember where each step is.
 *
 * A step is a bracket — `step/start` opens it, `step/end` closes it — and the log writes both
 * with the step's own `turn`/`step`, so the geography is read rather than inferred. An open
 * bracket is closed at the end of the window, which is what a running step needs.
 *
 * @param events - the durable window, in seq order.
 * @param key - the window's identity, when the caller has already read one from the raw snapshot
 *   (see `windowKeyOfSnapshot`); it is stored with the index, so the next caller can be answered
 *   without materializing the window at all.
 * @returns the index, with its own identity included.
 */
export declare function indexEvents(events: readonly DurableEvent[], key?: string): SceneIndex;
/** What one {@link sceneSlice} handed to the replay. */
export interface SceneSlice {
    readonly events: readonly DurableEvent[];
    /**
     * The header and context events carried into the slice, in that order, when the window holds
     * them: the sticky facts a bracket cannot carry (see {@link sceneSlice}).
     */
    readonly carried: readonly number[];
    /** The first seq the demand asked for, before the carried events: what "in force" is relative to. */
    readonly firstSeq: number;
    /** Steps the slice actually covers (the demand may name steps the window never held). */
    readonly spans: number;
    /** Settlement events in the slice — one per attempt — used to size the ledger budget. */
    readonly attempts: number;
}
/**
 * The scene a window on screen is asking for.
 *
 * The board knows its viewport exactly — which columns, which rows — and the data layer needs
 * steps. This is the translation, kept pure and out of the DOM so the rule "the scene is the
 * screen plus overscan, snapped to a page" is testable without a browser:
 *
 * - **one screen of overscan on each axis**, so a pan inside a scene never waits for a replay
 *   and the neighbouring scene is warm before it is needed;
 * - **a column shorter than the overhead asks for its top brick**, so scrolling up to a short
 *   column does not find it untyped;
 * - **Turn 0 is left out**: those are auxiliary calls, which belong to no column of history and
 *   are never cut from the log.
 */
export interface ScenePlan {
    readonly demand: SceneDemand;
    /** Identity of the plan: equal keys mean the same scene, so nothing needs re-cutting. */
    readonly key: string;
    /** Columns hidden to the left of the window, for the caller's prefetch decision. */
    readonly older: number;
}
/**
 * Plan the scene a window is showing.
 *
 * @param columns - every known Turn column, oldest first.
 * @param window - the window on screen, with its own index range.
 * @param metrics - board geometry, for the overscan on each axis.
 * @returns the demand, its key, and how much history is hidden to the left.
 */
export declare function scenePlanOf(columns: readonly BoardColumn[], window: BoardWindow, metrics: BoardMetrics): ScenePlan;
/**
 * Whether the reader is close enough to the start of the loaded history to ask for more.
 *
 * One screen, never fewer than two columns: at a screen the page has arrived by the time they
 * get there, and at two columns they are about to reach a wall they can already see. The
 * question is asked of `older` rather than of the pan, because a board showing *everything* it
 * holds is at the left edge whether or not it can pan.
 *
 * @param window - the window on screen.
 * @param metrics - board geometry.
 * @returns true when older history should be asked for.
 */
export declare function prefetchDue(window: BoardWindow, metrics: BoardMetrics): boolean;
/**
 * Cut the events one scene needs out of the window.
 *
 * Everything a replayed attempt is made of lives inside its step's bracket, so the slice is a
 * range query per demanded step plus three things the brackets do not contain: the header and
 * context in force at the slice's start, the demanded Turns' `turn/end` marks, and nothing
 * else. Events between the brackets (a delivery receipt, a title, an inbox splice) are left
 * out: the replay reads a closed alphabet, so carrying them would only cost time.
 *
 * @param index - the window's step geography.
 * @param demand - the Turns and steps on screen, overscan included.
 * @returns the slice, with what it covers and how many attempts it holds.
 */
export declare function sceneSlice(index: SceneIndex, demand: SceneDemand): SceneSlice;
/**
 * Identity of one step's exact replay.
 *
 * A finished step never changes: its `step/start` and `step/end` say which seqs it owns, and the
 * header and context in force when the scene was cut say what those events mean. Anything that
 * could change the replayed brick is in the key — so a page landing at the *older* end, a newer
 * Turn arriving, or the window being re-read entirely cannot invalidate it, and re-visiting the
 * same screen is a map lookup rather than a replay.
 *
 * @param turn - the Turn.
 * @param step - the step.
 * @param startSeq - where the step's bracket opens.
 * @param endSeq - where it closes (or the window's end, for a running step).
 * @param carried - the header and context seqs the slice carried, in that order.
 * @returns the cache key.
 */
export declare function stepVersionKey(turn: number, step: number, startSeq: number, endSeq: number, carried: readonly number[]): string;
/** Options for {@link HistoryScene}. */
export interface HistorySceneOptions {
    readonly sessionId: string;
    /** Scenes kept warm. Three is one screen back, one live, one prefetch ahead. */
    readonly maxScenes?: number;
    /** How many steps' exact replays to keep (see {@link HistoryScene.maxSteps}). */
    readonly maxSteps?: number;
    /** Raw-payload budget shared by every scene this object replays. */
    readonly maxTotalBytes?: number;
}
/** What one scene produced, so the caller can tell a new answer from a memoised one. */
export interface SceneRead {
    readonly key: string;
    readonly feed: BrickFeed;
    readonly spans: number;
    readonly attempts: number;
    readonly cached: boolean;
}
export declare class HistoryScene {
    readonly sessionId: string;
    private readonly maxScenes;
    /**
     * How many steps' exact replays to keep.
     *
     * A scene is a *view*: three of them is a sensible cache for a window, but a step is a **fact**
     * — a finished step's events never change again — so caching at scene granularity threw away
     * work that could never go stale. Two neighbouring scenes overlap by most of their steps, and
     * panning back over ground already covered replayed all of it. The step cache is what makes a
     * step cost its own replay exactly once per version.
     */
    private readonly maxSteps;
    private readonly stepCache;
    private readonly store;
    private readonly scenes;
    private readonly listeners;
    private index;
    /** The builder the live index was frozen from: a window that only grew extends this one. */
    private builder;
    private current;
    private lastDemand;
    /**
     * What this service has cost so far.
     *
     * Read by the verification scripts through the read-only handle in `index.tsx`, and by nothing
     * else: a demand's price is a *count* before it is a duration — how many windows were re-indexed,
     * how many demands were answered from the memo, and how much of the log each replay was handed.
     * `replayMs` is the one duration kept here, because the alternative is timing a whole frame in a
     * headless browser, which says more about the machine than about the board.
     */
    readonly stats: {
        /** Times the window was scanned in full — the O(window) path, which growth must not take. */
        windows: number;
        /** Times a window that only grew at an end was indexed by its growth alone. */
        windowDeltas: number;
        /** Events a delta actually had to read. */
        indexDeltaEvents: number;
        demands: number;
        cached: number;
        assembled: number;
        replays: number;
        sliceEvents: number;
        replayMs: number;
    };
    /**
     * What the step cache did, in counts.
     *
     * `hits` is the number of steps a scene did not have to replay at all — the number that grows
     * with how much of this session the reader has already looked at, and the one a pan should move
     * instead of `replays`. `misses` is the new ground. Read by `scripts/test-scroll.mjs` through
     * `window.__dshCacheBricksStats()`.
     */
    readonly stepStats: {
        hits: number;
        misses: number;
        evictions: number;
    };
    constructor(options: HistorySceneOptions);
    /**
     * Note the window this scene reads.
     *
     * Called on every render; a scan happens only when the window actually changed — its length,
     * its oldest seq or its newest seq — because those are the only ways a durable window moves.
     *
     * The key is what decides that, and the caller may read it from the raw snapshot instead of from
     * the events ({@link windowKeyOfSnapshot}): the whole point is that a render which changed
     * nothing must not copy the window to find out. When no key is given, the events' own identity
     * is used, which is what a caller that already materialized them wants.
     *
     * Silent on purpose: this runs while a tree is rendering, and the scene it rebuilds is read
     * by that same render. Nothing is announced, because nothing has been asked for yet.
     *
     * @param events - the durable window, oldest first.
     * @param key - the window's identity; defaults to the identity of `events`.
     * @returns true when this call rebuilt the index.
     */
    window(events: readonly DurableEvent[], key?: string): boolean;
    /**
     * Note a window that only **grew**, and index the growth instead of the window.
     *
     * The log is append-only: a page landing at the older end adds events, and a Turn settling adds
     * events, but neither changes one event already indexed. So there is nothing to re-read — the only
     * honest work is the new events, which is what this does. It is the difference between a hundred
     * thousand events re-scanned per page and five hundred.
     *
     * The caller must be sure the window really is the old one plus these ranges (see
     * `durableEventsOutside`); anything else is a different window and belongs in {@link window}.
     *
     * @param older - events older than everything indexed, ascending.
     * @param newer - events newer than everything indexed, ascending.
     * @param key - the window's new identity.
     * @returns true when this call re-cut the scene (it always does; the shape mirrors `window`).
     */
    windowGrew(older: readonly DurableEvent[], newer: readonly DurableEvent[], key: string): boolean;
    /** The seq range the index covers, for a caller that can tell growth from a different window. */
    get windowBounds(): {
        oldest: number;
        newest: number;
    } | undefined;
    /** Durable events the index holds, for the caller's growth check. */
    get indexedCount(): number;
    /**
     * Drop the scenes and re-cut the reader's screen.
     *
     * Scenes belong to the window that produced them, so they go — but the *steps* they were
     * assembled from do not: their keys are seq versions, so a page landing costs the new ground and
     * the screen the reader is on comes back from the step cache.
     */
    private recut;
    /**
     * The identity of the window this scene is holding, or undefined before the first
     * {@link window}.
     *
     * Read by the render path to answer "did the window move?" without copying it — the comparison
     * the scene used to make *after* `durableEvents` had already walked and sorted the whole
     * session.
     */
    get indexKey(): string | undefined;
    /** The index for the window last noted, or undefined before the first {@link window}. */
    get currentIndex(): SceneIndex | undefined;
    /** The scene last produced, or undefined when nothing has been demanded yet. */
    get scene(): SceneRead | undefined;
    /**
     * Replay the scene a demand describes, from cache when it has been asked for already.
     *
     * @param demand - the Turns and steps on screen.
     * @returns the scene, or undefined when the window holds no step the demand names.
     */
    demand(demand: SceneDemand): SceneRead | undefined;
    /** Drop every scene (the window changed underneath them). */
    invalidate(): void;
    /** Watch for a new scene, so a React tree can re-render when one arrives. */
    subscribe(listener: () => void): () => void;
    /**
     * Announce the scene currently held.
     *
     * For a caller that knows the ground moved under it — a page landing, a jump — and wants the
     * new answer read. Calling it when nothing changed is free: an external store skips a render
     * whose snapshot is identical.
     */
    refresh(): void;
    /** Raw payloads of every scene, shared so two scenes that share a prefix share the bytes. */
    get blobStore(): BlobStore;
    /** Cut, replay and memoise one scene. Notifies nobody: the caller decides what that means. */
    private replay;
    /** Remember one step's replay, evicting the least recently added when the cache is full. */
    private remember;
    private notify;
}
export {};
