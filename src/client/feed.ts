/**
 * The browser's end of the collector's HTTP surface.
 *
 * Two rules come straight from the runtime contract (see `docs/runtime-contract.md`):
 *
 * - URLs are **document-relative**. The served page carries `<base href="./">` and
 *   may sit behind a prefix-stripping mount, so `location.origin + '/cache-bricks'`
 *   would break outside the origin root.
 * - The feed is an optimisation, never a requirement. A composition without a host
 *   half (or an older line) answers 404, and the board must keep working from what
 *   the client can observe by itself — so every failure here resolves to
 *   `unavailable` instead of throwing into a render.
 */
import type { BrickFeed, BrickRecord } from '../shared/brick'

/** What the client knows about the host feed. */
export type FeedState = 'idle' | 'connecting' | 'live' | 'unavailable'

/** Injected browser APIs, so the client can be unit-tested without a DOM. */
export interface FeedEnvironment {
  /** Base URI to resolve against; defaults to `document.baseURI`. */
  readonly baseUri?: string
  readonly fetchImpl?: typeof fetch
  /** `EventSource` constructor; `undefined` disables live updates. */
  readonly eventSourceImpl?: typeof EventSource | undefined
}

/** Resolve a path against the document base, whatever the mount point is. */
export function documentRelative(path: string, baseUri: string): string {
  const base = baseUri === '' ? 'http://localhost/' : baseUri
  return new URL(path, base).toString()
}

/** One attempt removed of its blob refs, so the panel knows whether to fetch. */
export function hasRawPayloads(record: BrickRecord): boolean {
  return record.raw.streamRef !== undefined || record.request.requestRef !== undefined
}

/** Subscribes to the collector and hands the board a feed whenever it changes. */
export class BrickFeedClient {
  private readonly environment: FeedEnvironment
  private source: EventSource | undefined
  private stopped = false

  /** Latest state, so a late subscriber can paint immediately. */
  state: FeedState = 'idle'

  /** Latest feed received, if any. */
  feed: BrickFeed | undefined

  constructor(environment: FeedEnvironment = {}) {
    this.environment = environment
  }

  /** The URL of one route, resolved for the current mount. */
  url(route: string): string {
    const base = this.environment.baseUri ?? (typeof document === 'undefined' ? '' : document.baseURI)
    return documentRelative(`cache-bricks/${route}`, base)
  }

  /**
   * Begin following a session.
   * @param sessionId - the session whose bricks to show.
   * @param onFeed - called with every feed received.
   * @returns a stop function.
   */
  start(sessionId: string, onFeed: (feed: BrickFeed) => void): () => void {
    this.stopped = false
    this.state = 'connecting'
    void this.fetchOnce(sessionId, onFeed)
    this.openStream(sessionId, onFeed)
    return () => { this.stop() }
  }

  /** Stop following, closing any stream. */
  stop(): void {
    this.stopped = true
    this.source?.close()
    this.source = undefined
  }

  /** One snapshot fetch; a failure marks the feed unavailable rather than throwing. */
  private async fetchOnce(sessionId: string, onFeed: (feed: BrickFeed) => void): Promise<void> {
    const doFetch = this.environment.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
    if (doFetch === undefined) {
      this.state = 'unavailable'
      return
    }
    try {
      const response = await doFetch(this.url(`attempts?sessionId=${encodeURIComponent(sessionId)}`), {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        // 404 means the collector has not observed this session, which is the
        // normal state on a composition that has no host half at all — and the
        // usual cause when there is one is a session id the host never saw, so
        // name it instead of failing silently.
        this.state = 'unavailable'
        if (response.status === 404) {
          console.info(
            `[dsh-cache-bricks] the host collector has no observations for session ${sessionId} `
            + '(HTTP 404); the board falls back to the client-side fold.',
          )
        }
        return
      }
      const feed = await response.json() as BrickFeed
      if (this.stopped) return
      this.feed = feed
      this.state = 'live'
      onFeed(feed)
    } catch {
      this.state = 'unavailable'
    }
  }

  /** Live updates, when the browser and the host both support them. */
  private openStream(sessionId: string, onFeed: (feed: BrickFeed) => void): void {
    const Ctor = this.environment.eventSourceImpl ?? (typeof EventSource === 'function' ? EventSource : undefined)
    if (Ctor === undefined) return
    try {
      const source = new Ctor(this.url(`stream?sessionId=${encodeURIComponent(sessionId)}`))
      source.addEventListener('feed', (event: MessageEvent<string>) => {
        if (this.stopped) return
        try {
          const feed = JSON.parse(event.data) as BrickFeed
          this.feed = feed
          this.state = 'live'
          onFeed(feed)
        } catch {
          // A malformed frame is not worth disturbing the board for.
        }
      })
      source.addEventListener('error', () => {
        // The stream may reconnect on its own; the snapshot path already covers
        // the case where it cannot.
        if (this.state === 'connecting') this.state = 'unavailable'
      })
      this.source = source
    } catch {
      // EventSource throws on an unusable URL; the snapshot fetch already ran.
    }
  }

  /** Fetch one stored payload by ref, or undefined when it was evicted. */
  async blob(ref: string): Promise<unknown> {
    const doFetch = this.environment.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
    if (doFetch === undefined) return undefined
    try {
      const response = await doFetch(this.url(`blob?ref=${encodeURIComponent(ref)}`), {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return undefined
      const body = await response.json() as { value?: unknown }
      return body.value
    } catch {
      return undefined
    }
  }
}
