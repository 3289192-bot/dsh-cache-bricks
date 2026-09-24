/**
 * Taking the reader from a brick to its own row — exercised without a browser.
 *
 * The subject of these tests changed with the contract: the question is no longer "did
 * something scroll" but "did the row that was reached actually stand for this brick".
 * The two failures that made the feature look fixed while it was not are pinned here:
 * a later step must never be accepted as "nearest", and a miss must never scroll.
 */
import { describe, expect, it } from 'vitest'
import {
  findProcessToggle,
  findStepNodes,
  locateResultOf,
  nodeSeqOf,
  revealBrick,
  rowSelector,
  type RevealElement,
  type RevealScroller,
} from '../src/client/reveal'
import { loadRequestOf, type LoadReport } from '../src/client/navigation'
import { accuracyOf, type BrickTarget } from '../src/client/target'

/** An element that records clicks and can answer a label. */
function element(label = '', options: { disabled?: boolean } = {}): RevealElement & { clicks: number } {
  const state = {
    clicks: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    getAttribute: (name: string) => (name === 'aria-label' ? label : null),
    textContent: label,
    click: () => { state.clicks += 1 },
    ...(options.disabled === undefined ? {} : { disabled: options.disabled }),
  }
  return state
}

/**
 * A scroll container whose history grows by one page per load click.
 *
 * A row's height is what says whether it is on screen: a collapsed process group's rows
 * are in the DOM at zero height, and a `hidden="until-found"` row is revealed by a
 * `beforematch` dispatch.
 */
function scroller(options: {
  turns?: number[]
  older?: boolean
  official?: boolean
  loadsTo?: number[]
  steps?: { turn: number; step: number; height: number; group?: 'reasoning' | 'response'; untilFound?: boolean }[]
  retries?: { retryId: string; height: number; untilFound?: boolean }[]
  calls?: { callId: string; height: number; untilFound?: boolean }[]
  compactions?: { compactionId: string; height: number }[]
  anchors?: { seq: number; kind: string; id: string; height: number; turn?: number }[]
  process?: { turn: number; expanded: boolean; reveals: boolean }
}): RevealScroller & { scrolls: number[]; pages: number } {
  const mounted = new Set(options.turns ?? [])
  const state = {
    scrolls: [] as number[],
    pages: 0,
    scrollTop: 0,
    scrollHeight: 10_000,
    clientHeight: 800,
    getBoundingClientRect: () => ({ top: 0 }),
    scrollTo: (value: { top: number }) => { state.scrolls.push(value.top) },
    querySelector: (selector: string): RevealElement | null => {
      const match = /\[data-chat-turn="(\d+)"\]/u.exec(selector)
      if (match === null) return null
      return mounted.has(Number(match[1])) ? { getBoundingClientRect: () => ({ top: 400 }) } : null
    },
    querySelectorAll: (selector: string): RevealElement[] => {
      if (selector === '[data-chat-node-key]') {
        type Row = { key: string; top: number; group: string | null; entry: { height: number; untilFound?: boolean } }
        const rows: Row[] = [
          ...(options.steps ?? [])
            .filter((entry) => mounted.has(entry.turn))
            .map((entry) => ({
              key: `14:assistant-step${String(entry.turn)}:${String(entry.step)}`,
              top: 300,
              group: entry.group ?? null,
              entry,
            })),
          ...(options.retries ?? []).map((entry) => ({ key: `31:model-retry${entry.retryId}`, top: 520, group: null, entry })),
          ...(options.calls ?? []).map((entry) => ({ key: `9:tool-call${entry.callId}`, top: 460, group: null, entry })),
          ...(options.compactions ?? []).map((entry) => ({ key: `57:compaction${entry.compactionId}`, top: 480, group: null, entry })),
          ...(options.anchors ?? []).map((entry) => ({
            key: `${String(entry.seq)}:${entry.kind}${entry.id}`,
            top: 500,
            group: null,
            entry,
          })),
        ]
        return rows.map((row) => ({
          getBoundingClientRect: () => ({ top: row.top, height: row.entry.height }),
          getAttribute: (name: string) => (name === 'data-chat-node-key' ? row.key
            : name === 'data-chat-group-part' ? row.group
              : name === 'hidden' ? (row.entry.untilFound === true ? 'until-found' : null)
                : null),
          // The real name: the view's own `beforematch` listener is registered on the
          // element, and the reveal asks it through `dispatchEvent`. A fixture that mirrored
          // the misspelled `dispatch` hid the bug that the event never fired at all.
          dispatchEvent: (event: Event) => {
            if (event.type !== 'beforematch') return false
            // The view's listener opens the node: it stops being `hidden="until-found"`
            // (which is what `isLaidOut` reads) and lays out at its real height.
            row.entry.untilFound = false
            row.entry.height = 24
            return true
          },
        }))
      }
      if (selector === 'button[data-turn-process]') {
        const process = options.process
        if (process === undefined) return []
        return [{
          getBoundingClientRect: () => ({ top: 0 }),
          getAttribute: (name: string) => (name === 'data-turn-process'
            ? String(process.turn)
            : name === 'aria-expanded' ? String(process.expanded) : null),
          click: () => {
            if (!process.reveals) return
            process.expanded = true
            for (const entry of [...(options.steps ?? []), ...(options.calls ?? [])]) entry.height = 24
          },
        }]
      }
      return []
    },
  }
  return Object.assign(state, { mounted }) as unknown as RevealScroller
    & { scrolls: number[]; pages: number; mounted: Set<number> }
}

