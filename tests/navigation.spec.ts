/**
 * The unified navigation entry point, exercised without a browser or a session.
 *
 * Two things are being pinned here, and they are the reason this module exists:
 *
 * - **the loader is the official one.** `ISession.loadThrough(seq)` is called with the
 *   brick's own log position, and the answer is read back from the session's event window —
 *   no clicking another component's controls, no page counting, no guessing.
 * - **every branch says what it is.** "Nothing to load for", "no position known", "no session
 *   face on this core", "already covered" and "asked but still not covered" are five different
 *   sentences, and a UI that cannot tell them apart is how a miss gets reported as a success.
 */
import { describe, expect, it } from 'vitest'
import {
  covers,
  durableEventsOf,
  ensureBrickTargetLoaded,
  loadRequestForTurn,
  loadRequestOf,
  readTranscript,
  resolveHistoricalStep,
  sessionFaceOf,
  type SessionFace,
  type WindowSnapshot,
} from '../src/client/navigation'

/** An event window over a run of durable seqs, oldest first. */
function window(entries: { type: string; seq: number; data?: Record<string, unknown> }[], hasMore = true): WindowSnapshot {
  return {
    hasMore,
    entries: entries.map((entry) => ({ type: 'event', event: { ...entry, time: entry.seq } })),
  }
}

/** A session face over an event window, recording every `loadThrough` call. */
function face(options: {
  readonly window?: WindowSnapshot
  /** The window to install once `loadThrough` is called. */
  readonly after?: WindowSnapshot
  readonly throws?: boolean
}): SessionFace & { asked: number[] } {
  let current = options.window ?? window([{ type: 'turn/start', seq: 100 }, { type: 'turn/end', seq: 140 }])
  const asked: number[] = []
  return {
    asked,
    async loadThrough(seq) {
      asked.push(seq)
      if (options.throws === true) throw new Error('soft failure')
      if (options.after !== undefined) current = options.after
    },
    getSnapshot: () => ({ hasMore: current.hasMore === true }),
    eventSource: { getSnapshot: () => current },
  }
}

const instant = async (): Promise<void> => { await Promise.resolve() }

describe('sessionFaceOf: reaching the official face, or not', () => {
  const session = { loadThrough: async () => {}, eventSource: { getSnapshot: () => window([]) } }

  it('takes the binding’s session face for the session asked about', () => {
    const service = { binding: (id: string) => (id === 'session-1' ? { session } : undefined) }
    expect(sessionFaceOf(service, 'session-1')).toBe(session)
    expect(sessionFaceOf(service, 'session-2')).toBeUndefined()
  })

  it('refuses anything that cannot load through, so the UI reports "no loader"', () => {
    expect(sessionFaceOf(undefined, 'session-1')).toBeUndefined()
    expect(sessionFaceOf({}, 'session-1')).toBeUndefined()
    expect(sessionFaceOf({ binding: () => ({}) }, 'session-1')).toBeUndefined()
    expect(sessionFaceOf({ binding: () => ({ session: { eventSource: {} } }) }, 'session-1')).toBeUndefined()
    expect(sessionFaceOf({ binding: () => ({ session }) }, undefined)).toBeUndefined()
  })

  it('survives a service that throws rather than letting it reach a click handler', () => {
    const service = { binding: () => { throw new Error('no binding') } }
    expect(sessionFaceOf(service, 'session-1')).toBeUndefined()
  })
})

describe('covers: whether the window already reaches a position', () => {
  it('does not read "no older history" as blanket coverage', () => {
    // `hasMore === false` says there is nothing older left to page in; it does not say the
    // window reaches a position below its own oldest event. Coverage is the window *spanning*
    // the position, not how much history is left outside it — the old blanket answer turned a
    // position the session does not hold into "already loaded".
    const never = face({ window: window([{ type: 'turn/start', seq: 900 }], false) })
    expect(covers(never, 12)).toBe(false)
    // The same window, asked about a position it really holds: that one is covered.
    expect(covers(never, 900)).toBe(true)
  })

  it('compares the window’s own span with the position asked for', () => {
    const some = face({ window: window([{ type: 'turn/start', seq: 300 }, { type: 'turn/end', seq: 340 }]) })
    expect(covers(some, 300)).toBe(true)
    // Strictly inside the span, and at its newest edge: both are held.
    expect(covers(some, 320)).toBe(true)
    expect(covers(some, 340)).toBe(true)
    // Below the oldest event and above the newest one the window holds nothing: it is the
    // log's tail, so neither end can answer yes.
    expect(covers(some, 299)).toBe(false)
    expect(covers(some, 341)).toBe(false)
  })

  it('does not claim coverage from an empty window', () => {
    expect(covers(face({ window: window([]) }), 1)).toBe(false)
  })
})

