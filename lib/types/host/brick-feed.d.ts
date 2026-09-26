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
import type { BrickFeed } from '../shared/cache-brick';
import { AttemptTracker, type AttemptTrackerOptions } from './attempt-tracker';
/** Bricks kept per session. A few dozen bytes each, so this is well under a megabyte. */
export declare const DEFAULT_FEED_CAPACITY = 1024;
/** Sessions kept. A browser tab watches one; the rest are recent history. */
export declare const DEFAULT_SESSION_CAPACITY = 8;
/** What one session's ring hands out. */
export type FeedSink = (feed: BrickFeed) => void;
/**
 * One session's bricks, and the readers waiting on them.
 *
 * Publishing is coalesced by the collector, not here: this class only knows how to say "these
 * are the bricks now".
 */
export declare class SessionFeed {
    private readonly tracker;
    private readonly sessionId;
    private readonly sinks;
    constructor(sessionId: string, options?: AttemptTrackerOptions);
    /** The tracker this feed reads, so the collector can hand it observations. */
    get attempts(): AttemptTracker;
    /** The session's current bricks. */
    snapshot(): BrickFeed;
    /** Watch this feed. The returned function stops watching. */
    subscribe(sink: FeedSink): () => void;
    /** Number of live readers — the collector skips serializing when nobody is looking. */
    get listeners(): number;
    /** Hand every reader the current feed. */
    publish(): void;
    /** Drop every reader and every brick. */
    dispose(): void;
}
/** Every session's feed, with the least recently used dropped first. */
export declare class BrickFeeds {
    private readonly feeds;
    private readonly capacity;
    private readonly trackerOptions;
    constructor(options?: {
        sessions?: number;
        tracker?: AttemptTrackerOptions;
    });
    /**
     * The feed for one session, created on first use.
     *
     * @param sessionId - the session a model call belongs to.
     * @returns the feed, most recently used.
     */
    for(sessionId: string): SessionFeed;
    /** The feed for a session, without creating one. */
    peek(sessionId: string): SessionFeed | undefined;
    /** Every session this process has seen recently, most recent first. */
    sessions(): string[];
    /** Drop everything. */
    dispose(): void;
}
