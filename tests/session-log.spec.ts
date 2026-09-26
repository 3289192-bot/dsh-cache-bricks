/**
 * Reading a session log, once.
 *
 * Two layers, for the two different things that can go wrong:
 *
 * - **the fixture** pins the format: several Zstandard frames (which is how the artifact is
 *   written — one frame per append), a torn final frame (a log being written while it is read),
 *   settlements that carry their usage and settlements whose numbers are only in the compact
 *   stream, and the auxiliary records that have no `(turn, step)` and therefore no brick;
 * - **the live log check** runs the same reader against a real session artifact under this
 *   machine's DSH home, because a fixture can only prove the reader agrees with my reading of the
 *   format. It skips when there is no log to read.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { decodeFrames, frameRanges, logRoots, readLog, readSessionLog, usageFromStream } from '../src/host/session-log'

/** One Zstandard frame's worth of lines, as an append writes them. */
function frame(lines: readonly unknown[]): Buffer {
  return zstdCompressSync(Buffer.from(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8'))
}

/** A settled attempt, as `assistant/message` writes it. */
function settlement(seq: number, turn: number, step: number, usage?: Record<string, number>): unknown {
  return {
    type: 'assistant/message',
    seq,
    time: 1_000 + seq,
    data: { turn, step, ...(usage === undefined ? {} : { usage }) },
  }
}

describe('locating the frames in a log artifact', () => {
  it('finds every frame, in order', () => {
    const one = frame([{ type: 'session', id: 'S' }])
    const two = frame([settlement(1, 1, 1, { inputTokens: 10, cacheReadTokens: 90 })])
    const buffer = Buffer.concat([one, two])
    const ranges = frameRanges(buffer)
    expect(ranges).toHaveLength(2)
    expect(ranges[0]).toEqual({ start: 0, end: one.length })
    expect(ranges[1]).toEqual({ start: one.length, end: buffer.length })
    expect(decodeFrames(buffer)).toHaveLength(2)
  })

  it('ignores a torn final frame instead of guessing at it', () => {
    const whole = frame([settlement(1, 1, 1, { inputTokens: 10, cacheReadTokens: 90 })])
    const torn = whole.subarray(0, whole.length - 4)
    const ranges = frameRanges(Buffer.concat([whole, torn]))
    expect(ranges).toHaveLength(1)
    expect(decodeFrames(Buffer.concat([whole, torn]))).toHaveLength(1)
  })

  it('reports nothing rather than throwing on bytes that are not a log', () => {
    expect(frameRanges(Buffer.from('not a log at all'))).toEqual([])
    expect(decodeFrames(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual([])
    expect(decodeFrames(Buffer.alloc(0))).toEqual([])
    expect(readLog([]).records).toBe(0)
  })
})

describe('folding a log into settlements', () => {
  const chunks = decodeFrames(Buffer.concat([
    frame([{ type: 'session', version: 4, id: 'S' }]),
    // Turn 1: one step, usage on the event.
    frame([{ type: 'step/start', seq: 3, data: { turn: 1, step: 1 } }, settlement(4, 1, 1, { inputTokens: 20, cacheReadTokens: 1_980 }), { type: 'turn/end', seq: 5, data: { turn: 1 } }]),
    // Turn 2: a retried step — the failed attempt has no usage of its own, so its numbers are read
    // from the compact stream; then the attempt that worked.
    frame([
      { type: 'assistant/attempt', seq: 6, time: 2_000, data: { turn: 2, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 900, cacheReadTokens: 100 } } }] } },
      settlement(7, 2, 1, { inputTokens: 30, cacheReadTokens: 970 }),
      // An auxiliary call settles too, with no `(turn, step)`: counted, never a brick.
      { type: 'assistant/message', seq: 8, data: { usage: { inputTokens: 5, cacheReadTokens: 5 } } },
      { type: 'turn/end', seq: 9, data: { turn: 2 } },
    ]),
    // A torn tail: half a line, which a reader must ignore rather than fail on.
    zstdCompressSync(Buffer.from('{"type":"assistant/message","seq":10,"data":{"tu', 'utf8')),
  ]))

  it('reads one settlement per settled attempt, oldest first', () => {
    const read = readLog(chunks)
    expect(read.settlements.map((entry) => [entry.turn, entry.step])).toEqual([[1, 1], [2, 1], [2, 1]])
    expect(read.frames).toBe(4)
    expect(read.records).toBeGreaterThan(0)
  })

  it('takes usage off the event, and falls back to the compact stream', () => {
    const read = readLog(chunks)
    expect(read.settlements[0]!.usage).toEqual({ inputTokens: 20, cacheReadTokens: 1_980 })
    // The failed attempt: no usage field, so the stream's last usage chunk is the number.
    expect(read.settlements[1]!.usage).toEqual({ inputTokens: 900, cacheReadTokens: 100 })
    expect(read.settlements[2]!.usage).toEqual({ inputTokens: 30, cacheReadTokens: 970 })
  })

  it('keeps the turn-end marks, and counts what has no column', () => {
    const read = readLog(chunks)
    expect(read.endedTurns).toEqual([1, 2])
    expect(read.skipped).toBe(1)
  })

  it('reads a usage out of a compact stream only when it is there', () => {
    expect(usageFromStream([{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 7 } } }])).toEqual({ inputTokens: 7 })
    expect(usageFromStream([{ type: 'text-chunks', texts: ['x'] }])).toBeUndefined()
    expect(usageFromStream(undefined)).toBeUndefined()
  })
})

