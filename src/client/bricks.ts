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
import type { BrickFeed, BrickRecord, BrickUsage } from '../shared/brick'
import { EMPTY_COUNTERS, deriveMetrics } from '../shared/metrics'
import { badgeStatus, percentLabel, type CacheTone } from './logic'
import type { BrickTarget } from './target'
import {
  brickKey,
  reasoningShare,
  type ActivityKind,
  type BoardColumn,
  type Brick,
  type BrickAbnormal,
  type BrickContent,
} from './tetris'

/** Tone for a record's reading, with the same honesty rule the badges use. */
export function toneOfRatio(ratio: number | undefined, promptTokens: number | undefined): CacheTone {
  if (ratio === undefined) return 'unknown'
  const status = badgeStatus({
    usage: {
      inputTokens: Math.round((1 - ratio) * (promptTokens ?? 1000)),
      cacheReadTokens: Math.round(ratio * (promptTokens ?? 1000)),
    },
    hasCacheEvidence: true,
  })
  if (status === null) return 'unknown'
  // A prompt too small to be worth alarming about stays quiet, like the badges.
  if (promptTokens !== undefined && promptTokens < 1000) return 'minor'
  return status.tone
}

/**
 * Compact brick face: one decimal, `n/a` when the provider reported no cache fields.
 *
 * The same rule the client's own fold uses (`percentLabel`), so a brick reads the same
 * whichever half produced it.
 * @param ratio - share in [0, 1], or undefined when nothing was reported.
 * @returns e.g. `99.9%`, `100%`, `n/a`.
 */
export function labelOfRatio(ratio: number | undefined): string {
  return ratio === undefined ? 'n/a' : percentLabel(ratio)
}

/** What the board needs from one source. */
export interface BoardData {
  readonly columns: readonly BoardColumn[]
  readonly titles: Map<string, string>
  /** Records by brick key, for the detail panel. Empty for the fallback source. */
  readonly records: Map<string, BrickRecord>
  /** Bricks in board order, newest last, for "compare with the previous". */
  readonly order: readonly string[]
  /**
   * True when these bricks were folded by the client instead of collected from the host.
   *
   * The board shows a notice while it is set: without a collector there is no attempt
   * telemetry, only one brick per step.
   */
  readonly estimated?: true
  /**
   * Auxiliary calls (compaction, session title), oldest first.
   *
   * Real requests with real records, belonging to no Turn: they get the board's own lane
   * rather than a Turn column, which would invent a relationship that does not exist.
   */
  readonly aux: readonly Brick[]
}

/**
 * Bricks from the collector's feed: one per attempt, columns per Turn.
 * @param feed - the feed received from the host half.
 * @returns board data, with each brick's record available for the panel.
 */
