import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PANEL_TABS, BrickPanel, type BrickPanelProps } from '../src/client/panel'
import type { BrickRecord } from '../src/shared/brick'
import { diffBricks } from '../src/shared/diff'
import { EMPTY_COUNTERS, deriveMetrics } from '../src/shared/metrics'

const HEALTHY = { inputTokens: 2461, outputTokens: 2986, cacheReadTokens: 317_992, cacheWriteTokens: 0, reasoningTokens: 1421 }

/** A fully populated brick record, as the collector would produce. */
function record(overrides: Partial<BrickRecord> = {}): BrickRecord {
  const usage = overrides.usage ?? HEALTHY
  return {
    identity: { id: 's1:27:6:0', sessionId: 's1', turn: 27, step: 6, attemptOrdinal: 0, attemptId: 's1:7', revision: 3 },
    settlement: 'message',
    settlementSeq: 500,
    route: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
      maxTokens: 256_000,
      maxTokensDefaulted: true,
      contextWindow: 1_000_000,
    },
    usage,
    metrics: deriveMetrics(usage, { dispatchedAt: 1000, firstTokenAt: 2410, usageAt: 35_150, finishAt: 35_200 }, { ...EMPTY_COUNTERS, chunkCount: 412, textChars: 8112, reasoningChars: 4210, toolCallCount: 1 }, 1_000_000),
    request: {
      headerEventSeq: 300,
      headerReason: 'initial',
      headerHash: 'headerhash-0123456789',
      systemHash: 'systemhash-0123456789',
      toolsHash: 'toolshash-0123456789',
      messagesHash: 'messageshash-0123456789',
      messageCount: 273,
      sharedMessagePrefix: 272,
      toolSchemaCount: 21,
      requestRef: 'requestref-0123456789',
      headerRef: 'headerref-0123456789',
    },
    context: {
      pressureTokens: 317_464,
      projectedTokens: 320_411,
      contextWindow: 1_000_000,
      systemTokens: 18_344,
      toolsTokens: 31_221,
      messageTokens: 274_661,
      baselineKind: 'usage',
      baselineTokens: 317_464,
      totalMeterTokens: 320_411,
      surfaceTokens: 317_229,
      surfaceDeltaTokens: 2947,
      nodeCount: 273,
      meterRef: 'meterref-0123456789',
    },
    tools: [
      { callId: 'call-1', name: 'read', argumentsChars: 120, argumentsRef: 'argsref-0123456789', callAt: 2600, resultAt: 36_000, durationMs: 33_400, resultRef: 'resultref-0123456789' },
    ],
    finish: { reason: 'tool-calls' },
    raw: { streamRef: 'streamref-0123456789' },
    ...overrides,
  }
}

/** Render the panel with sane defaults. */
function render(overrides: Partial<BrickPanelProps> = {}): string {
  const props: BrickPanelProps = {
    record: record(),
    tab: 'overview',
    onTab: () => undefined,
    onClose: () => undefined,
    ...overrides,
  }
  return renderToStaticMarkup(createElement(BrickPanel, props))
}