/**
 * A loader that stands in for `ensureBrickTargetLoaded`.
 *
 * It answers exactly like the real one — the request it was handed, and whether the history
 * it asked for turned out to exist — so the tests below never re-implement the loader, they
 * observe what the jump does with its answer.
 */
function loader(options: {
  /** Turns whose rows the "history" brings in. */
  readonly brings?: number[]
  readonly mounted?: Set<number>
  readonly status?: LoadReport['status']
}): { load: (request: { seq?: number }) => Promise<LoadReport>; requests: (number | undefined)[] } {
  const requests: (number | undefined)[] = []
  return {
    requests,
    load: async (request) => {
      requests.push(request.seq)
      if (options.status !== undefined) return { status: options.status }
      for (const turn of options.brings ?? []) options.mounted?.add(turn)
      return request.seq === undefined ? { status: 'no-seq' } : { status: 'loaded', seq: request.seq }
    },
  }
}

const instant = async (): Promise<void> => { await Promise.resolve() }

describe('accuracyOf', () => {
  it('counts only the rows that are the attempt itself as exact', () => {
    expect(accuracyOf('assistant-step')).toBe('exact')
    expect(accuracyOf('tool-call')).toBe('exact')
    expect(accuracyOf('retry-chain')).toBe('exact')
    expect(accuracyOf('auxiliary')).toBe('exact')
    // A Turn's header is where a Turn begins, not where a request happened.
    expect(accuracyOf('turn-header')).toBe('context')
    expect(accuracyOf('none')).toBe('none')
  })
})

