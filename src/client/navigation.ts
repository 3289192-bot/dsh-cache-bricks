/**
 * The one way this plugin gets from a brick to the transcript it came from.
 *
 * There used to be two, and neither was a mechanism:
 *
 * - the panel opened from the collected record, and knew nothing about the conversation;
 * - the jump paged history in by clicking the Turn navigator and then the "load older"
 *   control up to eight times, hoping each click would land. It clicked controls that belong
 *   to another component's state machine, and it could not reach anything that navigator
 *   could not — which is most of a long session. Worse, when it stopped short it flashed a
 *   *nearby* row, so a reader was told the request had been found when it had not.
 *
 * The official client session face has the real thing:
 *
 * - `ISession.loadThrough(seq)` — `dsh-api-session-controller`, documented as **the turn-jump
 *   loader**: it pages history backwards until the window covers `seq`, repeated calls lower a
 *   shared target, and `snapshot.loadingOlder` is the busy signal for the whole jump
 *   (`lib/types/client/contract/session.d.ts:130-141`);
 * - `ISession.eventSource` — the observable **contiguous event window**
 *   (`lib/types/client/contract/events.d.ts:57-63`). This is what the inspector reads to show
 *   the conversation around a brick: the durable events themselves, not a scrape of the DOM;
 * - `ISession.getSnapshot()` — `hasMore` / `loadingOlder` (`contract/snapshot.d.ts`).
 *
 * It is reached through the sessions service — "the sessions-service face injected as
 * `ctx.sessions`" (`contract/sessions.d.ts:1-8`), whose binding carries
 * `SessionBinding.session` (`sessions/service.d.ts:76-84`) — and resolved **lazily, at use
 * time**: the service is provided *after* this plugin's client half applies (measured on
 * 0.1.7-rc.1: `undefined` inside `apply`, present two seconds later), so nothing here may
 * be captured at startup.
 *
 * Everything is structural and injectable — the plugin imports none of these packages at
 * runtime — so the whole strategy is testable without a browser.
 */
import type { BrickTarget, HistoricalStepTarget } from './target'

/** One entry of the session's contiguous event window. */
export interface WindowEntry {
  /** `event` is durable, `transient` is a client-only live chunk. */
  readonly type?: string
  readonly event?: {
    readonly type?: string
    readonly seq?: number
    readonly time?: number
    readonly data?: unknown
  }
}

/** The event window, as the session face publishes it. */
export interface WindowSnapshot {
  readonly entries?: readonly WindowEntry[]
  readonly hasMore?: boolean
}

/** The session lifecycle fields a jump cares about. */
export interface SessionSnapshotLike {
  readonly hasMore?: boolean
  readonly loadingOlder?: boolean
}

/** The parts of the official client session this plugin uses. */
export interface SessionFace {
  /** Page history backwards until the window covers `seq`. */
  loadThrough(seq: number): Promise<void>
  getSnapshot?(): SessionSnapshotLike
  eventSource?: { getSnapshot(): WindowSnapshot }
}

/** One durable event with its log position. */
export interface DurableEvent {
  readonly type: string
  readonly seq: number
  readonly time?: number
  readonly data: Record<string, unknown>
}

/**
 * The client session face for one session, when the sessions service can be reached.
 *
 * Structural on purpose: the plugin has no build-time dependency on the session controller,
 * and a core that renames or reshapes the service must degrade to "no loader" rather than
 * throw inside a click handler.
 *
 * @param service - whatever `ctx.get('sessions')` returned, unvalidated.
 * @param sessionId - the session the board is showing.
 * @returns the face, or undefined when this core cannot provide one.
 */
export function sessionFaceOf(service: unknown, sessionId: string | undefined): SessionFace | undefined {
  if (sessionId === undefined || sessionId === '' || service === null || typeof service !== 'object') return undefined
  const binding = (service as { binding?: unknown }).binding
  if (typeof binding !== 'function') return undefined
  let entry: unknown
  try {
    entry = (binding as (id: string) => unknown).call(service, sessionId)
  } catch {
    return undefined
  }
  const session = (entry as { session?: unknown } | null | undefined)?.session
  if (session === null || typeof session !== 'object') return undefined
  if (typeof (session as { loadThrough?: unknown }).loadThrough !== 'function') return undefined
  return session as SessionFace
}