describe('ensureBrickTargetLoaded: one entry point, five different answers', () => {
  it('separates the two reasons there is nothing to load', async () => {
    const session = face({})
    expect(await ensureBrickTargetLoaded(session, loadRequestOf({ kind: 'none', reason: 'session-title' })))
      .toEqual({ status: 'nothing-to-load' })
    expect(await ensureBrickTargetLoaded(session, loadRequestOf({ kind: 'assistant-step', turn: 4, step: 1, part: 'response' })))
      .toEqual({ status: 'no-seq' })
    // Neither asked the session for anything: there was nothing to ask for.
    expect(session.asked).toEqual([])
  })

  it('reports a core with no session face instead of quietly doing nothing', async () => {
    expect(await ensureBrickTargetLoaded(undefined, { seq: 12 })).toEqual({ status: 'no-loader', seq: 12 })
  })

  it('does not touch the network when the window already covers the position', async () => {
    // The window has to *span* seq 12 (oldest ≤ 12 ≤ newest) to be "already loaded": the
    // single event at seq 10 that used to stand in for it does not reach the position.
    const session = face({ window: window([{ type: 'turn/start', seq: 10 }, { type: 'turn/end', seq: 20 }]) })
    expect(await ensureBrickTargetLoaded(session, { seq: 12 })).toEqual({ status: 'already-loaded', seq: 12 })
    expect(session.asked).toEqual([])
  })

  it('asks the official loader for the brick’s own position, and confirms coverage after', async () => {
    const session = face({
      window: window([{ type: 'turn/start', seq: 900 }]),
      after: window([{ type: 'turn/start', seq: 12 }, { type: 'turn/end', seq: 40 }]),
    })
    expect(await ensureBrickTargetLoaded(session, { seq: 12 }, { wait: instant }))
      .toEqual({ status: 'loaded', seq: 12 })
    expect(session.asked).toEqual([12])
  })

  it('reports a load that does not reach the position, rather than assuming it did', async () => {
    const session = face({ window: window([{ type: 'turn/start', seq: 900 }]) })
    expect(await ensureBrickTargetLoaded(session, { seq: 12 }, { wait: instant, timeoutMs: 200, pollMs: 50 }))
      .toEqual({ status: 'timeout', seq: 12 })
    expect(session.asked).toEqual([12])
  })

  it('treats a throwing loader as a question the window still answers', async () => {
    // The session publishes its own failures (`snapshot.loadingOlder`, `openError`); what
    // matters here is only whether the window now covers the position.
    const session = face({ window: window([{ type: 'turn/start', seq: 900 }]), throws: true })
    expect(await ensureBrickTargetLoaded(session, { seq: 12 }, { wait: instant, timeoutMs: 100, pollMs: 50 }))
      .toEqual({ status: 'timeout', seq: 12 })
  })

  it('carries the reason a turn cannot be read at all', () => {
    expect(loadRequestForTurn(301)).toEqual({ seq: 301 })
    expect(loadRequestForTurn(0)).toEqual({ unreachable: 'no-seq' })
    expect(loadRequestForTurn(undefined)).toEqual({ unreachable: 'no-seq' })
  })
})

describe('durableEventsOf: the log, without the client-only rows', () => {
  it('keeps durable events in seq order and drops transient ones', () => {
    const events = durableEventsOf({
      hasMore: true,
      entries: [
        { type: 'event', event: { type: 'turn/start', seq: 30, data: { turn: 1 } } },
        { type: 'transient', event: { type: 'assistant/live-chunk', seq: 31, data: {} } },
        { type: 'event', event: { type: 'step/start', seq: 29, data: { turn: 1, step: 1 } } },
        { type: 'event', event: { type: 'no-seq' as string, data: {} } },
      ],
    })
    expect(events.map((event) => event.seq)).toEqual([29, 30])
    expect(events[0]!.type).toBe('step/start')
  })
})

