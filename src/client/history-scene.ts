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
import type { BrickFeed } from '../shared/brick'
import { BlobStore } from '../core/blob-store'
import { replaySession } from '../core/replay'
import type { BoardColumn, BoardMetrics, BoardWindow } from './tetris'
import type { DurableEvent } from './navigation'
import type { BrickRecord } from '../shared/brick'

/** One Turn's slice of the screen: the steps its visible rows hold. */
export interface SceneTurn {
  readonly turn: number
  /** First step the scene wants, inclusive. */
  readonly fromStep: number
  /** Last step the scene wants, inclusive. */
  readonly toStep: number
}

/**
 * What the board is looking at.
 *
 * Steps, not rows: a row is a rendering decision that changes when a retry adds a brick,
 * while a step is the identity the log is keyed by. Sending steps keeps the request stable
 * across exactly the changes that would otherwise make it flicker.
 */
export interface SceneDemand {
  readonly turns: readonly SceneTurn[]
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
export const SCENE_STEP_QUANTUM = 8

/** Snap a demand outward to the scene quantum, so small scrolls ask the same question. */
export function quantizeDemand(demand: SceneDemand): SceneDemand {
  const turns: SceneTurn[] = []
  for (const turn of demand.turns) {
    if (turn.fromStep > turn.toStep) continue
    turns.push({
      turn: turn.turn,
      fromStep: Math.floor(turn.fromStep / SCENE_STEP_QUANTUM) * SCENE_STEP_QUANTUM,
      toStep: Math.floor(turn.toStep / SCENE_STEP_QUANTUM) * SCENE_STEP_QUANTUM + (SCENE_STEP_QUANTUM - 1),
    })
  }
  turns.sort((left, right) => left.turn - right.turn || left.fromStep - right.fromStep)
  return { turns }
}

/** A demand's identity, for memoising the scene it produced. */
export function sceneKeyOf(demand: SceneDemand): string {
  if (demand.turns.length === 0) return 'empty'
  let key = ''
  for (const turn of demand.turns) {
    key += `${String(turn.turn)}:${String(turn.fromStep)}-${String(turn.toStep)},`
  }
  return key
}

/** Where one step's events live in the window. */
export interface StepSpan {
  readonly turn: number
  readonly step: number
  /** The `step/start` seq — the earliest event that belongs to this step. */
  readonly startSeq: number
  /**
   * The `step/end` seq, or the last event of the window while the step is still running.
   *
   * A running step is left open on purpose: the live collector owns that attempt, and a
   * replay of a step that has not settled would be a second, poorer copy of it.
   */
  readonly endSeq: number
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
  readonly key: string
  readonly events: readonly DurableEvent[]
  readonly oldestSeq: number
  readonly newestSeq: number
  /** Steps the scan actually bounded (a step with neither start nor end marker is not one). */
  readonly spanCount: number
  /** The step's span, or undefined when the window does not hold that step. */
  readonly spanAt: (turn: number, step: number) => StepSpan | undefined
  /** `turn/end` seq by Turn. */
  readonly turnEnds: ReadonlyMap<number, number>
  /** Seqs of the `request/header` events, ascending. */
  readonly headerSeqs: readonly number[]
  /** Seqs of the `request/context` events, ascending. */
  readonly contextSeqs: readonly number[]
}

/** `${turn}:${step}` — the key a span is filed under. */
function stepKey(turn: number, step: number): string {
  return `${String(turn)}:${String(step)}`
}

/** Identity of a durable window: what it holds, not how it was read. */
export function windowKeyOf(events: readonly DurableEvent[]): string {
  if (events.length === 0) return 'empty'
  return `${String(events.length)}|${String(events[0]!.seq)}|${String(events[events.length - 1]!.seq)}`
}

/**
 * The mutable side of a scene index: one pass over events, and the state a second pass can extend.
 *
 * A window that only *grew* at one end does not need a new scan of everything it holds — the log is
 * append-only, and an event that was already in the window says the same thing it said before. The
 * builder is what makes that true: `indexEvents` is one `feed` followed by `freeze`, and a page
 * landing is `prepend`/`feed` of the new events followed by `freeze` again. Without it,
 * `loadOlder()` re-read the whole window to learn about one page of it.
 */
class SceneIndexBuilder {
  private readonly spans = new Map<string, { turn: number; step: number; startSeq: number; endSeq: number }>()
  private readonly open = new Map<string, { turn: number; step: number; startSeq: number }>()
  private readonly turnEnds = new Map<number, number>()
  private headerSeqs: number[] = []
  private contextSeqs: number[] = []
  private oldest = 0
  private newest = 0

