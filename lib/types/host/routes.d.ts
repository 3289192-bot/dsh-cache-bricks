/**
 * The plugin's HTTP surface: three routes, all of them about bricks.
 *
 * | route | answers |
 * |---|---|
 * | `GET /cache-bricks/sessions` | which sessions this process has seen recently |
 * | `GET /cache-bricks/bricks?sessionId=…` | the session's bricks, as one flat payload |
 * | `GET /cache-bricks/stream?sessionId=…` | the same payload, pushed on every settlement (SSE) |
 *
 * There is no `/blob`, and that is the point of this version: a brick carries its own numbers, so
 * there is nothing to fetch afterwards and nothing on this surface worth protecting more than the
 * GUI itself. The guard is still applied — the harness's own request policy first, then a
 * loopback and same-origin check as a backstop.
 */
/** The request fields this router reads. */
export interface RouteRequestLike {
    readonly url?: string | undefined;
    readonly method?: string | undefined;
    readonly headers: Record<string, string | undefined>;
    readonly socket?: {
        readonly remoteAddress?: string | undefined;
    } | undefined;
}
/** The response fields this router writes. */
export interface RouteResponseLike {
    statusCode: number;
    setHeader(name: string, value: string): void;
    writeHead?(status: number, headers: Record<string, string>): void;
    write?(chunk: string): void;
    end(body?: string): void;
}
/** What the router serves, injected so it can be tested without a collector. */
export interface RouterDeps {
    readonly bricks: (sessionId: string) => unknown;
    readonly sessions: () => readonly string[];
    readonly subscribe: (sessionId: string, sink: (feed: unknown) => void) => () => void;
    /**
     * A browser asked about this session.
     *
     * Separate from `bricks` on purpose: reading a session's log is a decision with a cost, and only
     * the route knows whether the caller is a reader looking at the board or a probe.
     */
    readonly looked?: (sessionId: string) => void;
}
/** Options for {@link createBrickRouter}. */
export interface RouterOptions {
    /** Route prefix; defaults to `/cache-bricks`. */
    readonly basePath?: string;
    /** The harness's request policy, when the host context can supply it. */
    readonly guard?: (request: RouteRequestLike) => number | undefined;
}
/** The handler pair a web server registers. */
export interface BricksRouter {
    readonly path: string;
    readonly handler: (request: RouteRequestLike, response: RouteResponseLike) => void;
}
/**
 * Build the route handler for the plugin's namespace.
 * @param deps - brick access.
 * @param options - prefix and guard.
 * @returns a handler suitable for `webServer.register`, plus the path it serves.
 */
export declare function createBrickRouter(deps: RouterDeps, options?: RouterOptions): BricksRouter;
