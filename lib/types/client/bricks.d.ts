/**
 * Turning observations into bricks.
 *
 * Two sources exist, and the board should not care which one it got:
 *
 * 1. **The host feed** — attempt-level records from the collector, which is the
 *    full flight recorder: retries are separate bricks, and each brick can open a
 *    detail panel.
 * 2. **The session-event fallback** — the per-step readings the client derives on
 *    its own, used when no host half is present (a composition without the plugin
 *    loaded host-side, or a runtime line where the HTTP surface is unavailable).
 *
 * Both produce the same shape, so the tetris overlay and the panel need no branch.
 * Pure: no DOM, no fetch, no React.
 */
import type { BrickFeed, BrickRecord } from '../shared/brick';
import { type CacheTone } from './logic';
import type { BrickTarget } from './target';
import { type ActivityKind, type BoardColumn, type Brick, type BrickAbnormal, type BrickContent } from './tetris';
/** Tone for a record's reading, with the same honesty rule the badges use. */
export declare function toneOfRatio(ratio: number | undefined, promptTokens: number | undefined): CacheTone;
/**
 * Compact brick face: one decimal, `n/a` when the provider reported no cache fields.
 *
 * The same rule the client's own fold uses (`percentLabel`), so a brick reads the same
 * whichever half produced it.
 * @param ratio - share in [0, 1], or undefined when nothing was reported.
 * @returns e.g. `99.9%`, `100%`, `n/a`.
 */
export declare function labelOfRatio(ratio: number | undefined): string;
/** What the board needs from one source. */
export interface BoardData {
    readonly columns: readonly BoardColumn[];
    readonly titles: Map<string, string>;
    /** Records by brick key, for the detail panel. Empty for the fallback source. */
    readonly records: Map<string, BrickRecord>;
    /** Bricks in board order, newest last, for "compare with the previous". */
    readonly order: readonly string[];
    /**
     * True when these bricks were folded by the client instead of collected from the host.
     *
     * The board shows a notice while it is set: without a collector there is no attempt
     * telemetry, only one brick per step.
     */
    readonly estimated?: true;
    /**
     * Auxiliary calls (compaction, session title), oldest first.
     *
     * Real requests with real records, belonging to no Turn: they get the board's own lane
     * rather than a Turn column, which would invent a relationship that does not exist.
     */
    readonly aux: readonly Brick[];
    /**
     * The tallest column, when the caller already knows it.
     *
     * The board measures it once per content array otherwise, which is a scan of every Turn: the
     * world knows it from the columns it just built, so a pan that replaced fifty Turns does not make
     * the board re-measure ten thousand (see `CacheTetrisBoard.setColumns`).
     */
    readonly tallest?: number;
}
/**
 * Bricks from the collector's feed: one per attempt, columns per Turn.
 * @param feed - the feed received from the host half.
 * @returns board data, with each brick's record available for the panel.
 */
export declare function boardFromFeed(feed: BrickFeed): BoardData;
/**
 * Which channels an attempt produced.
 *
 * Read straight off the record, so a missing field means "not observed" rather than
 * "did not happen": an attempt with no usage reported still shows its tool edge if
 * tool calls were seen.
 *
 * The left edge is the honest approximation available at this level. Steering,
 * context and system-prompt changes are separate conversation nodes in rc1, and the
 * collector does not turn them into bricks; what it *can* say per attempt is
 * whether the model-visible input changed here — a new request header (tools or
 * configuration) or a new series.
 *
 * @param record - the collected attempt.
 * @returns the channel flags drawn as the brick's edges.
 */
export declare function contentOf(record: BrickRecord): BrickContent;
/**
 * A non-clean ending, if any — read from the record, never guessed.
 *
 * Order matters: a failed attempt reports as failed even though a retry follows it,
 * because "it broke" is the fact worth seeing first.
 * @param record - the collected attempt.
 * @returns the abnormal marker, or undefined for a clean attempt.
 */
export declare function abnormalOf(record: BrickRecord): BrickAbnormal | undefined;
/**
 * What kind of conversation move this attempt is: the brick's back face.
 *
 * Five branches, in the order the runtime's own data demands:
 *
 * 1. an auxiliary call (`compaction`, `session-title`) — the only self-declared
 *    kind a request has, and it belongs to no Turn at all;
 * 2. reasoning **and** tools — the split face, because that is a real combination
 *    and not a third thing;
 * 3. tools alone;
 * 4. reasoning alone;
 * 5. anything else, which is output — text, an image, a file, or an attempt that
 *    has not produced anything observable yet.
 *
 * Note what is **not** here: failure, retry, abort and the output limit. Those come
 * from the lifecycle (`abnormalOf`), which the board paints as a corner mark on
 * whichever type the attempt already is — a failed tool call is still a tool call.
 *
 * @param record - the collected attempt.
 * @returns the type whose colour and label the back face wears.
 */
