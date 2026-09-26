/**
 * Where bricks wait to be drawn.
 *
 * A ring, in memory, per session. Nothing is written to disk, nothing is indexed, nothing is
 * searched: the newest {@link DEFAULT_FEED_CAPACITY} bricks are kept and the rest fall off the
 * old end. Losing them is the design, not a limitation — a brick is a reading of a moment, and a
 * cache is watched live or not at all.
 *
 * A reader that arrives late is told what it missed (`dropped`), so a board that only holds the
 * tail of a long run cannot be mistaken for a session that started a few minutes ago.
 *
 * Sessions themselves are capped too, least-recently-used first: a host process sees many
 * sessions, and a plugin whose memory grows with them would be a plugin nobody keeps installed.
 */
import type { BrickFeed } from '../shared/cache-brick'
import { AttemptTracker, type AttemptTrackerOptions } from './attempt-tracker'

/** Bricks kept per session. A few dozen bytes each, so this is well under a megabyte. */
export const DEFAULT_FEED_CAPACITY = 1024

/** Sessions kept. A browser tab watches one; the rest are recent history. */
export const DEFAULT_SESSION_CAPACITY = 8

/** What one session's ring hands out. */
export type FeedSink = (feed: BrickFeed) => void

/**
 * One session's bricks, and the readers waiting on them.
 *
 * Publishing is coalesced by the collector, not here: this class only knows how to say "these
 * are the bricks now".
 */
export class SessionFeed {
  private readonly tracker: AttemptTracker
  private readonly sessionId: string
  private readonly sinks = new Set<FeedSink>()

  constructor(sessionId: string, options: AttemptTrackerOptions = {}) {
    this.sessionId = sessionId
    this.tracker = new AttemptTracker(sessionId, options)
  }

  /** The tracker this feed reads, so the collector can hand it observations. */
  get attempts(): AttemptTracker {
    return this.tracker
  }

  /** The session's current bricks. */
  snapshot(): BrickFeed {
    return {
      sessionId: this.sessionId,
      bricks: this.tracker.records(),
      dropped: this.tracker.dropped,
      endedTurns: this.tracker.endedTurns(),
      backfilled: this.tracker.backfilled,
      dispatched: this.tracker.dispatchedCount,
    }
  }

  /** Watch this feed. The returned function stops watching. */
  subscribe(sink: FeedSink): () => void {
    this.sinks.add(sink)
    return () => { this.sinks.delete(sink) }
  }

  /** Number of live readers — the collector skips serializing when nobody is looking. */
  get listeners(): number {
    return this.sinks.size
  }

  /** Hand every reader the current feed. */
  publish(): void {
    if (this.sinks.size === 0) return
    const feed = this.snapshot()
    for (const sink of this.sinks) {
      try {
        sink(feed)
      } catch {
        // A closed SSE response is not the collector's problem.
      }
    }
  }

  /** Drop every reader and every brick. */
  dispose(): void {
    this.sinks.clear()
  }
}

/** Every session's feed, with the least recently used dropped first. */
export class BrickFeeds {
  private readonly feeds = new Map<string, SessionFeed>()
  private readonly capacity: number
  private readonly trackerOptions: AttemptTrackerOptions

  constructor(options: { sessions?: number; tracker?: AttemptTrackerOptions } = {}) {
    this.capacity = Math.max(1, options.sessions ?? DEFAULT_SESSION_CAPACITY)
    this.trackerOptions = options.tracker ?? {}
  }

  /**
   * The feed for one session, created on first use.
   *
   * @param sessionId - the session a model call belongs to.
   * @returns the feed, most recently used.
   */
  for(sessionId: string): SessionFeed {
    const existing = this.feeds.get(sessionId)
    if (existing !== undefined) {
      this.feeds.delete(sessionId)
      this.feeds.set(sessionId, existing)
      return existing
    }
    if (this.feeds.size >= this.capacity) {
      const oldest = this.feeds.keys().next()
      if (oldest.done !== true) {
        this.feeds.get(oldest.value)?.dispose()
        this.feeds.delete(oldest.value)
      }
    }
    const feed = new SessionFeed(sessionId, this.trackerOptions)
    this.feeds.set(sessionId, feed)
    return feed
  }

  /** The feed for a session, without creating one. */
  peek(sessionId: string): SessionFeed | undefined {
    return this.feeds.get(sessionId)
  }

  /** Every session this process has seen recently, most recent first. */
  sessions(): string[] {
    return [...this.feeds.keys()].reverse()
  }

  /** Drop everything. */
  dispose(): void {
    for (const feed of this.feeds.values()) feed.dispose()
    this.feeds.clear()
  }
}
