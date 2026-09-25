/**
 * The brick panel: everything the collector knows about one model request, in
 * seven tabs, plus the comparison with another brick.
 *
 * It renders from a `BrickRecord` and nothing else — no store access, no fetching
 * inside the component. Large payloads (the request, the stream, the header,
 * replay state) are fetched by the caller and handed in through `raw`, which
 * keeps the component testable by rendering it to static markup and keeps the
 * blob traffic in one place.
 *
 * The panel is mounted by the seat component and positioned as a floating card,
 * because the transcript is not ours to insert into.
 */
import type { CSSProperties, ReactElement } from 'react'
import type { BrickRecord } from '../shared/brick'
import type { BrickDiff, DiffRow } from '../shared/diff'
import { showHash, showNumber, showPercent, showSeconds } from '../shared/metrics'
import { expandStreamRecords, summarizeTimeline, timelineClock, type TimelineEntry } from '../shared/stream-timeline'
import { activityOf, reasoningShareOf } from './bricks'
import { faceEnglish, faceSegments } from './tetris'
import type { RevealAccuracy, RevealRow } from './target'
import type { LoadReport, TranscriptView } from './navigation'
import type { BrickLocateResult } from './reveal'

/**
 * What the last click on this brick actually reached.
 *
 * It is passed in rather than inferred, because the whole point is that the panel must
 * not upgrade a near miss to a success: `exact` is this request's own row, `context` is
 * somewhere near it, `none` is nowhere.
 */
export interface JumpReport {
  readonly turn: number
  readonly step: number
  readonly accuracy: RevealAccuracy
  readonly row: RevealRow
  /** What the unified loader did on the way, so a miss can name its own cause. */
  readonly load?: LoadReport
  /** Which location answer this jump produced. */
  readonly locate?: BrickLocateResult
}

/**
 * The three facts a reader needs to tell a plugin problem from a host problem.
 *
 * "Transcript loaded ✓ / Chat projection ✕ / Reason: the host loaded the page and drew none of
 * it" is the shape: the session's window can hold a request while the transcript draws none of
 * it, and a report that cannot say that sends the next person to debug the wrong layer.
 *
 * @param locate - the classified result of the last jump.
 * @returns one row per fact.
 */
function locateRows(locate: BrickLocateResult): { readonly label: string; readonly value: string }[] {
  switch (locate.status) {
    case 'exact':
      return [
        { label: 'Transcript loaded', value: '✓' },
        { label: 'Chat projection', value: `✓ ${locate.row}` },
        { label: 'Reason', value: 'the request has its own row on screen' },
      ]
    case 'step-other-half':
      return [
        { label: 'Transcript loaded', value: '✓' },
        { label: 'Chat projection', value: `~ ${locate.row}: the other half` },
        { label: 'Reason', value: 'this step is on screen, but the half the attempt began in has no rendered row' },
      ]
    case 'host-projection-blocked':
      return [
        { label: 'Transcript loaded', value: `✓ seq ${String(locate.seq)}` },
        { label: 'Chat projection', value: '✕' },
        { label: 'Reason', value: 'history loaded, but the exact target row is unavailable; the cause is not established' },
      ]
    case 'loaded-awaiting-render':
      return [
        { label: 'Transcript loaded', value: '✓ already covered' },
        { label: 'Chat projection', value: '✕' },
        { label: 'Reason', value: 'the window holds this turn; the transcript has not drawn it' },
      ]
    case 'target-unavailable':
      return [
        { label: 'Transcript loaded', value: locate.reason === 'loaded' ? '✓' : '–' },
        { label: 'Chat projection', value: '✕' },
        { label: 'Reason', value: locateReasonText(locate.reason) },
      ]
  }
}

/** One short sentence per loader status, for the reason row. */
function locateReasonText(status: LoadReport['status']): string {
  switch (status) {
    case 'nothing-to-load':
      return 'nothing in the transcript can represent this call'
    case 'no-seq':
      return 'the record carries no log position for this attempt'
    case 'no-loader':
      return 'this core gave the plugin no session face'
    case 'timeout':
      return 'the history was requested and the window still does not reach it'
    case 'not-needed':
    case 'already-loaded':
    case 'loaded':
      return 'the history is there and no row was drawn'
  }
}