export declare function activityOf(record: BrickRecord): ActivityKind;
/**
 * The share of an attempt spent waiting for its first token, in `0..1`.
 *
 * @param record - the collected attempt.
 * @returns the share, or undefined when the attempt's timing is not known.
 */
export declare function ttftShareOf(record: BrickRecord): number | undefined;
/**
 * Where this attempt belongs in the transcript.
 *
 * The identity is always the attempt; the **anchor** is the row that can show it, and
 * which row that is follows from what the attempt produced:
 *
 * 1. an attempt inside a retry chain aims at the **chain row**. The failed attempt and
 *    the one that replaced it are the same step, the Chat view keeps one node for that
 *    step, and the chain row is the only place the pair is shown together;
 * 2. an auxiliary call the loop did not make for a Turn: a compaction aims at the row keyed
 *    by its `compactionId`, and a session title — which has no row at all — declares itself
 *    unreachable rather than aiming at something nearby;
 * 3. a step that produced **no assistant content** is visible only through the calls it
 *    made, so it aims at its first call's row — this is the common case in this harness,
 *    where most steps are tool work;
 * 4. everything else aims at the step's own row.
 *
 * Point 3 is decided by the attempt's own counters, **not** by whether it settled with a
 * message: a tool-only step does commit an `assistant/message` (finish `tool-calls`), and
 * the Chat view still materialises no `assistant-step` row for it — verified on a live
 * instance, where such a brick's step id was absent from the DOM while its call row was
 * there and laid out.
 *
 * @param record - the collected attempt.
 * @returns where the brick belongs, or why nothing can show it.
 */
export declare function targetOf(record: BrickRecord): BrickTarget;
/**
 * How much of a mixed brick's back face goes to reasoning.
 * @param record - the collected attempt.
 * @returns the share in `0..1`, from the attempt's own counters.
 */
export declare function reasoningShareOf(record: BrickRecord): number;
/**
 * Hover text for the detail line of one brick.
 *
 * It deliberately does **not** repeat the brick's identity: the board composes it
 * after `turn N · step M · <type>`, so a tooltip that said the same thing twice
 * would read as a defect.
 *
 * @param record - the collected attempt.
 * @returns the reading, the timing, how it ended, and the channels it used.
 */
export declare function titleFor(record: BrickRecord): string;
/**
 * The usage a client-side step fold can see: the three prompt buckets, because
 * that is what the session events carry for a step from the badge node. Output and
 * reasoning tokens are not part of that fold, and the panel shows them as absent
 * rather than as zero.
 */
export interface StepUsage {
    readonly inputTokens: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
}
/** A per-step reading from the client's own session-event fold. */
export interface StepReading {
    readonly turn: number;
    readonly step: number;
    readonly tone: CacheTone;
    readonly label: string;
    readonly detail?: string;
    readonly ended: boolean;
    readonly provider?: string;
    readonly usage?: StepUsage;
    /** Step start to first token, in milliseconds, when both were observed. */
    readonly ttftMs?: number;
    readonly usageAt?: number;
    /**
     * Durable seq this reading was measured from, when the event feed carried one.
     *
     * A folded brick has no attempt identity, but it does have a log position — which is
     * exactly what the session loader needs to bring the conversation around it into the
     * window for the inspector.
     */
    readonly seq?: number;
}
/**
 * A reduced record for one client-side reading.
 *
 * Everything here comes from the session event feed the browser already receives,
 * so the panel can open without a host half. Nothing is invented: what the client
 * cannot see (request hashes, the outgoing request, the timed stream, the context
 * snapshot) stays absent, and `observedBy: 'client'` tells the panel to say so.
 * @param reading - one step folded on the client.
 * @returns a record with the fields the client can honestly claim.
 */
export declare function recordFromReading(reading: StepReading): BrickRecord;
export declare function boardFromReadings(turns: readonly StepReading[]): BoardData;
/**
 * Everything the board can be built from, weakest first.
 *
 * The three sources answer three different questions, and none of them contains the others:
 *
 * - the **collector** knows this process's attempts — one brick per request, retry included,
 *   with the request, the timed stream and the dispatch-time context kept by reference — and
 *   nothing that happened before it started or after its LRU dropped a session;
 * - a **replay** of the session's own log knows every settled attempt of the turns the client
 *   is holding, at attempt granularity, with the log's own usage, activity, retries and
 *   settlement positions — but no request capture (`../core/replay`);
 * - the **fold** is the browser's per-step reading, for a core with no session face at all.
 */