export function boardFromFeed(feed: BrickFeed): BoardData {
  const columns = new Map<number, Brick[]>()
  const aux: Brick[] = []
  const titles = new Map<string, string>()
  const records = new Map<string, BrickRecord>()
  const order: string[] = []
  const endedTurns = new Set<number>(feed.endedTurns ?? [])
  let newestTurn = 0
  for (const record of feed.bricks) {
    if (record.identity.turn > newestTurn) newestTurn = record.identity.turn
  }
  for (const record of feed.bricks) {
    const key = record.identity.id
    const ratio = record.metrics.cacheHitRatio
    const kind = activityOf(record)
    const brick: Brick = {
      key,
      turn: record.identity.turn,
      step: record.identity.step,
      attempt: record.identity.attemptOrdinal,
      // A feed is either the live collector's or a replay of the session's own log, and the
      // record says which. The board paints them differently for exactly one reason: a
      // replayed brick has no request capture behind it, and the reader is owed that.
      origin: record.observedBy === 'replay' ? 'replay' : 'live',
      tone: toneOfRatio(ratio, record.metrics.promptTokens),
      label: labelOfRatio(ratio),
      kind,
      ...(() => {
        const detail = detailOf(record, kind)
        return detail === undefined ? {} : { detail }
      })(),
      ...(kind === 'mixed' ? { activityShare: reasoningShareOf(record) } : {}),
      ...(() => {
        const share = ttftShareOf(record)
        return share === undefined ? {} : { ttftShare: share }
      })(),
      ...(record.settlementSeq === undefined ? {} : { settlementSeq: record.settlementSeq }),
      target: targetOf(record),
      ...(record.retry === undefined ? {} : { retried: true }),
      ...(record.finish?.reason === 'error' || record.settlement === 'abandoned' ? { failed: true } : {}),
      content: contentOf(record),
      ...(abnormalOf(record) === undefined ? {} : { abnormal: abnormalOf(record)! }),
    }
    // Auxiliary calls (compaction, session-title) are real bricks with real
    // records — the panel can open them — but they belong to no Turn, so they get
    // no column: a column would invent a Turn that never happened.
    // Auxiliary calls (compaction, session-title) are real bricks with real records — the
    // panel can open them — but they belong to no Turn, so they get no Turn column: that
    // would invent a Turn that never happened. They go to the lane instead.
    if (record.identity.turn > 0) {
      const column = columns.get(record.identity.turn) ?? []
      column.push(brick)
      columns.set(record.identity.turn, column)
    } else {
      aux.push(brick)
    }
    records.set(key, record)
    order.push(key)
    titles.set(key, titleFor(record))
  }
  return {
    columns: [...columns.entries()]
      .sort((left, right) => left[0] - right[0])
      // `ended` drives both the ghost drop slot and the reserved lead column, so
      // it comes from `turn/end` when the host reports it. A host build that
      // predates that field would otherwise mark every column finished, including
      // the one currently streaming; treating only the newest as running is the
      // honest reading of what such a feed can say.
      .map(([turn, bricks]) => ({
        turn,
        // A Turn older than the newest one cannot still be running — the loop only
        // advances — so it counts as ended even when its `turn/end` predates this
        // collector process (a restart mid-session would otherwise report every
        // historical Turn as live).
        ended: feed.endedTurns === undefined
          ? turn !== newestTurn
          : turn < newestTurn || endedTurns.has(turn),
        bricks,
      })),
    titles,
    records,
    order,
    aux,
  }
}

/**
 * Hover text for a brick folded on the client.
 *
 * Like {@link titleFor} it leaves the identity to the board, which already prints
 * the turn, the step and the type in front of it.
 *
 * @param reading - one step's reading.
 * @returns the reading, the provider, the timing and whether it is still running.
 */
function titleOfReading(reading: StepReading): string {
  const parts = [
    `cache ${reading.label}`,
    reading.provider,
    reading.ttftMs === undefined ? undefined : `ttft ${(reading.ttftMs / 1000).toFixed(2)}s`,
    reading.detail,
    reading.ended ? undefined : 'running',
  ].filter((part): part is string => part !== undefined)
  return parts.join(' · ')
}

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
export function contentOf(record: BrickRecord): BrickContent {
  return {
    reasoning: record.metrics.reasoningChars > 0,
    tools: record.tools.length > 0 || record.metrics.toolCallCount > 0,
    output: record.metrics.textChars > 0,
    inputChange: record.request.headerReason === 'change' || record.request.startsSeries === true,
    auxiliary: record.route.purpose !== undefined,
  }
}

/**
 * A non-clean ending, if any — read from the record, never guessed.
 *
 * Order matters: a failed attempt reports as failed even though a retry follows it,
 * because "it broke" is the fact worth seeing first.
 * @param record - the collected attempt.
 * @returns the abnormal marker, or undefined for a clean attempt.
 */
export function abnormalOf(record: BrickRecord): BrickAbnormal | undefined {
  if (record.finish?.reason === 'error' || record.settlement === 'abandoned') return 'failed'
  if (record.finish?.reason === 'aborted' || record.interrupted === true) return 'interrupted'
  if (record.finish?.reason === 'max-tokens') return 'max-tokens'
  if (record.retry !== undefined || record.identity.attemptOrdinal > 0) return 'retry'
  return undefined
}

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
export function activityOf(record: BrickRecord): ActivityKind {
  const content = contentOf(record)
  if (content.auxiliary) return 'auxiliary'
  if (content.reasoning && content.tools) return 'mixed'
  if (content.tools) return 'tool'
  if (content.reasoning) return 'reasoning'
  return 'output'
}

