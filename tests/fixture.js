/**
 * Real DOM, real browser, mocked host: the board's fixture.
 *
 * The board is a body-level overlay that measures the conversation beside it, so there is no way
 * to check it without a layout. This fixture provides exactly two things: a transcript to sit
 * beside (`#scroll`, with one row so the gutter can be measured) and the plugin's own HTTP
 * surface, faked so a test can hand the board any feed it likes.
 *
 * It is deliberately small: a Lite brick has no refs to resolve, no stream to subscribe to beyond
 * one event name, and no second request to make.
 */
window.__fixture = { feeds: [], streams: [], registered: [], sessions: ['S'] }

/**
 * The module table the built client bundle registers into.
 *
 * The bundle is a classic script that calls `window.__ModuleLoader__.load({ factory })`; the
 * factory receives the shell's `require`, which here answers only the externals the harness would
 * have provided (React, its JSX runtime).
 */
window.__ModuleLoader__ = {
  load({ factory }) {
    window.__fixture.plugin = factory((id) => window.__testExternals[id])
  },
}

/** The bricks the fake collector is holding, newest last. */
window.__fixture.feed = { sessionId: 'S', bricks: [], dropped: 0, endedTurns: [], dispatched: 0 }

/** Serve the plugin's three routes. */
window.fetch = async (url) => {
  const parsed = new URL(url, document.baseURI)
  if (parsed.pathname.endsWith('/cache-bricks/bricks')) {
    const sessionId = parsed.searchParams.get('sessionId')
    if (sessionId !== 'S') return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => window.__fixture.feed }
  }
  return { ok: false, status: 404, json: async () => ({}) }
}

/** One SSE stream per board, so a test can push a feed the way a settlement would. */
window.EventSource = class {
  constructor(url) {
    this.url = url
    this.handlers = {}
    window.__fixture.streams.push(this)
  }

  addEventListener(type, handler) {
    ;(this.handlers[type] ??= []).push(handler)
  }

  close() {}
}

/** Push a feed to every open stream: what the collector does on a settlement. */
window.__fixture.push = (feed) => {
  window.__fixture.feed = feed
  for (const stream of window.__fixture.streams) {
    for (const handler of stream.handlers.bricks ?? []) handler({ data: JSON.stringify(feed) })
  }
}

/** One brick, with the numbers a board draws. */
window.__fixture.brick = (turn, step, tone, attempt = 0) => ({
  id: `S:${turn}:${step}:${attempt}`,
  turn,
  step,
  attempt,
  inputTokens: tone === 'good' ? 10 : tone === 'bad' ? 900 : 0,
  cacheReadTokens: tone === 'good' ? 990 : tone === 'bad' ? 100 : 0,
  cacheWriteTokens: 0,
  hitRatio: tone === 'unknown' ? null : tone === 'good' ? 0.99 : 0.1,
  startedAt: step * 100,
  finishedAt: step * 100 + 50,
  tone,
})

/** Build the plugin context the client half expects, and mount the seat it registers. */
window.__fixture.start = () => {
  const jsx = window.__testExternals['react/jsx-runtime'].jsx
  const ctx = {
    slots: {
      inject(name, callback) {
        window.__fixture.slots = name
        callback()
        return () => {}
      },
      register(options, Component) {
        window.__fixture.registered.push(options.id)
        window.__fixture.Component = Component
        return () => {}
      },
    },
    effect() {},
    get() { return undefined },
  }
  window.__fixture.plugin.apply(ctx)
  window.__fixture.root = window.__ReactDOM.createRoot(document.querySelector('#dock'))
  window.__fixture.render = (sessionId) => {
    window.__fixture.root.render(jsx(window.__fixture.Component, { sessionId }))
  }
  window.__fixture.render('S')
}
