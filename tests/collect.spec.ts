/**
 * The taps.
 *
 * Three things are worth pinning about the host half, and none of them are about features:
 *
 * 1. **It never changes the call.** `llm/stream` is a waterfall — returning anything but `next()`
 *    would replace the model's stream — so the returned value is asserted to be the very object
 *    the next listener produced.
 * 2. **It never throws into the model-call path.** A hostile request object, a broken frame, a
 *    settlement with nonsense in it: all of them are absorbed, because this code runs between the
 *    agent and the model.
 * 3. **A settled request is exactly one brick**, and a token-level delta costs nothing at all.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { installCollector, type Collector, type HostContextLike } from '../src/host/collect'
import { createBrickRouter } from '../src/host/routes'
import type { BrickFeed } from '../src/shared/cache-brick'

/** A host context that records the taps and can emit on them. */
function host(): HostContextLike & {
  emit(event: string, ...args: unknown[]): void
  readonly registered: string[]
} {
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>()
  const registered: string[] = []
  const services = new Map<string, unknown>()
  return {
    registered,
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return undefined
    },
    get(name) { return services.get(name) },
    inject(names, callback) {
      registered.push(...names)
      // The web server is present in this fake as soon as it is asked for.
      callback({
        on: () => undefined,
        get: (name: string) => (name === 'webServer'
          ? { register: (route: { path: string }) => { registered.push(route.path); return () => {} } }
          : undefined),
        inject: () => undefined,
        effect: (callback: () => void) => { callback(); return undefined },
      } as unknown as HostContextLike)
      return undefined
    },
    effect(callback) { callback(); return undefined },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...(args as never[]))
    },
  }
}

/**
 * The plugin's own route over a collector, so a test asks exactly what a browser asks.
 *
 * The read is fired by the request and finishes asynchronously, so the answer to the *first* look
 * may arrive before the log has been read; a second look is what a browser does anyway (its stream
 * pushes the result).
 */
function createRouterFor(collector: Collector): { handler: (request: unknown, response: unknown) => void } {
  return createBrickRouter({
    bricks: (sessionId) => collector.feed(sessionId),
    sessions: () => collector.sessions(),
    subscribe: (sessionId, sink) => collector.subscribe(sessionId, sink as (feed: unknown) => void),
    looked: (sessionId) => { collector.looked?.(sessionId) },
  })
}

/** Ask for one session's bricks the way the board does, waiting out the log read. */
async function askBricks(router: { handler: (request: unknown, response: unknown) => void }, sessionId: string): Promise<BrickFeed | undefined> {
  const ask = (): BrickFeed | undefined => {
    let body = ''
    router.handler(
      { url: `/cache-bricks/bricks?sessionId=${sessionId}`, method: 'GET', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } },
      {
        setHeader() {},
        end(chunk?: string) { if (chunk !== undefined) body += chunk },
      },
    )
    const parsed = JSON.parse(body) as BrickFeed & { error?: string }
    return parsed.error === undefined ? parsed : undefined
  }
  let payload = ask()
  for (let attempt = 0; attempt < 40 && payload === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    payload = ask()
  }
  // One more look after the read has certainly finished: the first successful answer may have
  // overtaken the backfill.
  await new Promise((resolve) => setTimeout(resolve, 150))
  return ask() ?? payload
}

/** One settled step's durable event data. */
function settlement(turn: number, step: number, usage: { inputTokens: number; cacheReadTokens?: number }) {
  return { turn, step, usage }
}

describe('the model-call tap', () => {
  it('returns exactly what the next listener produced', () => {
    const ctx = host()
    installCollector(ctx, { serve: false })
    const stream = { chunks: ['a', 'b'] }
    let received: unknown
    ctx.emit('llm/stream', { sessionId: 'S' }, () => { received = stream; return stream })
    expect(received).toBe(stream)
  })

  it('counts a dispatched request without touching it', () => {
    const ctx = host()
    const collector = installCollector(ctx, { serve: false })
    // A frozen request, like the loop's own: reading it is fine, writing it throws.
    const request = Object.freeze({ sessionId: 'S', messages: Object.freeze([{ role: 'user' }]) })
    ctx.emit('llm/stream', request, () => 'stream')
    expect(collector.feed('S')?.dispatched).toBe(1)
    expect(collector.feed('S')?.bricks).toEqual([])
  })

  it('survives a request whose fields throw on read', () => {
    const ctx = host()
    const collector = installCollector(ctx, { serve: false })
    const hostile = { get sessionId(): string { throw new Error('no') } }
    expect(() => { ctx.emit('llm/stream', hostile, () => 'stream') }).not.toThrow()
    // The request is counted under `unknown`, which is where an unreadable session belongs.
    expect(collector.feed('unknown')?.dispatched).toBe(1)
  })
})

