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
import type { LoadReport, LoadRequest, LoadStatus } from './navigation'
import { loadRequestOf } from './navigation'
import type { BrickTarget, RevealAccuracy, RevealRow } from './target'
import { accuracyOf, loadSeqOf } from './target'
import { revealTarget } from './tetris'

/** The parts of an element this module uses. */
export interface RevealElement {
  getBoundingClientRect(): RevealRect
  getAttribute?(name: string): string | null
  click?(): void
  /** Fire an event at the element; used for the Chat view's `beforematch` reveal. */
  dispatchEvent?(event: Event): boolean
  readonly parentElement?: RevealElement | null
  readonly isConnected?: boolean
  readonly disabled?: boolean
  readonly textContent?: string | null
  readonly classList?: { readonly length?: number }
}

/** The parts of an element rect this module uses. */
export interface RevealRect {
  readonly top: number
  /**
   * Laid-out height. A node inside a collapsed process group is in the DOM with
   * zero height, which is how "rendered but not shown" is recognised.
   */
  readonly height?: number
}

/** The parts of the scroll container this module uses. */
export interface RevealScroller {
  querySelector(selector: string): RevealElement | null
  querySelectorAll(selector: string): ArrayLike<RevealElement>
  getBoundingClientRect(): { readonly top: number }
  scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
  scrollTo(options: { top: number; behavior?: 'smooth' | 'auto' }): void
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
  readonly accuracy: RevealAccuracy
  /** Which kind of row was reached. */
  readonly row: RevealRow
  /** What the official loader did on the way, repeated verbatim by the panel. */
  readonly load: LoadReport
  /** True when a collapsed process group (or a `hidden="until-found"` row) had to be opened. */
  readonly expanded: boolean
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
  readonly fellBack?: true
  /** The row that was reached, when one was. */
  readonly element?: RevealElement
}

export interface RevealOptions {
  /** Sleep; injected so tests need no timers. */
  readonly wait?: (ms: number) => Promise<void>
  /** How long to keep checking for the row once the history it needs is loaded. */
  readonly settleMs?: number
  /** A newer click/session switch cancels this navigation before it can move the page. */
  readonly isCurrent?: () => boolean
  /**
   * The unified loader (`ensureBrickTargetLoaded` bound to this session).
   *
   * Absent means this core has no reachable session face: the jump then reports what it
   * found in the DOM as it is, and never pretends the row was loaded.
   */
  readonly load?: (request: LoadRequest) => Promise<LoadReport>
}

/** Selector for one Turn's row. */
export function rowSelector(turn: number): string {
  return `[data-chat-turn="${String(turn)}"]`
}

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
export function nodeSeqOf(key: string): number | undefined {
  const match = /^(\d+):/u.exec(key)
  return match === null ? undefined : Number(match[1])
}

/** Every element carrying a node key, whether it is laid out or not. */
function nodeElements(root: RevealScroller): RevealElement[] {
  return Array.from(root.querySelectorAll('[data-chat-node-key]'))
}

/** True when an element is laid out; a collapsed process node has zero height. */
function isLaidOut(element: RevealElement): boolean {
  if (element.isConnected === false) return false
  for (let parent: RevealElement | null | undefined = element; parent; parent = parent.parentElement) {
    if (parent.getAttribute?.('hidden') != null) return false
  }
  const height = element.getBoundingClientRect().height
  return height === undefined || height > 0
}

/** The key suffix an assistant step's node ends with: `assistant-step{turn}:{step}`. */
function stepKeySuffix(turn: number, step: number): string {
  return `assistant-step${String(turn)}:${String(step)}`
}

/**
 * Where a step's row sits in reading order.
 *
 * One `assistant-step` can be published as two rows sharing the node key, told apart
 * by `data-chat-group-part`: the `reasoning` half and the `response` half. A brick
 * counts a whole model response, so it aims at the reasoning row — the place the
 * response began — and only falls back to the response row when there is no
 * reasoning to show.
 *
 * @param element - one candidate row.
 * @returns 0 for the reasoning half, 1 for anything else.
 */
function groupPartRank(element: RevealElement): number {
  return element.getAttribute?.('data-chat-group-part') === 'reasoning' ? 0 : 1
}

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
export function findStepNodes(root: RevealScroller, turn: number, step: number): RevealElement[] {
  const suffix = stepKeySuffix(turn, step)
  return nodeElements(root)
    .filter((element) => (element.getAttribute?.('data-chat-node-key') ?? '').endsWith(suffix))
    .sort((left, right) => groupPartRank(left) - groupPartRank(right))
}

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
export function findProcessToggle(root: RevealScroller, turn: number): RevealElement | undefined {
  const buttons = root.querySelectorAll('button[data-turn-process]')
  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons[index]!
    if (button.getAttribute?.('data-turn-process') === String(turn)) return button
  }
  return undefined
}

