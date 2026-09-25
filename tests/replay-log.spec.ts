/**
 * Replaying a session's own log into bricks.
 *
 * Two layers, for the two different things that can go wrong:
 *
 * - **the fixture** pins the semantics — attempt ordinals from settlement order, a retried step
 *   becoming two bricks, activity counters off the compact stream, usage off the settlement,
 *   the target each brick can navigate by. It needs no session at all;
 * - **the live log check** runs the same replay against the newest session under
 *   `DSH_SESSION_ROOT` (default `~/.dsh-017/sessions`), because a fixture can only prove the
 *   replayer agrees with my reading of the format. Real logs prove it agrees with the format.
 *   It skips when there is no log to read, like the live panel check does.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { activityOf, targetOf } from '../src/client/bricks'
import { replaySession, type ReplayEvent } from '../src/core/replay'

/** A durable event with sane defaults. */
function event(seq: number, type: string, data: Record<string, unknown>, time = 1_000 + seq): ReplayEvent {
  return { type, seq, time, data }
}

/** One compact run record, as the log writes it. */
function run(type: 'reasoning-chunks' | 'text-chunks' | 'tool-call-chunks', texts: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type,
    time0: 1_100,
    index: 0,
    dt: texts.map(() => 5),
    ...(type === 'tool-call-chunks' ? { args: texts } : { texts }),
    ...extra,
  }
}

/** The stream a settled attempt carries: runs for the reading, blocks for the frame. */
function stream(options: { reasoning?: string[]; text?: string[]; call?: { id: string; name: string; args: string[] } }): unknown[] {
  const records: unknown[] = []
  if (options.reasoning !== undefined) {
    records.push({ type: 'chunk', time: 1_050, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } })
    records.push(run('reasoning-chunks', options.reasoning))
    records.push({ type: 'chunk', time: 1_060, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: options.reasoning.join('') } } })
  }
  if (options.text !== undefined) {
    records.push({ type: 'chunk', time: 1_100, chunk: { type: 'block-start', index: 1, blockType: 'text' } })
    records.push(run('text-chunks', options.text))
    records.push({ type: 'chunk', time: 1_150, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: options.text.join('') } } })
  }
  if (options.call !== undefined) {
    records.push({ type: 'chunk', time: 1_160, chunk: { type: 'block-start', index: 2, blockType: 'tool-call' } })
    records.push(run('tool-call-chunks', options.call.args, { id: options.call.id, name: options.call.name }))
    records.push({ type: 'chunk', time: 1_200, chunk: { type: 'block-end', index: 2, block: { type: 'tool-call', id: options.call.id, name: options.call.name, arguments: options.call.args.join('') } } })
  }
  records.push({ type: 'chunk', time: 1_300, chunk: { type: 'usage', usage: { inputTokens: 1_635, outputTokens: 116, cacheReadTokens: 7_168, cacheWriteTokens: 0 } } })
  records.push({ type: 'chunk', time: 1_300, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } })
  return records
}

/** A settled attempt, as `assistant/message` / `assistant/attempt` writes it. */
function settlement(
  seq: number,
  type: 'assistant/message' | 'assistant/attempt',
  turn: number,
  step: number,
  body: { stream?: unknown[]; usage?: Record<string, unknown>; interrupted?: true },
): ReplayEvent {
  return event(seq, type, {
    turn,
    step,
    ...(body.usage === undefined ? {} : { usage: body.usage }),
    ...(body.stream === undefined ? {} : { stream: body.stream }),
    ...(body.interrupted === undefined ? {} : { interrupted: body.interrupted }),
  })
}

describe('replaying the compact stream', () => {
  it('counts each run once, and keeps the first token time', () => {
    const report = replaySession('s1', [
      event(1, 'step/start', { turn: 1, step: 1 }, 1_000),
      settlement(2, 'assistant/message', 1, 1, {
        stream: stream({ reasoning: ['think', 'ing'], text: ['an', 'swer'], call: { id: 'call_9', name: 'bash', args: ['{"command":"ls"}'] } }),
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 90 },
      }),
    ])
    const [brick] = report.feed.bricks
    expect(brick).toBeDefined()
    // The block records are the frame around a run: counting them too would double every char.
    expect(brick!.metrics.reasoningChars).toBe('thinking'.length)
    expect(brick!.metrics.textChars).toBe('answer'.length)
    expect(brick!.metrics.toolCallCount).toBe(1)
    expect(brick!.tools[0]?.callId).toBe('call_9')
    // Timing comes from the run's own `time0`, not from the settlement.
    expect(brick!.metrics.firstTokenAt).toBe(1_100)
    // And TTFT is measured from the step's start: the log has no dispatch instant.
    expect(brick!.metrics.dispatchedAt).toBe(1_000)
    expect(brick!.metrics.ttftMs).toBe(100)
  })
})