/**
 * The share of an attempt spent waiting for its first token, in `0..1`.
 *
 * @param record - the collected attempt.
 * @returns the share, or undefined when the attempt's timing is not known.
 */
export function ttftShareOf(record: BrickRecord): number | undefined {
  const { ttftMs, durationMs } = record.metrics
  if (ttftMs === undefined || durationMs === undefined || durationMs <= 0) return undefined
  const share = ttftMs / durationMs
  return share > 0 && share < 1 ? share : undefined
}

/**
 * The short name of the model behind an attempt, for the brick's second line.
 *
 * Vendor prefixes are dropped because the lane already says what kind of call this was —
 * `v4-pro` identifies it at six pixels where `deepseek-v4-pro` would not fit at all.
 *
 * @param model - the model id the request carried.
 * @returns the last two segments of the id.
 */
function shortModel(model: string | undefined): string | undefined {
  if (model === undefined || model === '') return undefined
  const parts = model.split('-')
  return parts.length <= 2 ? model : parts.slice(-2).join('-')
}

/**
 * What the brick was specifically doing, in one short word.
 *
 * @param record - the collected attempt.
 * @param kind - its activity type.
 * @returns a tool name, a model name or a purpose, or undefined when there is nothing
 *   shorter to say than the type itself.
 */
function detailOf(record: BrickRecord, kind: ActivityKind): string | undefined {
  const tool = record.tools[0]?.name
  if (kind === 'tool' || kind === 'mixed') return tool === undefined || tool === '' ? undefined : tool
  if (kind === 'auxiliary') {
    return record.route.purpose === 'session-title' ? 'title' : record.route.purpose
  }
  return shortModel(record.route.model)
}

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
export function targetOf(record: BrickRecord): BrickTarget {
  // The durable seq of the event that settled this attempt — the log position the session
  // window must reach before any row for it can exist. Everything else about the target says
  // *which* row; this says *how far back to load*, which is the loader's only input.
  const loadSeq = record.settlementSeq !== undefined && record.settlementSeq > 0 ? record.settlementSeq : undefined
  const retryId = record.retry?.retryId ?? record.retryChainId
  if (retryId !== undefined) {
    return {
      kind: 'retry-chain',
      turn: record.identity.turn,
      step: record.identity.step,
      retryId,
      ...(loadSeq === undefined ? {} : { loadSeq }),
    }
  }
  if (record.identity.turn <= 0) {
    // An auxiliary call the loop did not make for a Turn. A compaction has a row of its own
    // — keyed by the id its durable event carried — while a session title is never rendered
    // in the transcript at all, so that one is declared unreachable instead of guessed at.
    if (record.route.purpose === 'session-title') return { kind: 'none', reason: 'session-title' }
    return record.compactionId === undefined
      ? { kind: 'none', reason: 'no-compaction-id' }
      : { kind: 'compaction', compactionId: record.compactionId, ...(loadSeq === undefined ? {} : { loadSeq }) }
  }
  const callId = record.tools[0]?.callId
  const hasReasoning = record.metrics.reasoningChars > 0
  const hasText = record.metrics.textChars > 0
  if (!hasReasoning && !hasText && callId !== undefined) {
    return {
      kind: 'tool-call',
      turn: record.identity.turn,
      step: record.identity.step,
      callId,
      ...(loadSeq === undefined ? {} : { loadSeq }),
    }
  }
  return {
    kind: 'assistant-step',
    turn: record.identity.turn,
    step: record.identity.step,
    // Where the attempt began, not where it ended: a step that reasoned starts in the
    // reasoning half, and one that only answered has no reasoning half to start in.
    part: hasReasoning ? 'reasoning' : 'response',
    ...(loadSeq === undefined ? {} : { loadSeq }),
  }
}