/** Scroll so the row sits about a quarter down the viewport. */
function scrollToRow(root: RevealScroller, row: RevealElement): void {
  const rowTop = row.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
  root.scrollTo({
    top: revealTarget(rowTop, root.scrollHeight, root.clientHeight),
    behavior: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  })
}

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
export function findCallNodes(root: RevealScroller, callId: string): RevealElement[] {
  const suffix = `tool-call${callId}`
  return nodeElements(root).filter((element) => (element.getAttribute?.('data-chat-node-key') ?? '').endsWith(suffix))
}

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
export function findRetryNodes(root: RevealScroller, retryId: string): RevealElement[] {
  const suffix = `model-retry${retryId}`
  return nodeElements(root).filter((element) => (element.getAttribute?.('data-chat-node-key') ?? '').endsWith(suffix))
}

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
export function findCompactionNodes(root: RevealScroller, compactionId: string): RevealElement[] {
  const suffix = `compaction${compactionId}`
  return nodeElements(root).filter((element) => (element.getAttribute?.('data-chat-node-key') ?? '').endsWith(suffix))
}

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
export function revealUntilFound(
  elements: readonly RevealElement[],
  visited: Set<RevealElement> = new Set(),
): boolean {
  let asked = false
  for (const element of elements) {
    // The hidden attribute/listener may belong to an enclosing process wrapper, not the row.
    const chain: RevealElement[] = []
    for (let node: RevealElement | null | undefined = element; node; node = node.parentElement) {
      if (node.getAttribute?.('hidden') === 'until-found') chain.unshift(node)
    }
    for (const node of chain) {
      if (visited.has(node) || typeof node.dispatchEvent !== 'function') continue
      visited.add(node)
      node.dispatchEvent(new Event('beforematch'))
      asked = true
    }
  }
  return asked
}

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
export function stepsInTurn(root: RevealScroller, turn: number): { step: number; element: RevealElement }[] {
  const prefix = `assistant-step${String(turn)}:`
  const found: { step: number; element: RevealElement }[] = []
  for (const element of nodeElements(root)) {
    const key = element.getAttribute?.('data-chat-node-key') ?? ''
    const at = key.lastIndexOf(prefix)
    if (at === -1) continue
    const tail = key.slice(at + prefix.length)
    if (!/^\d+$/u.test(tail) || !isLaidOut(element)) continue
    found.push({ step: Number(tail), element })
  }
  return found.sort((left, right) => left.step - right.step)
}

/** The exact rows a target can produce, and the kind each one is. */
const EXACT_ROWS: Record<BrickTarget['kind'], RevealRow | undefined> = {
  'assistant-step': 'assistant-step',
  'tool-call': 'tool-call',
  'retry-chain': 'retry-chain',
  compaction: 'compaction',
  none: undefined,
}

/**
 * The exact rows a target is represented by, laid out or not.
 * @param root - the scroll container.
 * @param target - where the brick belongs.
 * @returns the candidate rows, best first.
 */
function rowsFor(root: RevealScroller, target: BrickTarget): { row: RevealRow; elements: RevealElement[] } | undefined {
  switch (target.kind) {
    case 'assistant-step':
      // The declared part first — where the attempt began — then the other half of the
      // same node, which is still this brick's target (both halves share the node key).
      return { row: 'assistant-step', elements: orderByPart(findStepNodes(root, target.turn, target.step), target.part) }
    case 'tool-call':
      return { row: 'tool-call', elements: findCallNodes(root, target.callId) }
    case 'retry-chain':
      return { row: 'retry-chain', elements: findRetryNodes(root, target.retryId) }
    case 'compaction':
      return { row: 'compaction', elements: findCompactionNodes(root, target.compactionId) }
    case 'none':
      return undefined
  }
}

/**
 * Put the declared half of a step's node first.
 * @param elements - the step's rows, reasoning first by default.
 * @param part - the half the attempt began in.
 * @returns the same rows, the declared half first.
 */
function orderByPart(
  elements: readonly RevealElement[],
  part: 'reasoning' | 'response',
): RevealElement[] {
  return [...elements].sort((left, right) => {
    const rank = (element: RevealElement): number => {
      const own = element.getAttribute?.('data-chat-group-part') ?? 'response'
      return own === part ? 0 : 1
    }
    return rank(left) - rank(right)
  })
}

