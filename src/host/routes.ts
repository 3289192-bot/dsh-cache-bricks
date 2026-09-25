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
import type { BrickFeed } from '../shared/brick'

/** The parts of `IncomingMessage` this router reads. */
export interface RouteRequestLike {
  readonly method?: string
  readonly url?: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly socket?: { readonly remoteAddress?: string }
}

/** The parts of `ServerResponse` this router uses. */
export interface RouteResponseLike {
  statusCode: number
  setHeader(name: string, value: string): unknown
  writeHead?(status: number, headers: Record<string, string>): unknown
  write?(chunk: string): unknown
  end(body?: string): unknown
  on?(event: string, listener: () => void): unknown
}

/** What the router needs from the collector. */
export interface RouterOptions {
  /**
   * Pathname the route is registered under. The router must slice exactly this,
   * or a configured base path silently breaks every sub-route.
   */
  readonly basePath?: string
  /**
   * The harness's own request policy (`ctx.connection.requestRejection`), which
   * applies host, origin and browser-authentication checks. Returning a status
   * refuses the request; returning undefined defers to the local fence.
   */
  readonly guard?: (request: RouteRequestLike) => number | undefined
}

/** What the router needs from the collector. */
export interface RouterDeps {
  /** Current feed for a session, or undefined when nothing was observed yet. */
  readonly feed: (sessionId: string) => BrickFeed | undefined
  /** Sessions with a ledger. */
  readonly sessions: () => readonly string[]
  /** One stored payload by ref, or undefined when it was evicted. */
  readonly blob: (ref: string) => unknown
  /** Subscribe to new bricks; returns an unsubscribe. */
  readonly subscribe: (sessionId: string, sink: (feed: BrickFeed) => void) => () => void
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * True when the peer is the local machine.
 *
 * An absent `remoteAddress` is **not** treated as local: this route serves whole
 * requests, tool arguments and model streams, so an unidentifiable peer is
 * refused rather than admitted. (With the harness fence in place this is only a
 * backstop — the official policy runs first.)
 */
function isLoopback(request: RouteRequestLike): boolean {
  const address = request.socket?.remoteAddress
  return address !== undefined && LOOPBACK.has(address)
}

/**
 * True when the request either carries no `Origin` (same-origin fetches from the
 * page, and non-browser clients) or carries one matching the `Host` it was sent
 * to. A cross-origin page cannot read the response either way without CORS, but
 * refusing outright keeps the data out of reach of a stray `<img>`/`<script>`.
 */
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
  const text = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(text)
}

/**
 * Build the route handler for the plugin's namespace.
 * @param deps - ledger access.
 * @returns a handler suitable for `webServer.register`, plus the path it serves.
 */
export function createCacheBricksRouter(deps: RouterDeps, options: RouterOptions = {}): {
  readonly path: string
  readonly handler: (request: RouteRequestLike, response: RouteResponseLike) => void
} {
  const path = options.basePath ?? '/cache-bricks'
  const handler = (request: RouteRequestLike, response: RouteResponseLike): void => {
    // The harness's policy first: it is the same one /api uses, so this route is
    // exactly as reachable as the rest of the GUI and no more.
    const rejection = options.guard?.(request)
    if (rejection !== undefined) {
      json(response, rejection, { error: rejection === 401 ? 'unauthenticated' : 'forbidden' })
      return
    }
    if (!isLoopback(request) || !isSameOrigin(request)) {
      json(response, 403, { error: 'forbidden' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(path.length)
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(response, 405, { error: 'method not allowed' })
      return
    }

    if (route === '/sessions') {
      json(response, 200, { sessions: deps.sessions() })
      return
    }

    if (route === '/attempts') {
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null) {
        json(response, 400, { error: 'sessionId is required' })
        return
      }
      const feed = deps.feed(sessionId)
      json(response, feed === undefined ? 404 : 200, feed ?? { error: 'no observations for this session yet' })
      return
    }

    if (route === '/blob') {
      const ref = url.searchParams.get('ref')
      if (ref === null) {
        json(response, 400, { error: 'ref is required' })
        return
      }
      const value = deps.blob(ref)
      if (value === undefined) {
        json(response, 404, { error: 'unknown or evicted ref' })
        return
      }
      json(response, 200, { ref, value })
      return
    }

    if (route === '/stream') {
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null) {
        json(response, 400, { error: 'sessionId is required' })
        return
      }
      response.writeHead?.(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      const send = (event: string, payload: unknown): void => {
        response.write?.(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
      }
      const current = deps.feed(sessionId)
      if (current !== undefined) send('feed', current)
      const unsubscribe = deps.subscribe(sessionId, (feed) => { send('feed', feed) })
      const heartbeat = setInterval(() => { response.write?.(': hb\n\n') }, 25_000)
      let closed = false
      const cleanup = (): void => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        unsubscribe()
      }
      response.on?.('close', cleanup)
      return
    }

    json(response, 404, { error: 'unknown route' })
  }
  return { path, handler }
}