/**
 * How much of a mixed brick's back face goes to reasoning.
 * @param record - the collected attempt.
 * @returns the share in `0..1`, from the attempt's own counters.
 */
export function reasoningShareOf(record: BrickRecord): number {
  return reasoningShare(record.metrics.reasoningChars, record.metrics.toolCallCount)
}

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
export function titleFor(record: BrickRecord): string {
  const cache = record.metrics.cacheHitRatio === undefined
    ? 'cache n/a'
    : `cache ${(record.metrics.cacheHitRatio * 100).toFixed(1)}%`
  const ttft = record.metrics.ttftMs === undefined ? undefined : `ttft ${(record.metrics.ttftMs / 1000).toFixed(2)}s`
  const retried = record.retry === undefined ? undefined : `retried after ${record.retry.failureCode ?? 'failure'}`
  // The channels used to be painted on the four edges. They are accurate but they
  // are not rare: nearly every step reasons, calls a tool and answers, so colouring
  // them made every brick shout. Naming them on hover keeps the information and
  // gives the board back its quiet.
  const content = contentOf(record)
  const channels = [
    content.auxiliary ? 'auxiliary' : undefined,
    content.reasoning ? 'reasoning' : undefined,
    content.tools ? 'tools' : undefined,
    content.output ? 'text' : undefined,
    content.inputChange ? 'input change' : undefined,
  ].filter((entry): entry is string => entry !== undefined)
  const parts = [
    record.identity.attemptOrdinal > 0 ? `attempt ${String(record.identity.attemptOrdinal)}` : undefined,
    cache,
    ttft,
    record.finish?.reason,
    retried,
    channels.length === 0 ? undefined : channels.join(' + '),
  ].filter((part): part is string => part !== undefined)
  return parts.join(' · ')
}

/**
 * The usage a client-side step fold can see: the three prompt buckets, because
 * that is what the session events carry for a step from the badge node. Output and
 * reasoning tokens are not part of that fold, and the panel shows them as absent
 * rather than as zero.
 */
export interface StepUsage {
  readonly inputTokens: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** A per-step reading from the client's own session-event fold. */
export interface StepReading {
  readonly turn: number
  readonly step: number
  readonly tone: CacheTone
  readonly label: string
  readonly detail?: string
  readonly ended: boolean
  readonly provider?: string
  readonly usage?: StepUsage
  /** Step start to first token, in milliseconds, when both were observed. */
  readonly ttftMs?: number
  readonly usageAt?: number
  /**
   * Durable seq this reading was measured from, when the event feed carried one.
   *
   * A folded brick has no attempt identity, but it does have a log position — which is
   * exactly what the session loader needs to bring the conversation around it into the
   * window for the inspector.
   */
  readonly seq?: number
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
export function recordFromReading(reading: StepReading): BrickRecord {
  const usage = reading.usage === undefined
    ? undefined
    : {
      inputTokens: reading.usage.inputTokens,
      outputTokens: reading.usage.outputTokens ?? 0,
      ...(reading.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: reading.usage.cacheReadTokens }),
      ...(reading.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: reading.usage.cacheWriteTokens }),
    } satisfies BrickUsage
  const metrics = deriveMetrics(
    usage,
    {
      ...(reading.usageAt === undefined ? {} : { firstTokenAt: reading.usageAt }),
      ...(reading.usageAt === undefined || reading.ttftMs === undefined ? {} : { dispatchedAt: reading.usageAt - reading.ttftMs }),
    },
    EMPTY_COUNTERS,
  )
  return {
    observedBy: 'client',
    identity: {
      id: brickKey(reading.turn, reading.step),
      sessionId: '',
      turn: reading.turn,
      step: reading.step,
      attemptOrdinal: 0,
    },
    settlement: reading.ended ? 'message' : 'running',
    ...(reading.seq === undefined ? {} : { settlementSeq: reading.seq }),
    route: { provider: reading.provider ?? 'unknown', model: 'unknown' },
    ...(usage === undefined ? {} : { usage }),
    metrics,
    request: {},
    tools: [],
    raw: {},
  }
}

