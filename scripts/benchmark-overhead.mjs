/**
 * What the plugin costs, measured the same way for every line.
 *
 * Three builds answer the same workload: `v0.1.3` (the public stable), `release/0.1.4` (the full
 * line: scene replay, paging, blob store) and `lite` (this one). The question is not which is
 * nicer but what each one *does* per model call, so the workload is the harness's own shape:
 *
 *   dispatch (`llm/stream`) → `start` frame → D token-level deltas → `usage` chunk → `end` frame
 *   → settlement (`assistant/message` with usage and a compact stream) → `turn/end`
 *
 * and what is measured is what a reader would feel:
 *
 * - **µs per delta** — the cost that multiplies by a thousand in one long answer;
 * - **µs per request** — the fixed cost of one settled call;
 * - **retained heap** — what the process holds for a session of N requests;
 * - **feed bytes** — how much the host serializes per update for the browser;
 * - **artifact size** — what ships.
 *
 * Each build is loaded from its own `lib/index.js` in its own child process (memory has to be
 * measured without the other builds' state), driven by a fake Cordis context that records the taps
 * and answers the plugin's own route.
 *
 * Usage:
 *   node scripts/benchmark-overhead.mjs                       # every build it can find
 *   node scripts/benchmark-overhead.mjs --build <path>        # one package dir
 *   node scripts/benchmark-overhead.mjs --requests 240 --deltas 300
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

/** The builds to compare: this one, plus the two lines a reader could have installed. */
const DEFAULT_BUILDS = [
  { label: 'no plugin (baseline)', path: 'baseline' },
  { label: '0.1.4 lite', path: root },
  { label: '0.1.4 full/scene', path: process.env.DSH_FULL_BUILD ?? resolve(root, '..', '..', 'bench', 'full') },
  { label: '0.1.3 stable', path: process.env.DSH_STABLE_BUILD ?? resolve(root, '..', '..', 'bench', 'v013') },
]

