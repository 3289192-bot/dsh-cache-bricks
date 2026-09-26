/**
 * The browser's end of the collector's HTTP surface.
 *
 * Two rules come straight from the runtime contract (`docs/runtime-contract.md`), and both are
 * inherited unchanged from the full line because they are about the *harness*, not about bricks:
 *
 * - URLs are **document-relative**. The served page carries `<base href="./">` and may sit behind
 *   a prefix-stripping mount, so `location.origin + '/cache-bricks'` breaks outside the origin
 *   root.
 * - The feed is an optimisation, never a requirement. A composition with no host half answers
 *   404, and the board must say "no collector" rather than draw an empty gutter that looks like a
 *   cold cache.
 *
 * Bricks are flat, so the protocol is one sentence: *here are the bricks now*. No refs to
 * resolve, no second request, no reconciliation.
 */
import type { BrickFeed } from '../shared/cache-brick'

/** The route prefix the host half serves (`host/routes.ts`). */
export const BASE_PATH = '/cache-bricks'

/** How a feed client reports what it has. `undefined` means "no collector answering". */
export type FeedSink = (feed: BrickFeed | undefined) => void

/** Injected browser APIs, so this module is unit-testable without a DOM. */
export interface FeedEnvironment {
  /** Base URI to resolve against; defaults to `document.baseURI`. */
  readonly baseUri?: string
  readonly fetchImpl?: typeof fetch
  /** `EventSource` constructor; `undefined` disables pushes and leaves the snapshot. */
  readonly eventSourceImpl?: typeof EventSource | undefined
}

/**
 * Resolve a path against the document base, whatever the mount point is.
 * @param path - the plugin's own route, e.g. `/cache-bricks/bricks`.
 * @param baseUri - the page's base URI.
 * @returns an absolute URL string.
 */
export function documentRelative(path: string, baseUri: string): string {
  const base = baseUri === '' ? 'http://localhost/' : baseUri
  return new URL(path.replace(/^\//u, ''), base).toString()
}

/** A session the collector knows about, with nothing in it yet. */
export function emptyFeed(sessionId: string): BrickFeed {
  return { sessionId, bricks: [], dropped: 0, endedTurns: [], backfilled: 0, dispatched: 0 }
}

/**
 * Follow one session.
 *
 * The snapshot is fetched first, so a board that opens mid-turn draws the bricks that already
 * exist; the stream then replaces the whole feed whenever a request settles. A torn frame costs
 * one repaint, never correctness: every push is the complete list.
 */
export class BrickFeedClient {
  private source: EventSource | undefined
  private stopped = false
  private readonly environment: FeedEnvironment

  constructor(environment: FeedEnvironment = {}) {
    this.environment = environment
  }

  /**
   * Start following a session.
   *
   * @param sessionId - the session the board belongs to.
   * @param sink - called with the bricks whenever they change.
   * @returns a function that stops following.
   */
  start(sessionId: string, sink: FeedSink): () => void {
    this.stopped = false
    void this.snapshot(sessionId, sink)
    const EventSourceImpl = 'eventSourceImpl' in this.environment
      ? this.environment.eventSourceImpl
      : (globalThis as { EventSource?: typeof EventSource }).EventSource
    if (EventSourceImpl === undefined) return () => { this.stopped = true }
    const url = documentRelative(
      `${BASE_PATH}/stream?sessionId=${encodeURIComponent(sessionId)}`,
      this.environment.baseUri ?? document.baseURI,
    )
    try {
      const source = new EventSourceImpl(url)
      this.source = source
      source.addEventListener('bricks', (event) => {
        if (this.stopped) return
        try {
          sink(JSON.parse((event as MessageEvent<string>).data) as BrickFeed)
        } catch {
          // A torn frame is not worth a broken board: the next settlement sends a whole one.
        }
      })
      // A stream that dies says so, so the board stops claiming to be live.
      source.addEventListener('error', () => { if (!this.stopped) sink(undefined) })
    } catch {
      sink(undefined)
    }
    return () => {
      this.stopped = true
      this.source?.close()
      this.source = undefined
    }
  }

  /** Read the current bricks once, so the first paint is not blank. */
  private async snapshot(sessionId: string, sink: FeedSink): Promise<void> {
    const baseUri = this.environment.baseUri ?? document.baseURI
    const url = documentRelative(`${BASE_PATH}/bricks?sessionId=${encodeURIComponent(sessionId)}`, baseUri)
    const fetchImpl = this.environment.fetchImpl ?? fetch
    try {
      const response = await fetchImpl(url, { headers: { accept: 'application/json' } })
      if (this.stopped) return
      if (!response.ok) {
        // 404 is "this session has no bricks yet" — a real answer from a live collector, not a
        // failure; anything else means the collector is not there.
        sink(response.status === 404 ? emptyFeed(sessionId) : undefined)
        return
      }
      sink(await response.json() as BrickFeed)
    } catch {
      if (!this.stopped) sink(undefined)
    }
  }
}