/**
 * Bricks from the fallback source: one per **step**, keyed `turn:step`.
 *
 * This is the one place the board shows a different granularity from the rest of it, and
 * it is a degradation, not a mode: with no host half there is no attempt identity to be
 * had. That costs the brick its *attempt* precision — it cannot say which of a step's
 * requests it is — but not its place in the conversation: it carries a `historical-step`
 * target, which the jump resolves against the durable log, so a folded brick still opens
 * the row its step became (`resolveHistoricalStep`).
 *
 * The records are reduced (`observedBy: 'client'`), which is enough for the
 * overview tab and the diff's cache rows, and visibly not enough for the rest.
 * @param turns - per-step readings derived on the client.
 * @returns board data, with a reduced record per brick.
 */
export function boardFromReadings(turns: readonly StepReading[]): BoardData {
  const columns = new Map<number, { turn: number; ended: boolean; bricks: Brick[] }>()
  const titles = new Map<string, string>()
  const records = new Map<string, BrickRecord>()
  const order: string[] = []
  for (const reading of turns) {
    const key = brickKey(reading.turn, reading.step)
    const brick: Brick = {
      key,
      turn: reading.turn,
      step: reading.step,
      attempt: 0,
      tone: reading.tone,
      label: reading.label,
      // The client's own fold sees usage and whether the step ended — not which
      // channels ran — so every brick it produces is the quiet default type.
      // Claiming 思考 or 工具 here would be a guess dressed as a measurement.
      kind: 'output',
      // No attempt identity at all: these bricks are one per *step*, folded from the session
      // event feed. That is a claim about precision, not about reachability — the step is a
      // real place in the conversation, and the durable log says which row it became. So the
      // target is a `historical-step`, resolved against the log when the jump runs (see
      // `resolveHistoricalStep`), and the brick is drawn dashed so a board of them is never
      // read as a board of real requests.
      estimated: true,
      origin: 'fold',
      target: {
        kind: 'historical-step',
        turn: reading.turn,
        step: reading.step,
        ...(reading.seq === undefined || reading.seq <= 0 ? {} : { loadSeq: reading.seq }),
      },
    }
    const column = columns.get(reading.turn) ?? { turn: reading.turn, ended: reading.ended, bricks: [] }
    column.bricks.push(brick)
    column.ended = reading.ended
    columns.set(reading.turn, column)
    const record = recordFromReading(reading)
    records.set(key, record)
    // The reading is the primary source here: its label already went through the
    // provider-evidence rule, so it is more truthful than recomputing from a
    // reduced usage block.
    titles.set(key, titleOfReading(reading))
    order.push(key)
  }
  return {
    columns: [...columns.values()].sort((left, right) => left.turn - right.turn),
    titles,
    records,
    order,
    estimated: true,
    // The fold has no auxiliary calls to show: it sees usage per step, and a step is not a
    // request. A lane entry here would be inventing one.
    aux: [],
  }
}

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
  readonly live?: BrickFeed
  /** The session's log, replayed into bricks. */
  readonly replay?: BrickFeed
  /** The client's own per-step readings. */
  readonly readings?: readonly StepReading[]
}

/** `${turn}:${step}:${attempt}`, the identity a fine-grained brick is merged by. */
function attemptKey(turn: number, step: number, attempt: number): string {
  return `${String(turn)}:${String(step)}:${String(attempt)}`
}

/**
 * Build one board out of everything available.
 *
 * Merging is **per attempt**, not per step: a step whose first attempt happened before the
 * collector started and whose second it watched must still come out as two bricks, because that
 * pair is the case this plugin exists for. So the live feed wins on the attempts it has, a
 * replay fills the attempts it does not, and the fold supplies steps neither covers — one
 * step-level brick per step, dropped as soon as any attempt-level brick covers that step, since
 * keeping both would count the same request twice.
 *
 * @param sources - live feed, replayed feed and folded readings, any of them optional.
 * @returns the merged board. The board-level `estimated` flag is set only for a board that is
 *   *entirely* folded, where the claim is true of every brick.
 */
