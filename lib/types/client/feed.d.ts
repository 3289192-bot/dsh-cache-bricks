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
import type { BrickFeed } from '../shared/cache-brick';
/** The route prefix the host half serves (`host/routes.ts`). */
export declare const BASE_PATH = "/cache-bricks";
/** How a feed client reports what it has. `undefined` means "no collector answering". */
export type FeedSink = (feed: BrickFeed | undefined) => void;
/** Injected browser APIs, so this module is unit-testable without a DOM. */
export interface FeedEnvironment {
    /** Base URI to resolve against; defaults to `document.baseURI`. */
    readonly baseUri?: string;
    readonly fetchImpl?: typeof fetch;
    /** `EventSource` constructor; `undefined` disables pushes and leaves the snapshot. */
    readonly eventSourceImpl?: typeof EventSource | undefined;
}
/**
 * Resolve a path against the document base, whatever the mount point is.
 * @param path - the plugin's own route, e.g. `/cache-bricks/bricks`.
 * @param baseUri - the page's base URI.
 * @returns an absolute URL string.
 */
export declare function documentRelative(path: string, baseUri: string): string;
/** A session the collector knows about, with nothing in it yet. */
export declare function emptyFeed(sessionId: string): BrickFeed;
/**
 * Follow one session.
 *
 * The snapshot is fetched first, so a board that opens mid-turn draws the bricks that already
 * exist; the stream then replaces the whole feed whenever a request settles. A torn frame costs
 * one repaint, never correctness: every push is the complete list.
 */
export declare class BrickFeedClient {
    private source;
    private stopped;
    private readonly environment;
    constructor(environment?: FeedEnvironment);
    /**
     * Start following a session.
     *
     * @param sessionId - the session the board belongs to.
     * @param sink - called with the bricks whenever they change.
     * @returns a function that stops following.
     */
    start(sessionId: string, sink: FeedSink): () => void;
    /** Read the current bricks once, so the first paint is not blank. */
    private snapshot;
}