describe('readTranscript: the conversation, from the session’s own log', () => {
  const stepWindow = (): WindowSnapshot => window([
    { type: 'turn/start', seq: 100, data: { turn: 4 } },
    {
      type: 'user/message',
      seq: 101,
      data: { source: 'user', content: [{ type: 'text', text: 'why is the cache cold?' }] },
    },
    { type: 'step/start', seq: 102, data: { turn: 4, step: 1 } },
    { type: 'tool/call', seq: 103, data: { turn: 4, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"ls"}' } },
    {
      type: 'assistant/message',
      seq: 104,
      data: {
        turn: 4,
        step: 1,
        message: {
          content: [
            { type: 'reasoning', text: 'the header changed' },
            { type: 'text', text: 'It is cold because the header changed.' },
          ],
        },
      },
    },
    {
      type: 'tool/result',
      seq: 105,
      data: { turn: 4, step: 1, message: { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'a.ts' }] } },
    },
    { type: 'turn/end', seq: 106, data: { turn: 4, reason: { kind: 'stop' } } },
    { type: 'turn/start', seq: 200, data: { turn: 5 } },
    {
      type: 'user/message',
      seq: 201,
      data: { source: 'user', content: [{ type: 'text', text: 'and now?' }] },
    },
  ])

  it('reads the prompt, the assistant content and the calls of one step', () => {
    const view = readTranscript(face({ window: stepWindow() }), 4, 1, 104)
    expect(view).toBeDefined()
    expect(view!.inputs).toEqual([{ source: 'user', text: 'why is the cache cold?' }])
    expect(view!.reasoning).toBe('the header changed')
    expect(view!.text).toBe('It is cold because the header changed.')
    expect(view!.assistant).toBe('message')
    expect(view!.calls).toEqual([
      { callId: 'call_1', name: 'bash', args: '{"command":"ls"}', result: 'a.ts', isError: false },
    ])
    expect(view!.loaded).toBe(true)
    expect(view!.covers).toBe(true)
  })

  it('keeps a turn’s prompts to that turn', () => {
    const view = readTranscript(face({ window: stepWindow() }), 5, 1, 201)
    expect(view!.inputs).toEqual([{ source: 'user', text: 'and now?' }])
    // Turn 5 has no assistant event in the window, and that is a fact about the log.
    expect(view!.assistant).toBe('none')
    expect(view!.text).toBe('')
  })

  it('says an attempt committed no message instead of showing an empty box', () => {
    const window_ = window([
      { type: 'turn/start', seq: 100, data: { turn: 4 } },
      { type: 'step/start', seq: 102, data: { turn: 4, step: 1 } },
      { type: 'assistant/attempt', seq: 103, data: { turn: 4, step: 1, stream: [] } },
    ])
    const view = readTranscript(face({ window: window_ }), 4, 1, 103)
    expect(view!.assistant).toBe('attempt')
    expect(view!.text).toBe('')
  })

  it('marks a turn that is not in the window as not loaded', () => {
    const view = readTranscript(face({ window: stepWindow() }), 99, 1, 9)
    expect(view!.loaded).toBe(false)
    // The position is below the window’s oldest event, so the loader would have to run.
    expect(view!.covers).toBe(false)
  })

  it('refuses a compaction, which belongs to no turn', () => {
    expect(readTranscript(face({ window: stepWindow() }), 0, 0, 57)).toBeUndefined()
  })
})

