/**
 * What the collector costs per model request, measured on a real one.
 *
 * Skipped unless `DSH_BENCH=1`, so the ordinary suite stays fast and offline. It
 * pulls the newest brick's request envelope from the running instance, reassembles
 * its messages through the content-addressed refs, and times the summarizer cold
 * and warm — because "warm" is what every ordinary step looks like, and it is the
 * number that decides whether this plugin is cheap enough to leave on.
 *
 *   DSH_BENCH=1 pnpm exec vitest run tests/collector-cost.spec.ts
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BlobStore } from '../src/host/blob-store'
import { RequestSummarizer } from '../src/host/observe'
import { contentRef } from '../src/shared/sha256'
import { liveCookie, liveGet } from './helpers/live'
import type { BrickFeed, BrickRecord } from '../src/shared/brick'

const PORT = Number(process.env.DSH_LIVE_PORT ?? '18090')
const BASE = `http://127.0.0.1:${String(PORT)}`
const HOME = process.env.DSH_LIVE_HOME ?? join(homedir(), '.dsh-017')
const RUNS = 5

/** Session cookie plus a JSON getter bound to it. */
let cookie: string | undefined
async function get(path: string): Promise<any> {
  cookie ??= await liveCookie(BASE, HOME)
  return await liveGet(BASE, path, cookie)
}

/** Median of a set of timings. */
function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}

describe.skipIf(process.env.DSH_BENCH !== '1')('collector cost on a real request', () => {
  it('measures cold and warm summarization, and asserts the warm path stays cheap', async () => {
    const sessions = await get('/cache-badge/sessions')
    const sessionId: string | undefined = sessions?.sessions?.[0]
    if (sessionId === undefined) {
      console.log(`benchmark skipped: no collector at ${BASE}`)
      return
    }
    const feed: BrickFeed = await get(`/cache-badge/attempts?sessionId=${encodeURIComponent(sessionId)}`)
    const brick: BrickRecord = feed.bricks[feed.bricks.length - 1]!
    const envelope = (await get(`/cache-badge/blob?ref=${encodeURIComponent(brick.request.requestRef!)}`)).value as {
      toolsRef?: string
      system?: string
      messageRefsRef?: string
      messageCount?: number
    }
    // The live instance may predate the pointer shape, in which case the refs are
    // still inline in the envelope; either way the summarizer under test is this
    // working tree's.
    const inline = (envelope as { messageRefs?: string[] }).messageRefs
    const list = envelope.messageRefsRef !== undefined
      ? (await get(`/cache-badge/blob?ref=${encodeURIComponent(envelope.messageRefsRef)}`)).value as { refs: string[] }
      : { refs: inline ?? [] }
    const tools = envelope.toolsRef === undefined
      ? []
      : ((await get(`/cache-badge/blob?ref=${encodeURIComponent(envelope.toolsRef)}`)).value as { tools: unknown[] }).tools
    const messages: unknown[] = []
    for (const ref of list.refs) {
      messages.push((await get(`/cache-badge/blob?ref=${encodeURIComponent(ref)}`)).value)
    }
    const megabytes = Buffer.byteLength(JSON.stringify(messages)) / 1048576
    console.log(`request under test: ${brick.identity.id}`)
    console.log(`  ${String(brick.request.messageCount)} messages, ${megabytes.toFixed(2)} MB of message JSON, ${String(brick.request.toolSchemaCount)} tool schemas`)

    const base = {
      provider: brick.route.provider,
      model: brick.route.model,
      tools,
      ...(envelope.system === undefined ? {} : { system: envelope.system }),
    }

    // Cold: a store that has never seen this conversation.
    const coldSamples: number[] = []
    let coldStored = 0
    let coldBlobs = 0
    let coldBytes = 0
    for (let index = 0; index < RUNS; index += 1) {
      const store = new BlobStore()
      const started = performance.now()
      const result = new RequestSummarizer(store).summarize({ ...base, messages })
      coldSamples.push(performance.now() - started)
      coldStored = result.messagesStored ?? 0
      coldBlobs = store.stats().blobs
      coldBytes = store.stats().bytes
    }

    // Warm: the same conversation plus two new messages — an ordinary step.
    const store = new BlobStore()
    const summarizer = new RequestSummarizer(store)
    summarizer.summarize({ ...base, messages })
    const grown = [
      ...messages,
      { id: 'bench-a', role: 'user', content: [{ type: 'text', text: 'next question' }], source: { kind: 'user' } },
      { id: 'bench-b', role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'assistant' } },
    ]
    const warmSamples: number[] = []
    let warmStored = 0
    let warmBlobs = 0
    let warmBytes = 0
    for (let index = 0; index < RUNS; index += 1) {
      const before = store.stats()
      const started = performance.now()
      const result = summarizer.summarize({ ...base, messages: grown })
      warmSamples.push(performance.now() - started)
      // Record what the *first* warm call had to add: later iterations add
      // nothing, which is the steady state rather than the cost of a step.
      if (index === 0) {
        warmStored = result.messagesStored ?? 0
        warmBlobs = store.stats().blobs - before.blobs
        warmBytes = store.stats().bytes - before.bytes
      }
    }

    const hashStart = performance.now()
    contentRef(JSON.stringify(messages))
    const hashMs = performance.now() - hashStart

    console.log(`  cold: ${median(coldSamples).toFixed(1)} ms median · stored ${String(coldStored)} messages · ${String(coldBlobs)} blobs / ${(coldBytes / 1048576).toFixed(2)} MB`)
    console.log(`  warm: ${median(warmSamples).toFixed(1)} ms median · stored ${String(warmStored)} messages · +${String(warmBlobs)} blobs / +${(warmBytes / 1024).toFixed(1)} KB per request`)
    console.log(`  reference sha256 of the whole payload: ${hashMs.toFixed(1)} ms`)

    // The warm path is the one that runs on every step; it must stay small.
    expect(warmStored).toBe(2)
    expect(median(warmSamples)).toBeLessThan(50)
    expect(warmBytes).toBeLessThan(40 * 1024)
  }, 120_000)
})
