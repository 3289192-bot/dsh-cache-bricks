import { describe, expect, it } from 'vitest'
import { diffBricks } from '../src/shared/diff'
import type { BrickRecord, BrickUsage } from '../src/shared/brick'
import { EMPTY_COUNTERS, deriveMetrics } from '../src/shared/metrics'

/** Minimal record builder: only the fields a case cares about are passed in. */
function brick(overrides: {
  turn?: number
  step?: number
  attemptOrdinal?: number
  provider?: string
  model?: string
  toolsHash?: string
  systemHash?: string
  headerHash?: string
  headerReason?: 'initial' | 'resume' | 'change' | 'series'
  startsSeries?: boolean
  messageCount?: number
  usage?: BrickUsage
  contextWindow?: number
  finish?: BrickRecord['finish']
}): BrickRecord {
  const usage = overrides.usage
  return {
    identity: {
      id: `s:${String(overrides.turn ?? 1)}:${String(overrides.step ?? 1)}:${String(overrides.attemptOrdinal ?? 0)}`,
      sessionId: 's',
      turn: overrides.turn ?? 1,
      step: overrides.step ?? 1,
      attemptOrdinal: overrides.attemptOrdinal ?? 0,
    },
    settlement: 'message',
    route: {
      provider: overrides.provider ?? 'deepseek-official',
      model: overrides.model ?? 'deepseek-v4-flash',
    },
    ...(usage === undefined ? {} : { usage }),
    metrics: deriveMetrics(usage, {}, EMPTY_COUNTERS, overrides.contextWindow),
    request: {
      ...(overrides.headerHash === undefined ? {} : { headerHash: overrides.headerHash }),
      ...(overrides.headerReason === undefined ? {} : { headerReason: overrides.headerReason }),
      ...(overrides.startsSeries === undefined ? {} : { startsSeries: overrides.startsSeries }),
      ...(overrides.toolsHash === undefined ? {} : { toolsHash: overrides.toolsHash }),
      ...(overrides.systemHash === undefined ? {} : { systemHash: overrides.systemHash }),
      ...(overrides.messageCount === undefined ? {} : { messageCount: overrides.messageCount }),
    },
    tools: [],
    ...(overrides.finish === undefined ? {} : { finish: overrides.finish }),
    raw: {},
  }
}

/** A healthy request: a large cached prefix. */
const healthy = brick({
  turn: 27,
  step: 6,
  usage: { inputTokens: 2461, outputTokens: 2986, cacheReadTokens: 317_992, cacheWriteTokens: 0 },
  toolsHash: 'tools-a',
  systemHash: 'sys-a',
  headerHash: 'hdr-a',
  messageCount: 273,
})

/** The next request: same route and prefix, a few more messages. */
const grew = brick({
  turn: 27,
  step: 7,
  usage: { inputTokens: 2193, outputTokens: 120, cacheReadTokens: 319_000 },
  toolsHash: 'tools-a',
  systemHash: 'sys-a',
  headerHash: 'hdr-a',
  messageCount: 274,
})

/** The request where the cache collapsed: the tool schemas changed. */
const toolsChanged = brick({
  turn: 27,
  step: 8,
  usage: { inputTokens: 321_844, outputTokens: 118, cacheReadTokens: 0 },
  toolsHash: 'tools-b',
  systemHash: 'sys-a',
  headerHash: 'hdr-b',
  headerReason: 'change',
  startsSeries: true,
  messageCount: 275,
})

describe('diffBricks', () => {
  it('marks unchanged fields as unchanged and hash-equal payloads as identical', () => {
    const diff = diffBricks(healthy, grew)
    const tools = diff.rows.find((entry) => entry.label === 'Tools hash')!
    expect(tools.changed).toBe(false)
    expect(tools.identicalPayload).toBe(true)
    expect(diff.rows.find((entry) => entry.label === 'Provider')!.changed).toBe(false)
    expect(diff.rows.find((entry) => entry.label === 'Messages')!.changed).toBe(true)
  })

  it('reports the movement that matters: prompt size, cache read, hit ratio', () => {
    const diff = diffBricks(healthy, toolsChanged)
    const label = (name: string): string => diff.rows.find((entry) => entry.label === name)!.after
    expect(label('Prompt tokens')).toBe('321,844')
    expect(label('Cache read delta')).toBe('−317,992')
    expect(label('Cache hit')).toBe('0.00%')
  })

  it('blames the route first when the route changed', () => {
    const switched = brick({
      usage: { inputTokens: 1000, outputTokens: 10 },
      provider: 'other-gateway',
      model: 'deepseek-v4-pro',
      toolsHash: 'tools-a',
      systemHash: 'sys-a',
    })
    const diff = diffBricks(healthy, switched)
    expect(diff.verdict).toContain('route changed')
    expect(diff.verdict).toContain('other-gateway')
  })

  it('blames the request header only when nothing in the prefix itself changed', () => {
    const series = brick({
      usage: { inputTokens: 321_000, outputTokens: 10, cacheReadTokens: 0 },
      toolsHash: 'tools-a',
      systemHash: 'sys-a',
      headerHash: 'hdr-b',
      headerReason: 'series',
      startsSeries: true,
    })
    expect(diffBricks(healthy, series).verdict).toContain('new request header')
  })

  it('names the broken prefix part rather than the header that recorded it', () => {
    // toolsChanged also logged a `change` header; the tools hash is the cause and
    // the more actionable sentence.
    expect(diffBricks(healthy, toolsChanged).verdict).toContain('Tools differs')
    const systemChanged = brick({
      usage: { inputTokens: 320_000, outputTokens: 10, cacheReadTokens: 0 },
      toolsHash: 'tools-a',
      systemHash: 'sys-b',
    })
    expect(diffBricks(healthy, systemChanged).verdict).toContain('System differs')
  })

  it('falls back to the prompt delta when only the message tail changed', () => {
    const verdict = diffBricks(healthy, grew).verdict
    expect(verdict).toContain('prompt grew')
    expect(verdict).toContain('740')
  })

  it('says so when nothing observable differs', () => {
    const diff = diffBricks(healthy, healthy)
    expect(diff.changed).toHaveLength(0)
    expect(diff.verdict).toContain('no request field differs')
  })

  it('tells the truth when the provider reports no cache fields at all', () => {
    const silent = brick({ usage: { inputTokens: 900, outputTokens: 10 } })
    expect(diffBricks(silent, silent).verdict).toContain('not reported')
  })

  it('compares attempts of the same step, which is what a retry looks like', () => {
    const first = brick({
      turn: 4,
      step: 2,
      attemptOrdinal: 0,
      usage: { inputTokens: 5000, outputTokens: 0, cacheReadTokens: 0 },
      toolsHash: 'tools-a',
      finish: { reason: 'error', failure: { message: 'rate limited', code: 'rate_limit' } },
    })
    const retry = brick({
      turn: 4,
      step: 2,
      attemptOrdinal: 1,
      usage: { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 180_000 },
      toolsHash: 'tools-a',
      finish: { reason: 'stop' },
    })
    const diff = diffBricks(first, retry)
    expect(diff.rows.find((entry) => entry.label === 'Attempt')!.after).toBe('#1')
    expect(diff.rows.find((entry) => entry.label === 'Finish')!.changed).toBe(true)
    expect(diff.rows.find((entry) => entry.label === 'Cache hit')!.changed).toBe(true)
  })
})