/** Every durable event in the window, oldest first. */
export function durableEventsOf(window: WindowSnapshot | undefined): DurableEvent[] {
  const found: DurableEvent[] = []
  for (const entry of window?.entries ?? []) {
    if (entry.type !== undefined && entry.type !== 'event') continue
    const event = entry.event
    if (event === undefined || typeof event.type !== 'string' || typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq)) continue
    const data = event.data
    found.push({
      type: event.type,
      seq: event.seq,
      ...(event.time === undefined ? {} : { time: event.time }),
      data: data !== null && typeof data === 'object' ? data as Record<string, unknown> : {},
    })
  }
  return found.sort((left, right) => left.seq - right.seq)
}

/** Every durable event the session face is holding right now. */
export function durableEvents(face: SessionFace): DurableEvent[] {
  return durableEventsOf(face.eventSource?.getSnapshot())
}

/**
 * Whether the window the session currently holds covers one log position.
 *
 * `hasMore === false` answers it outright — there is no older history left, so every seq the
 * session has is in the window. Otherwise the window is the log's **tail**, and its oldest
 * event is what the coverage question turns on.
 *
 * @param face - the session face.
 * @param seq - the durable seq the window must reach.
 * @returns true when the window starts at or below `seq`.
 */
export function covers(face: SessionFace, seq: number): boolean {
  const window = face.eventSource?.getSnapshot()
  if (window === undefined) return false
  if (!Number.isSafeInteger(seq) || seq < 1) return false
  const events = durableEventsOf(window)
  const oldest = events[0]
  const newest = events.at(-1)
  return oldest !== undefined && newest !== undefined && oldest.seq <= seq && newest.seq >= seq
}

/** How one load ended: every branch is a different sentence in the panel. */
export type LoadStatus =
  /** The brick has nothing in the transcript to reach (contract target `none`). */
  | 'nothing-to-load'
  /** The row was already rendered: the loader was never asked. */
  | 'not-needed'
  /** The sessions service is not reachable on this core, or has no binding for this session. */
  | 'no-loader'
  /** The record carries no durable seq for this attempt, so there is nothing to page to. */
  | 'no-seq'
  /** The window already covered it: no network, no waiting. */
  | 'already-loaded'
  /** The official loader brought it in. */
  | 'loaded'
  /** The loader was asked and the window still does not cover it. */
  | 'timeout'

/** What one {@link ensureBrickTargetLoaded} call did. */
export interface LoadReport {
  readonly status: LoadStatus
  /** The seq the window had to reach, when the record had one. */
  readonly seq?: number
  /**
   * `false` when the reader also observed that the transcript drew no row for this brick.
   *
   * It is set by the *jump*, not by the loader, and the distinction is the point: a session
   * window that covers a log position is not the same thing as a transcript that renders it.
   * On 0.1.7-rc.1 those two come apart for any turn that has to be paged in, because the
   * conversation's own rebuild throws while flushing the loaded page (see
   * `docs/runtime-contract.md`, "the loaded page does not always render").
   */
  readonly rendered?: boolean
}

/** Timing, injectable so tests need no timers. */
export interface LoadOptions {
  readonly wait?: (ms: number) => Promise<void>
  readonly timeoutMs?: number
  readonly pollMs?: number
}