export function boardFromSources(sources: BoardSources): BoardData {
  const live = sources.live?.bricks ?? []
  const replay = sources.replay?.bricks ?? []
  const readings = sources.readings ?? []
  if (live.length === 0 && replay.length === 0) return boardFromReadings(readings)

  const liveBoard = live.length === 0 ? undefined : boardFromFeed(sources.live!)
  const replayBoard = replay.length === 0 ? undefined : boardFromFeed(sources.replay!)

  // Attempt-level bricks, live last so it overwrites a replay of the same attempt.
  const bricks = new Map<string, { brick: Brick; record: BrickRecord; title: string; turn: number; step: number; attempt: number }>()
  const coveredSteps = new Set<string>()
  const columns = new Map<number, { turn: number; ended: boolean; bricks: Brick[] }>()
  const titles = new Map<string, string>()
  const records = new Map<string, BrickRecord>()
  const aux: Brick[] = []
  const endedTurns = new Set<number>()

  const addBoard = (board: BoardData, feed: BrickFeed | undefined): void => {
    for (const turn of feed?.endedTurns ?? []) endedTurns.add(turn)
    for (const column of board.columns) {
      const entry = columns.get(column.turn) ?? { turn: column.turn, ended: false, bricks: [] }
      // Either source reporting a Turn ended is enough: the log knows the past, the collector
      // the present, and one that died mid-Turn never saw the end its log recorded.
      entry.ended = entry.ended || column.ended
      columns.set(column.turn, entry)
      for (const brick of column.bricks) {
        const record = board.records.get(brick.key)
        if (record === undefined) continue
        bricks.set(attemptKey(brick.turn, brick.step, brick.attempt), {
          brick,
          record,
          title: board.titles.get(brick.key) ?? brick.label,
          turn: brick.turn,
          step: brick.step,
          attempt: brick.attempt,
        })
        coveredSteps.add(brickKey(brick.turn, brick.step))
      }
    }
    for (const brick of board.aux) {
      const record = board.records.get(brick.key)
      if (record === undefined) continue
      aux.push(brick)
      records.set(brick.key, record)
      titles.set(brick.key, board.titles.get(brick.key) ?? brick.label)
    }
  }

  // Weakest first, so a stronger source overwrites it: replay, then live.
  if (replayBoard !== undefined) addBoard(replayBoard, sources.replay)
  if (liveBoard !== undefined) addBoard(liveBoard, sources.live)

  for (const entry of bricks.values()) {
    const column = columns.get(entry.turn)!
    column.bricks.push(entry.brick)
    records.set(entry.brick.key, entry.record)
    titles.set(entry.brick.key, entry.title)
  }

  // The fold fills what no attempt-level brick covers, and only that.
  const restored = readings.filter((reading) => !coveredSteps.has(brickKey(reading.turn, reading.step)))
  if (restored.length > 0) {
    const folded = boardFromReadings(restored)
    for (const column of folded.columns) {
      const entry = columns.get(column.turn) ?? { turn: column.turn, ended: false, bricks: [] }
      entry.ended = entry.ended || column.ended
      columns.set(column.turn, entry)
      for (const brick of column.bricks) {
        const record = folded.records.get(brick.key)
        if (record === undefined) continue
        entry.bricks.push(brick)
        records.set(brick.key, record)
        titles.set(brick.key, folded.titles.get(brick.key) ?? brick.label)
      }
    }
  }

  const ordered = [...columns.values()].sort((left, right) => left.turn - right.turn)
  for (const column of ordered) column.bricks.sort(byStepThenAttempt)
  return {
    columns: ordered,
    titles,
    records,
    order: [...ordered.flatMap((column) => column.bricks.map((brick) => brick.key)), ...aux.map((brick) => brick.key)],
    aux,
  }
}

/** Board order inside a column: by step, then by attempt so a retry sits after the attempt it replaced. */
function byStepThenAttempt(left: Brick, right: Brick): number {
  return left.step - right.step || left.attempt - right.attempt
}