/**
 * One short, literal sentence about the last jump.
 *
 * A miss says *why*: "the record carries no log position" and "the history was requested but
 * the window still does not reach it" are different problems, and a feature that reports both
 * as "could not jump" makes the next person debug the wrong one.
 *
 * @param jump - what the last jump reached.
 * @param load - what the unified loader did on the way, when the caller has it.
 * @returns the sentence.
 */
function jumpText(jump: JumpReport, load?: LoadReport): string {
  if (jump.locate?.status === 'step-other-half') {
    return `this step's own half has no rendered row; landed on the other half of the same step (${jump.row}) — not highlighted`
  }
  if (jump.accuracy === 'exact') return `landed on this request's row (${jump.row})`
  const reason = (load ?? jump.load)?.status
  if (reason === 'no-seq') return 'this record carries no log position, so there is no row to load'
  if (reason === 'no-loader') return 'this core gave the plugin no session face, so history could not be loaded'
  if (reason === 'timeout') return 'the history was requested but the window still does not reach this request'
  if (reason === 'nothing-to-load') return 'nothing in the transcript can represent this call'
  if (reason === 'loaded') {
    return 'the history through seq ' + String((load ?? jump.load)?.seq)
      + ' was loaded, but the transcript still shows no row for this request — '
      + 'the exact row is still unavailable; this alone does not identify the cause'
  }
  if (jump.accuracy === 'context') return 'the turn was reached, but this request has no rendered row'
  return 'this request has no rendered row in the transcript — the record is shown without jumping'
}

/** The tabs, in order. */
/** Which of the three provenances a record has; an untagged record is a live capture. */
function sourceOf(record: BrickRecord): 'host' | 'replay' | 'client' {
  return record.observedBy === 'replay' ? 'replay' : record.observedBy === 'client' ? 'client' : 'host'
}

/** The chip's word for each provenance. */
const SOURCE_LABEL: Record<'host' | 'replay' | 'client', string> = {
  host: 'host feed',
  replay: 'log replay',
  client: 'client fold',
}

/** And what the chip means when hovered. */
const SOURCE_TITLE: Record<'host' | 'replay' | 'client', string> = {
  host: 'Collected by the host half, with the request and stream kept by reference',
  replay: "Folded from this session's own log by the collector's own observations; no request capture",
  client: 'Folded in the browser from the session event feed',
}

export const PANEL_TABS = [
  { id: 'transcript', label: '对话' },
  { id: 'overview', label: 'Overview' },
  { id: 'request', label: 'Request' },
  { id: 'context', label: 'Context' },
  { id: 'stream', label: 'Stream' },
  { id: 'tools', label: 'Tools' },
  { id: 'retry', label: 'Retry / Errors' },
  { id: 'raw', label: 'Raw' },
] as const

/** Blob kinds the panel can ask for. */
export type RawKind = 'request' | 'header' | 'toolHistory' | 'stream' | 'replay' | 'messages'

/** Props for {@link BrickPanel}. */
export interface BrickPanelProps {
  readonly record: BrickRecord
  readonly tab: string
  readonly onTab: (tab: string) => void
  readonly onClose: () => void
  /** Take the reader to this brick's own row in the transcript (the board's double click). */
  readonly onLocate?: () => void
  /** Compare against the previous brick of the same session. */
  readonly onCompare?: () => void
  readonly diff?: BrickDiff
  /** What the last click reached, so the panel can say it without flattering it. */
  readonly jump?: JumpReport
  /**
   * The conversation around this brick, read from the session window.
   *
   * Loaded automatically when a brick is selected. The preview does not navigate or
   * highlight the main transcript; double-click / the Locate button does that separately.
   */
  readonly transcript?: TranscriptState
  /** Ask the session for the history this brick's turn needs. */
  readonly onLoadTranscript?: () => void
  /** Loaded payloads, keyed by kind. */
  readonly raw?: Partial<Record<RawKind, unknown>>
  readonly onLoadRaw?: (kind: RawKind) => void
  readonly store?: { readonly blobs: number; readonly bytes: number }
}

const CARD: CSSProperties = {
  position: 'fixed',
  top: '72px',
  right: '20px',
  width: 'min(560px, calc(100vw - 40px))',
  boxSizing: 'border-box',
  maxHeight: '72vh',
  overflow: 'auto',
  zIndex: '20',
  color: 'var(--dsw-alias-label-primary, #e5e7eb)',
  background: 'var(--dsw-alias-bg-layer-1, rgba(17, 24, 39, 0.97))',
  border: '1px solid rgba(148, 163, 184, 0.3)',
  borderRadius: '12px',
  boxShadow: '0 18px 48px rgba(0, 0, 0, 0.45)',
  font: '12px/1.5 ui-sans-serif, system-ui, sans-serif',
  padding: '12px 14px',
}

const GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(120px, 40%) 1fr',
  columnGap: '10px',
  rowGap: '2px',
  margin: '6px 0 12px',
  fontVariantNumeric: 'tabular-nums',
}

const MONO: CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }

/** One labelled value. */
function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): ReactElement {
  return (
    <>
      <span style={{ color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>{label}</span>
      <span style={mono ? MONO : undefined}>{value}</span>
    </>
  )
}

/** A section heading. */
function Heading({ children }: { children: string }): ReactElement {
  return (
    <div style={{ margin: '10px 0 2px', fontWeight: 600, letterSpacing: '0.02em', textTransform: 'uppercase', fontSize: '10px', color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>
      {children}
    </div>
  )
}

/** Colour for a diff row: changed rows are the point of the view. */
function diffColor(row: DiffRow): string {
  if (!row.changed) return 'var(--dsw-alias-label-tertiary, #94a3b8)'
  return 'var(--dsw-alias-state-warning-primary, #f59e0b)'
}

/** The comparison view: what changed between two real requests. */
export function DiffTable({ diff }: { diff: BrickDiff }): ReactElement {
  return (
    <div>
      <Heading>Comparison</Heading>
      <div style={{ margin: '2px 0 8px', color: 'var(--dsw-alias-state-warning-primary, #f59e0b)' }}>{diff.verdict}</div>
      <div style={{ ...GRID, gridTemplateColumns: 'minmax(96px, 32%) 1fr 1fr' }}>
        <span style={{ color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>field</span>
        <span style={{ color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>before</span>
        <span style={{ color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>after</span>
        {diff.rows.filter((row) => row.changed || row.informational === true).map((row) => (
          <Row3 key={`${row.group}:${row.label}`} row={row} />
        ))}
      </div>
    </div>
  )
}

/** One three-column diff row. */
function Row3({ row }: { row: DiffRow }): ReactElement {
  const color = diffColor(row)
  return (
    <>
      <span style={{ color }}>{row.label}</span>
      <span style={{ ...MONO, color }}>{row.before}</span>
      <span style={{ ...MONO, color }}>{row.after}</span>
    </>
  )
}

/** The stream timeline. */
function Timeline({ entries }: { entries: readonly TimelineEntry[] }): ReactElement {
  const summary = summarizeTimeline(entries)
  return (
    <div>
      <Heading>Timeline</Heading>
      <div style={GRID}>
        <Row label="First token" value={timelineClock(summary.firstTokenAt ?? 0)} mono />
        <Row label="Usage" value={timelineClock(summary.usageAt ?? 0)} mono />
        <Row label="Finish" value={timelineClock(summary.finishAt ?? 0)} mono />
        <Row label="Chunks" value={showNumber(summary.chunks)} mono />
      </div>
      <div style={{ ...MONO, fontSize: '11px', maxHeight: '220px', overflow: 'auto', borderTop: '1px solid rgba(148,163,184,.2)' }}>
        {entries.map((entry, position) => (
          <div key={`${String(position)}:${String(entry.at)}`} style={{ display: 'flex', gap: '8px', padding: '1px 0' }}>
            <span style={{ color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>{timelineClock(entry.at)}</span>
            <span style={{ width: '72px', color: entry.kind === 'usage' || entry.kind === 'finish' ? '#f59e0b' : undefined }}>{entry.kind}</span>
            <span style={{ flex: 1 }}>
              {entry.detail}
              {entry.fragments > 1 ? ` · ${entry.spanMs} ms` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Placeholder for a tab whose data only the host half can collect. */
function NotCollected({ what }: { what: string }): ReactElement {
  return (
    <div style={{ color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>
      {`${what} is only collected by the host half. Restart the instance to have it captured.`}
    </div>
  )
}

/** The raw tab: refs first, payloads on demand. */
function RawTab({ props }: { props: BrickPanelProps }): ReactElement {
  const { record, raw, onLoadRaw, store } = props
  const refs: [RawKind, string | undefined][] = [
    ['request', record.request.requestRef],
    ['messages', record.request.messageHashesRef],
    ['header', record.request.headerRef],
    ['toolHistory', record.request.toolHistoryRef],
    ['stream', record.raw.streamRef],
    ['replay', record.raw.replayRef],
  ]
  return (
    <div>
      <Heading>Stored by reference</Heading>
      <div style={{ margin: '0 0 6px', color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>
        {'Messages are stored one by one, so a request that shares 600 of 602 messages pays for two. '
          + 'The `messages` list above holds one ref per message; each is fetchable from /cache-bricks/blob?ref=…'}
      </div>
      <div style={GRID}>
        {refs.map(([kind, ref]) => (
          <Row key={kind} label={kind} value={ref === undefined ? '—' : showHash(ref)} mono />
        ))}
        {store === undefined ? null : <Row label="store" value={`${showNumber(store.blobs)} blobs · ${showNumber(store.bytes)} bytes`} mono />}
      </div>
      {onLoadRaw === undefined ? null : (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {refs.filter(([, ref]) => ref !== undefined).map(([kind]) => (
            <button key={kind} type="button" onClick={() => { onLoadRaw(kind) }} style={{ cursor: 'pointer' }}>
              load {kind}
            </button>
          ))}
        </div>
      )}
      {raw === undefined ? null : (
        <pre style={{ ...MONO, fontSize: '11px', maxHeight: '260px', overflow: 'auto', whiteSpace: 'pre-wrap', marginTop: '8px' }}>
          {JSON.stringify(raw, undefined, 2)}
        </pre>
      )}
    </div>
  )
}

/** The panel. */
/**
 * What the transcript tab knows: nothing yet, loading, read, or why it could not be read.
 *
 * The distinction between "not asked yet" and "could not be read" is the point: the first is
 * a button, the second is a sentence naming the reason, and neither is an empty box.
 */
export interface TranscriptState {
  readonly status: 'idle' | 'loading' | 'ready' | 'unavailable'
  readonly view?: TranscriptView
  readonly report?: LoadReport
}

/** One labelled block of verbatim text from the log. */
function Verbatim({ label, text, tone }: { label: string; text: string; tone?: string }): ReactElement {
  return (
    <div style={{ margin: '6px 0' }}>
      <div style={{ color: 'var(--dsw-alias-label-tertiary, #94a3b8)', fontSize: '11px' }}>{label}</div>
      <pre
        data-cache-bricks-transcript={label}
        style={{
          ...MONO,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: '240px',
          overflow: 'auto',
          margin: '2px 0 0',
          padding: '6px 8px',
          borderRadius: '6px',
          background: 'rgba(148,163,184,.10)',
          color: tone ?? 'inherit',
          fontSize: '11px',
        }}
      >
        {text === '' ? '(empty)' : text}
      </pre>
    </div>
  )
}

/**
 * The conversation around this brick, as the session's own log has it.
 *
 * Nothing here is measured by the collector: this is the prompt that started the turn, the
 * assistant content this step committed, and the calls it made with their results — read from
 * the durable event window, with the official loader having been asked for the history first.
 */
function TranscriptTab({ state, onLoad }: {
  readonly state: TranscriptState
  readonly onLoad?: () => void
}): ReactElement {
  if (state.status === 'idle') {
    return (
      <div data-cache-bricks-transcript-state="idle">
        <Heading>Conversation</Heading>
        <div style={{ color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>
          The prompt this turn answered, the assistant text this step committed, and its tool
          calls with results — read from the session log.
        </div>
        <div style={{ marginTop: '8px' }}>
          <button
            type="button"
            onClick={onLoad}
            disabled={onLoad === undefined}
            style={{ cursor: 'pointer' }}
            title="Asks the session for the history this brick needs. The chat is not scrolled."
          >
            读取对话
          </button>
        </div>
      </div>
    )
  }
  if (state.status === 'loading') {
    return <div data-cache-bricks-transcript-state="loading">正在读取这块砖对应的对话…</div>
  }
  if (state.status === 'unavailable' || state.view === undefined) {
    return (
      <div data-cache-bricks-transcript-state="unavailable">
        <Heading>Conversation</Heading>
        <div>
          {state.report?.status === 'no-seq'
            ? 'This record carries no log position, so its turn cannot be loaded or read.'
            : state.report?.status === 'no-loader'
              ? 'This core did not give the plugin a session face, so the conversation could not be read.'
              : state.report?.status === 'timeout'
                ? 'The history was requested but the window still does not reach this brick.'
                : 'This brick has no turn in the transcript (an auxiliary call).'}
        </div>
      </div>
    )
  }
  const view = state.view
  return (
    <div data-cache-bricks-transcript-state="ready">
      <Heading>{`Turn ${String(view.turn)} · Step ${String(view.step)}`}</Heading>
      {view.loaded
        ? null
        : (
          <div style={{ color: 'var(--dsw-alias-state-warn-label, #d29922)' }}>
            当前窗口缺少本轮开头，以下只显示已读到的日志片段，不代表完整对话。
          </div>
        )}
      {view.inputs.length === 0
        ? <div style={{ color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>no prompt recorded for this turn in the window</div>
        : view.inputs.map((input, index) => (
          <Verbatim key={`${input.source}-${String(index)}`} label={`input · ${input.source}`} text={input.text} />
        ))}
      {view.assistant === 'message'
        ? (
          <>
            {view.reasoning === '' ? null : <Verbatim label="reasoning" text={view.reasoning} />}
            <Verbatim label="assistant" text={view.text} />
          </>
        )
        : view.assistant === 'attempt'
          ? (
            <div style={{ color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>
              this attempt committed no assistant message — it is visible through its calls or its retry row
            </div>
          )
          : (
            <div style={{ color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>
              the window has no assistant event for this step
            </div>
          )}
      {view.calls.length === 0 ? null : <Heading>{`Tool calls (${String(view.calls.length)})`}</Heading>}
      {view.calls.map((call) => (
        <div key={call.callId} style={{ borderTop: '1px solid rgba(148,163,184,.2)', paddingTop: '4px' }}>
          <Verbatim label={`call · ${call.name === '' ? '(unnamed)' : call.name}`} text={call.args} />
          {call.result === undefined
            ? null
            : <Verbatim label="result" text={call.result} {...(call.isError === true ? { tone: '#f87171' } : {})} />}
        </div>
      ))}
      <div style={{ color: 'var(--dsw-alias-label-tertiary, #94a3b8)', fontSize: '11px', marginTop: '4px' }}>
        {view.covers
          ? 'read from the session log; the window covers this brick'
          : 'read from the session log; the window does not reach this brick yet'}
      </div>
    </div>
  )
}

export function BrickPanel(props: BrickPanelProps): ReactElement {
  const { record, tab, onTab, onClose, onCompare, onLocate, diff } = props
  const identity = record.identity
  const attempt = identity.attemptOrdinal > 0 ? ` · attempt ${String(identity.attemptOrdinal)}` : ''
  // The board's back face is a flip away; the record states the same activity in
  // words so a touch user — who has no hover and may never flip — still reads it.
  // A split brick gets two adjacent chips, which is the same two-colour reading at
  // a size where both labels fit.
  const activity = activityOf(record)
  const activityName = faceEnglish(activity)
  const chips = faceSegments(activity, { portion: reasoningShareOf(record) })
  return (
    <div style={CARD} data-cache-bricks-panel="" role="dialog" aria-label="砖块对话预览" aria-modal="false"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
        <strong style={{ fontSize: '13px' }}>
          {`Turn ${String(identity.turn)} · Step ${String(identity.step)}${attempt}`}
        </strong>
        <span
          data-cache-bricks-kind={activity}
          title={`activity: ${activityName}`}
          style={{ display: 'flex', borderRadius: '4px', overflow: 'hidden' }}
        >
          {chips.map((segment) => (
            <span
              key={segment.tone}
              style={{
                fontSize: '10px',
                fontWeight: 700,
                padding: '1px 6px',
                background: segment.color,
                color: '#ffffff',
                letterSpacing: '0.06em',
              }}
            >
              {segment.label}
            </span>
          ))}
        </span>
        <span style={{ flex: 1, color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>{record.settlement}</span>
        <span
          data-cache-bricks-source={sourceOf(record)}
          title={SOURCE_TITLE[sourceOf(record)]}
          style={{
            fontSize: '10px',
            padding: '1px 6px',
            borderRadius: '999px',
            border: '1px solid rgba(148,163,184,.35)',
            color: record.observedBy === 'client'
              ? 'var(--dsw-alias-label-tertiary, #94a3b8)'
              : 'var(--dsw-alias-state-success-primary, #22c55e)',
          }}
        >
          {SOURCE_LABEL[sourceOf(record)]}
        </span>
        {onLocate === undefined ? null : (
          <button
            type="button"
            onClick={onLocate}
            style={{ cursor: 'pointer' }}
            title="Loads the history this request needs, then scrolls the conversation to its own row. A miss is reported, never rounded up."
          >
            在主对话中定位
          </button>
        )}
        {onCompare === undefined ? null : (
          <button type="button" onClick={onCompare} style={{ cursor: 'pointer' }} title="Compare with the previous request of this session">
            compare
          </button>
        )}
        <button type="button" onClick={onClose} style={{ cursor: 'pointer' }} aria-label="close">
          ✕
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', margin: '8px 0' }}>
        {PANEL_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => { onTab(entry.id) }}
            style={{
              cursor: 'pointer',
              borderRadius: '999px',
              padding: '2px 9px',
              fontSize: '11px',
              border: '1px solid rgba(148,163,184,.35)',
              background: entry.id === tab ? 'rgba(148,163,184,.22)' : 'transparent',
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {sourceOf(record) === 'client' ? (
        <div style={{ margin: '6px 0', padding: '6px 8px', borderRadius: '8px', background: 'rgba(148, 163, 184, 0.12)', color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>
          {'Folded client-side from the session event feed: this step is older than the collector process '
            + '(a restart, a mid-session start, or an evicted session), so the request, the timed stream and '
            + "the context snapshot were never captured. The jump still works: it loads this step's history "
            + 'and lands on the row the durable log gives it — at step precision, not attempt.'}
        </div>
      ) : sourceOf(record) === 'replay' ? (
        <div style={{ margin: '6px 0', padding: '6px 8px', borderRadius: '8px', background: 'rgba(148, 163, 184, 0.12)', color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>
          {'Reconstructed from the session log, one brick per settled attempt: usage, cache accounting, '
            + 'activity, tools, retries and the row it goes to are the log\'s own, and the timed stream is kept '
            + 'by reference. What the log never carried is absent rather than guessed — the outgoing request, '
            + 'the message hashes, the dispatch-time context snapshot, and the dispatch instant itself, so the '
            + 'TTFT here is measured from the step\'s start.'}
        </div>
      ) : null}

      {props.jump === undefined ? null : (
        <div
          data-cache-bricks-jump={props.jump.accuracy}
          style={{
            margin: '6px 0',
            fontSize: '11px',
            color: props.jump.accuracy === 'exact'
              ? 'var(--dsw-alias-state-success-primary, #22c55e)'
              : 'var(--dsw-alias-label-tertiary, #94a3b8)',
          }}
        >
          {jumpText(props.jump, props.jump.load)}
          {props.jump.locate === undefined ? null : (
            <div
              data-cache-bricks-locate={props.jump.locate.status}
              style={{ ...GRID, margin: '4px 0 0', rowGap: '1px', fontVariantNumeric: 'normal' }}
            >
              {locateRows(props.jump.locate).map((row) => (
                <Row key={row.label} label={row.label} value={row.value} />
              ))}
            </div>
          )}
        </div>
      )}

      {diff === undefined ? null : <DiffTable diff={diff} />}

      {tab === 'overview' ? (
        <div>
          <Heading>Cache</Heading>
          <div style={GRID}>
            <Row label="Hit" value={showPercent(record.metrics.cacheHitRatio)} mono />
            <Row label="Read" value={showNumber(record.usage?.cacheReadTokens)} mono />
            <Row label="Uncached" value={showNumber(record.usage?.inputTokens)} mono />
            <Row label="Written" value={showNumber(record.usage?.cacheWriteTokens)} mono />
            <Row label="Prompt" value={showNumber(record.metrics.promptTokens)} mono />
          </div>
          <Heading>Tokens</Heading>
          <div style={GRID}>
            <Row label="Output" value={showNumber(record.usage?.outputTokens)} mono />
            <Row label="Reasoning" value={showNumber(record.usage?.reasoningTokens)} mono />
            <Row label="Total" value={showNumber(record.usage?.totalTokens)} mono />
          </div>
          <Heading>Timing</Heading>
          <div style={GRID}>
            <Row label="TTFT" value={showSeconds(record.metrics.ttftMs)} mono />
            <Row label="Duration" value={showSeconds(record.metrics.durationMs)} mono />
            <Row label="TPS" value={record.metrics.tps === undefined ? '—' : record.metrics.tps.toFixed(1)} mono />
          </div>
          <Heading>Route</Heading>
          <div style={GRID}>
            <Row label="Provider" value={record.route.provider} />
            <Row label="Model" value={record.route.model} />
            <Row label="Reasoning" value={`${record.route.reasoningEffort ?? '—'}${record.route.reasoningEffortDefaulted === true ? ' (adapter)' : ''}`} />
            <Row label="Max output" value={`${showNumber(record.route.maxTokens)}${record.route.maxTokensDefaulted === true ? ' (adapter)' : ''}`} />
          </div>
          <Heading>Result</Heading>
          <div style={GRID}>
            <Row label="Finish" value={record.finish?.reason ?? '—'} />
            <Row label="Tools" value={showNumber(record.metrics.toolCallCount)} mono />
            <Row label="Retries" value={record.retry === undefined ? '0' : String(record.retry.retry)} mono />
            <Row label="Interrupted" value={record.interrupted === true ? 'yes' : 'no'} />
          </div>
        </div>
      ) : null}

      {tab === 'request' ? (
        record.observedBy === 'client' ? <NotCollected what="The outgoing request and its header hashes" /> : (
        <div>
          <Heading>Header</Heading>
          <div style={GRID}>
            <Row label="Event seq" value={showNumber(record.request.headerEventSeq)} mono />
            <Row label="Reason" value={record.request.headerReason ?? '—'} />
            <Row label="Starts series" value={record.request.startsSeries === true ? 'yes' : 'no'} />
            <Row label="Header hash" value={showHash(record.request.headerHash)} mono />
          </div>
          <Heading>Prefix</Heading>
          <div style={GRID}>
            <Row label="System hash" value={showHash(record.request.systemHash)} mono />
            <Row label="Tools hash" value={showHash(record.request.toolsHash)} mono />
            <Row label="Messages hash" value={showHash(record.request.messagesHash)} mono />
            <Row label="Messages" value={showNumber(record.request.messageCount)} mono />
            <Row label="Shared prefix" value={showNumber(record.request.sharedMessagePrefix)} mono />
            <Row label="Newly stored" value={record.request.messagesStored === undefined ? '—' : `${showNumber(record.request.messagesStored)} messages`} mono />
            {/*
              The tool rows say which list the hash covers. From 0.1.7-rc.2 a request may
              carry a history-relative declaration list: the header's own list plus what
              earlier developer messages activated. The count is what the model could call
              here, so the split is spelled out rather than folded into one number.
            */}
            <Row
              label="Tool schemas"
              value={record.request.toolSchemaAdded === undefined
                ? showNumber(record.request.toolSchemaCount)
                : `${showNumber(record.request.toolSchemaCount)} (${showNumber(record.request.toolSchemaDeclared)} declared +${showNumber(record.request.toolSchemaAdded)} in history)`}
              mono
            />
            {record.request.deferredToolCount === undefined ? null : (
              <Row label="Deferred" value={`${showNumber(record.request.deferredToolCount)} (activated by a later message)`} mono />
            )}
            {record.request.toolSchemaActivated === undefined ? null : (
              <Row label="Activated" value={`${showNumber(record.request.toolSchemaActivated)} declaration(s) activated by the history`} mono />
            )}
            {record.request.toolUpdateMessages === undefined ? null : (
              <Row label="Tool updates" value={`${showNumber(record.request.toolUpdateMessages)} developer message(s) changed the tool set`} mono />
            )}
            {record.request.developerMessageCount === undefined ? null : (
              <Row label="Developer msgs" value={showNumber(record.request.developerMessageCount)} mono />
            )}
          </div>
        </div>
        )
      ) : null}

      {tab === 'context' ? (
        record.observedBy === 'client' ? <NotCollected what="The context snapshot taken at dispatch" /> : (
        <div>
          <Heading>At dispatch</Heading>
          <div style={GRID}>
            <Row label="Pressure" value={showNumber(record.context?.pressureTokens)} mono />
            <Row label="Projected" value={showNumber(record.context?.projectedTokens)} mono />
            <Row label="Window" value={showNumber(record.context?.contextWindow ?? record.route.contextWindow)} mono />
            <Row label="Occupancy" value={showPercent(record.metrics.contextOccupancy)} mono />
            <Row label="Surface" value={showNumber(record.context?.surfaceTokens)} mono />
            <Row label="Δ surface" value={showNumber(record.context?.surfaceDeltaTokens)} mono />
          </div>
          <Heading>≈ Composition (heuristic)</Heading>
          <div style={GRID}>
            <Row label="System" value={`≈ ${showNumber(record.context?.systemTokens)}`} mono />
            <Row label="Tools" value={`≈ ${showNumber(record.context?.toolsTokens)}`} mono />
            <Row label="Messages" value={`≈ ${showNumber(record.context?.messageTokens)}`} mono />
          </div>
          <Heading>Token meter</Heading>
          <div style={GRID}>
            <Row label="Baseline" value={record.context?.baselineKind ?? '—'} />
            <Row label="Baseline tokens" value={showNumber(record.context?.baselineTokens)} mono />
            <Row label="Total" value={showNumber(record.context?.totalMeterTokens)} mono />
            <Row label="Surface nodes" value={showNumber(record.context?.nodeCount)} mono />
          </div>
        </div>
        )
      ) : null}

      {tab === 'stream' ? (
        record.observedBy === 'client' ? <NotCollected what="The timed model stream" /> : (
          <Timeline entries={expandStreamRecords(Array.isArray(props.raw?.stream) ? props.raw.stream as readonly unknown[] : [])} />
        )
      ) : null}

      {tab === 'tools' ? (
        record.observedBy === 'client' ? <NotCollected what="Tool calls and their results" /> : (
        <div>
          <Heading>{`Tool calls (${String(record.tools.length)})`}</Heading>
          {record.tools.length === 0 ? <div style={{ color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>none</div> : null}
          {record.tools.map((call) => (
            <div key={call.callId} style={{ borderTop: '1px solid rgba(148,163,184,.2)', padding: '4px 0' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <strong>{call.name === '' ? '(unnamed)' : call.name}</strong>
                <span style={{ flex: 1, color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>{showHash(call.callId)}</span>
                {call.isError === true ? <span style={{ color: '#f87171' }}>{call.error?.code ?? 'error'}</span> : null}
              </div>
              <div style={{ ...GRID, margin: '2px 0' }}>
                <Row label="Arguments" value={call.argumentsChars === undefined ? '—' : `${showNumber(call.argumentsChars)} chars`} mono />
                <Row label="Duration" value={showSeconds(call.durationMs)} mono />
                <Row label="Result" value={call.resultRef === undefined ? '—' : showHash(call.resultRef)} mono />
              </div>
            </div>
          ))}
        </div>
        )
      ) : null}

      {tab === 'retry' ? (
        <div>
          <Heading>Retry</Heading>
          {record.retry === undefined ? (
            <div style={{ color: 'var(--dsw-alias-label-tertiary, #94a3b8)' }}>no retry scheduled for this attempt</div>
          ) : (
            <div style={GRID}>
              <Row label="Chain" value={showHash(record.retry.retryId)} mono />
              <Row label="Attempt" value={`${String(record.retry.retry)} of ${record.retry.maxRetries === undefined ? '∞' : String(record.retry.maxRetries)}`} mono />
              <Row label="Mode" value={record.retry.mode} />
              <Row label="Delay" value={showSeconds(record.retry.delayMs)} mono />
              <Row label="Failure" value={record.retry.failureMessage ?? '—'} />
            </div>
          )}
          <Heading>Finish</Heading>
          <div style={GRID}>
            <Row label="Reason" value={record.finish?.reason ?? '—'} />
            <Row label="Code" value={record.finish?.failure?.code ?? '—'} mono />
            <Row label="Message" value={record.finish?.failure?.message ?? '—'} />
            <Row label="Status" value={showNumber(record.finish?.failure?.status)} mono />
            <Row label="Retry after" value={showSeconds(record.finish?.failure?.providerRetryAfterMs)} mono />
            <Row label="Request id" value={record.finish?.failure?.requestId ?? '—'} mono />
          </div>
          <Heading>Settlement</Heading>
          <div style={GRID}>
            <Row label="State" value={record.settlement} />
            <Row label="Seq" value={showNumber(record.settlementSeq)} mono />
            <Row label="Interrupted" value={record.interrupted === true ? 'yes' : 'no'} />
          </div>
        </div>
      ) : null}

      {tab === 'transcript' ? (
        <TranscriptTab
          state={props.transcript ?? { status: 'idle' }}
          {...(props.onLoadTranscript === undefined ? {} : { onLoad: props.onLoadTranscript })}
        />
      ) : null}

      {tab === 'raw' ? <RawTab props={props} /> : null}
    </div>
  )
}