  /** First and last seq this builder has been fed, ascending by construction. */
  get bounds(): { oldest: number; newest: number } {
    return { oldest: this.oldest, newest: this.newest }
  }

  /**
   * Take events in ascending seq order, on top of whatever this builder already holds.
   *
   * A step's span is opened with its own start as a placeholder end: a step that is still running
   * when the window ends is closed at the window's last seq by {@link freeze}, which is the same
   * rule the one-shot scan used.
   */
  feed(events: readonly DurableEvent[]): void {
    for (const event of events) {
      const data = event.data
      if (this.oldest === 0 || event.seq < this.oldest) this.oldest = event.seq
      if (event.seq > this.newest) this.newest = event.seq
      switch (event.type) {
        case 'step/start': {
          const { turn, step } = data as { turn?: unknown; step?: unknown }
          if (typeof turn !== 'number' || typeof step !== 'number') break
          const key = stepKey(turn, step)
          const pending = { turn, step, startSeq: event.seq }
          this.open.set(key, pending)
          // A repeated `step/start` (a resumed step) restarts the bracket: the first one is kept,
          // so the slice still reaches back to where the step's events begin.
          if (!this.spans.has(key)) this.spans.set(key, { ...pending, endSeq: event.seq })
          break
        }
        case 'step/end': {
          const { turn, step } = data as { turn?: unknown; step?: unknown }
          if (typeof turn !== 'number' || typeof step !== 'number') break
          const key = stepKey(turn, step)
          const span = this.spans.get(key)
          if (span === undefined) {
            // An end without a start still names a step: keep it as a zero-width span rather than
            // dropping events that belong to it.
            this.spans.set(key, { turn, step, startSeq: event.seq, endSeq: event.seq })
          } else {
            span.endSeq = event.seq
          }
          this.open.delete(key)
          break
        }
        case 'turn/end': {
          const turn = data.turn
          if (typeof turn === 'number') this.turnEnds.set(turn, event.seq)
          break
        }
        case 'request/header':
          this.headerSeqs.push(event.seq)
          break
        case 'request/context':
          this.contextSeqs.push(event.seq)
          break
        default:
          break
      }
    }
  }

  /**
   * Take events older than everything fed so far.
   *
   * The two carried-seq lists are kept ascending by sorting after the fact: they hold one entry per
   * request series, so this is a handful of numbers, while the alternative — rebuilding the index —
   * is the whole window again.
   */
  prepend(events: readonly DurableEvent[]): void {
    this.feed(events)
    this.headerSeqs.sort((left, right) => left - right)
    this.contextSeqs.sort((left, right) => left - right)
  }

