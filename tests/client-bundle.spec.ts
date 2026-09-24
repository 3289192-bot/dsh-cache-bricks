/**
 * Artifact-level test: the BUILT client bundle is what the host serves and the
 * browser materializes, so this suite executes `lib/client.js` exactly as the
 * module loader does — through `window.__ModuleLoader__.load({id, factory})` —
 * then drives the registered Definition over synthetic session events and
 * renders the seat the brick board is mounted in.
 *
 * It fails if the bundle stops being self-contained (an unexpected module
 * request beyond the shell's `react` table entries), stops registering under the
 * served id, publishes its node visible (which would drop it back into the
 * conversation and its fold), or renders panel markup into the seat instead of
 * leaving that to the floating card. Run `pnpm run build` first.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { brickKey } from '../src/client/tetris'

const require = createRequire(import.meta.url)

/** The bundle the host serves: `exports["./client"]` of this package. */
const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

interface SlotRegistration {
  readonly name: string
  readonly key?: string
  readonly id?: string
  readonly order?: number
}

interface LoadedBundle {
  readonly id: string
  readonly exports: { apply: (ctx: unknown) => void; inject: string[] }
  readonly definition: any
  readonly seat: (props: { useChat?: unknown }) => unknown
  readonly slots: readonly SlotRegistration[]
  readonly injected: readonly string[]
  readonly requested: string[]
}

/** Execute the built bundle through the module loader and apply the plugin. */
function loadBundle(): LoadedBundle {
  const registrations: { id: string; factory: (require: (spec: string) => unknown) => any }[] = []
  const requested: string[] = []
  const definitions: any[] = []
  const slots: SlotRegistration[] = []
  const injected: string[] = []
  let seat: any

  const scope = { window: { __ModuleLoader__: { load: (def: any) => registrations.push(def) } } }
  // The bundle is a classic script that talks to the loader facade on `window`.
  new Function('window', readFileSync(BUNDLE, 'utf8'))(scope.window)

  expect(registrations).toHaveLength(1)
  const registration = registrations[0]!
  expect(registration.id).toBe('dsh-cache-badge')

  const exports = registration.factory((spec: string) => {
    requested.push(spec)
    // The module table is the shell's; anything outside it would throw in the
    // browser, so an unexpected specifier must fail this test. `react` and
    // `react/jsx-runtime` are both in the shell's module table; the JSX runtime is
    // what the compiled panel asks for.
    if (spec === 'react') return require('react')
    if (spec === 'react/jsx-runtime') return require('react/jsx-runtime')
    throw new Error(`client bundle requested a module outside the shell table: ${spec}`)
  })

  exports.apply({
    slots: {
      inject: (name: string, callback: () => void) => {
        injected.push(name)
        callback()
      },
      register: (options: SlotRegistration, component: unknown) => {
        slots.push(options)
        if (options.name === 'conversation.composer.dock') seat = component
        return () => {}
      },
    },
    get: (name: string) => (name === 'uiConversation'
      ? { events: { register: (definition: unknown) => {
        definitions.push(definition)
        return () => {}
      } } }
      : undefined),
    effect: (callback: () => unknown) => callback(),
  })

  expect(definitions).toHaveLength(1)
  expect(typeof seat).toBe('function')
  return { id: registration.id, exports, definition: definitions[0], seat, slots, injected, requested }
}

/** One assistant step's events, expressed as session events. */
function stepEvents(
  turn: number,
  step: number,
  usage: unknown,
  provider: string | undefined,
  seq: number,
): any[] {
  const events: any[] = [
    { type: 'step/start', seq, time: 1000 + seq * 10, data: { turn, step } },
    { type: 'assistant/chunk', seq: seq + 1, time: 1000 + (seq + 1) * 10, data: { turn, step, chunk: { type: 'text-delta', text: 'hi' } } },
    { type: 'assistant/chunk', seq: seq + 2, time: 1000 + (seq + 2) * 10, data: { turn, step, chunk: { type: 'usage', usage } } },
  ]
  if (provider !== undefined) {
    events.push({
      type: 'assistant/message',
      seq: seq + 3,
      time: 1000 + (seq + 3) * 10,
      data: { turn, step, message: { source: { provider } }, usage },
    })
  }
  return events
}