// ── the child: one build, one workload, one JSON line ────────────────────────────────────
if (args.includes('--child')) {
  const requested = option('build', root)
  const isBaseline = requested === 'baseline'
  const build = isBaseline ? 'baseline' : resolve(requested)
  const turns = Number(option('turns', '40'))
  const steps = Number(option('steps', '6'))
  const deltas = Number(option('deltas', '300'))
  const streamRecords = Number(option('stream', '20'))

  const baseline = isBaseline
  const pkg = baseline
    ? { name: 'no plugin', version: '-' }
    : JSON.parse(readFileSync(join(build, 'package.json'), 'utf8'))

  /** A host context that records the taps, answers `webServer`, and counts publishes. */
  function makeHost() {
    const listeners = new Map()
    const routes = []
    const services = new Map()
    const context = {
      routes,
      publishes: 0,
      on(event, listener) {
        const list = listeners.get(event) ?? []
        list.push(listener)
        listeners.set(event, list)
      },
      get: (key) => services.get(key),
      inject(names, callback) {
        callback({
          on: () => undefined,
          get: (key) => (key === 'webServer'
            ? {
              register: (route) => {
                routes.push(route)
                return () => {}
              },
            }
            : undefined),
          inject: () => undefined,
          effect: (callback) => { callback() },
        })
      },
      effect: (callback) => { callback() },
      emit(event, ...rest) {
        for (const listener of listeners.get(event) ?? []) listener(...rest)
      },
    }
    return context
  }

  const host = makeHost()
  if (!baseline) {
    // The `apply` of a build is what installs the taps; the baseline runs the identical workload
    // with nothing listening, so the harness's own cost can be subtracted from every measurement.
    const { apply } = await import(pathToFileURL(join(build, 'lib/index.js')).href)
    apply(host, {
      // No line should read a session log during a throughput measurement.
      backfill: false,
      logsRoots: [join(build, 'does-not-exist')],
    })
  }

  // A browser is watching: without a subscriber, every line is allowed to skip its publish work.
  const route = baseline ? undefined : host.routes.find((entry) => entry.path === '/cache-bricks')
  const call = (url) => {
    if (route === undefined) return { status: 0, body: '' }
    let body = ''
    let status = 0
    route.handler(
      { url, method: 'GET', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } },
      {
        set statusCode(value) { status = value },
        get statusCode() { return status },
        setHeader() {},
        write() {},
        end(chunk) { body += chunk ?? '' },
      },
    )
    return { status, body }
  }

  /**
   * The compact stream a settled attempt carries.
   *
   * Every request's stream is its own — the text differs per step — because a store that
   * deduplicates identical payloads would otherwise hide exactly the cost being measured. This is
   * also what a real session looks like: no two answers are the same bytes.
   */
  const compactStreamFor = (turn, step) => [
    { type: 'chunk', time: 1_000, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    {
      type: 'text-chunks',
      time0: 1_001,
      index: 0,
      dt: Array.from({ length: streamRecords }, () => 5),
      texts: Array.from({ length: streamRecords }, (_, index) => `token ${String(turn)}:${String(step)}:${String(index)} `),
    },
    { type: 'chunk', time: 1_900, chunk: { type: 'block-end', index: 0 } },
  ]

  const sessionId = 'bench'
  const total = turns * steps
  const started = process.hrtime.bigint()
  let deltaNs = 0n
  let requestNs = 0n

  for (let turn = 1; turn <= turns; turn += 1) {
    for (let step = 1; step <= steps; step += 1) {
      // The dispatch: a real request, with the payload the loop would send.
      const dispatchAt = process.hrtime.bigint()
      host.emit('llm/stream', { sessionId, provider: 'bench', model: 'bench', messages: [] }, () => ({ stream: true }))
      host.emit('agent/assistant-stream', {
        agent: { session: { id: sessionId } },
        frame: { type: 'start', turn, step, attemptId: `a${String(turn)}-${String(step)}`, time: Date.now() },
      })
      const deltaStart = process.hrtime.bigint()
      for (let index = 0; index < deltas; index += 1) {
        host.emit('agent/assistant-stream', {
          agent: { session: { id: sessionId } },
          frame: { type: 'chunk', time: Date.now(), chunk: { type: 'text-delta', text: 'token ' } },
        })
      }
      deltaNs += process.hrtime.bigint() - deltaStart
      host.emit('agent/assistant-stream', {
        agent: { session: { id: sessionId } },
        frame: { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 200, cacheReadTokens: 1_800, outputTokens: 40 } } },
      })
      host.emit('agent/assistant-stream', {
        agent: { session: { id: sessionId } },
        frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: turn * 1_000 + step } },
      })
      // The settlement: what the provider billed, plus the compact stream the log would keep.
      host.emit('session/event', { id: sessionId }, {
        type: 'assistant/message',
        time: Date.now(),
        data: {
          turn,
          step,
          message: { role: 'assistant' },
          stream: compactStreamFor(turn, step),
          usage: { inputTokens: 200, cacheReadTokens: 1_800, outputTokens: 40 },
        },
      })
      requestNs += process.hrtime.bigint() - dispatchAt
    }
    host.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn } })
  }
  const totalMs = Number(process.hrtime.bigint() - started) / 1e6

  // What the browser is sent, once, with the session full.
  const bricksRoute = call(`/cache-bricks/bricks?sessionId=${sessionId}`)
  const attemptsRoute = call(`/cache-bricks/attempts?sessionId=${sessionId}`)
  const feed = bricksRoute.status === 200 ? bricksRoute : attemptsRoute
  const feedBytes = baseline ? 0 : feed.body.length
  const feedBricks = (() => {
    if (baseline) return 0
    try {
      const parsed = JSON.parse(feed.body)
      return (parsed.bricks ?? []).length
    } catch {
      return 0
    }
  })()

  // Retained heap for this session, measured after a collection when the runtime allows one.
  const heap = (() => {
    const before = process.memoryUsage().heapUsed
    globalThis.gc?.()
    return (process.memoryUsage().heapUsed - before) / (1024 * 1024)
  })()
  const usage = process.memoryUsage()

  console.log(JSON.stringify({
    label: option('label', pkg.name),
    version: pkg.version,
    build: baseline ? '-' : build,
    requests: total,
    deltas: total * deltas,
    totalMs,
    perDeltaUs: Number(deltaNs) / 1e3 / (total * deltas),
    perRequestMs: Number(requestNs) / 1e6 / total,
    feedBytes,
    feedBricks,
    heapBytes: usage.heapUsed,
    rssBytes: usage.rss,
    heapDeltaMb: heap,
    clientBytes: baseline ? 0 : statSync(join(build, 'lib/client.js')).size,
    hostBytes: baseline ? 0 : statSync(join(build, 'lib/index.js')).size,
    routes: host.routes.map((entry) => entry.path),
  }))
  process.exit(0)
}