  /** Freeze what has been fed into an index, closing the steps the window ends inside. */
  freeze(events: readonly DurableEvent[], key: string): SceneIndex {
    for (const [step, pending] of this.open) {
      const span = this.spans.get(step)
      if (span !== undefined) span.endSeq = this.newest === 0 ? pending.startSeq : this.newest
    }
    const spans = this.spans
    const turnEnds = this.turnEnds
    return {
      key,
      events,
      oldestSeq: this.oldest,
      newestSeq: this.newest,
      spanCount: spans.size,
      spanAt: (turn, step) => spans.get(stepKey(turn, step)),
      turnEnds,
      headerSeqs: this.headerSeqs,
      contextSeqs: this.contextSeqs,
    }
  }
}

/** A builder, for a caller that keeps an index across window changes (see `HistoryScene`). */
export function sceneIndexBuilder(): SceneIndexBuilder {
  return new SceneIndexBuilder()
}

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
export function indexEvents(events: readonly DurableEvent[], key: string = windowKeyOf(events)): SceneIndex {
  const builder = new SceneIndexBuilder()
  builder.feed(events)
  return builder.freeze(events, key)
}

/** What one {@link sceneSlice} handed to the replay. */
export interface SceneSlice {
  readonly events: readonly DurableEvent[]
  /**
   * The header and context events carried into the slice, in that order, when the window holds
   * them: the sticky facts a bracket cannot carry (see {@link sceneSlice}).
   */
  readonly carried: readonly number[]
  /** The first seq the demand asked for, before the carried events: what "in force" is relative to. */
  readonly firstSeq: number
  /** Steps the slice actually covers (the demand may name steps the window never held). */
  readonly spans: number
  /** Settlement events in the slice — one per attempt — used to size the ledger budget. */
  readonly attempts: number
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
  readonly demand: SceneDemand
  /** Identity of the plan: equal keys mean the same scene, so nothing needs re-cutting. */
  readonly key: string
  /** Columns hidden to the left of the window, for the caller's prefetch decision. */
  readonly older: number
}

/**
 * Plan the scene a window is showing.
 *
 * @param columns - every known Turn column, oldest first.
 * @param window - the window on screen, with its own index range.
 * @param metrics - board geometry, for the overscan on each axis.
 * @returns the demand, its key, and how much history is hidden to the left.
 */
export function scenePlanOf(
  columns: readonly BoardColumn[],
  window: BoardWindow,
  metrics: BoardMetrics,
): ScenePlan {
  const overscanColumns = metrics.columns
  const overscanRows = Math.max(2, Math.ceil(window.limit / 2))
  const first = Math.max(0, window.columnStart - overscanColumns)
  const last = Math.min(columns.length, window.columnEnd + overscanColumns)
  const from = Math.max(0, window.rowStart - overscanRows)
  const to = window.rowEnd + overscanRows
  const turns: SceneTurn[] = []
  for (let index = first; index < last; index += 1) {
    const column = columns[index]!
    if (column.turn <= 0) continue
    const end = Math.min(column.bricks.length, to)
    if (end <= from) {
      const top = column.bricks[column.bricks.length - 1]
      if (top !== undefined) turns.push({ turn: column.turn, fromStep: top.step, toStep: top.step })
      continue
    }
    turns.push({
      turn: column.turn,
      fromStep: column.bricks[from]!.step,
      toStep: column.bricks[end - 1]!.step,
    })
  }
  return { demand: { turns }, key: sceneKeyOf(quantizeDemand({ turns })), older: window.older }
}

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
export function prefetchDue(window: BoardWindow, metrics: BoardMetrics): boolean {
  return window.older <= Math.max(2, metrics.columns)
}
/** The seqs a slice is made of, merged into as few ascending ranges as possible. */
function mergeRanges(ranges: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const sorted = ranges.filter((range) => range.to >= range.from).sort((left, right) => left.from - right.from)
  const merged: Array<{ from: number; to: number }> = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.from <= last.to + 1) last.to = Math.max(last.to, range.to)
    else merged.push({ ...range })
  }
  return merged
}

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
export function sceneSlice(index: SceneIndex, demand: SceneDemand): SceneSlice {
  const ranges: Array<{ from: number; to: number }> = []
  let spans = 0
  let firstSeq = Number.POSITIVE_INFINITY
  for (const requested of demand.turns) {
    for (const step of stepsBetween(index, requested)) {
      const span = index.spanAt(requested.turn, step)
      if (span === undefined) continue
      spans += 1
      ranges.push({ from: span.startSeq, to: span.endSeq })
      if (span.startSeq < firstSeq) firstSeq = span.startSeq
    }
    const end = index.turnEnds.get(requested.turn)
    if (end !== undefined) ranges.push({ from: end, to: end })
  }
  if (ranges.length === 0) return { events: [], carried: [], firstSeq: 0, spans: 0, attempts: 0 }

  // The header and the context in force where the slice begins — one of each, because they are
  // two different sticky facts written by two different events. Without them a sliced brick
  // would quietly disagree with the same brick replayed from the whole window: no route, no
  // tool declarations, no system hash.
  const carried: number[] = []
  for (const seqs of [index.headerSeqs, index.contextSeqs]) {
    for (let at = seqs.length - 1; at >= 0; at -= 1) {
      const seq = seqs[at]!
      if (seq <= firstSeq) { carried.push(seq); break }
    }
  }

  const merged = mergeRanges(ranges)
  const events: DurableEvent[] = []
  let attempts = 0
  // Only the events inside the ranges are visited: the first range's start is found by binary
  // search, and the walk stops at the last range's end. A scene therefore costs the scene, not
  // the window it was cut from.
  for (const seq of carried) {
    const carriedEvent = findBySeq(index.events, seq)
    if (carriedEvent !== undefined) events.push(carriedEvent)
  }
  // Each range is walked on its own. The old loop started at the first range and ran to the last
  // one, testing every event in between — so a screen showing six Turns near the end of a
  // hundred-thousand-event window read the whole stretch between them to build a slice of a few
  // hundred events. The ranges are merged and disjoint, so this is the same set of events.
  for (const range of merged) {
    for (let at = firstAtOrAfter(index.events, range.from); at < index.events.length; at += 1) {
      const event = index.events[at]!
      if (event.seq > range.to) break
      if (carried.includes(event.seq)) continue
      if (event.type === 'assistant/message' || event.type === 'assistant/attempt') attempts += 1
      events.push(event)
    }
  }
  // Carried header/context events must be in force before the attempts they govern, so the
  // slice is presented in seq order — which is the order the replay reads it in anyway.
  events.sort((left, right) => left.seq - right.seq)
  return { events, carried, firstSeq, spans, attempts }
}

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
export function stepVersionKey(
  turn: number,
  step: number,
  startSeq: number,
  endSeq: number,
  carried: readonly number[],
): string {
  return `${String(turn)}:${String(step)}|${String(startSeq)}-${String(endSeq)}|h${String(carried[0] ?? 0)}|c${String(carried[1] ?? 0)}`
}

