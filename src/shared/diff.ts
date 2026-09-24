/**
 * Comparing two bricks: the reason this plugin exists.
 *
 * A single brick says "this request cached 0.2%". The interesting question is
 * always *what changed* between the request that cached 99.4% and the next one
 * that cached nothing — and DSH records enough to answer it: the request header
 * (with the reason it was re-logged), the tool schemas, the system prompt, the
 * message list, the route and the context snapshot are all observable, and each
 * one can be hashed. Equal hashes mean an identical payload; a changed hash means
 * the prefix broke there.
 *
 * Pure: it takes two records and returns rows. No DOM, no runtime imports.
 */
import type { BrickRecord } from './brick'
import { promptTokensOf, showHash, showNumber, showPercent, showSeconds } from './metrics'

/** One compared field. */
export interface DiffRow {
  /** Grouping used by the panel: identity, route, request, context, cache, result. */
  readonly group: 'route' | 'request' | 'cache' | 'context' | 'result'
  readonly label: string
  readonly before: string
  readonly after: string
  /** True when the two sides differ — the thing to look at. */
  readonly changed: boolean
  /** Set for hash comparisons: equal hashes prove an identical payload. */
  readonly identicalPayload?: boolean
  /**
   * True for rows that display a movement rather than a value (`+1,842`). They
   * describe the difference, so they are never counted as a difference.
   */
  readonly informational?: boolean
}

/** The result of comparing two attempts. */
export interface BrickDiff {
  readonly rows: readonly DiffRow[]
  /** Every changed row, in panel order. */
  readonly changed: readonly DiffRow[]
  /** One sentence naming the first thing that broke, for the panel header. */
  readonly verdict: string
}

/** Text cell for a possibly-absent scalar. */
function cell(value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null) return '—'
  return String(value)
}

/** Build one row, deciding `changed` by string comparison unless told otherwise. */
function row(
  group: DiffRow['group'],
  label: string,
  before: string,
  after: string,
  override?: boolean,
): DiffRow {
  return { group, label, before, after, changed: override ?? before !== after }
}

/**
 * A row that shows the movement between the two bricks instead of a value.
 *
 * It is marked informational so it never counts as a difference by itself: the
 * movement is the *description* of the change, not another change.
 */
function deltaRow(group: DiffRow['group'], label: string, movement: string): DiffRow {
  return { group, label, before: '—', after: movement, changed: false, informational: true }
}

/**
 * Hash row: equal hashes mean the same payload, which is stronger than equal text.
 *
 * Two absent hashes are "unknown", not "changed" — a missing hash means the
 * payload was never captured, and a diff that cries wolf on every uncaptured
 * field is worse than one that stays quiet.
 */
function hashRow(group: DiffRow['group'], label: string, before: string | undefined, after: string | undefined): DiffRow {
  const known = before !== undefined && after !== undefined
  const identical = known && before === after
  return {
    group,
    label,
    before: showHash(before),
    after: showHash(after),
    changed: known && !identical,
    identicalPayload: identical,
  }
}

/** Signed token delta, e.g. `+1,842` or `-320,453`. */
function delta(before: number | undefined, after: number | undefined): string {
  if (before === undefined || after === undefined) return '—'
  const difference = after - before
  return `${difference >= 0 ? '+' : '−'}${Math.abs(difference).toLocaleString('en-US')}`
}

/**
 * Compare two attempts of the same session.
 * @param before - the earlier brick.
 * @param after - the later brick.
 * @returns rows plus the changed subset and a one-line verdict.
 */