describe('revealBrick: exact or nothing', () => {
  const step = (
    turn: number,
    stepNumber: number,
    part: 'reasoning' | 'response' = 'reasoning',
    loadSeq?: number,
  ): BrickTarget => ({
    kind: 'assistant-step',
    turn,
    step: stepNumber,
    part,
    ...(loadSeq === undefined ? {} : { loadSeq }),
  })

  it('lands on the step’s own row when it is laid out', async () => {
    const root = scroller({ turns: [31], steps: [{ turn: 31, step: 2, height: 24, group: 'reasoning' }] })
    const outcome = await revealBrick(root, step(31, 2), { wait: instant })
    expect(outcome).toMatchObject({
      accuracy: 'exact',
      row: 'assistant-step',
      expanded: false,
      load: { status: 'not-needed' },
    })
    expect(outcome.element?.getAttribute?.('data-chat-node-key')).toBe('14:assistant-step31:2')
    // A quarter of the viewport above the row, not above the Turn.
    expect((root as unknown as { scrolls: number[] }).scrolls).toEqual([100])
  })

  it('opens the Turn’s process group to reach a collapsed row', async () => {
    const root = scroller({
      turns: [31],
      steps: [{ turn: 31, step: 2, height: 0, group: 'reasoning' }],
      process: { turn: 31, expanded: false, reveals: true },
    })
    const outcome = await revealBrick(root, step(31, 2), { wait: instant, settleMs: 200 })
    expect(outcome).toMatchObject({ accuracy: 'exact', row: 'assistant-step', expanded: true })
  })

  it('asks the view to reveal a row it holds as hidden="until-found"', async () => {
    const root = scroller({ turns: [31], steps: [{ turn: 31, step: 2, height: 0, group: 'reasoning', untilFound: true }] })
    const outcome = await revealBrick(root, step(31, 2), { wait: instant, settleMs: 200 })
    expect(outcome).toMatchObject({ accuracy: 'exact', row: 'assistant-step', expanded: true })
  })

  it('lands the half the attempt began in, for all three classes of content', async () => {
    // Fixture ②: reasoning-only, response-only, and both. Each brick declares the half its
    // attempt began in, and each lands on that half of the step node — both halves share the
    // node key, so `part` is the only thing that tells them apart. What happens when the
    // declared half has no row at all is pinned by the two tests below.
    const root = scroller({
      turns: [4],
      steps: [
        { turn: 4, step: 1, height: 18, group: 'reasoning' },
        { turn: 4, step: 2, height: 30, group: 'response' },
        { turn: 4, step: 3, height: 18, group: 'reasoning' },
        { turn: 4, step: 3, height: 30, group: 'response' },
      ],
    })
    const reasoningOnly = await revealBrick(root, step(4, 1, 'reasoning'), { wait: instant })
    expect(reasoningOnly).toMatchObject({ accuracy: 'exact', row: 'assistant-step' })
    expect(reasoningOnly.element?.getAttribute?.('data-chat-group-part')).toBe('reasoning')

    const responseOnly = await revealBrick(root, step(4, 2, 'response'), { wait: instant })
    expect(responseOnly).toMatchObject({ accuracy: 'exact', row: 'assistant-step' })
    expect(responseOnly.element?.getAttribute?.('data-chat-group-part')).toBe('response')

    const both = await revealBrick(root, step(4, 3, 'reasoning'), { wait: instant })
    expect(both.element?.getAttribute?.('data-chat-group-part')).toBe('reasoning')
  })

  it('prefers the brick’s own half even when the other half is already on screen', async () => {
    // Both halves of step 2 are rendered: the response half is laid out, the reasoning half is
    // the one the view holds as `hidden="until-found"`. The brick began in the reasoning half,
    // so the reveal has to open it rather than accept the half that happens to be visible —
    // accepting it would mark the answer while the reader asked where the attempt began.
    const root = scroller({
      turns: [31],
      steps: [
        { turn: 31, step: 2, height: 0, group: 'reasoning', untilFound: true },
        { turn: 31, step: 2, height: 24, group: 'response' },
      ],
    })
    const outcome = await revealBrick(root, step(31, 2), { wait: instant, settleMs: 200 })
    expect(outcome).toMatchObject({ accuracy: 'exact', row: 'assistant-step' })
    expect(outcome.element?.getAttribute?.('data-chat-group-part')).toBe('reasoning')
    expect(outcome.fellBack).toBeUndefined()
  })

  it('reaches the same step’s other half when the declared half was never rendered, and says so', async () => {
    // A core that draws no reasoning, or a reader who hides it: the declared half has no row
    // at all, so no amount of waiting will produce one. The other half of the same step is
    // still the step, and scrolling nowhere would be a worse answer — but it is *reported*:
    // `context` and `fellBack`, never passed off as the brick's own row.
    const root = scroller({ turns: [31], steps: [{ turn: 31, step: 2, height: 24, group: 'response' }] })
    const outcome = await revealBrick(root, step(31, 2), { wait: instant, settleMs: 200 })
    expect(outcome).toMatchObject({ accuracy: 'context', row: 'assistant-step', fellBack: true })
    expect(outcome.element?.getAttribute?.('data-chat-group-part')).toBe('response')
    expect(locateResultOf(outcome))
      .toEqual({ status: 'step-other-half', row: 'assistant-step', element: outcome.element })
  })

  it('does not treat the other half as exact', async () => {
    // Same fixture as above, asked the other way round: the row kind on its own is worth
    // `exact` (`accuracyOf('assistant-step')`), and the fallback is the only thing keeping
    // that claim off a landing that is not this brick's own half.
    const root = scroller({ turns: [31], steps: [{ turn: 31, step: 2, height: 24, group: 'response' }] })
    const outcome = await revealBrick(root, step(31, 2), { wait: instant, settleMs: 200 })
    expect(accuracyOf(outcome.row)).toBe('exact')
    expect(outcome.accuracy).not.toBe('exact')
    expect(outcome.accuracy).toBe('context')
    expect(locateResultOf(outcome).status).not.toBe('exact')
    expect(locateResultOf(outcome).status).toBe('step-other-half')
  })

  it('asks the official loader for the history, then lands on the row inside it', async () => {
    const root = scroller({ turns: [30], steps: [{ turn: 29, step: 1, height: 24, group: 'reasoning' }] })
    const stub = loader({ brings: [29], mounted: root.mounted })
    const outcome = await revealBrick(root, step(29, 1, 'reasoning', 301), {
      wait: instant,
      settleMs: 300,
      load: stub.load,
    })
    expect(outcome).toMatchObject({ accuracy: 'exact', row: 'assistant-step', load: { status: 'loaded', seq: 301 } })
    // The loader was asked for the brick's own log position — the request the record builds.
    expect(stub.requests).toEqual([301])
  })

  it('never accepts a later step as "nearest", and does not move at all', async () => {
    // Showing the reader what came *after* the request they clicked is not a landing.
    // This is the case that used to report success while marking the wrong row.
    const root = scroller({ turns: [4], steps: [{ turn: 4, step: 57, height: 24 }] })
    const outcome = await revealBrick(root, step(4, 36), { wait: instant, settleMs: 100 })
    expect(outcome).toMatchObject({ accuracy: 'none', row: 'none' })
    expect(outcome.element).toBeUndefined()
    expect((root as unknown as { scrolls: number[] }).scrolls).toEqual([])
  })

  it('reports a load that ends without a row as none, and does not move', async () => {
    const root = scroller({ steps: [] })
    const outcome = await revealBrick(root, step(29, 4, 'reasoning', 301), {
      wait: instant,
      settleMs: 200,
      load: loader({}).load,
    })
    expect(outcome).toMatchObject({ accuracy: 'none', row: 'none' })
    expect((root as unknown as { scrolls: number[] }).scrolls).toEqual([])
  })

  it('says the loader was never needed when the row is already on screen', async () => {
    const root = scroller({ turns: [31], steps: [{ turn: 31, step: 2, height: 24, group: 'reasoning' }] })
    const stub = loader({})
    const outcome = await revealBrick(root, step(31, 2), { wait: instant, load: stub.load })
    expect(outcome.load).toEqual({ status: 'not-needed', seq: undefined })
    expect(stub.requests).toEqual([])
  })

  it('reports "no loader" rather than pretending, when this core has no session face', async () => {
    const root = scroller({ turns: [4], steps: [{ turn: 4, step: 9, height: 24 }] })
    const outcome = await revealBrick(root, step(4, 36), { wait: instant, settleMs: 100 })
    expect(outcome).toMatchObject({ accuracy: 'none', load: { status: 'no-loader' } })
  })

  it('lands on a call the attempt made when the step has no row of its own', async () => {
    const root = scroller({ turns: [4], calls: [{ callId: 'call_00_x', height: 20 }] })
    const outcome = await revealBrick(root, { kind: 'tool-call', turn: 4, step: 9, callId: 'call_00_x' }, { wait: instant })
    expect(outcome).toMatchObject({ accuracy: 'exact', row: 'tool-call' })
    expect(outcome.element?.getAttribute?.('data-chat-node-key')).toBe('9:tool-callcall_00_x')
  })

  it('lands on the retry chain for an attempt inside one', async () => {
    const root = scroller({
      turns: [4],
      steps: [{ turn: 4, step: 2, height: 24 }],
      retries: [{ retryId: 'r-7', height: 22 }],
    })
    const outcome = await revealBrick(root, { kind: 'retry-chain', turn: 4, step: 2, retryId: 'r-7' }, { wait: instant })
    expect(outcome).toMatchObject({ accuracy: 'exact', row: 'retry-chain' })
    expect(outcome.element?.getAttribute?.('data-chat-node-key')).toBe('31:model-retryr-7')
  })

  it('refuses the step row when the retry chain is the only honest scene', async () => {
    // The step row belongs to whichever attempt committed the message, so landing a
    // failed attempt's brick there would show it the other attempt's work.
    const root = scroller({ turns: [4], steps: [{ turn: 4, step: 2, height: 24 }], retries: [] })
    const outcome = await revealBrick(
      root,
      { kind: 'retry-chain', turn: 4, step: 2, retryId: 'r-7' },
      { wait: instant, settleMs: 100 },
    )
    expect(outcome).toMatchObject({ accuracy: 'none', row: 'none' })
    expect((root as unknown as { scrolls: number[] }).scrolls).toEqual([])
  })

  it('lands on the compaction row by id, for a call that belongs to no Turn', async () => {
    // Fixture ③ of the closure bar: no turn, no step — only the auxiliary call's identity.
    const root = scroller({ compactions: [{ compactionId: 'cmp-9', height: 32 }] })
    const outcome = await revealBrick(root, { kind: 'compaction', compactionId: 'cmp-9' }, { wait: instant })
    expect(outcome).toMatchObject({ accuracy: 'exact', row: 'compaction' })
    expect(outcome.element?.getAttribute?.('data-chat-node-key')).toBe('57:compactioncmp-9')
    expect((root as unknown as { scrolls: number[] }).scrolls).toHaveLength(1)
  })

  it('does not move for an auxiliary call the contract declares unreachable', async () => {
    // A session title is never rendered in the transcript at all: the honest outcome is
    // that this brick has no row, not that some nearby row will do.
    const root = scroller({ compactions: [{ compactionId: 'cmp-9', height: 32 }] })
    const outcome = await revealBrick(root, { kind: 'none', reason: 'session-title' }, { wait: instant })
    expect(outcome).toMatchObject({ accuracy: 'none', row: 'none', load: { status: 'nothing-to-load' } })
    expect((root as unknown as { scrolls: number[] }).scrolls).toEqual([])
  })

  it('does nothing at all for a brick that has no target', async () => {
    const root = scroller({ turns: [4], steps: [{ turn: 4, step: 2, height: 24 }] })
    const outcome = await revealBrick(root, { kind: 'none', reason: 'client-fold' }, { wait: instant })
    expect(outcome).toMatchObject({ accuracy: 'none', row: 'none', load: { status: 'nothing-to-load' } })
    expect((root as unknown as { scrolls: number[] }).scrolls).toEqual([])
  })
})

