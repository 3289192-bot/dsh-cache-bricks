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
  | {
    readonly kind: 'assistant-step'
    readonly turn: number
    readonly step: number
    readonly part: 'reasoning' | 'response'
    readonly loadSeq?: number
  }
  /** The row of a call the attempt made: a step with no assistant content is visible only through its calls. */
  | {
    readonly kind: 'tool-call'
    readonly turn: number
    readonly step: number
    readonly callId: string
    readonly loadSeq?: number
  }
  /** The official retry chain row, shared by every attempt in the chain (the N:1 case). */
  | {
    readonly kind: 'retry-chain'
    readonly turn: number
    readonly step: number
    readonly retryId: string
    readonly loadSeq?: number
  }
  /**
   * The transcript's compaction row, keyed by the id the durable `compaction/start` carried.
   *
   * Deliberately **not** anchored by `seq`: the chat view builds that node at its own
   * checkpoint seq (`chatNode(context, "compaction", marker.seq, marker)`), which is a
   * different event from the auxiliary model call's settlement — so a seq could never
   * bridge them, while the id does.
   */
  | { readonly kind: 'compaction'; readonly compactionId: string; readonly loadSeq?: number }
  /** Nothing in the transcript can represent this attempt; the reason says why. */
  | { readonly kind: 'none'; readonly reason: 'session-title' | 'no-compaction-id' | 'client-fold' }

/**
 * How exactly a brick reached its row.
 *
 * `exact` is the brick's own row. `context` is somewhere near it — today only the Turn's
 * own header — and a reader must never be told that a context landing *is* the request
 * they clicked. `none` is not moving at all.
 */
export type RevealAccuracy = 'exact' | 'context' | 'none'

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
export function loadSeqOf(target: BrickTarget): number | undefined {
  return target.kind === 'none' ? undefined : target.loadSeq
}

/** Which kind of row a landing produced. */
export type RevealRow = 'assistant-step' | 'tool-call' | 'retry-chain' | 'compaction' | 'turn-header' | 'none'

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
export function accuracyOf(row: RevealRow): RevealAccuracy {
  if (row === 'turn-header') return 'context'
  return row === 'none' ? 'none' : 'exact'
}