/** Drive one whole Turn through the real Definition and publish its node. */
function turnNode(bundle: LoadedBundle, steps: { usage: unknown; provider?: string }[], turn = 1): any {
  const events: any[] = [{ type: 'turn/start', seq: 1, time: 1000, data: { turn } }]
  steps.forEach((entry, index) => {
    events.push(...stepEvents(turn, index + 1, entry.usage, entry.provider, 10 * (index + 1)))
  })
  events.push({ type: 'turn/end', seq: 900, time: 9000, data: { turn } })

  const definition = bundle.definition
  const [first, ...rest] = events
  let state = definition.start({ state: undefined } as any, { event: first } as any)
  const matches: any[] = [{ event: first, location: { kind: 'turn', turn: { turn } } }]
  for (const event of rest) {
    state = definition.update({ state } as any, { event } as any)
    matches.push({ event, location: { kind: 'turn', turn: { turn } } })
  }
  return definition.buildViewNode({
    key: 'k', id: `turn:${turn}`, kind: 'cache-badge', target: 'chat', state, matches,
    start: { event: first, role: 'start', location: { kind: 'turn', turn: { turn } } },
  } as any)
}

describe('built client bundle', () => {
  let bundle: LoadedBundle

  beforeAll(() => {
    bundle = loadBundle()
  })

  it('registers itself under the served id and asks only for baseline modules', () => {
    expect(bundle.id).toBe('dsh-cache-badge')
    expect(bundle.exports.inject).toEqual(['slots'])
    // `react` and the JSX runtime, both from the shell's module table, and
    // nothing else: a cross-plugin value import would show up here.
    expect([...new Set(bundle.requested)].sort()).toEqual(['react', 'react/jsx-runtime'])
  })

  it('publishes its reading hidden, so the transcript never routes or folds it', () => {
    const node = turnNode(bundle, [{ usage: { inputTokens: 1200, cacheReadTokens: 150_000 }, provider: 'deepseek-official' }])
    expect(node.visibility).toBe('hidden')
    expect(node.data.turn).toBe(1)
  })

  it('takes one session seat for the board controller and nothing else', () => {
    expect(bundle.injected).toContain('conversation.chat.node')
    expect(bundle.slots).toEqual([
      { name: 'conversation.composer.dock', id: 'cache-badge', order: 1 },
    ])
  })

  it('renders nothing into the seat: the bricks are an overlay, not a row', () => {
    const node = turnNode(bundle, [{ usage: { inputTokens: 1200, cacheReadTokens: 150_000 }, provider: 'deepseek-official' }])
    const useChat = (selector: (snapshot: unknown) => unknown) => selector({ nodes: { values: () => [node] } })
    // SSR runs no effects, so the board is never created here; the point is that
    // the seat itself contributes no markup to the composer area.
    expect(renderToStaticMarkup(createElement(bundle.seat as any, { useChat }))).toBe('')
    expect(renderToStaticMarkup(createElement(bundle.seat as any, {}))).toBe('')
  })

  it('carries one brick per step, in step order', () => {
    const node = turnNode(bundle, [
      { usage: { inputTokens: 1200, cacheReadTokens: 150_000 }, provider: 'deepseek-official' },
      { usage: { inputTokens: 91_300, cacheReadTokens: 8700 }, provider: 'deepseek-official' },
    ])
    expect(node.data.steps.map((sample: any) => sample.step)).toEqual([1, 2])
    expect(brickKey(node.data.turn, 2)).toBe('1:2')
  })

  it('reads an omitted cache field as a full rebuild for a provider that has shown one', () => {
    const node = turnNode(bundle, [
      { usage: { inputTokens: 1200, cacheReadTokens: 150_000 }, provider: 'deepseek-official' },
      { usage: { inputTokens: 182_000 }, provider: 'deepseek-official' },
    ])
    expect(node.data.steps[1].usage).toEqual({ inputTokens: 182_000 })
  })

  it('publishes an empty — never withdrawn — node before the Turn reports any usage', () => {
    // The artifact contract, not just the source one: the assembler refuses a rebuild that
    // turns a materialized node into null, and losing that rebuild loses the history page
    // that triggered it. A turn with nothing measured yet is published with no steps.
    const node = turnNode(bundle, [])
    expect(node).not.toBeNull()
    expect(node.data.steps).toEqual([])
    expect(node.visibility).toBe('hidden')
  })
})
