import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// The renderer owns the `ctx.slots` registry this half registers into; the other
// two supply the node contract and the chat-store/selector face it reads.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ReactElement } from 'react'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { Context } from '@deepseek-ai/cordis'
import { cacheBricksDefinition, type CacheBricksNodeData, type StepSample } from './cache-bricks-node'
import { badgeLogLine, badgeStatus, brickLabel, hasCacheFields, ttftMs } from './logic'
import { CacheTetrisBoard } from './tetris-view'
import type { Brick } from './tetris'
import { locateResultOf, type RevealOutcome } from './reveal'
import { BrickFeedClient } from './feed'
import { BrickPanel, type JumpReport, type RawKind, type TranscriptState } from './panel'
import { boardFromReadings, boardFromSources, type BoardData, type StepReading } from './bricks'
import {
  durableEvents, ensureTurnTranscriptLoaded, HistoryPager, loadRequestForTurn, onWindowChange, readTranscript,
  resolveHistoricalStep, sessionFaceOf,
  type LoadReport, type LoadRequest, type SessionFace,
} from './navigation'
import { HistoryScene, type SceneDemand } from './history-scene'
import { diffBricks } from '../shared/diff'
import type { BrickFeed, BrickRecord } from '../shared/brick'


/**
 * Selector hook over the Chat store, declared structurally: ui-chat's own
 * `UseChat` alias resolves through `@deepseek-ai/dsh-client-store`, a runtime
 * package this plugin deliberately does not depend on (it never imports it at
 * runtime), so the shape is restated here instead.
 */
type ChatSelector = <T>(selector: (snapshot: ChatSnapshot) => T) => T

/** The session seat delivers the Chat store selector (ui-chat's SessionStandardProps). */
interface CacheBricksBoardProps {
  useChat?: ChatSelector
  /** Session this seat belongs to (session-scoped seat), when the carrier provides it. */
  sessionId?: string
}

/** One console line per step and badge content, surviving React remounts. */
const logged = new Set<string>()

/**
 * The feed client, kept outside the component so the panel's raw loader can reach
 * it without threading a callback through every level.
 */
const feedClientRef: { current: BrickFeedClient | undefined } = { current: undefined }

/**
 * The client context, kept only so the official services can be resolved **at use time**.
 *
 * They cannot be resolved once at startup: the sessions service is provided *after* this
 * plugin's client half applies (measured on 0.1.7-rc.1: `ctx.get('sessions')` is undefined
 * inside `apply` and present two seconds later), so anything captured early would be a
 * permanent `undefined` — a jump feature that never loads and never says why.
 */
const ctxRef: { current: Context | undefined } = { current: undefined }

/** How one load ended, in one short sentence for the panel. */
export function loadText(report: LoadReport): string {
  switch (report.status) {
    case 'not-needed':
      return 'the row was already on screen'
    case 'already-loaded':
      return `history already covered seq ${String(report.seq)}`
    case 'loaded':
      return `loaded history through seq ${String(report.seq)}`
        + (report.rendered === false ? ' (the transcript has not rendered it)' : '')
    case 'nothing-to-load':
      return 'this brick has no row in the transcript to load for'
    case 'no-seq':
      return 'the record carries no log position for this attempt, so there is nothing to load'
    case 'no-loader':
      return 'this core did not give the plugin a session face, so nothing could be loaded'
    case 'timeout':
      return `history was requested but the window still does not cover seq ${String(report.seq)}`
      + (report.rendered === false ? ' — and the transcript shows no new rows either' : '')
  }
}

/**
 * The one loader this session's bricks use, resolved fresh on every call.
 *
 * @param sessionId - the session the board is showing.
 * @returns a function that makes the window cover a target's log position.
 */
function loaderFor(sessionId: string | undefined): (request: LoadRequest) => Promise<LoadReport> {
  return async (request) => ensureTurnTranscriptLoaded(faceFor(sessionId), request)
}

/**
 * The session's own log, read a **scene** at a time — the board's historical source.
 *
 * The collector only ever sees this process, so a brick older than it used to lose its type, its
 * lifecycle and its target. The log has held all of that all along; `./history-scene` reads it
 * with the same observations the collector uses, so a replayed brick means what a live one means,
 * minus the request capture the log never had.
 *
 * What changed in 0.1.4 is *how much* of it is read at once. Replaying the whole window worked
 * while the window was one session's tail; once it could page older history in, the replay grew
 * past the ledger's brick budget and the oldest bricks came back typed by the client fold. The
 * board now says which Turns and steps are on screen, and only that slice is replayed.
 *
 * One service per session, kept outside the component so a re-render cannot lose a warm scene.
 */