describe('reading the chat view’s node keys', () => {
  it('reads only the anchor seq, and says why it reads no more', () => {
    // `[seq:]kind + id` with no separator: `tool-call` + `call_00_x` publishes as
    // `tool-callcall_00_x`, which no parser can tell from a kind named
    // `tool-callcall`. The seq prefix is unambiguous; the split is not.
    expect(nodeSeqOf('14:assistant-step4:1')).toBe(14)
    expect(nodeSeqOf('9:tool-callcall_00_qFeD')).toBe(9)
    expect(nodeSeqOf('tool-callcall_00_qFeD')).toBeUndefined()
  })

  it('matches a whole step key suffix, so step 1 cannot answer for step 11', () => {
    const root = scroller({
      turns: [4],
      steps: [{ turn: 4, step: 1, height: 24 }, { turn: 4, step: 11, height: 24 }],
    })
    const found = findStepNodes(root, 4, 1)
    expect(found).toHaveLength(1)
    expect(found[0]!.getAttribute?.('data-chat-node-key')).toBe('14:assistant-step4:1')
    expect(findStepNodes(root, 4, 11)).toHaveLength(1)
    expect(findStepNodes(root, 3, 1)).toHaveLength(0)
  })

  it('prefers the reasoning half of a step over its response half', () => {
    const root = scroller({
      turns: [4],
      steps: [
        { turn: 4, step: 2, height: 30, group: 'response' },
        { turn: 4, step: 2, height: 18, group: 'reasoning' },
      ],
    })
    expect(findStepNodes(root, 4, 2)[0]!.getAttribute?.('data-chat-group-part')).toBe('reasoning')
  })

  it('finds the disclosure for one Turn only', () => {
    const root = scroller({ turns: [31], process: { turn: 31, expanded: false, reveals: true } })
    expect(findProcessToggle(root, 31)?.getAttribute?.('data-turn-process')).toBe('31')
    expect(findProcessToggle(root, 32)).toBeUndefined()
  })
})