/** The target's own row — for a step, only the half the attempt began in. */
function findRow(root: RevealScroller, target: BrickTarget): { row: RevealRow; element: RevealElement } | undefined {
  const candidates = rowsFor(root, target)
  if (candidates === undefined) return undefined
  // Only the declared half counts here. Accepting the other half *before* the reveal loop has
  // run would stop the loop from ever opening the half this brick actually began in — the
  // reason the filter is a filter and not just a preference. The other half is reached by
  // `findOtherHalf`, after the loop, and reported rather than passed off as this row.
  const element = candidates.elements
    .filter((row) => target.kind !== 'assistant-step' || partOfRow(row) === target.part)
    .find(isLaidOut)
  return element === undefined ? undefined : { row: candidates.row, element }
}

/** Which half of a step node a row is; a response row may carry the bare key. */
function partOfRow(element: RevealElement): 'reasoning' | 'response' {
  return element.getAttribute?.('data-chat-group-part') === 'reasoning' ? 'reasoning' : 'response'
}

/**
 * The same step's other half, when that is all this step rendered.
 *
 * One `assistant-step` is published as up to two rows sharing the node key. A core that does
 * not draw reasoning, or a reader who hides it, leaves the reasoning half with no row at all —
 * and then "no row" would be a worse answer than the step: the reader asked where this request
 * is, and the step *is* where it is. Reaching it is reported as `step-other-half` and never
 * highlighted, so the difference between the brick's own row and its step survives.
 */
function findOtherHalf(root: RevealScroller, target: BrickTarget): { row: RevealRow; element: RevealElement } | undefined {
  if (target.kind !== 'assistant-step') return undefined
  const candidates = rowsFor(root, target)
  if (candidates === undefined) return undefined
  const element = candidates.elements.find(isLaidOut)
  if (element === undefined || partOfRow(element) === target.part) return undefined
  return { row: candidates.row, element }
}

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
export type BrickLocateResult =
  | { readonly status: 'exact'; readonly row: RevealRow; readonly element: RevealElement }
  | { readonly status: 'step-other-half'; readonly row: RevealRow; readonly element: RevealElement }
  | { readonly status: 'host-projection-blocked'; readonly seq: number }
  | { readonly status: 'loaded-awaiting-render' }
  | { readonly status: 'target-unavailable'; readonly reason: LoadStatus }

/**
 * Classify one reveal outcome. Pure, so the meaning of a jump is testable on its own.
 *
 * @param outcome - what the reveal reached and what the loader did.
 * @returns the locate status the panel and the console report.
 */
export function locateResultOf(outcome: RevealOutcome): BrickLocateResult {
  if (outcome.fellBack === true && outcome.element !== undefined && outcome.row !== 'none') {
    return { status: 'step-other-half', row: outcome.row, element: outcome.element }
  }
  if (outcome.accuracy === 'exact' && outcome.element !== undefined) {
    return { status: 'exact', row: outcome.row, element: outcome.element }
  }
  const { status, seq } = outcome.load
  // Coverage without an exact row is not proof of an assembler failure. A delayed mount,
  // hidden subtree or stale target can produce the same observation.
  if (status === 'loaded' && seq !== undefined) return { status: 'loaded-awaiting-render' }
  if (status === 'not-needed' || status === 'already-loaded') return { status: 'loaded-awaiting-render' }
  return { status: 'target-unavailable', reason: status }
}

/** What one landing attempt produced, including the load report on a miss. */
interface LandResult {
  readonly found: boolean
  /** What the unified loader did, whether or not a row was reached. */
  readonly load: LoadReport
  readonly row?: RevealRow
  readonly element?: RevealElement
  readonly expanded?: boolean
  readonly fellBack?: boolean
}

/** The Turn a target belongs to, for the disclosure control; an auxiliary call has none. */
function turnOf(target: BrickTarget): number | undefined {
  switch (target.kind) {
    case 'assistant-step':
    case 'tool-call':
    case 'retry-chain':
      return target.turn
    case 'compaction':
    case 'none':
      return undefined
  }
}

/**
 * Reach the brick's **own** row, loading the history it needs and opening whatever hides it.
 *
 * The order is the whole design in three lines: look (it may already be there), **load
 * through the official loader** (the row cannot exist before its history does), then open the
 * two things the view holds closed. None of those is a landing; if they end without the exact
 * row on screen this returns nothing rather than something nearby.
 *
 * @param root - the scroll container.
 * @param target - where the brick belongs.
 * @param wait - the injected sleep.
 * @param settleMs - how long to wait for a just-opened group to lay out.
 * @param load - the unified loader, when this core has a session face.
 * @returns what was reached and what the loader did — the report is returned even on a miss.
 */