let historySceneRef: { sessionId: string; scene: HistoryScene } | undefined

function historySceneOf(sessionId: string | undefined): HistoryScene | undefined {
  if (sessionId === undefined || sessionId === '') return undefined
  // A different session is a different window: replace the service rather than accumulating one
  // raw-payload store per session visited.
  if (historySceneRef?.sessionId !== sessionId) historySceneRef = { sessionId, scene: new HistoryScene({ sessionId }) }
  return historySceneRef.scene
}

/** The session face for this board's session, resolved fresh on every call. */
function faceFor(sessionId: string | undefined): SessionFace | undefined {
  try { return sessionFaceOf(ctxRef.current?.get('sessions'), sessionId) } catch { return undefined }
}

/**
 * Everything the session knows about one brick's place in the conversation.
 *
 * A collected brick answers through its target (which says which row it is, and which
 * log position that row needs). A folded brick has no target — but it still has a
 * turn, a step and the seq it was measured from, which is enough to read the turn.
 */
function transcriptQueryOf(record: BrickRecord): { turn: number; step: number; request: LoadRequest } | undefined {
  if (record.identity.turn <= 0) return undefined
  return {
    turn: record.identity.turn,
    step: record.identity.step,
    request: { ...loadRequestForTurn(record.settlementSeq), turn: record.identity.turn },
  }
}

/**
 * Providers that have ever reported a cache-accounting field in this page. Once
 * a provider is in this set, a later request without cache fields is read as a
 * genuine `0` read (a full miss) instead of being left unconfirmed.
 */
const providersWithCacheEvidence = new Set<string>()

/** One detailed console warning per provider that never reports cache fields. */
const unconfirmedNotified = new Set<string>()

/** Every materialized Turn reading, oldest first (visible or hidden nodes). */
function selectReadings(snapshot: ChatSnapshot): readonly CacheBricksNodeData[] {
  const turns: CacheBricksNodeData[] = []
  for (const node of snapshot.nodes.values()) {
    if (node.kind !== 'cache-bricks') continue
    const data = node.data as CacheBricksNodeData | undefined
    if (data !== undefined) turns.push(data)
  }
  return turns.sort((left, right) => left.turn - right.turn)
}

/** Whether this page has evidence that the step's provider reports cache fields. */
function evidenceFor(sample: StepSample): boolean {
  return hasCacheFields(sample.usage)
    || (sample.provider !== undefined && providersWithCacheEvidence.has(sample.provider))
}

/**
 * The brick board: each real model request attempt drops a brick into its Turn's column,
 * the newest Turn anchored at the board's right edge, so a finished Turn pushes the older
 * columns one cell to the left and the next Turn stacks in the free column. It renders
 * nothing into the session seat it is mounted in — the board is a body-level overlay (see
 * {@link CacheTetrisBoard}) parked in the blank gutter beside the transcript, because no
 * seat exists there.
 *
 * A brick is an attempt, not a step: this harness retries, and the retry is a second
 * request with its own cache outcome. What each brick *shows* is folded from the session
 * event feed per step, so the fold is a fallback with a different granularity — see
 * `./bricks` — and those reduced bricks make no claim about a transcript row.
 */