describe('replaying a session', () => {
  it('turns a retried step into two bricks, in the order the log settled them', () => {
    const report = replaySession('s1', [
      event(1, 'step/start', { turn: 7, step: 2 }, 2_000),
      settlement(2, 'assistant/attempt', 7, 2, { stream: [] }),
      event(3, 'llm/retry', { turn: 7, step: 2, retryId: 'r-1', retry: 1, delayMs: 500 }),
      settlement(4, 'assistant/message', 7, 2, {
        stream: stream({ text: ['ok'] }),
        usage: { inputTokens: 20, outputTokens: 1, cacheReadTokens: 980 },
      }),
    ])
    const [failed, retried] = report.feed.bricks
    expect(report.feed.bricks).toHaveLength(2)
    expect(failed!.identity.attemptOrdinal).toBe(0)
    expect(failed!.settlement).toBe('attempt')
    expect(failed!.retry?.retryId).toBe('r-1')
    expect(retried!.identity.attemptOrdinal).toBe(1)
    expect(retried!.settlement).toBe('message')
    expect(retried!.retryChainId).toBe('r-1')
    // Both are navigable, and the pair shares the row that shows them together.
    expect(failed!.settlementSeq).toBe(2)
    expect(retried!.settlementSeq).toBe(4)
    expect(targetOf(failed!)).toMatchObject({ kind: 'retry-chain', retryId: 'r-1' })
    expect(targetOf(retried!)).toMatchObject({ kind: 'retry-chain', retryId: 'r-1' })
    expect(activityOf(failed!)).toBe('output')
    expect(activityOf(retried!)).toBe('output')
  })

  it('recovers the type face the old fold could not: reasoning, tools, mixed', () => {
    const report = replaySession('s1', [
      event(1, 'step/start', { turn: 3, step: 1 }, 1_000),
      settlement(2, 'assistant/message', 3, 1, {
        stream: stream({ reasoning: ['because'], text: ['done'], call: { id: 'c1', name: 'bash', args: ['{}'] } }),
        usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 95 },
      }),
      event(3, 'step/start', { turn: 3, step: 2 }, 2_000),
      settlement(4, 'assistant/message', 3, 2, {
        stream: stream({ reasoning: ['only thinking'] }),
        usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 95 },
      }),
      event(5, 'step/start', { turn: 3, step: 3 }, 3_000),
      settlement(6, 'assistant/message', 3, 3, {
        stream: stream({ call: { id: 'c2', name: 'read', args: ['{}'] } }),
        usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 95 },
      }),
    ])
    const kinds = report.feed.bricks.map((brick) => activityOf(brick))
    // The very thing that used to be a blank face for anything older than the collector.
    expect(kinds).toEqual(['mixed', 'reasoning', 'tool'])
  })

  it('keeps the settlement, the usage and the log position', () => {
    const report = replaySession('s1', [
      event(1, 'step/start', { turn: 4, step: 1 }, 1_000),
      event(2, 'request/context', { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1_000_000 }),
      settlement(3, 'assistant/message', 4, 1, { stream: stream({ text: ['hi'] }), usage: { inputTokens: 1_000, outputTokens: 10, cacheReadTokens: 9_000, cacheWriteTokens: 0 } }),
      event(4, 'turn/end', { turn: 4 }),
    ])
    const [brick] = report.feed.bricks
    expect(brick!.usage?.cacheReadTokens).toBe(9_000)
    expect(brick!.metrics.cacheHitRatio).toBeCloseTo(0.9, 6)
    expect(brick!.route.provider).toBe('deepseek-official')
    expect(brick!.route.contextWindow).toBe(1_000_000)
    expect(report.feed.endedTurns).toEqual([4])
    expect(report.unattributed).toBe(0)
    // A brick with no request capture says so instead of pretending.
    expect(brick!.request.requestRef).toBeUndefined()
    expect(brick!.context?.pressureTokens).toBeUndefined()
    // Reconstructed from the log, and it says so — not 'host', which would claim a capture.
    expect(brick!.observedBy).toBe('replay')
  })

  it('counts a settlement that names no step, instead of guessing an owner for it', () => {
    // An auxiliary call's settlement has no turn/step, so it belongs to no brick here. In a
    // replay every settlement that *does* name a step gets its own attempt by construction,
    // which is why `unattributed` stays zero and this is the case that has to be counted.
    const report = replaySession('s1', [
      event(1, 'assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } }),
      event(2, 'step/start', { turn: 1, step: 1 }, 1_000),
      settlement(3, 'assistant/message', 1, 1, { stream: stream({ text: ['kept'] }), usage: { inputTokens: 1, outputTokens: 1 } }),
    ])
    expect(report.feed.bricks).toHaveLength(1)
    expect(report.feed.bricks[0]!.identity.step).toBe(1)
    expect(report.ignored).toBeGreaterThanOrEqual(1)
    expect(report.unattributed).toBe(0)
  })
})

