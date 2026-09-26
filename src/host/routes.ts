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
  readonly url?: string | undefined
  readonly method?: string | undefined
  readonly headers: Record<string, string | undefined>
  readonly socket?: { readonly remoteAddress?: string | undefined } | undefined
}

/** The response fields this router writes. */
export interface RouteResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  writeHead?(status: number, headers: Record<string, string>): void
  write?(chunk: string): void
  end(body?: string): void
}

/** What the router serves, injected so it can be tested without a collector. */
export interface RouterDeps {
  readonly bricks: (sessionId: string) => unknown
  readonly sessions: () => readonly string[]
  readonly subscribe: (sessionId: string, sink: (feed: unknown) => void) => () => void
  /**
   * A browser asked about this session.
   *
   * Separate from `bricks` on purpose: reading a session's log is a decision with a cost, and only
   * the route knows whether the caller is a reader looking at the board or a probe.
   */
  readonly looked?: (sessionId: string) => void
}

/** Options for {@link createBrickRouter}. */
export interface RouterOptions {
  /** Route prefix; defaults to `/cache-bricks`. */
  readonly basePath?: string
  /** The harness's request policy, when the host context can supply it. */
  readonly guard?: (request: RouteRequestLike) => number | undefined
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * True when the peer is this machine.
 *
 * An absent `remoteAddress` is **not** treated as local: an unidentifiable peer is refused rather
 * than admitted, because the answer would otherwise be a session's activity on an unknown
 * connection.
 */
function isLoopback(request: RouteRequestLike): boolean {
  const address = request.socket?.remoteAddress
  return address !== undefined && LOOPBACK.has(address)
}

/** True when the request either carries no `Origin` or one matching the `Host` it reached. */
function isSameOrigin(request: RouteRequestLike): boolean {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = request.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** JSON response helper. */
function json(response: RouteResponseLike, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

/** The handler pair a web server registers. */
export interface BricksRouter {
  readonly path: string
  readonly handler: (request: RouteRequestLike, response: RouteResponseLike) => void
}

/**
 * Build the route handler for the plugin's namespace.
 * @param deps - brick access.
 * @param options - prefix and guard.
 * @returns a handler suitable for `webServer.register`, plus the path it serves.
 */
export function createBrickRouter(deps: RouterDeps, options: RouterOptions = {}): BricksRouter {
  const path = options.basePath ?? '/cache-bricks'
  const handler = (request: RouteRequestLike, response: RouteResponseLike): void => {
    const rejection = options.guard?.(request)
    if (rejection !== undefined) {
      json(response, rejection, { error: rejection === 401 ? 'unauthenticated' : 'forbidden' })
      return
    }
    if (!isLoopback(request) || !isSameOrigin(request)) {
      json(response, 403, { error: 'forbidden' })
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(path.length)

    if (route === '/sessions') {
      json(response, 200, { sessions: deps.sessions() })
      return
    }

    const sessionId = url.searchParams.get('sessionId')
    if (route === '/bricks' || route === '/stream') {
      if (sessionId === null) {
        json(response, 400, { error: 'sessionId is required' })
        return
      }
      deps.looked?.(sessionId)
    }
    if (route === '/bricks') {
      const payload = deps.bricks(sessionId!)
      json(response, payload === undefined ? 404 : 200, payload ?? { error: 'this session has no bricks yet' })
      return
    }

    if (route === '/stream') {
      response.writeHead?.(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      const send = (event: string, payload: unknown): void => {
        response.write?.(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
      }
      // The snapshot first, so a board that opens mid-turn draws what already exists instead of
      // waiting for the next settlement.
      const current = deps.bricks(sessionId!)
      if (current !== undefined) send('bricks', current)
      const unsubscribe = deps.subscribe(sessionId!, (feed) => { send('bricks', feed) })
      const heartbeat = setInterval(() => { response.write?.(': hb\n\n') }, 25_000)
      const close = (): void => {
        clearInterval(heartbeat)
        unsubscribe()
      }
      // Node's response emits `close` when the client goes away, for an SSE stream or a reload.
      ;(response as { on?: (event: string, listener: () => void) => void }).on?.('close', close)
      return
    }

    json(response, 404, { error: 'not found' })
  }
  return { path, handler }
}