function CacheBricksBoard(props: CacheBricksBoardProps): ReactElement | null {
  // `useChat` arrives from ui-chat's SessionStandardProps merge. The guard is
  // invariant for a given seat (a carrier either delivers the face or never
  // does), so the hook order stays stable across renders.
  const turns = typeof props.useChat === 'function' ? props.useChat(selectReadings) : undefined
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
  const boardRef = useRef<CacheTetrisBoard | undefined>(undefined)
  const selectedRef = useRef<string | undefined>(undefined)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [tab, setTab] = useState('transcript')
  const [comparing, setComparing] = useState(false)
  const [raw, setRaw] = useState<Partial<Record<RawKind, unknown>>>({})
  const [jump, setJump] = useState<JumpReport | undefined>(undefined)
  const [transcript, setTranscript] = useState<TranscriptState>({ status: 'idle' })
  const [previewReload, setPreviewReload] = useState(0)
  const [notice, setNotice] = useState<{ state: 'loading' | 'success' | 'error'; text: string } | undefined>(undefined)
  const feed = useFeed(sessionId)
  useEffect(() => {
    if (notice?.state !== 'success') return
    const timer = setTimeout(() => setNotice(undefined), 3500)
    return () => clearTimeout(timer)
  }, [notice])

  // Evidence is recorded during render, not from an effect: it is an idempotent
  // module-level memo, and classifying a step must not depend on whether an
  // earlier step's commit already ran its effects. Only the console once-gates
  // below need commit semantics.
  if (turns !== undefined) {
    for (const data of turns) {
      for (const sample of data.steps) {
        if (hasCacheFields(sample.usage) && sample.provider !== undefined) {
          providersWithCacheEvidence.add(sample.provider)
        }
      }
    }
  }
  const signature = turns === undefined ? '' : turns.map((data) => [
    data.turn,
    data.ended ? 'e' : 'o',
    data.steps.map((sample) => `${String(sample.step)}:${String(sample.usage?.inputTokens ?? '')}:${String(sample.usage?.cacheReadTokens ?? '')}`).join(','),
  ].join('|')).join(';')

  // Console side effects run after commit: warn once per provider that reports
  // no cache fields, and log one line per step. A discarded React render must
  // not consume the once-gates or drop the log line.
  useEffect(() => {
    if (turns === undefined) return
    for (const data of turns) {
      for (const sample of data.steps) {
        if (sample.usage === undefined) continue
        if (
          sample.provider !== undefined
          && !hasCacheFields(sample.usage)
          && !providersWithCacheEvidence.has(sample.provider)
          && !unconfirmedNotified.has(sample.provider)
        ) {
          unconfirmedNotified.add(sample.provider)
          console.warn(
            `[dsh-cache-bricks] provider "${sample.provider}" returned usage without `
            + 'cacheReadTokens/cacheWriteTokens; no cache field has been seen for it, so its steps '
            + 'show "n/a" instead of a percentage.',
          )
        }
        const decided = badgeStatus({ usage: sample.usage, hasCacheEvidence: evidenceFor(sample) })
        if (decided === null) continue
        const lineKey = `${String(data.turn)}:${String(sample.step)}:${decided.label}`
        if (logged.has(lineKey)) continue
        logged.add(lineKey)
        console.info(badgeLogLine(decided, {
          turn: data.turn,
          step: sample.step,
          provider: sample.provider,
          at: sample.usageTime ?? Date.now(),
        }))
      }
    }
  }, [signature])

  // The reporting is shared by the board's double click and the panel's button, so the two
  // can never drift apart about what a jump reached. It lives in a ref because the board is
  // created once, imperatively, and must not be re-created when a render brings a new closure.
  const reporter = useRef<(brick: Brick, outcome: RevealOutcome) => void>(() => {})
  reporter.current = (brick, outcome) => {
    const where = brick.turn > 0 ? `turn ${String(brick.turn)} step ${String(brick.step)}` : 'an auxiliary call'
    const row = outcome.element?.getAttribute?.('data-chat-node-key')
    const detail = [
      loadText(outcome.load),
      outcome.expanded ? 'opened a collapsed group' : undefined,
      row === undefined ? undefined : row,
    ].filter((part): part is string => part !== undefined).join(', ')
    const located = locateResultOf(outcome)
    setNotice({
      state: located.status === 'exact' ? 'success' : 'error',
      text: located.status === 'exact-not-visible'
        // Found, and the reader cannot see it: a capped process group is clipping the row. Say that
        // rather than "located" — the whole point of the check is that this case stops lying.
        ? '找到了这一行，但它被这一轮的过程组裁掉了，屏幕上看不见；没有高亮，也不当作定位成功。'
        : outcome.accuracy === 'exact'
        // A folded brick lands on its **step**: say so, so a step-level landing is never read
        // as "this is the request you clicked" (the board's dashes say it too, but the notice
        // is what a reader actually reads).
        ? brick.estimated === true
          ? `已定位：第 ${String(brick.turn)} 轮 · 第 ${String(brick.step)} 步（历史折叠砖：step 级，不含 attempt）`
          : `已定位：第 ${String(brick.turn)} 轮 · 第 ${String(brick.step)} 步`
        : outcome.fellBack === true
          // Reached, but the row is the same step's other half: say which half is missing
          // rather than reporting a miss that did not happen (or a success that is not one).
          ? '本步骤这一半没有渲染行；已定位到同一步骤的另一半（未高亮）。'
          : outcome.load.status === 'nothing-to-load'
            ? '这块砖没有原对话行；单击可查看详情。'
            : '未找到这块砖的原对话行，没有跳到邻近内容。单击可查看对话预览和诊断。',
    })
    setJump({
      turn: brick.turn,
      step: brick.step,
      accuracy: outcome.accuracy,
      row: outcome.row,
      load: outcome.load,
      locate: located,
    })
    console.info(
      `[dsh-cache-bricks] ${where}: ${outcome.accuracy} landing · locate=${located.status}`
      + `${detail === '' ? '' : ` (${detail})`}`,
    )
  }

  /**
   * The pager, and the one thing to do when a page lands: rebuild the index from the window the
   * session now holds, re-cut the screen the reader is on, and let React see the new scene.
   *
   * The board asks for a page on every paint near the left edge, so both halves are idempotent:
   * `need()` answers `stalled`/`busy`/`no-more` without a request, and `window()` rescans only
   * when the window actually moved.
   */
  const pagerRef = useRef<HistoryPager | undefined>(undefined)
  const refreshScene = useRef<() => void>(() => {})
  refreshScene.current = () => {
    const scene = historySceneOf(sessionId)
    if (scene === undefined) return
    const face = faceFor(sessionId)
    if (face !== undefined) scene.window(durableEvents(face))
    scene.refresh()
  }
  pagerRef.current ??= new HistoryPager(undefined)
  pagerRef.current.aim(faceFor(sessionId))

  /**
   * The scene service is a store, and the scene it currently holds is its snapshot: when a
   * scene is cut, the key changes and React re-renders. A lookup that hit the memo changes
   * nothing, so panning inside a scene costs no renders at all.
   */
  const scene = historySceneOf(sessionId)
  useSyncExternalStore(
    (listener) => scene?.subscribe(listener) ?? (() => {}),
    () => scene?.scene?.key ?? '',
    // A server render has no window and no scene: the board is a browser overlay, and the seat
    // it is mounted into must render nothing at all (see `client-bundle.spec.ts`).
    () => '',
  )

  // A page can also arrive from outside this board (a jump, the conversation's own loader).
  // Only a window that grew at the *older* end changes the index, and that is one number to
  // compare — an append is picked up by the ordinary render path.
  const oldestSeq = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (scene === undefined) return undefined
    return onWindowChange(faceFor(sessionId), () => {
      const face = faceFor(sessionId)
      const oldest = face?.eventSource?.getSnapshot()?.entries?.[0]?.event?.seq
      if (oldest === oldestSeq.current) return
      oldestSeq.current = oldest
      refreshScene.current()
    })
  }, [sessionId, scene])

  // The board is created once and driven imperatively: it lives outside React's
  // tree (body-level overlay) and must never be re-created by a render.
  useEffect(() => {
    const board = new CacheTetrisBoard({
      // Single click reads in a preview. Double click closes it and locates the exact row.
      onSelect: (key) => {
        selectedRef.current = key
        setSelected(key)
        boardRef.current?.setSelected(key)
        setTab('transcript')
        setNotice(undefined)
        setPreviewReload((version) => version + 1)
        setComparing(false)
        setRaw({})
        setJump(undefined)
        // A new brick means a new conversation to read: the old one is not this brick's.
        setTranscript({ status: 'idle' })
      },
      onRevealStart: (brick) => {
        selectedRef.current = undefined
        setSelected(undefined)
        setTranscript({ status: 'idle' })
        boardRef.current?.setSelected(brick.key)
        setNotice({ state: 'loading', text: '正在定位这块砖对应的原对话…' })
      },
      load: loaderFor(sessionId),
      // A folded brick names a step, not a row: ask the durable log which row that step
      // became, once the jump has loaded the history the answer lives in.
      resolve: (target) => resolveHistoricalStep(faceFor(sessionId), target),
      // The board repeats what it actually reached rather than upgrading a near miss to a
      // success: `exact` is the brick's own row, `context` the Turn header, `none` nothing.
      onRevealed: (brick, outcome) => { reporter.current(brick, outcome) },
      // What the reader is looking at, sent only when it changes. The scene service replays
      // exactly that slice and announces the result, which re-renders this component and hands
      // the board a board built from exact records — one round trip, no polling.
      onScene: (demand: SceneDemand) => { historySceneOf(sessionId)?.demand(demand) },
      // Near the left edge of the history this client holds: ask for a page. The pager decides
      // whether asking means anything (`hasMore`, a page in flight, the same window twice), and
      // a page that landed is a new window — rebuild the index and re-cut the reader's screen.
      onNeedOlder: () => {
        void pagerRef.current?.need().then((status) => { if (status === 'loaded') refreshScene.current() })
      },
    })
    selectedRef.current = undefined
    setSelected(undefined)
    setNotice(undefined)
    boardRef.current = board
    board.start()
    return () => {
      boardRef.current = undefined
      board.dispose()
    }
  }, [sessionId])

  // Three sources, merged rather than swapped: the collector knows this process's attempts
  // and nothing older, a replay of the session's own log knows every attempt the client is
  // holding, and the per-step fold is what is left for a core with no session face at all.
  // A feed that answered with anything used to replace the history outright, so resuming an
  // old session dropped every brick older than the collector — and the bricks it dropped were
  // the ones that had a type and a row to go to. See `boardFromSources`.
  const readings = readingsOf(turns)
  const live = feed !== undefined && feed.sessionId === sessionId ? feed : undefined
  // Note the window the session holds now; the scan happens only when it moved, and the scene
  // for the reader's last screen is re-cut silently so this render never sees a stale one.
  if (scene !== undefined) {
    const face = faceFor(sessionId)
    if (face !== undefined) scene.window(durableEvents(face))
  }
  const replayed = scene?.scene?.feed
  const data: BoardData = live === undefined && replayed === undefined
    ? boardFromReadings(readings)
    : boardFromSources({
      ...(live === undefined ? {} : { live }),
      ...(replayed === undefined ? {} : { replay: replayed }),
      readings,
    })

  useEffect(() => {
    boardRef.current?.setColumns(data.columns, data.titles, data.aux)
    // The notice is for a board that is *entirely* folded, where "one brick per step,
    // no attempt telemetry" is true of every brick. In a mixed board the claim is per
    // brick — the restored ones are drawn dashed — so a whole-board notice would lie.
    boardRef.current?.setEstimated(data.estimated === true)
  }, [sessionId, data.columns, data.titles, data.aux, data.estimated])

  // A brick that scrolled out of the feed (or a session switch) closes the panel
  // rather than leaving it describing something no longer on the board.
  const record = selected === undefined ? undefined : data.records.get(selected)
  useEffect(() => {
    if (selected !== undefined && record === undefined) {
      selectedRef.current = undefined
      setSelected(undefined)
      boardRef.current?.setSelected(undefined)
    }
  }, [selected, record])

  // Read immediately on selection (no extra tab/button). Async results are owned by the
  // selected brick and session; closing, switching or double-clicking invalidates the read.
  useEffect(() => {
    if (record === undefined || selected === undefined) return
    let cancelled = false
    const key = selected
    const isCurrent = (): boolean => !cancelled && selectedRef.current === key
    setTranscript({ status: 'loading' })
    const query = transcriptQueryOf(record)
    const face = faceFor(sessionId)
    if (query === undefined || face === undefined) {
      setTranscript({ status: 'unavailable', report: { status: query === undefined ? 'nothing-to-load' : 'no-loader' } })
      return () => { cancelled = true }
    }
    void ensureTurnTranscriptLoaded(face, query.request, isCurrent).then((report) => {
      if (!isCurrent()) return
      const view = readTranscript(face, query.turn, query.step, query.request.seq, {
        exactAttempt: record.observedBy !== 'client',
        ...(record.observedBy === 'client' ? {} : { callIds: record.tools.map((call) => call.callId) }),
      })
      setTranscript(view === undefined ? { status: 'unavailable', report } : { status: 'ready', view, report })
    }).catch((error: unknown) => {
      if (!isCurrent()) return
      console.warn('[dsh-cache-bricks] preview read failed', error)
      // `seq` is optional under `exactOptionalPropertyTypes`: report the position only when
      // there is one, rather than carrying an explicit `undefined` into the panel's copy.
      setTranscript({
        status: 'unavailable',
        report: { status: 'timeout', ...(query.request.seq === undefined ? {} : { seq: query.request.seq }) },
      })
    })
    return () => { cancelled = true }
    // Feed objects are refreshed regularly; re-read on semantic changes, not every feed poll.
  }, [sessionId, selected, previewReload, record?.settlementSeq, record?.settlement, record?.tools.length])

  const notification = notice === undefined ? null : (
    <div role="status" aria-live="polite" data-cache-bricks-notice={notice.state}
      style={{ position: 'fixed', top: '64px', right: '20px', zIndex: 1001, maxWidth: 'min(420px, 90vw)',
        padding: '10px 14px', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-1, #18202b)',
        color: 'var(--dsw-alias-label-primary, #e5e7eb)', boxShadow: '0 4px 20px #0004', fontSize: '13px' }}>
      {notice.text}
      <button type="button" onClick={() => setNotice(undefined)} aria-label="关闭定位提示" style={{ marginLeft: '10px' }}>×</button>
    </div>
  )
  if (record === undefined) return notification

  const allBricks = [...data.columns.flatMap((column) => column.bricks), ...data.aux]
  const index = data.order.indexOf(record.identity.id)
  const previous = index > 0 ? data.records.get(data.order[index - 1]!) : undefined
  return (
    <>
    {notification}
    <BrickPanel
      record={record}
      tab={tab}
      onTab={setTab}
      onClose={() => {
        selectedRef.current = undefined
        setSelected(undefined)
        boardRef.current?.setSelected(undefined)
      }}
      {...(previous === undefined ? {} : {
        onCompare: () => { setComparing((open) => !open) },
        ...(comparing ? { diff: diffBricks(previous, record) } : {}),
      })}
      {...(jump === undefined ? {} : { jump })}
      onLocate={() => {
        const brick = allBricks.find((candidate) => candidate.key === record.identity.id)
        if (brick === undefined) return
        void boardRef.current?.goToBrick(brick)
      }}
      transcript={transcript}
      onLoadTranscript={() => setPreviewReload((version) => version + 1)}
      raw={raw}
      onLoadRaw={(kind) => {
        const ref = kind === 'request'
          ? record.request.requestRef
          : kind === 'messages'
            ? record.request.messageHashesRef
            : kind === 'header'
              ? record.request.headerRef
              : kind === 'toolHistory'
                ? record.request.toolHistoryRef
                : kind === 'stream'
                  ? record.raw.streamRef
                  : record.raw.replayRef
        if (ref === undefined) return
        const key = record.identity.id
        void feedClientRef.current?.blob(ref).then((value) => {
          if (selectedRef.current !== key) return
          setRaw((current) => ({ ...current, [kind]: value }))
        }).catch((error: unknown) => console.warn('[dsh-cache-bricks] raw read failed', error))
      }}
      {...(feed === undefined ? {} : { store: feed.store })}
    />
    </>
  )
}

