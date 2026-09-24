/**
 * Expanding a durable compact stream into a readable timeline.
 *
 * DSH stores one model stream as `AssistantStreamRecord`s: raw `chunk` records
 * for block boundaries, usage and finish, and *runs* for deltas
 * (`text-chunks` / `reasoning-chunks` / `tool-call-chunks`) where every original
 * delta boundary and timestamp is recoverable from `time0` plus the `dt` gaps.
 *
 * A per-delta timeline of a 4,000-fragment answer would be unreadable, so a run
 * becomes **one** entry that reports when it started, how long it took, how many
 * fragments it packed and how much text it carried — the shape of the stream,
 * which is what a cache investigation actually looks at.
 *
 * Pure: takes plain records, returns entries. No runtime import, no DOM.
 */

/** One line of the stream timeline. */
export interface TimelineEntry {
  /** Epoch milliseconds, on the same wall clock as the session log. */
  readonly at: number
  readonly kind: 'text' | 'reasoning' | 'tool-call' | 'block-start' | 'block-end' | 'usage' | 'finish' | 'other'
  /** Stream block index, when the record carries one. */
  readonly index?: number
  /** Human-readable detail: sizes for runs, the reason for a finish, and so on. */
  readonly detail: string
  /** Fragments packed into this entry (1 for a raw record). */
  readonly fragments: number
  /** Span covered by those fragments, in milliseconds. */
  readonly spanMs: number
  /** Characters carried by this entry, for the totals above the timeline. */
  readonly chars: number
}

/** What a timeline adds up to. */
export interface TimelineSummary {
  readonly chunks: number
  readonly textChars: number
  readonly reasoningChars: number
  readonly toolCalls: number
  readonly firstTokenAt?: number
  readonly usageAt?: number
  readonly finishAt?: number
  readonly finishReason?: string
}

/** Narrowing helpers, kept local so a malformed record can never throw. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

/** Render a compact form of the raw tool arguments for the timeline. */
function previewArguments(text: string): string {
  const flat = text.replace(/\s+/gu, ' ')
  return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat
}

/**
 * Expand stream records into timeline entries.
 * @param records - the durable stream, as stored by the runtime.
 * @returns entries in stream order; unreadable records are skipped.
 */
export function expandStreamRecords(records: readonly unknown[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  for (const raw of records) {
    const record = asRecord(raw)
    if (record === undefined) continue
    const type = record.type
    if (type === 'chunk') {
      const chunk = asRecord(record.chunk)
      const at = typeof record.time === 'number' ? record.time : 0
      const chunkType = typeof chunk?.type === 'string' ? chunk.type : 'other'
      entries.push({
        at,
        kind: chunkType === 'block-start' || chunkType === 'block-end' || chunkType === 'usage' || chunkType === 'finish'
          ? chunkType
          : 'other',
        ...(typeof chunk?.index === 'number' ? { index: chunk.index } : {}),
        detail: detailOfChunk(chunkType, chunk),
        fragments: 1,
        spanMs: 0,
        chars: 0,
      })
      continue
    }
    if (type !== 'text-chunks' && type !== 'reasoning-chunks' && type !== 'tool-call-chunks') continue
    const members = type === 'tool-call-chunks'
      ? (Array.isArray(record.args) ? record.args as readonly unknown[] : [])
      : (Array.isArray(record.texts) ? record.texts as readonly unknown[] : [])
    const gaps = Array.isArray(record.dt) ? record.dt as readonly unknown[] : []
    const start = typeof record.time0 === 'number' ? record.time0 : 0
    const span = gaps.reduce((total: number, gap) => total + (typeof gap === 'number' ? gap : 0), 0)
    const chars = members.reduce((total: number, member) => total + (typeof member === 'string' ? member.length : 0), 0)
    const kind = type === 'text-chunks' ? 'text' : type === 'reasoning-chunks' ? 'reasoning' : 'tool-call'
    entries.push({
      at: start,
      kind,
      ...(typeof record.index === 'number' ? { index: record.index } : {}),
      detail: kind === 'tool-call'
        ? `${typeof record.name === 'string' ? record.name : 'tool'} ${previewArguments(members.join(''))}`
        : `${chars.toLocaleString('en-US')} chars in ${String(members.length)} fragments`,
      fragments: members.length,
      spanMs: span,
      chars,
    })
  }
  return entries
}

/** One-line description of a raw chunk. */
function detailOfChunk(chunkType: string, chunk: Record<string, unknown> | undefined): string {
  switch (chunkType) {
    case 'block-start':
      return `block ${String(chunk?.blockType ?? '?')}`
    case 'block-end':
      return 'block end'
    case 'usage': {
      const usage = asRecord(chunk?.usage)
      if (usage === undefined) return 'usage'
      const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0
      const read = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0
      const write = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0
      const prompt = input + read + write
      const ratio = prompt > 0 ? (read / prompt) * 100 : undefined
      return `usage · prompt ${prompt.toLocaleString('en-US')} · cache ${ratio === undefined ? 'n/a' : `${ratio.toFixed(2)}%`}`
    }
    case 'finish': {
      const reason = asRecord(chunk?.reason)
      const kind = typeof reason?.kind === 'string' ? reason.kind : 'stop'
      const failure = asRecord(reason?.failure)
      return typeof failure?.message === 'string' ? `finish: ${kind} · ${failure.message}` : `finish: ${kind}`
    }
    default:
      return chunkType
  }
}

/**
 * Add a timeline up.
 * @param entries - entries from {@link expandStreamRecords}.
 * @returns the totals the panel shows above the timeline.
 */
export function summarizeTimeline(entries: readonly TimelineEntry[]): TimelineSummary {
  let textChars = 0
  let reasoningChars = 0
  let toolCalls = 0
  let chunks = 0
  let firstTokenAt: number | undefined
  let usageAt: number | undefined
  let finishAt: number | undefined
  let finishReason: string | undefined
  for (const entry of entries) {
    chunks += entry.fragments
    // The first token is the first delta the provider sent, whatever kind it was.
    if (firstTokenAt === undefined && entry.kind !== 'usage' && entry.kind !== 'finish' && entry.kind !== 'block-start' && entry.kind !== 'block-end' && entry.kind !== 'other') {
      firstTokenAt = entry.at
    }
    if (entry.kind === 'text') textChars += entry.chars
    if (entry.kind === 'reasoning') reasoningChars += entry.chars
    if (entry.kind === 'tool-call') toolCalls += 1
    if (entry.kind === 'usage') usageAt = entry.at
    if (entry.kind === 'finish') {
      finishAt = entry.at
      finishReason = entry.detail.replace('finish: ', '').split(' · ')[0]
    }
  }
  return {
    chunks,
    textChars,
    reasoningChars,
    toolCalls,
    ...(firstTokenAt === undefined ? {} : { firstTokenAt }),
    ...(usageAt === undefined ? {} : { usageAt }),
    ...(finishAt === undefined ? {} : { finishAt }),
    ...(finishReason === undefined ? {} : { finishReason }),
  }
}

/** Format a wall-clock time for the timeline gutter. */
export function timelineClock(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '—'
  const date = new Date(at)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}
