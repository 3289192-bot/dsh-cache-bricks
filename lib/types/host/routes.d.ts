/**
 * The HTTP surface the browser half talks to.
 *
 * Deliberately not under `/api`: an exact route below `/api` shadows the
 * framework's authenticated prefix route, and the installed plugins that do this
 * (`dsh-reveal-files`) then have to be trusted to check auth themselves. Instead
 * this namespace carries its own, narrow guard — loopback peer plus same-origin —
 * and serves read-only JSON. Nothing here can reach the model: it reads a ledger.
 *
 * Written against structural request/response shapes so it can be unit-tested
 * with two small fakes instead of a live server.
 */
import type { BrickFeed } from '../shared/brick';
/** The parts of `IncomingMessage` this router reads. */
export interface RouteRequestLike {
    readonly method?: string;
    readonly url?: string;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly socket?: {
        readonly remoteAddress?: string;
    };
}
/** The parts of `ServerResponse` this router uses. */
export interface RouteResponseLike {
    statusCode: number;
    setHeader(name: string, value: string): unknown;
    writeHead?(status: number, headers: Record<string, string>): unknown;
    write?(chunk: string): unknown;
    end(body?: string): unknown;
    on?(event: string, listener: () => void): unknown;
}
/** What the router needs from the collector. */
export interface RouterOptions {
    /**
     * Pathname the route is registered under. The router must slice exactly this,
     * or a configured base path silently breaks every sub-route.
     */
    readonly basePath?: string;
    /**
     * The harness's own request policy (`ctx.connection.requestRejection`), which
     * applies host, origin and browser-authentication checks. Returning a status
     * refuses the request; returning undefined defers to the local fence.
     */
    readonly guard?: (request: RouteRequestLike) => number | undefined;
}
/** What the router needs from the collector. */
export interface RouterDeps {
    /** Current feed for a session, or undefined when nothing was observed yet. */
    readonly feed: (sessionId: string) => BrickFeed | undefined;
    /** Sessions with a ledger. */
    readonly sessions: () => readonly string[];
    /** One stored payload by ref, or undefined when it was evicted. */
    readonly blob: (ref: string) => unknown;
    /** Subscribe to new bricks; returns an unsubscribe. */
    readonly subscribe: (sessionId: string, sink: (feed: BrickFeed) => void) => () => void;
}
/**
 * Build the route handler for the plugin's namespace.
 * @param deps - ledger access.
 * @returns a handler suitable for `webServer.register`, plus the path it serves.
 */
export declare function createCacheBricksRouter(deps: RouterDeps, options?: RouterOptions): {
    readonly path: string;
    readonly handler: (request: RouteRequestLike, response: RouteResponseLike) => void;
};