/**
 * Follow the host feed for a session.
 *
 * Absent or failing, it returns undefined and the board falls back to the
 * client's own fold — the collector is an enhancement, never a requirement.
 */
function useFeed(sessionId: string | undefined): BrickFeed | undefined {
  const [feed, setFeed] = useState<BrickFeed | undefined>(undefined)
  useEffect(() => {
    setFeed(undefined)
    if (sessionId === undefined) return
    const client = new BrickFeedClient()
    feedClientRef.current = client
    const stop = client.start(sessionId, (next) => { setFeed(next) })
    return () => {
      feedClientRef.current = undefined
      stop()
    }
  }, [sessionId])
  return feed
}

/** Map the client-side per-step fold onto the fallback brick source. */
function readingsOf(turns: readonly CacheBricksNodeData[] | undefined): StepReading[] {
  const readings: StepReading[] = []
  for (const data of turns ?? []) {
    for (const sample of data.steps) {
      if (sample.usage === undefined) continue
      const decided = badgeStatus({ usage: sample.usage, hasCacheEvidence: evidenceFor(sample) })
      if (decided === null) continue
      const ttft = ttftMs(sample.stepStartTime, sample.firstTokenTime)
      readings.push({
        turn: data.turn,
        step: sample.step,
        tone: decided.tone,
        label: brickLabel(decided),
        detail: decided.label.replace('Cache ', ''),
        ended: data.ended,
        ...(sample.provider === undefined ? {} : { provider: sample.provider }),
        usage: sample.usage,
        ...(typeof sample.usageTime === 'number' ? { usageAt: sample.usageTime } : {}),
        ...(ttft > 0 ? { ttftMs: ttft } : {}),
        ...(sample.seq === undefined ? {} : { seq: sample.seq }),
      })
    }
  }
  return readings
}