export function diffBricks(before: BrickRecord, after: BrickRecord): BrickDiff {
  const rows: DiffRow[] = [
    // Route: the config the request ran with. A change here is a legitimate
    // reason for the prefix to be re-evaluated by the provider.
    row('route', 'Provider', before.route.provider, after.route.provider),
    row('route', 'Model', before.route.model, after.route.model),
    row(
      'route',
      'Reasoning effort',
      cell(before.route.reasoningEffort) + (before.route.reasoningEffortDefaulted === true ? ' (adapter)' : ''),
      cell(after.route.reasoningEffort) + (after.route.reasoningEffortDefaulted === true ? ' (adapter)' : ''),
    ),
    row('route', 'Temperature', cell(before.route.temperature), cell(after.route.temperature)),
    row('route', 'Max output', cell(before.route.maxTokens), cell(after.route.maxTokens)),
    row('route', 'Stop', cell(before.route.stop?.join(', ')), cell(after.route.stop?.join(', '))),

    // Request: the prefix itself, by hash where a hash exists.
    row('request', 'Header event', cell(before.request.headerEventSeq), cell(after.request.headerEventSeq)),
    row('request', 'Header reason', cell(before.request.headerReason), cell(after.request.headerReason)),
    row('request', 'Starts series', cell(before.request.startsSeries), cell(after.request.startsSeries)),
    hashRow('request', 'Header hash', before.request.headerHash, after.request.headerHash),
    hashRow('request', 'System hash', before.request.systemHash, after.request.systemHash),
    hashRow('request', 'Tools hash', before.request.toolsHash, after.request.toolsHash),
    row('request', 'Tool schemas', cell(before.request.toolSchemaCount), cell(after.request.toolSchemaCount)),
    // 0.1.7-rc.2 makes the declaration list history-relative. A tool the history added
    // changes what the model can call without changing the header's own list, so it gets
    // its own row instead of hiding inside `Tool schemas`.
    row('request', 'Tools added in history', cell(before.request.toolSchemaAdded), cell(after.request.toolSchemaAdded)),
    row('request', 'Tools activated', cell(before.request.toolSchemaActivated), cell(after.request.toolSchemaActivated)),
    row('request', 'Deferred tools', cell(before.request.deferredToolCount), cell(after.request.deferredToolCount)),
    row('request', 'Messages', cell(before.request.messageCount), cell(after.request.messageCount)),
    row(
      'request',
      'Shared prefix',
      cell(before.request.sharedMessagePrefix),
      cell(after.request.sharedMessagePrefix),
    ),

    // Cache: the outcome, with the movement that prompted the comparison.
    row('cache', 'Prompt tokens', showNumber(before.metrics.promptTokens), showNumber(after.metrics.promptTokens)),
    deltaRow('cache', 'Prompt delta', delta(before.metrics.promptTokens, after.metrics.promptTokens)),
    row('cache', 'Cache read', showNumber(before.usage?.cacheReadTokens), showNumber(after.usage?.cacheReadTokens)),
    deltaRow('cache', 'Cache read delta', delta(before.usage?.cacheReadTokens, after.usage?.cacheReadTokens)),
    row(
      'cache',
      'Uncached input',
      showNumber(before.usage?.inputTokens),
      showNumber(after.usage?.inputTokens),
    ),
    row('cache', 'Cache hit', showPercent(before.metrics.cacheHitRatio), showPercent(after.metrics.cacheHitRatio)),

    // Context: pressure and composition at dispatch, frozen per brick.
    row('context', 'Context window', showNumber(before.context?.contextWindow ?? before.route.contextWindow),
      showNumber(after.context?.contextWindow ?? after.route.contextWindow)),
    row('context', 'Occupancy', showPercent(before.metrics.contextOccupancy), showPercent(after.metrics.contextOccupancy)),
    row('context', '≈ System', showNumber(before.context?.systemTokens), showNumber(after.context?.systemTokens)),
    row('context', '≈ Tools', showNumber(before.context?.toolsTokens), showNumber(after.context?.toolsTokens)),
    row('context', '≈ Messages', showNumber(before.context?.messageTokens), showNumber(after.context?.messageTokens)),
    row('context', 'Surface nodes', showNumber(before.context?.nodeCount), showNumber(after.context?.nodeCount)),

    // Result: how each attempt ended.
    row('result', 'Finish', cell(before.finish?.reason), cell(after.finish?.reason)),
    row('result', 'Retry of', cell(before.retry?.retryId), cell(after.retry?.retryId)),
    row('result', 'Attempt', `#${String(before.identity.attemptOrdinal)}`, `#${String(after.identity.attemptOrdinal)}`),
    row('result', 'TTFT', showSeconds(before.metrics.ttftMs), showSeconds(after.metrics.ttftMs)),
    row('result', 'Duration', showSeconds(before.metrics.durationMs), showSeconds(after.metrics.durationMs)),
    row('result', 'Tool calls', cell(before.metrics.toolCallCount), cell(after.metrics.toolCallCount)),
  ]

  const changed = rows.filter((entry) => entry.changed)
  return { rows, changed, verdict: verdictOf(before, after, changed) }
}

/**
 * Name the most likely cause of a cache collapse, in the order the provider sees
 * the request: route first, then header, then tools/system, then messages, then
 * context size.
 */
function verdictOf(before: BrickRecord, after: BrickRecord, changed: readonly DiffRow[]): string {
  const hitBefore = before.metrics.cacheHitRatio
  const hitAfter = after.metrics.cacheHitRatio
  const headline = hitBefore === undefined || hitAfter === undefined
    ? 'cache hit not reported by the provider'
    : `cache hit ${showPercent(hitBefore)} → ${showPercent(hitAfter)}`

  const route = changed.find((entry) => entry.group === 'route')
  if (route !== undefined) return `${headline}: route changed (${route.label} ${route.before} → ${route.after})`

  // The concrete broken part comes before the header that recorded it: a changed
  // tools hash *causes* a `change` header, and "Tools differs" is the actionable
  // sentence, not "a new header was logged".
  const prefix = changed.find((entry) => entry.label === 'Tools hash' || entry.label === 'System hash')
  if (prefix !== undefined) return `${headline}: ${prefix.label.replace(' hash', '')} differs — that is where the prefix broke`

  const series = changed.find((entry) => entry.label === 'Starts series' || entry.label === 'Header reason')
  if (series !== undefined) return `${headline}: new request header (${series.label} ${series.before} → ${series.after})`

  // A growing shared prefix with a collapsing hit ratio is the signature of a
  // change *inside* the tail rather than a re-rendered head.
  const shared = after.request.sharedMessagePrefix
  const total = after.request.messageCount
  if (shared !== undefined && total !== undefined && shared < total - 1) {
    return `${headline}: the prefix is shared up to message ${String(shared)} of ${String(total)}`
  }

  const tokens = promptTokensOf(after.usage)
  const grew = before.metrics.promptTokens !== undefined && tokens !== undefined
    ? tokens - before.metrics.promptTokens
    : undefined
  if (changed.some((entry) => entry.group === 'cache')) {
    return grew === undefined
      ? `${headline}: prompt accounting changed`
      : `${headline}: prompt ${grew >= 0 ? 'grew' : 'shrank'} ${Math.abs(grew).toLocaleString('en-US')} tokens into a different prefix`
  }
  return `${headline}: no request field differs, so the change is inside the message content`
}