function defaultWait(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/**
 * What has to be loaded for one brick: the log position, and — when there is none — whether
 * that is because the transcript cannot represent the brick at all.
 */
export interface LoadRequest {
  /** The durable seq the window must cover. */
  readonly seq?: number
  /** A step cannot be rebuilt/read reliably without the beginning of its turn. */
  readonly turn?: number
  /** Why there is nothing to load, when there is nothing. */
  readonly unreachable?: 'nothing-to-load' | 'no-seq'
}

/**
 * The load request for a brick's navigation target.
 * @param target - where the brick belongs.
 * @returns the request, with the reason when no loading can help.
 */
export function loadRequestOf(target: BrickTarget): LoadRequest {
  if (target.kind === 'none') return { unreachable: 'nothing-to-load' }
  return target.loadSeq === undefined ? { unreachable: 'no-seq' } : {
    seq: target.loadSeq, ...('turn' in target ? { turn: target.turn } : {}),
  }
}

/**
 * The load request for reading the turn a brick sits in.
 *
 * A folded brick has no navigation target — nothing in the transcript is *it* — but it is
 * still measured from a real log position, and that is what reading its turn needs.
 *
 * @param seq - the durable seq the record was measured from, when it has one.
 * @returns the request.
 */
export function loadRequestForTurn(seq: number | undefined): LoadRequest {
  return seq === undefined || seq <= 0 ? { unreachable: 'no-seq' } : { seq }
}

/**
 * Make sure the session window covers what a brick needs. **Loading only.**
 *
 * This is the single low-level entry point behind both the inspector and the jump: the
 * inspector calls it to have something to read, the jump calls it to make a row exist. Neither
 * decides anything else here — in particular this never scrolls, never opens a group and never
 * claims a landing.
 *
 * @param face - the session face, or undefined when the service is unreachable.
 * @param request - the log position, or why there is none.
 * @param options - injected timing.
 * @returns what happened, in a form the UI can repeat verbatim.
 */
export async function ensureBrickTargetLoaded(
  face: SessionFace | undefined,
  request: LoadRequest,
  options: LoadOptions = {},
): Promise<LoadReport> {
  if (request.unreachable !== undefined) return { status: request.unreachable }
  const seq = request.seq
  if (seq === undefined || !Number.isSafeInteger(seq) || seq < 1) return { status: 'no-seq' }
  if (face === undefined) return { status: 'no-loader', seq }
  if (covers(face, seq)) return { status: 'already-loaded', seq }

  const wait = options.wait ?? defaultWait
  try {
    await face.loadThrough(seq)
  } catch {
    // A soft failure is the session's own to publish (`snapshot.loadingOlder`, `openError`);
    // the coverage check below still answers the only question asked here.
  }
  const budget = options.timeoutMs ?? 4000
  const poll = options.pollMs ?? 100
  for (let spent = 0; spent < budget; spent += poll) {
    if (covers(face, seq)) return { status: 'loaded', seq }
    await wait(poll)
  }
  return covers(face, seq) ? { status: 'loaded', seq } : { status: 'timeout', seq }
}

/**
 * The settlement may be halfway through a long turn. Page to its real start, not just the
 * settlement, so reading a loaded step does not turn into an empty preview. No DOM writes.
 * The guard stops stale preview requests from initiating further pages after another click.
 */
export async function ensureTurnTranscriptLoaded(
  face: SessionFace | undefined,
  request: LoadRequest,
  isCurrent: () => boolean = () => true,
): Promise<LoadReport> {
  let report = await ensureBrickTargetLoaded(face, request)
  if (face === undefined || request.turn === undefined || request.turn <= 0) return report
  for (let page = 0; page < 24 && isCurrent(); page += 1) {
    const events = durableEvents(face)
    if (events.some((event) => event.type === 'turn/start' && event.data.turn === request.turn)) return report
    const oldest = events[0]?.seq
    if (oldest === undefined || oldest <= 1 || face.eventSource?.getSnapshot().hasMore === false) return report
    if (report.status !== 'loaded' && report.status !== 'already-loaded') return report
    const earlier = await ensureBrickTargetLoaded(face, { seq: oldest - 1 })
    const nextOldest = durableEvents(face)[0]?.seq
    if (nextOldest === undefined || nextOldest >= oldest) return report
    if (earlier.status === 'loaded') report = { ...report, status: 'loaded' }
  }
  return report
}

export interface TranscriptScope {
  /** Host records identify one settled attempt, not the first successful message of a step. */
  readonly exactAttempt?: boolean
  readonly callIds?: readonly string[]
}

/** One thing that entered the turn on the model-visible surface. */
export interface TranscriptInput {
  /** `user` for a human prompt, otherwise the inject source the event named. */
  readonly source: string
  readonly text: string
}

/** One tool call of the step, with the result the log holds for it. */
export interface TranscriptCall {
  readonly callId: string
  readonly name: string
  /** Raw argument JSON, exactly as the model produced it. */
  readonly args: string
  readonly result?: string
  readonly isError?: boolean
}

/** The conversation around one brick, read from the durable log. */
export interface TranscriptView {
  readonly turn: number
  readonly step: number
  /** What entered the turn: the human prompt, and any injected context. */
  readonly inputs: readonly TranscriptInput[]
  readonly reasoning: string
  readonly text: string
  /**
   * Which durable event carried this step's assistant half.
   *
   * `attempt` is the honest case where an attempt settled without committing a message — a
   * failed or retried one — so there is no assistant text to show and the panel says that
   * instead of showing an empty box.
   */
  readonly assistant: 'message' | 'attempt' | 'none'
  readonly calls: readonly TranscriptCall[]
  /** Whether the window covers the brick's own seq; false means "not loaded that far yet". */
  readonly covers: boolean
  /** True when the beginning of the turn is present in the window. */
  readonly loaded: boolean
}

/** The rows a folded step can resolve to: the three that name a place in a Turn. */
type ResolvedStepRow = Extract<BrickTarget, { kind: 'assistant-step' | 'tool-call' | 'retry-chain' }>

/**
 * What a folded step actually became, read from the durable log.
 *
 * A folded brick knows its `(turn, step)` and the log position it was measured from — and the
 * session's own log is the authority on what happened there. So the question "where does this
 * brick go?" is answerable without any collector state: load that position, read the step, and
 * land on the row it produced. The decision mirrors `targetOf` for collected records, on
 * purpose — the two paths must not disagree about which row a step with a message, a call and a
 * retry belongs to:
 *
 * 1. a retry chain wins, because that is the only row that shows the attempts together;
 * 2. otherwise the message's own half: reasoning if the step thought, response if it only spoke;
 * 3. otherwise the first tool call — a step that only called tools has no assistant row at all;
 * 4. otherwise `undefined`, and the reveal falls back to the Turn itself, reported as `context`.
 *    Never a neighbouring step: "near enough" is what this whole module exists to refuse.
 *
 * @param face - the session face, or undefined when this core has none.
 * @param target - the folded brick's target.
 * @returns the concrete row, or undefined when the log offers none (not loaded far enough yet,
 *   or a step that produced neither a message nor a call).
 */
export function resolveHistoricalStep(
  face: SessionFace | undefined,
  target: HistoricalStepTarget,
): BrickTarget | undefined {
  if (face === undefined) return undefined
  const { turn, step } = target
  const loadSeq = target.loadSeq
  // The same log position the step was measured from: whatever row this step became is at or
  // before it, so carrying it keeps one load answering both "which row" and "how far back".
  const seq = (resolved: ResolvedStepRow): ResolvedStepRow => (loadSeq === undefined ? resolved : { ...resolved, loadSeq })
  // The retry schedule is durable, and it is about this step. `turn`/`step` are optional on
  // the event, so an event that names only a retry id is not evidence about this step.
  const retry = durableEvents(face).find((event) => event.type === 'llm/retry'
    && event.data.turn === turn && event.data.step === step && typeof event.data.retryId === 'string')
  if (retry !== undefined) {
    return seq({ kind: 'retry-chain', turn, step, retryId: retry.data.retryId as string })
  }
  const view = readTranscript(face, turn, step, loadSeq)
  if (view === undefined) return undefined
  if (view.reasoning !== '') return seq({ kind: 'assistant-step', turn, step, part: 'reasoning' })
  if (view.text !== '') return seq({ kind: 'assistant-step', turn, step, part: 'response' })
  const callId = view.calls[0]?.callId
  if (callId !== undefined) return seq({ kind: 'tool-call', turn, step, callId })
  return undefined
}

/** The text of the blocks of one kind in a message's content, in order. */
function blockText(content: unknown, kind: 'text' | 'reasoning'): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const typed = block as { type?: unknown; text?: unknown }
    if (typed.type !== kind || typeof typed.text !== 'string') continue
    if (typed.text !== '') parts.push(typed.text)
  }
  return parts.join('\n')
}