/**
 * The events one step's replay needs: its own bracket plus the sticky facts, in seq order.
 *
 * Nothing else — the replay reads a closed alphabet, and a slice that carried its neighbours would
 * make the step's cache key a lie.
 *
 * @param index - the window's index.
 * @param startSeq - the step's first seq.
 * @param endSeq - the step's last seq.
 * @param carried - the header and context seqs in force.
 * @returns the events, oldest first.
 */
function stepSlice(index: SceneIndex, startSeq: number, endSeq: number, carried: readonly number[]): DurableEvent[] {
  const events: DurableEvent[] = []
  for (const seq of carried) {
    const event = findBySeq(index.events, seq)
    if (event !== undefined) events.push(event)
  }
  for (let at = firstAtOrAfter(index.events, startSeq); at < index.events.length; at += 1) {
    const event = index.events[at]!
    if (event.seq > endSeq) break
    if (carried.includes(event.seq)) continue
    events.push(event)
  }
  events.sort((left, right) => left.seq - right.seq)
  return events
}

/** Attempts an event list holds, for the ledger's own budget. */
function countAttempts(events: readonly DurableEvent[]): number {
  let attempts = 0
  for (const event of events) {
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') attempts += 1
  }
  return attempts
}

/** Board order of assembled bricks: by Turn, then step, then attempt. */
function byIdentity(left: BrickRecord, right: BrickRecord): number {
  const turn = left.identity.turn - right.identity.turn
  if (turn !== 0) return turn
  const step = left.identity.step - right.identity.step
  if (step !== 0) return step
  return left.identity.attemptOrdinal - right.identity.attemptOrdinal
}

/** The event at a seq, when the window holds it. */
function findBySeq(events: readonly DurableEvent[], seq: number): DurableEvent | undefined {
  const at = firstAtOrAfter(events, seq)
  return events[at]?.seq === seq ? events[at] : undefined
}

/** Index of the first event at or after `seq` (the window is sorted by seq). */
function firstAtOrAfter(events: readonly DurableEvent[], seq: number): number {
  let low = 0
  let high = events.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (events[mid]!.seq < seq) low = mid + 1
    else high = mid
  }
  return low
}

