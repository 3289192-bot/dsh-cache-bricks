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
import type { BrickFeed, BrickRecord } from '../shared/brick';
/** What the client knows about the host feed. */
export type FeedState = 'idle' | 'connecting' | 'live' | 'unavailable';
/** Injected browser APIs, so the client can be unit-tested without a DOM. */
export interface FeedEnvironment {
    /** Base URI to resolve against; defaults to `document.baseURI`. */
    readonly baseUri?: string;
    readonly fetchImpl?: typeof fetch;
    /** `EventSource` constructor; `undefined` disables live updates. */
    readonly eventSourceImpl?: typeof EventSource | undefined;
}
/** Resolve a path against the document base, whatever the mount point is. */
export declare function documentRelative(path: string, baseUri: string): string;
/** One attempt removed of its blob refs, so the panel knows whether to fetch. */
export declare function hasRawPayloads(record: BrickRecord): boolean;
/** Subscribes to the collector and hands the board a feed whenever it changes. */
export declare class BrickFeedClient {
    private readonly environment;
    private source;
    private stopped;
    /** Latest state, so a late subscriber can paint immediately. */
    state: FeedState;
    /** Latest feed received, if any. */
    feed: BrickFeed | undefined;
    constructor(environment?: FeedEnvironment);
    /** The URL of one route, resolved for the current mount. */
    url(route: string): string;
    /**
     * Begin following a session.
     * @param sessionId - the session whose bricks to show.
     * @param onFeed - called with every feed received.
     * @returns a stop function.
     */
    start(sessionId: string, onFeed: (feed: BrickFeed) => void): () => void;
    /** Stop following, closing any stream. */
    stop(): void;
    /** One snapshot fetch; a failure marks the feed unavailable rather than throwing. */
    private fetchOnce;
    /** Live updates, when the browser and the host both support them. */
    private openStream;
    /** Fetch one stored payload by ref, or undefined when it was evicted. */
    blob(ref: string): Promise<unknown>;
}