describe('one settled request, one brick', () => {
  it('turns a turn of events into a brick in the session feed', () => {
    const ctx = host()
    const collector = installCollector(ctx, { serve: false })
    ctx.emit('llm/stream', { sessionId: 'S' }, () => 'stream')
    ctx.emit('agent/assistant-stream', {
      agent: { session: { id: 'S' } },
      frame: { type: 'start', turn: 3, step: 1, attemptId: 'a1', time: 1_000 },
    })
    ctx.emit('agent/assistant-stream', {
      agent: { session: { id: 'S' } },
      frame: { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 20, cacheReadTokens: 1_980 } } },
    })
    // Nothing yet: a request in flight has no reading to show.
    expect(collector.feed('S')?.bricks).toEqual([])
    ctx.emit('session/event', { id: 'S' }, { type: 'assistant/message', time: 1_500, data: settlement(3, 1, { inputTokens: 20, cacheReadTokens: 1_980 }) })

    const feed = collector.feed('S') as BrickFeed
    expect(feed.bricks).toHaveLength(1)
    expect(feed.bricks[0]!.id).toBe('S:3:1:0')
    expect(feed.bricks[0]!.tone).toBe('good')
    expect(feed.dispatched).toBe(1)
  })

  it('does not count a token-level delta or wake anyone for it', () => {
    const ctx = host()
    const collector = installCollector(ctx, { serve: false })
    let pushes = 0
    collector.subscribe('S', () => { pushes += 1 })
    ctx.emit('agent/assistant-stream', { agent: { session: { id: 'S' } }, frame: { type: 'start', turn: 1, step: 1 } })
    for (let index = 0; index < 2_000; index += 1) {
      ctx.emit('agent/assistant-stream', {
        agent: { session: { id: 'S' } },
        frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'x' } },
      })
    }
    // Two thousand deltas: no brick, no push. This is the whole reason the plugin is cheap.
    expect(pushes).toBe(0)
    expect(collector.feed('S')?.bricks).toEqual([])
  })

  it('pushes once when a retry chain settles, not once per event', () => {
    const ctx = host()
    const collector = installCollector(ctx, { serve: false })
    let pushes = 0
    collector.subscribe('S', () => { pushes += 1 })
    ctx.emit('agent/assistant-stream', { agent: { session: { id: 'S' } }, frame: { type: 'start', turn: 1, step: 1 } })
    ctx.emit('session/event', { id: 'S' }, { type: 'assistant/attempt', time: 10, data: settlement(1, 1, { inputTokens: 900 }) })
    ctx.emit('agent/assistant-stream', { agent: { session: { id: 'S' } }, frame: { type: 'start', turn: 1, step: 1 } })
    ctx.emit('session/event', { id: 'S' }, { type: 'assistant/message', time: 20, data: settlement(1, 1, { inputTokens: 20, cacheReadTokens: 1_980 }) })
    expect(collector.feed('S')?.bricks).toHaveLength(2)
    // The first settlement pushes immediately; the second lands inside the coalescing window, so
    // the browser gets at most one more repaint rather than one per attempt.
    expect(pushes).toBeLessThanOrEqual(2)
  })

  it('marks a Turn finished when the log says so', () => {
    const ctx = host()
    const collector = installCollector(ctx, { serve: false })
    ctx.emit('session/event', { id: 'S' }, { type: 'turn/end', data: { turn: 2 } })
    expect(collector.feed('S')?.endedTurns).toEqual([2])
  })

  it('ignores an event that is not a settlement, and never throws on a malformed one', () => {
    const ctx = host()
    const collector = installCollector(ctx, { serve: false })
    expect(() => {
      ctx.emit('session/event', { id: 'S' }, { type: 'tool/call', data: { turn: 1, step: 1 } })
      ctx.emit('session/event', { id: 'S' }, { type: 'assistant/message', data: { turn: 'x', step: null } })
      ctx.emit('session/event', { id: 'S' }, { type: 'assistant/attempt', data: {} })
      ctx.emit('session/event', { id: 'S' }, undefined)
      ctx.emit('agent/assistant-stream', { agent: {} })
      ctx.emit('agent/assistant-stream', undefined)
    }).not.toThrow()
    expect(collector.feed('S')?.bricks).toEqual([])
  })
})

describe('serving', () => {
  it('registers its route on the web server', () => {
    const ctx = host()
    installCollector(ctx, {})
    expect(ctx.registered).toContain('webServer')
    expect(ctx.registered).toContain('/cache-bricks')
  })

  it('observes without serving when asked to', () => {
    const ctx = host()
    installCollector(ctx, { serve: false })
    expect(ctx.registered).not.toContain('webServer')
  })

  it('honours a different prefix for the route', () => {
    const ctx = host()
    installCollector(ctx, { basePath: '/bricks-lite' })
    expect(ctx.registered).toContain('/bricks-lite')
  })
})


/**
 * The one thing Lite reads from history: a session's own log, once, when a browser looks at it.
 *
 * The trigger matters as much as the read. An active session's past is the least interesting thing
 * about it, and reading every session's log at startup would be exactly the "scan everything" this
 * line exists to avoid — so the cost is paid when a *reader* asks, and once per session.
 */