function stepsBetween(index: SceneIndex, requested: SceneTurn): number[] {
  const steps: number[] = []
  for (let step = requested.fromStep; step <= requested.toStep; step += 1) {
    if (index.spanAt(requested.turn, step) !== undefined) steps.push(step)
  }
  return steps
}

/** Options for {@link HistoryScene}. */
export interface HistorySceneOptions {
  readonly sessionId: string
  /** Scenes kept warm. Three is one screen back, one live, one prefetch ahead. */
  readonly maxScenes?: number
  /** How many steps' exact replays to keep (see {@link HistoryScene.maxSteps}). */
  readonly maxSteps?: number
  /** Raw-payload budget shared by every scene this object replays. */
  readonly maxTotalBytes?: number
}

/** What one scene produced, so the caller can tell a new answer from a memoised one. */
export interface SceneRead {
  readonly key: string
  readonly feed: BrickFeed
  readonly spans: number
  readonly attempts: number
  readonly cached: boolean
}

/**
 * The scene cache: the durable window, indexed once, replayed a screen at a time.
 *
 * A scene is memoised on `window ⊕ demand`, so panning back over ground already covered is a
 * map lookup, and a page landing (which changes the window) invalidates every scene at once
 * rather than leaving stale ones to be mistaken for current.
 */
/** One step's exact replay, cached by the versions that make it deterministic. */
interface StepRead {
  readonly key: string
  readonly bricks: readonly BrickRecord[]
  readonly attempts: number
}

export class HistoryScene {
  readonly sessionId: string
  private readonly maxScenes: number
  /**
   * How many steps' exact replays to keep.
   *
   * A scene is a *view*: three of them is a sensible cache for a window, but a step is a **fact**
   * — a finished step's events never change again — so caching at scene granularity threw away
   * work that could never go stale. Two neighbouring scenes overlap by most of their steps, and
   * panning back over ground already covered replayed all of it. The step cache is what makes a
   * step cost its own replay exactly once per version.
   */
  private readonly maxSteps: number
  private readonly stepCache = new Map<string, StepRead>()
  private readonly store: BlobStore
  private readonly scenes = new Map<string, SceneRead>()
  private readonly listeners = new Set<() => void>()
  private index: SceneIndex | undefined
  /** The builder the live index was frozen from: a window that only grew extends this one. */
  private builder = sceneIndexBuilder()
  private current: SceneRead | undefined
  private lastDemand: SceneDemand | undefined
  /**
   * What this service has cost so far.
   *
   * Read by the verification scripts through the read-only handle in `index.tsx`, and by nothing
   * else: a demand's price is a *count* before it is a duration — how many windows were re-indexed,
   * how many demands were answered from the memo, and how much of the log each replay was handed.
   * `replayMs` is the one duration kept here, because the alternative is timing a whole frame in a
   * headless browser, which says more about the machine than about the board.
   */
  readonly stats = {
    /** Times the window was scanned in full — the O(window) path, which growth must not take. */
    windows: 0,
    /** Times a window that only grew at an end was indexed by its growth alone. */
    windowDeltas: 0,
    /** Events a delta actually had to read. */
    indexDeltaEvents: 0,
    demands: 0,
    cached: 0,
    assembled: 0,
    replays: 0,
    sliceEvents: 0,
    replayMs: 0,
  }
  /**
   * What the step cache did, in counts.
   *
   * `hits` is the number of steps a scene did not have to replay at all — the number that grows
   * with how much of this session the reader has already looked at, and the one a pan should move
   * instead of `replays`. `misses` is the new ground. Read by `scripts/test-scroll.mjs` through
   * `window.__dshCacheBricksStats()`.
   */
  readonly stepStats = { hits: 0, misses: 0, evictions: 0 }

