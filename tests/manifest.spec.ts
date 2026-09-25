import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The manifest is the only part of this plugin the host reads before the browser
 * ever runs, and a mistake there fails quietly: a missing slot declaration made a
 * sibling plugin's entry never activate (dsh-cache-hit-decimal 0.2.1 changelog),
 * and a wrong bundle patch means the row is never inserted at all. These
 * assertions pin the facts the host and the client graph depend on.
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as any

describe('package manifest', () => {
  it('ships a bundle patch that inserts this plugin by its own package name', () => {
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    const patch = readFileSync(`${root}/cordis.patch.yml`, 'utf8')
    expect(patch).toContain('- id: cache-bricks')
    expect(patch).toContain(`name: '${pkg.name}'`)
  })

  it('declares a web client with a served client entry', () => {
    expect(pkg.dsh.client.platform).toBe('web')
    expect(pkg.exports['./client']).toBeTruthy()
  })

  it('injects the packages that declare what this entry consumes', () => {
    // ui-conversation declares `conversation.composer.dock`; ui-chat merges
    // `useChat` into SessionStandardProps. Unnamed, the graph may materialize
    // this row first: the entry would either throw on an undeclared slot or
    // render nothing, both silently.
    expect(pkg.dsh.client.inject).toEqual([
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-chat',
    ])
  })

  it('survives a composition that lacks those rows', () => {
    // Both loaders skip an inject name that has no graph row (`if (dependency
    // !== void 0)`) — dsh-client-modules 0.1.6 and 0.1.7 — so the declaration
    // orders the graph, it never becomes a hard dependency.
    for (const name of pkg.dsh.client.inject as string[]) {
      expect(name.startsWith('@deepseek-ai/')).toBe(true)
    }
  })

  it('keeps the host half free of runtime dependencies on DSH internals', () => {
    const host = readFileSync(`${root}/lib/index.js`, 'utf8')
    // The host half now installs the collector, but it must still speak to the
    // runtime only through structural types: a real import of a DSH package would
    // tie the plugin to one runtime line and could drag host code into the
    // model-call path.
    expect(host).toContain('installCollector')
    expect(host).not.toMatch(/from\s*['"]@deepseek-ai\//)
    expect(host).not.toMatch(/require\(['"]@deepseek-ai\//)
  })

  it('does not add a tool, a prompt section or a request rewrite', () => {
    const host = readFileSync(`${root}/lib/index.js`, 'utf8')
    // The only interaction with the model-call path is the llm/stream observer,
    // which returns next() untouched (behaviourally pinned in collect.spec.ts).
    // Nothing here may register a tool or append to the session.
    // A tool registration, a prompt section, or a log append are the three ways
    // a host plugin can change what the model sees.
    expect(host).not.toContain('ctx.tools')
    expect(host).not.toContain('registerTool')
    expect(host).not.toContain('system-prompt')
    expect(host).not.toContain('.append(')
  })
})