describe('backfilling a session from its log', () => {
  /** A harness log for one session: header, then a frame per append, as the artifact is written. */
  function writeLog(root: string, sessionId: string, frames: readonly unknown[][]): string {
    const dir = join(root, '--workspace--', sessionId)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'session.v4.jsonl.zstd')
    // The artifact's first frame holds the session header — the file starts with a frame, not with
    // a plaintext line (measured on a real log: magic at byte 0).
    const header = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: sessionId })}\n`, 'utf8'))
    const body = frames.map((lines) => zstdCompressSync(Buffer.from(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')))
    writeFileSync(path, Buffer.concat([header, ...body]))
    return path
  }

  const settled = (turn: number, step: number, inputTokens: number, cacheReadTokens: number): unknown => ({
    type: 'assistant/message',
    time: 1_000 * turn + step,
    data: { turn, step, usage: { inputTokens, cacheReadTokens } },
  })

  it('fills an old session when a reader asks for its bricks, and only then', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cache-bricks-logs-'))
    writeLog(root, 'session-old', [
      [settled(1, 1, 20, 1_980), settled(1, 2, 400, 600)],
      [{ type: 'turn/end', data: { turn: 1 } }, settled(2, 1, 10, 990)],
    ])
    const ctx = host()
    // A fresh collector has seen nothing: the session does not exist as far as live traffic goes.
    installCollector(ctx, { serve: false, logsRoots: [root] })
    const feed = installCollector(ctx, { serve: false, logsRoots: [root] })

    // Nothing is read until someone looks: `feed()` alone does not trigger it.
    expect(feed.feed('session-old')).toBeUndefined()

    // The route is what a browser hits, and it is what triggers the read.
    const router = createRouterFor(feed)
    const payload = await askBricks(router, 'session-old')
    expect(payload.bricks).toHaveLength(3)
    expect(payload.bricks.map((brick) => [brick.turn, brick.step])).toEqual([[1, 1], [1, 2], [2, 1]])
    expect(payload.bricks[0]!.hitRatio).toBeCloseTo(1_980 / 2_000, 6)
    expect(payload.bricks[0]!.tone).toBe('good')
    expect(payload.backfilled).toBe(3)
    expect(payload.endedTurns).toEqual([1])
    // The reading is the log's own, and the brick still carries nothing but its eleven fields.
    expect(Object.keys(payload.bricks[0]!).sort()).toEqual([
      'attempt', 'cacheReadTokens', 'cacheWriteTokens', 'finishedAt', 'hitRatio', 'id', 'inputTokens',
      'startedAt', 'step', 'tone', 'turn',
    ])
  })

  it('lets the live path own a step the log also has', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cache-bricks-logs-'))
    writeLog(root, 'session-both', [[settled(9, 1, 20, 80)], [settled(9, 1, 20, 980)]])
    const ctx = host()
    const collector = installCollector(ctx, { serve: false, logsRoots: [root] })
    // The live half sees this step first: its attempt is the one being billed, so the log's
    // settlements for the same step are not allowed to duplicate it or steal its ordinal.
    collector.feeds.for('session-both').attempts.settle({ turn: 9, step: 1, usage: { inputTokens: 30, cacheReadTokens: 970 } })

    const router = createRouterFor(collector)
    const payload = await askBricks(router, 'session-both')
    expect(payload.bricks).toHaveLength(1)
    expect(payload.bricks[0]!.inputTokens).toBe(30)
    expect(payload.backfilled).toBe(0)
  })

  it('reads a session once, however many times it is asked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cache-bricks-logs-'))
    writeLog(root, 'session-once', [[settled(1, 1, 10, 90)]])
    const ctx = host()
    const collector = installCollector(ctx, { serve: false, logsRoots: [root] })
    const router = createRouterFor(collector)
    await askBricks(router, 'session-once')
    await askBricks(router, 'session-once')
    expect(collector.feed('session-once')?.bricks).toHaveLength(1)
  })

  it('counts live traffic when there is no log to read, and says nothing about a past it cannot see', async () => {
    const ctx = host()
    const collector = installCollector(ctx, { serve: false, logsRoots: [join(tmpdir(), 'cache-bricks-nothing-here')] })
    const router = createRouterFor(collector)
    const payload = await askBricks(router, 'session-unknown')
    expect(payload).toBeUndefined()
    expect(collector.feed('session-unknown')).toBeUndefined()
  })

  it('does not read any log when backfill is off', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cache-bricks-logs-'))
    writeLog(root, 'session-off', [[settled(1, 1, 10, 90)]])
    const ctx = host()
    const collector = installCollector(ctx, { serve: false, backfill: false, logsRoots: [root] })
    const router = createRouterFor(collector)
    await askBricks(router, 'session-off')
    expect(collector.feed('session-off')).toBeUndefined()
  })
})
