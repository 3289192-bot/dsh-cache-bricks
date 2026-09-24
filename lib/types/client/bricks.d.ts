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
/** Compact brick face: whole percent from 10% up, one decimal below it. */
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
/**
 * Bricks from the fallback source: one per **step**, keyed `turn:step`.
 *
 * This is the one place the board shows a different granularity from the rest of it, and
 * it is a degradation, not a mode: with no host half there is no attempt identity to be
 * had, so these bricks carry `target: none` and cannot navigate.
 *
 * The records are reduced (`observedBy: 'client'`), which is enough for the
 * overview tab and the diff's cache rows, and visibly not enough for the rest.
 * @param turns - per-step readings derived on the client.
 * @returns board data, with a reduced record per brick.
 */
export declare function boardFromReadings(turns: readonly StepReading[]): BoardData;