describe('finding a session log', () => {
  it('looks under the harness home by default', () => {
    const roots = logRoots({})
    expect(roots.length).toBeGreaterThan(0)
    expect(roots[roots.length - 1]!.replaceAll('\\', '/')).toContain('/sessions')
    expect(roots[roots.length - 1]!.replaceAll('\\', '/')).toContain(homedir().replaceAll('\\', '/').split('/').pop()!)
  })

  it('takes explicit roots first, so a test or a host can point it somewhere', () => {
    expect(logRoots({ roots: ['C:/tmp/a', 'C:/tmp/b'] })).toEqual(['C:/tmp/a', 'C:/tmp/b'])
  })

  it('answers undefined rather than throwing when there is no such session', async () => {
    await expect(readSessionLog('session-that-does-not-exist', { roots: ['C:/definitely/not/here'] })).resolves.toBeUndefined()
  })
})

describe('a real session log on this machine', () => {
  /**
   * Every harness home this machine has, then the plugin's own resolution.
   *
   * The plugin is *told* where the harness lives (`DSH_HOME` is set by the launcher that boots it);
   * a test process is not, so it looks for the homes itself — any `~/.dsh*` that has a `sessions`
   * directory. Generic rather than hardcoded, and it still skips on a machine with none.
   */
  function roots(): string[] {
    const found = logRoots({})
    try {
      for (const entry of readdirSync(homedir())) {
        if (!entry.startsWith('.dsh')) continue
        const candidate = join(homedir(), entry, 'sessions')
        if (existsSync(candidate) && !found.includes(candidate)) found.push(candidate)
      }
    } catch {
      // A home that cannot be listed is a home with no session logs.
    }
    return found
  }

  /** The largest log artifact under this machine's harness homes, and the root it was found under. */
  function biggestLog(): { path: string; root: string } | undefined {
    const found: Array<{ path: string; at: number; root: string }> = []
    for (const root of roots()) {
      if (!existsSync(root)) continue
      for (const workspace of readdirSync(root)) {
        const dir = join(root, workspace)
        let entries: string[]
        try {
          entries = readdirSync(dir)
        } catch {
          continue
        }
        for (const session of entries) {
          const file = join(dir, session, 'session.v4.jsonl.zstd')
          try {
            found.push({ path: file, at: statSync(file).size, root })
          } catch {
            // Not a session directory.
          }
        }
      }
    }
    // The largest, not the newest: a session created a minute ago is a header and nothing else.
    found.sort((left, right) => right.at - left.at)
    const best = found[0]
    return best === undefined ? undefined : { path: best.path, root: best.root }
  }

  const biggest = biggestLog()

  it.skipIf(biggest === undefined)('decodes it and finds settled attempts with real usage', () => {
    const buffer = readFileSync(biggest!.path)
    const read = readLog(decodeFrames(buffer))
    console.log(`read ${String(read.records)} records from ${String(read.frames)} frame(s): `
      + `${String(read.settlements.length)} settlements, ${String(read.endedTurns.length)} ended turns, ${String(read.skipped)} without a step`)
    expect(read.records).toBeGreaterThan(0)
    expect(read.settlements.length).toBeGreaterThan(0)
    // Every settlement names a step, and at least one carries the cache accounting a brick reads.
    expect(read.settlements.every((entry) => entry.turn >= 0 && entry.step >= 0)).toBe(true)
    expect(read.settlements.some((entry) => entry.usage?.cacheReadTokens !== undefined)).toBe(true)
  })

  it.skipIf(biggest === undefined)('finds and reads the same session through the public entry point', async () => {
    const sessionId = biggest!.path.split(/[\\/]/u).at(-2)!
    const read = await readSessionLog(sessionId, { roots: [biggest!.root] })
    expect(read?.path).toBe(biggest!.path)
    expect(read!.settlements.length).toBeGreaterThan(0)
  })
})