export interface BoardSources {
    /** The collector's feed, when a host half is answering this session. */
    readonly live?: BrickFeed;
    /** The session's log, replayed into bricks. */
    readonly replay?: BrickFeed;
    /** The client's own per-step readings. */
    readonly readings?: readonly StepReading[];
}
/**
 * The board as a persistent world: one light base, two overlays, patched rather than rebuilt.
 *
 * The merge itself is unchanged — per **attempt**, strongest source last (`live` > `exact` >
 * `fold`), with a folded step dropped as soon as any attempt-level brick covers it. What changed is
 * *when* it runs. `boardFromSources` used to rebuild the whole session on every call, and the board
 * calls it whenever the scene on screen is re-cut: a pan to a new screen re-folded every reading the
 * session had, rebuilt every Turn's column, and re-sorted all of them — O(session) work for a
 * viewport-sized change. That is the one place where a "window" board still behaved like a backlog.
 *
 * The world separates the rates:
 *
 * - the **base** is the fold, rebuilt only when the fold itself changes (the streaming rate, not the
 *   pan rate);
 * - the **exact overlay** is the scene's replay, applied by patch: the steps it covers are replaced,
 *   the steps it stopped covering fall back to their fold brick — O(scene), and adjacent scenes share
 *   most of their steps;
 * - the **live overlay** is the collector's feed, applied only when it changes.
 *
 * A materialization is then one array of Turn pointers plus the columns that were actually touched,
 * which is what a pan should cost. `order` stays lazy: it is a list of every brick on the board, and
 * only the panel (which needs "the brick before this one") ever asks for it.
 */
export declare class BoardWorld {
    /**
     * What the world has cost, in counts rather than milliseconds.
     *
     * A pan should move `columnsRebuilt` and nothing else: `foldRebuilds` counts the O(session) work
     * and must stay flat while the reader pans, `orderBuilds` counts the session-sized list that only
     * the panel asks for, and `exactSteps` counts what the scene actually replaced. Read by the
     * browser checks through `window.__dshCacheBricksStats()`, and by nothing in the plugin.
     */
    readonly stats: {
        /** Materializations: one per scene change, one per fold change. */
        boards: number;
        /** Times the fold layer was rebuilt — the only O(session) step, and it runs at the fold's rate. */
        foldRebuilds: number;
        /** Steps the fold layer holds after the last rebuild. */
        foldSteps: number;
        /** Scene patches, and the steps each one replaced. */
        exactPatches: number;
        exactSteps: number;
        /** Collector patches. */
        livePatches: number;
        /** Turns whose column was rebuilt because something inside it changed. */
        columnsRebuilt: number;
        /** Times the session-sized `order` list was materialized (the panel asking for it). */
        orderBuilds: number;
    };
    private readings;
    /** Turns in ascending order, maintained on insert. */
    private turns;
    private readonly byTurn;
    private readonly steps;
    /** The steps the exact overlay covered last time, so leaving them can release them. */
    private exactSteps;
    /** The attempt keys the live overlay held last time. */
    private liveKeys;
    /** The collector's feed object the overlay was built from: a pan hands back the same one. */
    private liveFeed;
    private readonly records;
    private readonly titles;
    private aux;
    private readonly auxRecords;
    private readonly auxTitles;
    private endedTurns;
    /**
     * Bring the world up to date and hand back a board for this moment.
     *
     * @param sources - live feed, replayed feed and folded readings, any of them optional.
     * @returns the merged board. Only the columns whose content changed are rebuilt; `order` is
     *   computed on first use.
     */
    board(sources: BoardSources): BoardData;
    /** Whether the last {@link board} call had no feed behind it at all. */
    private foldedOnly;
    /** Replace the fold layer: the only step that is O(session), and it runs at the fold's rate. */
    private setFold;
    /** Replace the collector's overlay. */
    private setLive;
    /** Replace the replay overlay: the scene on screen, in and out. */
    private setExact;
    /** The attempt-level entries of one feed, keyed `${turn}:${step}:${attempt}`. */
    private entriesOf;
    private putOverlay;
    /** One layer drops an attempt: the step falls back to whatever is left under it. */
    private removeOverlay;
    /** The scene moved on: this step is no longer exactly known. */
    private releaseExact;
    /** The lane: auxiliary calls belong to no Turn, so the strongest feed's list wins. */
    private applyAux;
    private stepState;
    private ensureTurn;
    /** Note that one Turn's content changed (and optionally its ended flag). */
    private touch;
    /**
     * The effective bricks of one step: the overlays if any of them has it, the fold otherwise.
     *
     * This is the whole merge rule, in one place, and it is why a patch costs the step rather than
     * the session.
     */
    private bricksOf;
    /** The record and title behind one effective brick. */
    private detailOf;
    /** Build the board for this moment, rebuilding only the Turns that changed. */
    private materialize;
    private columns;
    /** Every brick on the board, newest last: built only when a caller asks (the panel does). */
    private orderOf;
    /** The steps of one Turn, in step order. */
    private stepsOf;
}
/**
 * Build one board out of everything available.
 *
 * The merge rules live in {@link BoardWorld} (per attempt, `live` > `exact` > `fold`, see there);
 * this is the one-shot form of it, for a caller that has no world to keep — the panel tests, and
 * anything that merges a single snapshot.
 *
 * @param sources - live feed, replayed feed and folded readings, any of them optional.
 * @returns the merged board. The board-level `estimated` flag is set only for a board that is
 *   *entirely* folded, where the claim is true of every brick.
 */
export declare function boardFromSources(sources: BoardSources): BoardData;