/** A message's own content, split into what was thought and what was said. */
function messageText(message: unknown): { reasoning: string; text: string } {
  const content = (message as { content?: unknown } | null | undefined)?.content
  return { reasoning: blockText(content, 'reasoning'), text: blockText(content, 'text') }
}

/** The `source` a user-role event carried, for the label above its text. */
function inputSource(data: Record<string, unknown>): string {
  const source = data.source
  if (typeof source === 'string' && source !== '') return source
  if (source !== null && typeof source === 'object') {
    const kind = (source as { source?: unknown; kind?: unknown }).source ?? (source as { kind?: unknown }).kind
    if (typeof kind === 'string' && kind !== '') return kind
  }
  return 'user'
}

/**
 * Read the conversation around a brick out of the session's own event window.
 *
 * This is the inspector's other half: the tile already holds everything the *collector*
 * measured, and this holds what the *session* recorded — the prompt that started the turn,
 * the assistant content this step committed, and the calls it made with their results. No
 * DOM is read and nothing is inferred: fields that are not in the window come back empty,
 * and `loaded` says whether the turn was there at all.
 *
 * @param face - the session face.
 * @param turn - the Turn to read.
 * @param step - the step inside it.
 * @param seq - the durable seq this brick was measured from, for the coverage answer.
 * @returns the view, or undefined when there is no turn to read (an auxiliary call).
 */