async function landExact(
  root: RevealScroller,
  target: BrickTarget,
  wait: (ms: number) => Promise<void>,
  settleMs: number,
  load: ((request: LoadRequest) => Promise<LoadReport>) | undefined,
  isCurrent: () => boolean,
): Promise<LandResult> {
  const shown = findRow(root, target)
  if (shown !== undefined) {
    scrollToRow(root, shown.element)
    // Never asked: the row was already rendered, so nothing was loaded and nothing was opened.
    const seq = loadSeqOf(target)
    return {
      found: true,
      row: shown.row,
      element: shown.element,
      expanded: false,
      load: { status: 'not-needed', ...(seq === undefined ? {} : { seq }) },
    }
  }

  // The history that row is built from may not be in the window yet. This is the only thing
  // that can make it exist, and it is the official loader — not a click on someone else's
  // control, and never a fallback to a nearby row.
  const report = load === undefined
    ? { status: 'no-loader' as const }
    : await load(loadRequestOf(target))

  // History coverage and React's DOM commit are separate moments. Re-resolve controls on
  // every tick, including wrappers which did not exist when loadThrough resolved.
  let asked = false
  const openedToggles = new Set<RevealElement>()
  const revealedHidden = new Set<RevealElement>()
  const turn = turnOf(target)
  const tick = 50
  for (let spent = 0; spent <= settleMs && isCurrent(); spent += tick) {
    const toggle = turn === undefined ? undefined : findProcessToggle(root, turn)
    if (toggle !== undefined && toggle.getAttribute?.('aria-expanded') !== 'true'
      && !openedToggles.has(toggle) && typeof toggle.click === 'function') {
      openedToggles.add(toggle)
      toggle.click()
      asked = true
    }
    const candidates = rowsFor(root, target)
    if (candidates !== undefined && revealUntilFound(candidates.elements, revealedHidden)) asked = true
    const opened = findRow(root, target)
    if (opened !== undefined && isCurrent()) {
      scrollToRow(root, opened.element)
      return { found: true, row: opened.row, element: opened.element, expanded: asked, load: report }
    }
    if (spent < settleMs) await wait(tick)
  }
  // Only now, with the whole budget spent, is "the declared half was never rendered" a
  // conclusion rather than an impatient guess: a React commit can arrive hundreds of
  // milliseconds after the history it needs (measured: 850 ms in the interaction fixture), so
  // checking earlier would trade a correct landing for a wrong one. The step's other half is
  // still better than nowhere — reported as `step-other-half`, never highlighted.
  const other = findOtherHalf(root, target)
  if (other !== undefined && isCurrent()) {
    scrollToRow(root, other.element)
    return { found: true, row: other.row, element: other.element, expanded: asked, fellBack: true, load: report }
  }
  return { found: false, load: { ...report, rendered: false } }

}

/**
 * Take the reader to the request a brick stands for.
 *
 * @param root - the scroll container.
 * @param target - where the brick belongs.
 * @param options - injected timing and the unified loader.
 * @returns what was reached, how well it stands for the brick, and what the load did.
 */
export async function revealBrick(
  root: RevealScroller,
  target: BrickTarget,
  options: RevealOptions = {},
): Promise<RevealOutcome> {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const settleMs = options.settleMs ?? 4000
  const isCurrent = options.isCurrent ?? (() => true)

  if (!isCurrent() || target.kind === 'none' || EXACT_ROWS[target.kind] === undefined) {
    return { accuracy: 'none', row: 'none', load: { status: 'nothing-to-load' }, expanded: false }
  }

  const landed = await landExact(root, target, wait, settleMs, options.load, isCurrent)
  if (!landed.found || landed.row === undefined || landed.element === undefined) {
    return { accuracy: 'none', row: 'none', load: landed.load, expanded: false }
  }
  return {
    // The other half of the same step is *the step*, not the brick's own row: it is reached
    // (so the reader is not left where they were) and reported as `context`, never `exact`.
    accuracy: landed.fellBack === true ? 'context' : accuracyOf(landed.row),
    row: landed.row,
    load: landed.load,
    expanded: landed.expanded === true,
    ...(landed.fellBack === true ? { fellBack: true as const } : {}),
    element: landed.element,
  }
}