/**
 * Services required by the cache-bricks browser half.
 *
 * Only `slots` is a hard dependency (always present on the web surface). The
 * conversation-node registry — where a node Definition is registered — is
 * core-owned and its service key has changed across core versions (0.1.7
 * exposes `ctx.uiConversation.events`; legacy `ctx.conversationEvents` still
 * exists on other cores). It is resolved structurally with `ctx.get` instead
 * of being injected or read as a property: a loader entry is a sibling of the
 * core entry that provides the service, so property access without `inject`
 * throws `cannot get property "<name>" without inject` and would fail apply —
 * not degrade. `ctx.get` reads the global service store and returns
 * `undefined` when absent, so a missing or renamed registry disables only the
 * board, never pending or boot failure.
 */
export const inject = ['slots']

/** The register-capable Definition registry surface the badge Definition needs. */
interface CacheBricksRegistry {
  register(definition: unknown): () => void
}

/** Structural registry read across the two core service names. */
function registerCacheBricksDefinition(
  ctx: Context,
  registerAt: (registry: CacheBricksRegistry) => void,
): void {
  const readService = (name: string): unknown => {
    try {
      return (ctx as unknown as { get(name: string): unknown }).get(name)
    } catch {
      return undefined
    }
  }
  const asRegistry = (value: unknown): CacheBricksRegistry | undefined => {
    if (value === null || typeof value !== 'object') return undefined
    const node = value as { register?: (definition: unknown) => () => void; events?: unknown }
    if (typeof node.register === 'function') return node as CacheBricksRegistry
    const events = node.events
    if (events !== null && typeof events === 'object') {
      const eventsNode = events as { register?: (definition: unknown) => () => void }
      if (typeof eventsNode.register === 'function') return eventsNode as CacheBricksRegistry
    }
    return undefined
  }
  const registry = asRegistry(readService('uiConversation'))
    ?? asRegistry(readService('conversationEvents'))
  if (registry === undefined) {
    console.warn(
      '[dsh-cache-bricks] conversation-node registry unavailable; the brick board is disabled. '
      + 'Expected the registry on browser service uiConversation.events (or legacy conversationEvents).',
    )
    return
  }
  registerAt(registry)
}