export function readTranscript(
  face: SessionFace,
  turn: number,
  step: number,
  seq: number | undefined,
  scope: TranscriptScope = {},
): TranscriptView | undefined {
  if (turn <= 0) return undefined
  const events = durableEvents(face)
  const turnStart = events.findIndex((event) => event.type === 'turn/start' && event.data.turn === turn)
  const afterTurn = turnStart === -1
    ? -1
    : events.findIndex((event, index) => index > turnStart && event.type === 'turn/start')
  const inTurn = turnStart === -1
    ? events.filter((event) => event.data.turn === turn)
    : events.slice(turnStart, afterTurn === -1 ? undefined : afterTurn)
  const inStep = inTurn.filter((event) => event.data.turn === turn && event.data.step === step)

  const inputs: TranscriptInput[] = []
  for (const event of inTurn) {
    if (event.type !== 'user/message' || (seq !== undefined && event.seq > seq)) continue
    inputs.push({ source: inputSource(event.data), text: blockText((event.data as { content?: unknown }).content, 'text') })
  }

  const matchesAttempt = (event: DurableEvent): boolean => scope.exactAttempt === true
    ? seq !== undefined && event.seq === seq
    : seq === undefined || event.seq <= seq
  const settled = inStep.filter((event) => event.type === 'assistant/message' && matchesAttempt(event)).at(-1)
  const attempted = inStep.filter((event) => event.type === 'assistant/attempt' && matchesAttempt(event)).at(-1)
  const message = settled === undefined ? undefined : messageText((settled.data as { message?: unknown }).message)
  const assistant: TranscriptView['assistant'] = settled !== undefined ? 'message' : attempted === undefined ? 'none' : 'attempt'

  const results = new Map<string, { text: string; isError: boolean }>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const message_ = event.data.message as { content?: unknown; toolCallId?: unknown; isError?: unknown } | undefined
    const callId = message_?.toolCallId
    if (typeof callId !== 'string') continue
    results.set(callId, { text: blockText(message_?.content, 'text'), isError: message_?.isError === true })
  }
  const calls: TranscriptCall[] = []
  for (const event of inStep) {
    if (event.type !== 'tool/call') continue
    const callId = event.data.callId
    if (typeof callId !== 'string' || (scope.callIds !== undefined && !scope.callIds.includes(callId))) continue
    const result = results.get(callId)
    calls.push({
      callId,
      name: typeof event.data.name === 'string' ? event.data.name : '',
      args: typeof event.data.arguments === 'string' ? event.data.arguments : event.data.arguments == null ? '' : JSON.stringify(event.data.arguments, null, 2),
      ...(result === undefined ? {} : { result: result.text, isError: result.isError }),
    })
  }

  return {
    turn,
    step,
    inputs,
    reasoning: message?.reasoning ?? '',
    text: message?.text ?? '',
    assistant,
    calls,
    covers: seq === undefined ? false : covers(face, seq),
    loaded: turnStart !== -1,
  }
}