// ── the driver ──────────────────────────────────────────────────────────────────────────
const builds = (() => {
  const explicit = option('build', undefined)
  if (explicit !== undefined) return [{ label: option('label', explicit), path: resolve(explicit) }]
  // The baseline entry has no package behind it: it is the workload with nothing installed.
  return DEFAULT_BUILDS.filter((entry) => entry.path === 'baseline' || existsSync(join(entry.path, 'lib/index.js')))
})()

if (builds.length === 0) {
  console.error('no build found; pass --build <package dir>')
  process.exit(1)
}

/**
 * Run one build `repeat` times and keep the median of each measurement.
 *
 * The machine this is measured on is also running the harness, the agent and the plugin itself, so
 * a single run varies by a factor of two. A median of three is not a benchmark lab; it is enough to
 * stop a busy desktop from writing the conclusion.
 */
function measure(build, repeat) {
  const runs = []
  for (let attempt = 0; attempt < repeat; attempt += 1) {
    const result = spawnSync(process.execPath, [
      '--expose-gc',
      fileURLToPath(import.meta.url),
      '--child',
      '--build', build.path,
      '--label', build.label,
      '--turns', option('turns', '40'),
      '--steps', option('steps', '6'),
      '--deltas', option('deltas', '300'),
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const line = (result.stdout ?? '').trim().split('\n').at(-1) ?? ''
    try {
      runs.push(JSON.parse(line))
    } catch {
      // A run that produced nothing is simply not counted.
    }
  }
  if (runs.length === 0) return undefined
  const median = (pick) => {
    const values = runs.map(pick).sort((left, right) => left - right)
    return values[Math.floor(values.length / 2)]
  }
  return {
    ...runs[0],
    perDeltaUs: median((run) => run.perDeltaUs),
    perRequestMs: median((run) => run.perRequestMs),
    heapBytes: median((run) => run.heapBytes),
    runs: runs.length,
  }
}

const repeat = Number(option('repeat', '3'))
const rows = []
for (const build of builds) {
  const row = measure(build, repeat)
  if (row === undefined) {
    console.error(`${build.label}: no result (see the child's stderr)`)
    continue
  }
  rows.push(row)
}

const pad = (value, width) => String(value).padStart(width)
const floor = rows.find((row) => row.label.startsWith('no plugin'))
const pad2 = (value, width) => String(value).padStart(width)
console.log(`\n${String(rows[0]?.requests ?? 0)} settled requests · ${String(rows[0]?.deltas ?? 0)} token deltas each run`)
if (floor !== undefined) {
  console.log(`baseline (no plugin): ${floor.perDeltaUs.toFixed(3)} µs/delta · ${floor.perRequestMs.toFixed(3)} ms/request — subtracted below`)
  console.log(`medians of ${String(repeat)} runs each, on a machine that is also running the harness\n`)
}
console.log(`${'build'.padEnd(20)}${pad2('client', 9)}${pad2('host', 9)}${pad2('µs/delta', 10)}${pad2('marginal', 10)}${pad2('ms/req', 8)}${pad2('feed B', 9)}${pad2('heap MB', 9)}`)
for (const row of rows) {
  const marginal = floor === undefined ? undefined : row.perDeltaUs - floor.perDeltaUs
  console.log(
    `${String(row.label).padEnd(20)}`
    + pad2(row.clientBytes === 0 ? '-' : `${(row.clientBytes / 1024).toFixed(1)}k`, 9)
    + pad2(row.hostBytes === 0 ? '-' : `${(row.hostBytes / 1024).toFixed(1)}k`, 9)
    + pad2(row.perDeltaUs.toFixed(3), 10)
    + pad2(marginal === undefined ? '-' : marginal.toFixed(3), 10)
    + pad2(row.perRequestMs.toFixed(3), 8)
    + pad2(row.feedBytes === 0 ? '-' : row.feedBytes, 9)
    + pad2((row.heapBytes / 1048576).toFixed(1), 9),
  )
}
console.log('')