/** Register the per-Turn reading and the brick board that paints it. */
export function apply(ctx: Context): void {
  ctxRef.current = ctx
  // Defer Definition registration until the chat-node seat is declared: that
  // declaration lives under ui-chat, which injects `uiConversation`, so by the
  // time this callback fires the registry is guaranteed ACTIVE and `ctx.get`
  // resolves it. No renderer is registered for the kind: the node is published
  // hidden, so Chat never routes it into the flow.
  let definitionRegistered = false
  ctx.slots.inject('conversation.chat.node', () => {
    if (!definitionRegistered) {
      registerCacheBricksDefinition(ctx, (registry) => {
        try {
          const dispose = registry.register(cacheBricksDefinition)
          // The Definition is owned by the registry's core context; tie the
          // disposer to this fiber so an unload/reload does not leave a stale
          // `cache-bricks` Definition that makes the next run throw
          // "already registered".
          ctx.effect(() => dispose)
          definitionRegistered = true
        } catch (error) {
          console.warn('[dsh-cache-bricks] failed to register the badge node; the brick board is disabled.', error)
        }
      })
    }
    // The seat needs no renderer; it only has to be declared so this fiber
    // activates after the Chat target exists.
    return () => {}
  })

  // A session-scoped seat for the board's controller. It renders nothing: the
  // bricks are a body-level overlay anchored to the transcript's own scrollport,
  // because no seat exists in the blank gutter beside it.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'cache-bricks',
    order: 1,
  }, CacheBricksBoard))
}