describe('locateResultOf: four answers, and never a rounded-up one', () => {
  const element = { getBoundingClientRect: () => ({ top: 0 }) }

  it('is exact only when the brick’s own row was reached', () => {
    expect(locateResultOf({
      accuracy: 'exact', row: 'assistant-step', expanded: false, element,
      load: { status: 'not-needed' },
    })).toEqual({ status: 'exact', row: 'assistant-step', element })
  })

  it('does not blame the host for a load that covered the position but drew no row', () => {
    // The same observation the 0.1.7-rc.1 case produced — `loadThrough` covered the seq and the
    // transcript drew none of it — but it is no longer read as a host fault: a delayed mount, a
    // hidden subtree or a stale target produce it too, so the honest answer is that the window
    // holds the position and the row has not been drawn. Nothing is attributed to the host.
    expect(locateResultOf({
      accuracy: 'none', row: 'none', expanded: false,
      load: { status: 'loaded', seq: 3974, rendered: false },
    })).toEqual({ status: 'loaded-awaiting-render' })
  })

  it('says the same for a window that already covered it, or needed no load at all', () => {
    // Nothing was loaded just now in either case, so nothing failed just now either — and
    // "just loaded it" is not a different sentence any more: all three are coverage without
    // a row, which is exactly what `loaded-awaiting-render` says.
    expect(locateResultOf({
      accuracy: 'none', row: 'none', expanded: false,
      load: { status: 'already-loaded', seq: 3974, rendered: false },
    })).toEqual({ status: 'loaded-awaiting-render' })
    expect(locateResultOf({
      accuracy: 'none', row: 'none', expanded: false,
      load: { status: 'not-needed' },
    })).toEqual({ status: 'loaded-awaiting-render' })
  })

  it('keeps the loader’s own reason when there was nothing to load', () => {
    for (const status of ['nothing-to-load', 'no-seq', 'no-loader', 'timeout'] as const) {
      expect(locateResultOf({ accuracy: 'none', row: 'none', expanded: false, load: { status } }))
        .toEqual({ status: 'target-unavailable', reason: status })
    }
  })
})