  constructor(options: HistorySceneOptions) {
    this.sessionId = options.sessionId
    this.maxScenes = Math.max(1, options.maxScenes ?? 3)
    this.maxSteps = Math.max(1, options.maxSteps ?? 4_096)
    this.store = new BlobStore(options.maxTotalBytes === undefined ? {} : { maxTotalBytes: options.maxTotalBytes })
  }

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
  window(events: readonly DurableEvent[], key: string = windowKeyOf(events)): boolean {
    if (this.index?.key === key) return false
    this.builder = sceneIndexBuilder()
    this.builder.feed(events)
    this.index = this.builder.freeze(events, key)
    this.stats.windows += 1
    return this.recut()
  }

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
  windowGrew(older: readonly DurableEvent[], newer: readonly DurableEvent[], key: string): boolean {
    if (this.index?.key === key) return false
    const previous = this.index?.events ?? []
    if (older.length > 0) this.builder.prepend(older)
    if (newer.length > 0) this.builder.feed(newer)
    const events = older.length === 0 && newer.length === 0
      ? previous
      : [...older, ...previous, ...newer]
    this.index = this.builder.freeze(events, key)
    this.stats.windowDeltas += 1
    this.stats.indexDeltaEvents += older.length + newer.length
    return this.recut()
  }

  /** The seq range the index covers, for a caller that can tell growth from a different window. */
  get windowBounds(): { oldest: number; newest: number } | undefined {
    return this.index === undefined ? undefined : this.builder.bounds
  }

  /** Durable events the index holds, for the caller's growth check. */
  get indexedCount(): number {
    return this.index?.events.length ?? 0
  }

  /**
   * Drop the scenes and re-cut the reader's screen.
   *
   * Scenes belong to the window that produced them, so they go — but the *steps* they were
   * assembled from do not: their keys are seq versions, so a page landing costs the new ground and
   * the screen the reader is on comes back from the step cache.
   */
  private recut(): boolean {
    this.scenes.clear()
    this.current = undefined
    const last = this.lastDemand
    if (last !== undefined) this.replay(last)
    return true
  }

  /**
   * The identity of the window this scene is holding, or undefined before the first
   * {@link window}.
   *
   * Read by the render path to answer "did the window move?" without copying it — the comparison
   * the scene used to make *after* `durableEvents` had already walked and sorted the whole
   * session.
   */
  get indexKey(): string | undefined {
    return this.index?.key
  }

  /** The index for the window last noted, or undefined before the first {@link window}. */
  get currentIndex(): SceneIndex | undefined {
    return this.index
  }

  /** The scene last produced, or undefined when nothing has been demanded yet. */
  get scene(): SceneRead | undefined {
    return this.current
  }

  /**
   * Replay the scene a demand describes, from cache when it has been asked for already.
   *
   * @param demand - the Turns and steps on screen.
   * @returns the scene, or undefined when the window holds no step the demand names.
   */
  demand(demand: SceneDemand): SceneRead | undefined {
    this.stats.demands += 1
    this.lastDemand = demand
    const before = this.current?.key
    const read = this.replay(demand)
    if (read !== undefined && read.key !== before) this.notify()
    return read
  }

  /** Drop every scene (the window changed underneath them). */
  invalidate(): void {
    this.scenes.clear()
    this.current = undefined
    this.index = undefined
    this.builder = sceneIndexBuilder()
    this.lastDemand = undefined
    this.notify()
  }

  /** Watch for a new scene, so a React tree can re-render when one arrives. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Announce the scene currently held.
   *
   * For a caller that knows the ground moved under it — a page landing, a jump — and wants the
   * new answer read. Calling it when nothing changed is free: an external store skips a render
   * whose snapshot is identical.
   */
  refresh(): void {
    this.notify()
  }

  /** Raw payloads of every scene, shared so two scenes that share a prefix share the bytes. */
  get blobStore(): BlobStore {
    return this.store
  }