describe('resolving a folded step against the durable log', () => {
  /** One Turn with four steps: a thinking one, a tool-only one, a retried one, a silent one. */
  const log = (): WindowSnapshot => window([
    { type: 'turn/start', seq: 100, data: { turn: 4 } },
    { type: 'step/start', seq: 101, data: { turn: 4, step: 1 } },
    {
      type: 'assistant/message',
      seq: 102,
      data: {
        turn: 4,
        step: 1,
        message: { content: [{ type: 'reasoning', text: 'weighing it' }, { type: 'text', text: 'here is why' }] },
      },
    },
    { type: 'step/start', seq: 103, data: { turn: 4, step: 2 } },
    { type: 'tool/call', seq: 104, data: { turn: 4, step: 2, callId: 'call_9', name: 'bash', arguments: '{}' } },
    { type: 'tool/result', seq: 105, data: { message: { toolCallId: 'call_9', content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'step/start', seq: 106, data: { turn: 4, step: 3 } },
    { type: 'llm/retry', seq: 107, data: { turn: 4, step: 3, retryId: 'r-7', retry: 1, delayMs: 500 } },
    { type: 'step/start', seq: 108, data: { turn: 4, step: 4 } },
    { type: 'assistant/attempt', seq: 109, data: { turn: 4, step: 4, stream: [] } },
  ])

  it('sends a thinking step to its reasoning half and a speaking step to its response half', () => {
    // Acceptance case ②: the ordinary answer. Which half is decided by what the step actually
    // contains — the same rule the collected path uses — so the two paths cannot disagree.
    const face_ = face({ window: log() })
    expect(resolveHistoricalStep(face_, { kind: 'historical-step', turn: 4, step: 1, loadSeq: 102 }))
      .toEqual({ kind: 'assistant-step', turn: 4, step: 1, part: 'reasoning', loadSeq: 102 })

    const spoke = face({ window: window([
      { type: 'turn/start', seq: 100, data: { turn: 4 } },
      { type: 'step/start', seq: 101, data: { turn: 4, step: 1 } },
      {
        type: 'assistant/message',
        seq: 102,
        data: { turn: 4, step: 1, message: { content: [{ type: 'text', text: 'only an answer' }] } },
      },
    ]) })
    expect(resolveHistoricalStep(spoke, { kind: 'historical-step', turn: 4, step: 1, loadSeq: 102 }))
      .toEqual({ kind: 'assistant-step', turn: 4, step: 1, part: 'response', loadSeq: 102 })
  })

  it('sends a tool-only step to the call the log recorded, by call id', () => {
    // Acceptance case ③: no assistant row exists for this step; the call id is the only thing
    // that can name its row, and it comes from the durable `tool/call` event.
    const resolved = resolveHistoricalStep(face({ window: log() }), { kind: 'historical-step', turn: 4, step: 2, loadSeq: 104 })
    expect(resolved).toEqual({ kind: 'tool-call', turn: 4, step: 2, callId: 'call_9', loadSeq: 104 })
  })

  it('sends a retried step to the retry chain, and never to a neighbouring step', () => {
    // Acceptance case ④: the retry schedule is durable, so the scene that holds both attempts
    // together is reachable without any collector state — and step 3 stays step 3.
    const resolved = resolveHistoricalStep(face({ window: log() }), { kind: 'historical-step', turn: 4, step: 3, loadSeq: 107 })
    expect(resolved).toEqual({ kind: 'retry-chain', turn: 4, step: 3, retryId: 'r-7', loadSeq: 107 })
    expect(resolved).not.toMatchObject({ step: 2 })
    expect(resolved).not.toMatchObject({ step: 4 })
  })

  it('offers no row for a step that produced neither a message nor a call', () => {
    // An attempt that settled with nothing to show. The reveal lands on the Turn and says
    // `context`; this function's job is to refuse to name a row that does not exist.
    expect(resolveHistoricalStep(face({ window: log() }), { kind: 'historical-step', turn: 4, step: 4, loadSeq: 109 }))
      .toBeUndefined()
  })

  it('leaves the log position off when the fold measured no position', () => {
    const resolved = resolveHistoricalStep(face({ window: log() }), { kind: 'historical-step', turn: 4, step: 1 })
    expect(resolved).toEqual({ kind: 'assistant-step', turn: 4, step: 1, part: 'reasoning' })
  })

  it('says nothing at all without a session face, instead of guessing from the DOM', () => {
    expect(resolveHistoricalStep(undefined, { kind: 'historical-step', turn: 4, step: 1, loadSeq: 102 }))
      .toBeUndefined()
  })
})