/** Newest session log under the session root, when there is one. */
function newestLog(): string | undefined {
  const root = process.env.DSH_SESSION_ROOT ?? join(homedir(), '.dsh-017', 'sessions')
  const found: { path: string; at: number }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'session.v4.jsonl.zstd') found.push({ path, at: statSync(path).mtimeMs })
    }
  }
  try {
    walk(root)
  } catch {
    return undefined
  }
  return found.sort((left, right) => right.at - left.at)[0]?.path
}

/** Every zstd frame in a session log, decoded. */
function decode(path: string): ReplayEvent[] {
  const buffer = readFileSync(path)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts: number[] = []
  for (let at = buffer.indexOf(magic); at >= 0; at = buffer.indexOf(magic, at + 1)) starts.push(at)
  starts.push(buffer.length)
  const chunks: Buffer[] = []
  for (let index = 0; index < starts.length - 1;) {
    let consumed = false
    for (let next = index + 1; next < starts.length; next += 1) {
      try {
        chunks.push(zstdDecompressSync(buffer.subarray(starts[index], starts[next])))
        index = next
        consumed = true
        break
      } catch {
        // Not a frame boundary: keep growing the slice.
      }
    }
    if (!consumed) break
  }
  const events: ReplayEvent[] = []
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as ReplayEvent
      if (typeof parsed.type === 'string' && typeof parsed.seq === 'number') events.push(parsed)
    } catch {
      // A torn tail line is not a replay failure.
    }
  }
  return events
}

describe('replaying a real session log', () => {
  const path = newestLog()

  it.skipIf(path === undefined)('reconstructs attempt-level bricks from the newest log', () => {
    const events = decode(path!)
    const report = replaySession('replayed', events)
    const kinds = new Set(report.feed.bricks.map((brick) => activityOf(brick)))
    const targets = new Set(report.feed.bricks.map((brick) => targetOf(brick).kind))
    console.log(`replayed ${String(events.length)} events -> ${String(report.feed.bricks.length)} bricks`
      + ` (${String(report.ignored)} ignored, ${String(report.unattributed)} unattributed);`
      + ` types: ${[...kinds].join('/')}; targets: ${[...targets].join('/')};`
      + ` endedTurns: ${report.feed.endedTurns.length}`)

    expect(report.feed.bricks.length).toBeGreaterThan(0)
    expect(report.unattributed).toBe(0)
    // Every replayed brick knows where it settled, which is what navigation needs.
    expect(report.feed.bricks.every((brick) => (brick.settlementSeq ?? 0) > 0)).toBe(true)
    // Usage comes back, so the cache reading is real rather than n/a.
    expect(report.feed.bricks.some((brick) => brick.usage?.cacheReadTokens !== undefined)).toBe(true)
    // And so does the activity the old fold could never see.
    expect([...kinds].some((kind) => kind !== 'output')).toBe(true)
    expect([...targets].some((kind) => kind === 'assistant-step')).toBe(true)
  })
})
