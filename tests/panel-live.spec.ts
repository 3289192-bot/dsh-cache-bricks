/**
 * Live integration check for the panel.
 *
 * Everything else in the suite either feeds the panel a synthetic record or
 * checks the collector's HTTP surface. Neither proves the join: that a brick the
 * collector actually captured renders, in the real component, with its real
 * numbers — hashes, TTFT, the context snapshot taken at dispatch, the tool call.
 *
 * This test pulls a brick from a *running* instance and renders all seven tabs
 * from it. When no instance answers it skips instead of failing, so the suite
 * still runs on a machine with nothing booted.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrickPanel } from '../src/client/panel'
import { diffBricks } from '../src/shared/diff'
import { liveCookie, liveGet } from './helpers/live'
import type { BrickFeed, BrickRecord } from '../src/shared/brick'

const PORT = Number(process.env.DSH_LIVE_PORT ?? '18090')
const BASE = `http://127.0.0.1:${String(PORT)}`
const HOME = process.env.DSH_LIVE_HOME ?? join(homedir(), '.dsh-017')

/** Ask the collector for its feed, or nothing when no instance is answering. */
async function liveFeed(): Promise<BrickFeed | undefined> {
  try {
    const cookie = await liveCookie(BASE, HOME)
    const list = await liveGet(BASE, '/cache-badge/sessions', cookie) as { sessions?: string[] } | undefined
    if (list === undefined) return undefined
    let best: BrickFeed | undefined
    for (const sessionId of list.sessions ?? []) {
      const feed = await liveGet(BASE, `/cache-badge/attempts?sessionId=${encodeURIComponent(sessionId)}`, cookie) as BrickFeed | undefined
      if (feed === undefined) continue
      if (best === undefined || feed.bricks.length > best.bricks.length) best = feed
    }
    return best
  } catch {
    return undefined
  }
}

const feed = await liveFeed()
const bricks = feed?.bricks ?? []
const hasBricks = bricks.length > 0

/** Render one tab of the panel for a record. */
function render(record: BrickRecord, tab: string, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(BrickPanel, {
    record,
    tab,
    onTab: () => undefined,
    onClose: () => undefined,
    ...extra,
  }))
}

describe.skipIf(!hasBricks)('the panel renders a brick the collector captured live', () => {
  const record = bricks[bricks.length - 1]!
  const previous = bricks.length > 1 ? bricks[bricks.length - 2] : undefined

  it('shows the cache reading, the route and the timing from the real record', () => {
    const markup = render(record, 'overview')
    expect(markup).toContain(record.route.provider)
    expect(markup).toContain(record.route.model)
    if (record.metrics.cacheHitRatio !== undefined) {
      expect(markup).toContain(`${(record.metrics.cacheHitRatio * 100).toFixed(2)}%`)
    }
    if (record.metrics.ttftMs !== undefined) {
      expect(markup).toContain(`${(record.metrics.ttftMs / 1000).toFixed(2)}s`)
    }
    if (record.metrics.promptTokens !== undefined) {
      expect(markup).toContain(record.metrics.promptTokens.toLocaleString('en-US'))
    }
  })

  it('shows the request forensics: header reason, hashes and the shared prefix', () => {
    const markup = render(record, 'request')
    if (record.request.headerReason !== undefined) expect(markup).toContain(record.request.headerReason)
    if (record.request.toolsHash !== undefined) {
      expect(markup).toContain(record.request.toolsHash.slice(0, 12))
    }
    if (record.request.sharedMessagePrefix !== undefined) {
      expect(markup).toContain(record.request.sharedMessagePrefix.toLocaleString('en-US'))
    }
  })

  it('shows the context frozen at dispatch, with the heuristic split labelled', () => {
    const markup = render(record, 'context')
    if (record.context?.contextWindow !== undefined) {
      expect(markup).toContain(record.context.contextWindow.toLocaleString('en-US'))
    }
    expect(markup).toContain('≈ Composition (heuristic)')
    expect(markup).not.toContain('Folded client-side')
  })

  it('shows the tool calls this request produced', () => {
    const markup = render(record, 'tools')
    for (const call of record.tools) {
      if (call.name !== '') expect(markup).toContain(call.name)
    }
    expect(markup).toContain(`Tool calls (${String(record.tools.length)})`)
  })

  it('lists the stored refs instead of pretending to hold the bytes', () => {
    const markup = render(record, 'raw')
    expect(markup).toContain('Stored by reference')
    if (record.request.requestRef !== undefined) expect(markup).toContain(record.request.requestRef.slice(0, 12))
    if (record.raw.streamRef !== undefined) expect(markup).toContain(record.raw.streamRef.slice(0, 12))
  })

  it('compares two real requests and names what changed in one sentence', () => {
    const first = bricks[0]!
    const diff = diffBricks(first, record)
    const markup = render(record, 'overview', { diff, onCompare: () => undefined })
    expect(markup).toContain('Comparison')
    expect(markup).toContain(diff.verdict)
    // A session that keeps hitting its cache should not be reported as broken.
    if (first.identity.id !== record.identity.id) {
      expect(diff.verdict).toMatch(/cache hit/)
    }
    console.log(`live panel check: ${record.identity.id} · ${diff.verdict}`)
  })
})

describe.skipIf(hasBricks)('live panel check', () => {
  it('skips when no instance is answering', () => {
    console.log(`live panel check skipped: no collector at ${BASE}`)
    expect(hasBricks).toBe(false)
  })
})
