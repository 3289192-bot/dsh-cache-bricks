/**
 * Where a brick belongs in the transcript — the mapping the board had been missing.
 *
 * A brick's **identity** and its **place in the conversation** are two different
 * things, and conflating them is why this jump felt broken for so long:
 *
 * - a brick is one model request **attempt**, because that is what cache accounting is
 *   per: two attempts of one step are two requests, two bills, two cache outcomes;
 * - the Chat view publishes nodes per **step**, and a step is not an attempt. A retried
 *   step is two bricks and one `assistant-step` node — the view clears and reuses that
 *   node when the retry happens (`resetForRetry`, `dsh-client-ui-chat/lib/client.js:7338`,
 *   called from its `llm/retry` handling), so no attempt-level assistant node exists to
 *   aim at.
 *
 * So the mapping is explicitly **N:1**, and it is written down here instead of being
 * re-derived from whichever anchor happened to be at hand. The target says what the
 * attempt *is* in the transcript; whether that row is currently rendered is a separate
 * question, answered by the reveal's accuracy.
 *
 * Targets come in two granularities, and the difference is the brick's, not the row's:
 * a **collected** brick names one attempt (`assistant-step` / `tool-call` / `retry-chain` /
 * `compaction`), while a **folded** brick names one step (`historical-step`) and is resolved
 * against the durable log when the jump runs. Both are exact landings at their own
 * granularity; only the board's own marking (`estimated`) tells the reader which one they got.
 *
 * Every reachable target also carries **`loadSeq`** — the durable log position the session
 * window has to cover before that row can exist at all. It is the one input the official
 * loader needs (`ISession.loadThrough(seq)`), and it is taken from the record's own settling
 * event, so "which history do I need" is answered by the attempt itself rather than by a
 * count of pages to click through.
 */
export type BrickTarget = 
/**
 * The step's own row — the ordinary case.
 *
 * `part` says which half of that node the attempt *began* in: one `assistant-step` is
 * published as up to two rows sharing the node key, told apart by `data-chat-group-part`
 * (`client.js:1735`: `response` is the bare key, `reasoning` is keyed with the part). An
 * attempt that only produced a final answer has **no reasoning half at all**, so the
 * part is decided where the target is produced, from what the attempt actually contains.
 */
{
    readonly kind: 'assistant-step';
    readonly turn: number;
    readonly step: number;
    readonly part: 'reasoning' | 'response';
    readonly loadSeq?: number;
}
/** The row of a call the attempt made: a step with no assistant content is visible only through its calls. */
 | {
    readonly kind: 'tool-call';
    readonly turn: number;
    readonly step: number;
    readonly callId: string;
    readonly loadSeq?: number;
}
/** The official retry chain row, shared by every attempt in the chain (the N:1 case). */
 | {
    readonly kind: 'retry-chain';
    readonly turn: number;
    readonly step: number;
    readonly retryId: string;
    readonly loadSeq?: number;
}
/**
 * The transcript's compaction row, keyed by the id the durable `compaction/start` carried.
 *
 * Deliberately **not** anchored by `seq`: the chat view builds that node at its own
 * checkpoint seq (`chatNode(context, "compaction", marker.seq, marker)`), which is a
 * different event from the auxiliary model call's settlement — so a seq could never
 * bridge them, while the id does.
 */
 | {
    readonly kind: 'compaction';
    readonly compactionId: string;
    readonly loadSeq?: number;
}
/**
 * A step the client folded itself — no attempt identity, but a real place in the conversation.
 *
 * The fold sees usage per step, so it cannot say *which request* a brick is, and it must not
 * pretend to. It can say *which step of which Turn* it is, because the durable log is the
 * session's own record of exactly that — and a step is a row. Treating "no attempt identity"
 * as "nothing to navigate to" threw that away: after a restart (or an eviction, or a resumed
 * old session) every brick older than the collector became a brick that could not be opened
 * in the conversation, even though the brick, the log and the loader all knew where it was.
 *
 * So this target is resolved **at navigation time**, against the log: load through
 * `loadSeq`, read the step, and land on the row it actually became — a message half, a tool
 * call, a retry chain. What it never does is claim more than the fold measured: the landing
 * is **step**-exact, and the board marks these bricks as folded (`estimated`, dashed, `≈`),
 * so a step-level landing is never read as "this is the attempt you clicked".
 */
 | {
    readonly kind: 'historical-step';
    readonly turn: number;
    readonly step: number;
    readonly loadSeq?: number;
}
/** Nothing in the transcript can represent this attempt; the reason says why. */
 | {
    readonly kind: 'none';
    readonly reason: 'session-title' | 'no-compaction-id';
};
/**
 * A folded brick's target: the step, and how far back the log has to be loaded to read it.
 *
 * Named because three modules pass it around (the board, the reveal, the log reader) and the
 * `Extract` spelling at every one of those seams would hide what they are agreeing on.
 */
export type HistoricalStepTarget = Extract<BrickTarget, {
    kind: 'historical-step';
}>;
/**
 * How exactly a brick reached its row.
 *
 * `exact` is the brick's own row. `context` is somewhere near it — today only the Turn's
 * own header — and a reader must never be told that a context landing *is* the request
 * they clicked. `none` is not moving at all.
 */
export type RevealAccuracy = 'exact' | 'context' | 'none';
/**
 * The log position a target has to be loaded through, when the record knows one.
 *
 * `undefined` is a real answer: an attempt whose settling event is not known — one still in
 * flight, or seen only mid-flight by a restarted collector — cannot be paged to, and the UI
 * says so instead of loading guesses.
 *
 * @param target - where the brick belongs.
 * @returns the durable seq, or undefined.
 */
export declare function loadSeqOf(target: BrickTarget): number | undefined;
/** Which kind of row a landing produced. */
export type RevealRow = 'assistant-step' | 'tool-call' | 'retry-chain' | 'compaction' | 'turn-header' | 'none';
/**
 * The accuracy a row kind is worth.
 *
 * Only the four rows that are the brick's declared target count as exact; the Turn header
 * is where a Turn begins, not where a request happened.
 *
 * Note what `exact` does **not** claim: that the brick owns a row nobody else can point at.
 * A retried step is two bricks and one row, and both bricks are exact on it — the mapping
 * the board relies on is *brick → navigation target*, one to one, not *brick → row*.
 *
 * @param row - the kind of row that was reached.
 * @returns the accuracy to report.
 */
export declare function accuracyOf(row: RevealRow): RevealAccuracy;