describe('the load request a target produces', () => {
  it('asks for the log position the record measured, not a page count', () => {
    // The request carries the Turn as well as the seq: the loader pages to the brick's own
    // position, and the turn is what tells it which Turn's beginning has to be rebuilt for a
    // step to be readable. A compaction belongs to no Turn, so it carries none.
    expect(loadRequestOf({ kind: 'assistant-step', turn: 4, step: 1, part: 'reasoning', loadSeq: 301 }))
      .toEqual({ seq: 301, turn: 4 })
    expect(loadRequestOf({ kind: 'tool-call', turn: 4, step: 1, callId: 'c', loadSeq: 88 }))
      .toEqual({ seq: 88, turn: 4 })
    expect(loadRequestOf({ kind: 'retry-chain', turn: 4, step: 1, retryId: 'r', loadSeq: 90 }))
      .toEqual({ seq: 90, turn: 4 })
    expect(loadRequestOf({ kind: 'compaction', compactionId: 'x', loadSeq: 57 })).toEqual({ seq: 57 })
  })

  it('separates "nothing to load for" from "no position known"', () => {
    // An auxiliary call that the transcript never renders: loading cannot help, and saying
    // "no-seq" would blame the record for something that is not its fault.
    expect(loadRequestOf({ kind: 'none', reason: 'session-title' })).toEqual({ unreachable: 'nothing-to-load' })
    expect(loadRequestOf({ kind: 'assistant-step', turn: 4, step: 1, part: 'response' }))
      .toEqual({ unreachable: 'no-seq' })
  })

  it('builds the row selector the chat view publishes', () => {
    expect(rowSelector(42)).toBe('[data-chat-turn="42"]')
  })
})
