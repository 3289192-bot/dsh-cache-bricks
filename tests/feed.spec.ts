import { describe, expect, it, vi } from 'vitest'
import { BrickFeedClient, documentRelative, hasRawPayloads } from '../src/client/feed'
import type { BrickFeed, BrickRecord } from '../src/shared/brick'
import { EMPTY_COUNTERS, deriveMetrics } from '../src/shared/metrics'

/** A minimal feed for transport tests. */
function feed(sessionId = 's1'): BrickFeed {
  return { sessionId, bricks: [], store: { blobs: 0, bytes: 0 } }
}

/** A minimal record, for the payload-presence helper. */
function brick(options: { streamRef?: string; requestRef?: string }): BrickRecord {
  return {
    identity: { id: 's1:1:1:0', sessionId: 's1', turn: 1, step: 1, attemptOrdinal: 0 },
    settlement: 'message',
    route: { provider: 'p', model: 'm' },
    metrics: deriveMetrics(undefined, {}, EMPTY_COUNTERS),
    request: { ...(options.requestRef === undefined ? {} : { requestRef: options.requestRef }) },
    tools: [],
    raw: { ...(options.streamRef === undefined ? {} : { streamRef: options.streamRef }) },
  }
}

/** A fake EventSource that lets the test push frames. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>()
  readonly closed = { value: false }
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  close(): void {
    this.closed.value = true
  }

  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent<string>)
  }
}

describe('documentRelative', () => {
  it('resolves against the page base, so a mounted proxy keeps working', () => {
    expect(documentRelative('cache-badge/attempts', 'http://127.0.0.1:18090/'))
      .toBe('http://127.0.0.1:18090/cache-badge/attempts')
    // Served under a prefix-stripping mount: the route must follow the mount.
    expect(documentRelative('cache-badge/attempts', 'http://host/prefix/app/'))
      .toBe('http://host/prefix/app/cache-badge/attempts')
  })

  it('does not fall over when there is no document', () => {
    expect(documentRelative('cache-badge/attempts', '')).toBe('http://localhost/cache-badge/attempts')
  })
})

describe('BrickFeedClient', () => {
  it('takes a snapshot first, then follows the stream', async () => {
    FakeEventSource.instances = []
    const seen: BrickFeed[] = []
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(feed()), { status: 200 }))
    const client = new BrickFeedClient({
      baseUri: 'http://127.0.0.1:18090/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
    })
    client.start('s1', (next) => seen.push(next))
    await vi.waitFor(() => { expect(seen).toHaveLength(1) })
    expect(client.state).toBe('live')
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:18090/cache-badge/attempts?sessionId=s1')

    // A live frame replaces the snapshot.
    const source = FakeEventSource.instances.at(-1)!
    source.emit('feed', JSON.stringify({ ...feed(), store: { blobs: 3, bytes: 99 } }))
    expect(seen).toHaveLength(2)
    expect(seen[1]!.store.blobs).toBe(3)
  })

  it('reports unavailable instead of throwing when there is no host half', async () => {
    const client = new BrickFeedClient({
      baseUri: 'http://127.0.0.1:18090/',
      fetchImpl: (async () => new Response('{"error":"unknown route"}', { status: 404 })) as unknown as typeof fetch,
      eventSourceImpl: undefined,
    })
    const seen: BrickFeed[] = []
    client.start('s1', (next) => seen.push(next))
    await vi.waitFor(() => { expect(client.state).toBe('unavailable') })
    expect(seen).toHaveLength(0)
  })

  it('survives a network error and a malformed frame', async () => {
    FakeEventSource.instances = []
    const client = new BrickFeedClient({
      baseUri: 'http://x/',
      fetchImpl: (async () => { throw new Error('offline') }) as unknown as typeof fetch,
      eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
    })
    const seen: BrickFeed[] = []
    client.start('s1', (next) => seen.push(next))
    await vi.waitFor(() => { expect(client.state).toBe('unavailable') })
    const source = FakeEventSource.instances.at(-1)!
    source.emit('feed', 'not json')
    expect(seen).toHaveLength(0)
  })

  it('fetches a payload by ref and treats an evicted one as absent', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      if (url.includes('ref=gone')) return new Response('{"error":"x"}', { status: 404 })
      return new Response(JSON.stringify({ ref: 'abc', value: { messages: ['hi'] } }), { status: 200 })
    }) as unknown as typeof fetch
    const client = new BrickFeedClient({ baseUri: 'http://x/', fetchImpl })
    expect(await client.blob('abc')).toEqual({ messages: ['hi'] })
    expect(await client.blob('gone')).toBeUndefined()
    expect(calls.every((url) => url.startsWith('http://x/cache-badge/blob?'))).toBe(true)
  })

  it('stops following when asked', async () => {
    FakeEventSource.instances = []
    const client = new BrickFeedClient({
      baseUri: 'http://x/',
      fetchImpl: (async () => new Response(JSON.stringify(feed()), { status: 200 })) as unknown as typeof fetch,
      eventSourceImpl: FakeEventSource as unknown as typeof EventSource,
    })
    const stop = client.start('s1', () => undefined)
    stop()
    expect(FakeEventSource.instances.at(-1)!.closed.value).toBe(true)
  })
})

describe('hasRawPayloads', () => {
  it('tells the panel whether there is anything to fetch', () => {
    expect(hasRawPayloads(brick({ streamRef: 'a' }))).toBe(true)
    expect(hasRawPayloads(brick({ requestRef: 'b' }))).toBe(true)
    expect(hasRawPayloads(brick({}))).toBe(false)
  })
})