  /** Cut, replay and memoise one scene. Notifies nobody: the caller decides what that means. */
  private replay(demand: SceneDemand): SceneRead | undefined {
    const index = this.index
    if (index === undefined) return undefined
    const quantized = quantizeDemand(demand)
    const key = `${index.key}#${sceneKeyOf(quantized)}`
    const cached = this.scenes.get(key)
    if (cached !== undefined) {
      // Re-insert so the map's order stays least-recently-used, and hand back a read that says
      // it came from the cache — the stored object is the memo, not a claim about this call.
      this.scenes.delete(key)
      this.scenes.set(key, cached)
      this.stats.cached += 1
      const hit: SceneRead = { ...cached, cached: true }
      this.current = hit
      return hit
    }
    const slice = sceneSlice(index, quantized)
    if (slice.spans === 0) return this.current
    // A scene materialization: the memo missed, so this screen is (re)assembled out of its steps —
    // `replays` counts the steps that were new, this counts the screens that were cut.
    this.stats.assembled += 1
    const started = performance.now()
    // Assemble the scene out of steps: a step already replayed under the same header, context and
    // seq range is a fact, and re-cutting the screen must not re-derive it. Only the steps whose
    // version is new are replayed, and they are replayed *alone* — the slice a step needs is its
    // own bracket plus the two sticky facts, which is exactly what makes its key stable.
    const carried = slice.carried
    const bricks: BrickRecord[] = []
    const endedTurns = new Set<number>()
    for (const requested of quantized.turns) {
      if (index.turnEnds.has(requested.turn)) endedTurns.add(requested.turn)
      for (const step of stepsBetween(index, requested)) {
        const span = index.spanAt(requested.turn, step)
        if (span === undefined) continue
        const stepKey = stepVersionKey(requested.turn, step, span.startSeq, span.endSeq, carried)
        const hit = this.stepCache.get(stepKey)
        if (hit !== undefined) {
          this.stepStats.hits += 1
          for (const brick of hit.bricks) bricks.push(brick)
          continue
        }
        this.stepStats.misses += 1
        const events = stepSlice(index, span.startSeq, span.endSeq, carried)
        const stepStarted = performance.now()
        const report = replaySession(this.sessionId, events, {
          store: this.store,
          // A step cannot exceed its own attempts: the budget exists so the ledger cannot grow with
          // the session, and one step is bounded by the model's own retry count. The small margin
          // keeps an unsettled draft from being evicted mid-replay.
          maxBricks: countAttempts(events) + 8,
          // `stepSlice` presents its events in seq order, so the replay must not copy the array and
          // sort it again: that copy is pure garbage on a slice that is already ordered.
          ordered: true,
          // Nobody asked for this step's raw payloads — the reader asked for a board. They are the
          // session's own events, still in the client's window, and `navigation.ts` hands them to
          // the panel by seq when someone opens one. Hashing them here cost a digest per attempt,
          // per tool result and per header on the drawing thread, for bytes nothing was waiting for.
          raw: 'lazy',
        })
        this.stats.replays += 1
        this.stats.sliceEvents += events.length
        this.stats.replayMs += performance.now() - stepStarted
        const exact = report.feed.bricks.filter((brick) => brick.identity.turn === requested.turn && brick.identity.step === step)
        this.remember(stepKey, exact)
        for (const brick of exact) bricks.push(brick)
      }
    }
    bricks.sort(byIdentity)
    this.stats.replayMs += performance.now() - started - this.stats.replayMs + this.stats.replayMs
    const read: SceneRead = {
      key,
      feed: {
        sessionId: this.sessionId,
        bricks,
        endedTurns: [...endedTurns].sort((left, right) => left - right),
        store: this.store.stats(),
      },
      spans: slice.spans,
      attempts: slice.attempts,
      cached: false,
    }
    this.scenes.set(key, read)
    while (this.scenes.size > this.maxScenes) {
      const oldest = this.scenes.keys().next()
      if (oldest.done === true) break
      this.scenes.delete(oldest.value)
    }
    this.current = read
    return read
  }

  /** Remember one step's replay, evicting the least recently added when the cache is full. */
  private remember(key: string, bricks: readonly BrickRecord[]): void {
    this.stepCache.set(key, { key, bricks, attempts: bricks.length })
    while (this.stepCache.size > this.maxSteps) {
      const oldest = this.stepCache.keys().next()
      if (oldest.done === true) break
      this.stepCache.delete(oldest.value)
      this.stepStats.evictions += 1
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
