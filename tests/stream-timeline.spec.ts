import { describe, expect, it } from 'vitest'
import { expandStreamRecords, summarizeTimeline, timelineClock } from '../src/shared/stream-timeline'

/** A durable stream in the shape the runtime stores. */
const STREAM: readonly unknown[] = [
  { type: 'chunk', time: 1000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
  { type: 'reasoning-chunks', time0: 1010, index: 0, dt: [5, 5], texts: ['think', 'ing', '…'] },
  { type: 'chunk', time: 1020, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning' } } },
  { type: 'chunk', time: 1030, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
  { type: 'text-chunks', time0: 1040, index: 1, dt: [10, 10, 10], texts: ['Hello', ' ', 'world'] },
  { type: 'tool-call-chunks', time0: 1100, index: 2, dt: [7, 3], id: 'c1', name: 'read', args: ['{"path"', ':"a.ts"}'] },
  { type: 'chunk', time: 1120, chunk: { type: 'usage', usage: { inputTokens: 2461, outputTokens: 2986, cacheReadTokens: 317_992, cacheWriteTokens: 0 } } },
  { type: 'chunk', time: 1121, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
]

describe('expandStreamRecords', () => {
  it('expands runs into one entry each, with their real start time and span', () => {
    const entries = expandStreamRecords(STREAM)
    const kinds = entries.map((entry) => entry.kind)
    expect(kinds).toEqual(['block-start', 'reasoning', 'block-end', 'block-start', 'text', 'tool-call', 'usage', 'finish'])

    const reasoning = entries[1]!
    expect(reasoning.at).toBe(1010)
    expect(reasoning.fragments).toBe(3)
    // dt gaps are recoverable, so the run's span is exact rather than estimated.
    expect(reasoning.spanMs).toBe(10)
    expect(reasoning.chars).toBe('thinking…'.length)

    const text = entries[4]!
    expect(text.at).toBe(1040)
    expect(text.chars).toBe('Hello world'.length)
    expect(text.spanMs).toBe(30)
  })

  it('describes a tool call with its name and a preview of the raw arguments', () => {
    const call = expandStreamRecords(STREAM).find((entry) => entry.kind === 'tool-call')!
    expect(call.detail).toContain('read')
    expect(call.detail).toContain('{"path":"a.ts"}')
  })

  it('reads the cache ratio out of the usage chunk', () => {
    const usage = expandStreamRecords(STREAM).find((entry) => entry.kind === 'usage')!
    expect(usage.detail).toContain('320,453')
    expect(usage.detail).toContain('99.23%')
  })

  it('survives records it does not understand', () => {
    expect(expandStreamRecords([null, 42, {}, { type: 'unknown-kind' }, { type: 'chunk' }])).toHaveLength(1)
  })
})

describe('summarizeTimeline', () => {
  it('totals the stream and finds the first token', () => {
    const summary = summarizeTimeline(expandStreamRecords(STREAM))
    expect(summary.firstTokenAt).toBe(1010)
    expect(summary.textChars).toBe('Hello world'.length)
    expect(summary.reasoningChars).toBe('thinking…'.length)
    expect(summary.toolCalls).toBe(1)
    expect(summary.usageAt).toBe(1120)
    expect(summary.finishAt).toBe(1121)
    expect(summary.finishReason).toBe('tool-calls')
  })

  it('is empty, not wrong, for an empty stream', () => {
    const summary = summarizeTimeline([])
    expect(summary.chunks).toBe(0)
    expect(summary.firstTokenAt).toBeUndefined()
    expect(summary.finishReason).toBeUndefined()
  })
})

describe('timelineClock', () => {
  it('formats a timestamp with milliseconds, and refuses a missing one', () => {
    const at = new Date(2026, 8, 24, 8, 22, 17, 102).getTime()
    expect(timelineClock(at)).toBe('08:22:17.102')
    expect(timelineClock(0)).toBe('—')
    expect(timelineClock(Number.NaN)).toBe('—')
  })
})
