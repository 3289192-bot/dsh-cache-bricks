/**
 * The ring and the wire.
 *
 * Two properties matter here, and both are about honesty rather than plumbing:
 *
 * - a feed that had to drop bricks **says so** (`dropped`), so a board holding the tail of a long
 *   run is never mistaken for a session that began a minute ago;
 * - the route serves bricks and nothing else — no blob endpoint, because there is nothing stored
 *   to fetch, and the guard still applies.
 */
import { describe, expect, it } from 'vitest'
import { BrickFeeds, SessionFeed } from '../src/host/brick-feed'
import { createBrickRouter, type RouteRequestLike, type RouteResponseLike } from '../src/host/routes'

/** A fake response that records what was written. */
function response(): RouteResponseLike & { readonly body: string; readonly status: number } {
  let body = ''
  let status = 0
  return {
    get body() { return body },
    get status() { return status },
    set statusCode(value: number) { status = value },
    get statusCode() { return status },
    setHeader() {},
    write(chunk: string) { body += chunk },
    end(chunk?: string) { if (chunk !== undefined) body += chunk },
  }
}

/** A loopback GET with an optional session. */
function request(url: string, overrides: Partial<RouteRequestLike> = {}): RouteRequestLike {
  return {
    url,
    method: 'GET',
    headers: { host: '127.0.0.1:18090' },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  }
}

/** One brick, settled. */
function brick(step: number) {
  return {
    id: `S:1:${String(step)}:0`,
    turn: 1,
    step,
    attempt: 0,
    inputTokens: 10,
    cacheReadTokens: 990,
    cacheWriteTokens: 0,
    hitRatio: 0.99,
    startedAt: step,
    finishedAt: step + 1,
    tone: 'good' as const,
  }
}

describe('one session’s ring', () => {
  it('hands out the bricks newest last, and counts what it dropped', () => {
    const feed = new SessionFeed('S', { capacity: 2 })
    feed.attempts.settle({ turn: 1, step: 1, time: 1, usage: { inputTokens: 10, cacheReadTokens: 990 } })
    feed.attempts.settle({ turn: 1, step: 2, time: 2, usage: { inputTokens: 10, cacheReadTokens: 990 } })
    feed.attempts.settle({ turn: 1, step: 3, time: 3, usage: { inputTokens: 10, cacheReadTokens: 990 } })
    const snapshot = feed.snapshot()
    expect(snapshot.bricks.map((entry) => entry.step)).toEqual([2, 3])
    expect(snapshot.dropped).toBe(1)
    expect(snapshot.sessionId).toBe('S')
  })

  it('pushes to readers, and stops when they leave', () => {
    const feed = new SessionFeed('S')
    const seen: number[] = []
    const stop = feed.subscribe((snapshot) => { seen.push(snapshot.bricks.length) })
    expect(feed.listeners).toBe(1)
    feed.attempts.settle({ turn: 1, step: 1, time: 1, usage: { inputTokens: 1, cacheReadTokens: 1 } })
    feed.publish()
    stop()
    feed.publish()
    expect(seen).toEqual([1])
    expect(feed.listeners).toBe(0)
  })

  it('reports the dispatched count, so a gap between requests and bricks is visible', () => {
    const feed = new SessionFeed('S')
    feed.attempts.dispatched()
    feed.attempts.dispatched()
    feed.attempts.settle({ turn: 1, step: 1, time: 1, usage: { inputTokens: 1, cacheReadTokens: 1 } })
    const snapshot = feed.snapshot()
    expect(snapshot.dispatched).toBe(2)
    expect(snapshot.bricks).toHaveLength(1)
  })
})

describe('sessions', () => {
  it('keeps the most recent and drops the least recently used', () => {
    const feeds = new BrickFeeds({ sessions: 2 })
    feeds.for('A').attempts.settle({ turn: 1, step: 1, time: 1, usage: { inputTokens: 1, cacheReadTokens: 1 } })
    feeds.for('B')
    feeds.for('A')
    feeds.for('C')
    expect(feeds.sessions().sort()).toEqual(['A', 'C'])
    expect(feeds.peek('B')).toBeUndefined()
  })

  it('answers undefined for a session it has never seen, without creating one', () => {
    const feeds = new BrickFeeds()
    expect(feeds.peek('nope')).toBeUndefined()
    expect(feeds.sessions()).toEqual([])
  })
})

describe('the route', () => {
  const deps = {
    bricks: (sessionId: string) => (sessionId === 'S' ? { sessionId, bricks: [brick(1)], dropped: 0, endedTurns: [1], dispatched: 1 } : undefined),
    sessions: () => ['S'],
    subscribe: () => () => {},
  }

  it('serves bricks, and only bricks', () => {
    const router = createBrickRouter(deps)
    expect(router.path).toBe('/cache-bricks')
    const ok = response()
    router.handler(request('/cache-bricks/bricks?sessionId=S'), ok)
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body).bricks).toHaveLength(1)

    // The full line had a /blob route; this one must not, because nothing is stored.
    const blob = response()
    router.handler(request('/cache-bricks/blob?ref=abc'), blob)
    expect(blob.status).toBe(404)
  })

  it('says which sessions it has seen, and 404s a session with no bricks yet', () => {
    const router = createBrickRouter(deps)
    const sessions = response()
    router.handler(request('/cache-bricks/sessions'), sessions)
    expect(JSON.parse(sessions.body).sessions).toEqual(['S'])
    const unknown = response()
    router.handler(request('/cache-bricks/bricks?sessionId=other'), unknown)
    expect(unknown.status).toBe(404)
  })

  it('requires a session id rather than guessing one', () => {
    const router = createBrickRouter(deps)
    const missing = response()
    router.handler(request('/cache-bricks/bricks'), missing)
    expect(missing.status).toBe(400)
  })

  it('refuses a peer that is not this machine, and a cross-origin page', () => {
    const router = createBrickRouter(deps)
    const remote = response()
    router.handler(request('/cache-bricks/bricks?sessionId=S', { socket: { remoteAddress: '10.0.0.7' } }), remote)
    expect(remote.status).toBe(403)
    const unroutable = response()
    router.handler(request('/cache-bricks/bricks?sessionId=S', { socket: {} }), unroutable)
    expect(unroutable.status).toBe(403)
    const crossOrigin = response()
    router.handler(request('/cache-bricks/bricks?sessionId=S', { headers: { host: '127.0.0.1:18090', origin: 'http://evil.test' } }), crossOrigin)
    expect(crossOrigin.status).toBe(403)
  })

  it('applies the harness policy before anything else', () => {
    const router = createBrickRouter(deps, { guard: () => 401 })
    const refused = response()
    router.handler(request('/cache-bricks/sessions'), refused)
    expect(refused.status).toBe(401)
    expect(JSON.parse(refused.body).error).toBe('unauthenticated')
  })

  it('streams the snapshot first, so a board that opens mid-turn is not blank', () => {
    const router = createBrickRouter(deps)
    const stream = response()
    router.handler(request('/cache-bricks/stream?sessionId=S'), stream)
    expect(stream.body).toContain('event: bricks')
    expect(stream.body).toContain('"turn":1')
  })
})