describe('BrickPanel', () => {
  it('shows every tab, and the identity of the attempt in the header', () => {
    const markup = render()
    for (const tab of PANEL_TABS) expect(markup).toContain(tab.label)
    expect(markup).toContain('Turn 27 · Step 6')
    expect(markup).toContain('99.23%')
    expect(markup).toContain('320,453')
  })

  it('marks a value the adapter filled in rather than the caller', () => {
    expect(render()).toContain('256,000 (adapter)')
  })

  it('labels the heuristic composition as an approximation, never as billing', () => {
    const markup = render({ tab: 'context' })
    expect(markup).toContain('≈ Composition (heuristic)')
    expect(markup).toContain('≈ 18,344')
    expect(markup).toContain('≈ 274,661')
    // The provider-anchored figures sit above it, unapproximated.
    expect(markup).toContain('317,464')
    expect(markup).toContain('1,000,000')
  })

  it('separates the attempt from the step it retried', () => {
    const markup = render({
      record: record({
        identity: { id: 's1:4:2:1', sessionId: 's1', turn: 4, step: 2, attemptOrdinal: 1 },
        settlement: 'message',
        retry: undefined,
      }),
      tab: 'retry',
    })
    expect(markup).toContain('attempt 1')
    expect(markup).toContain('no retry scheduled for this attempt')
  })

  it('shows the retry that replaced a failed attempt', () => {
    const failed = record({
      identity: { id: 's1:4:2:0', sessionId: 's1', turn: 4, step: 2, attemptOrdinal: 0 },
      settlement: 'attempt',
      usage: { inputTokens: 321_844, outputTokens: 118, cacheReadTokens: 0 },
      finish: { reason: 'error', failure: { message: 'rate limited', code: 'rate_limit', status: 429, providerRetryAfterMs: 1500, requestId: 'req-9' } },
      retry: { retryId: 'retry-1234567890', provider: 'deepseek-official', mode: 'normal', policyKey: 'k', retry: 1, maxRetries: 3, delayMs: 1500, failureMessage: 'rate limited', failureCode: 'rate_limit' },
    })
    const markup = render({ record: failed, tab: 'retry' })
    expect(markup).toContain('1 of 3')
    expect(markup).toContain('rate_limit')
    expect(markup).toContain('429')
    expect(markup).toContain('1.50s')
  })

  it('renders a tool call with its duration and error, and says when there are none', () => {
    expect(render({ tab: 'tools' })).toContain('33.40s')
    const none = render({ tab: 'tools', record: record({ tools: [] }) })
    expect(none).toContain('Tool calls (0)')
    expect(none).toContain('none')
  })

  it('builds the stream timeline from the payload when it is loaded', () => {
    const stream = [
      { type: 'chunk', time: 1000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
      { type: 'reasoning-chunks', time0: 1010, index: 0, dt: [5], texts: ['think', 'ing'] },
      { type: 'chunk', time: 1120, chunk: { type: 'usage', usage: HEALTHY } },
      { type: 'chunk', time: 1121, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
    ]
    const markup = render({ tab: 'stream', raw: { stream } })
    expect(markup).toContain('Timeline')
    expect(markup).toContain('reasoning')
    expect(markup).toContain('99.23%')
    expect(markup).toContain('finish: tool-calls')
  })

  it('offers the stored payloads by ref instead of pretending to know them', () => {
    const markup = render({ tab: 'raw', store: { blobs: 12, bytes: 4096 } })
    expect(markup).toContain('Stored by reference')
    expect(markup).toContain("streamref-01")
    expect(markup).toContain('12 blobs · 4,096 bytes')
  })

  it('renders the comparison verdict and only the rows worth reading', () => {
    const before = record()
    const after = record({
      identity: { id: 's1:27:7:0', sessionId: 's1', turn: 27, step: 7, attemptOrdinal: 0 },
      usage: { inputTokens: 321_844, outputTokens: 118, cacheReadTokens: 0 },
      request: { ...record().request, toolsHash: 'tools-OTHER', messageCount: 274, sharedMessagePrefix: 273 },
    })
    const markup = render({ tab: 'overview', diff: diffBricks(before, after) })
    expect(markup).toContain('Comparison')
    expect(markup).toContain('Tools differs')
    expect(markup).toContain('Cache hit')
    expect(markup).toContain('0.00%')
  })

  it('names which half produced the brick, so the source is never a guess', () => {
    const host = render({ record: record({ observedBy: 'host' }) })
    expect(host).toContain('host feed')
    expect(host).toContain('data-cache-bricks-source="host"')
    const client = render({ record: record({ observedBy: 'client', request: {}, context: undefined, raw: {} }) })
    expect(client).toContain('client fold')
    expect(client).toContain('data-cache-bricks-source="client"')
    // A record from a build that predates the marker still reads as host-collected.
    expect(render({ record: record() })).toContain('host feed')
  })

  it('says a client-folded brick is reduced, instead of showing empty rows as measured', () => {
    const folded = record({
      observedBy: 'client',
      request: {},
      context: undefined,
      tools: [],
      raw: {},
    })
    const overview = render({ record: folded, tab: 'overview' })
    expect(overview).toContain('Folded client-side')
    // The tabs whose data only the host collects explain themselves.
    expect(render({ record: folded, tab: 'request' })).toContain('only collected by the host half')
    expect(render({ record: folded, tab: 'context' })).toContain('only collected by the host half')
    expect(render({ record: folded, tab: 'stream' })).toContain('only collected by the host half')
    expect(render({ record: folded, tab: 'tools' })).toContain('only collected by the host half')
    // The cache rows it does know are still there.
    expect(overview).toContain('99.23%')
  })

  it('offers a compare action only when the caller can supply one', () => {
    expect(render()).not.toContain('>compare<')
    expect(render({ onCompare: () => undefined })).toContain('>compare<')
  })

  it('renders the step’s other half as a "~" projection, never as a success', () => {
    // The locate answer the reveal can now give: the step is on screen, but the half this
    // attempt began in is not. The panel prints the half it reached behind a `~`, and it must
    // not put the `✓` the exact answer uses next to it.
    const element = { getBoundingClientRect: () => ({ top: 0 }) }
    const markup = render({
      jump: {
        turn: 27,
        step: 6,
        accuracy: 'context',
        row: 'assistant-step',
        locate: { status: 'step-other-half', row: 'assistant-step', element },
      },
    })
    expect(markup).toContain('data-cache-bricks-locate="step-other-half"')
    expect(markup).toContain('Chat projection')
    expect(markup).toContain('~ assistant-step: the other half')
    expect(markup).not.toContain('✓ assistant-step')
  })

  it('says which declaration list the tools hash covers, when history added to it', () => {
    // rc.2's declaration list is history-relative, so one number would hide the split the
    // hash actually covers. A request that carries none renders exactly as it always did.
    const withHistory = record({
      request: {
        ...record().request,
        toolSchemaCount: 23,
        toolSchemaDeclared: 21,
        toolSchemaAdded: 2,
        toolSchemaActivated: 5,
        deferredToolCount: 3,
        toolUpdateMessages: 1,
        developerMessageCount: 4,
      },
    })
    const markup = render({ record: withHistory, tab: 'request' })
    expect(markup).toContain('23 (21 declared +2 in history)')
    expect(markup).toContain('3 (activated by a later message)')
    expect(markup).toContain('5 declaration(s) activated by the history')
    expect(markup).toContain('1 developer message(s) changed the tool set')
    expect(markup).toContain('Developer msgs')
    const plain = render({ tab: 'request' })
    expect(plain).not.toContain('declared +')
    expect(plain).not.toContain('Deferred')
    expect(plain).not.toContain('Tool updates')
  })
})
