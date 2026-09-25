/**
 * The frozen brick contract, asserted rather than described.
 *
 * `docs/brick-contract.md` says: **a brick is one actually executed model request
 * attempt**. Prose cannot stop that from drifting — a later change can re-add a "nearest"
 * landing or let a folded step pass for a request and every existing test would still be
 * green. These are the invariants behind the sentence, so moving the boundary has to be a
 * deliberate edit to this file.
 */
import { describe, expect, it } from 'vitest'
import { BrickLedger, type Observation } from '../src/core/brick-ledger'
import { boardFromFeed, boardFromReadings, targetOf } from '../src/client/bricks'
import { accuracyOf, type BrickTarget } from '../src/client/target'
import { EMPTY_COUNTERS, deriveMetrics } from '../src/shared/metrics'
import type { BrickFeed, BrickRecord, BrickUsage } from '../src/shared/brick'

const USAGE: BrickUsage = { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 9000 }

/** A minimal record, so a target can be derived without a ledger. */
function record(overrides: Partial<BrickRecord> & { turn?: number; step?: number; ordinal?: number } = {}): BrickRecord {
  const turn = overrides.turn ?? 3
  const step = overrides.step ?? 7
  const ordinal = overrides.ordinal ?? 0
  return {
    identity: { id: `s:${String(turn)}:${String(step)}:${String(ordinal)}`, sessionId: 's', turn, step, attemptOrdinal: ordinal },
    settlement: 'message',
    route: { provider: 'p', model: 'm' },
    usage: USAGE,
    metrics: deriveMetrics(USAGE, {}, EMPTY_COUNTERS),
    request: {},
    tools: [],
    raw: {},
    ...overrides,
  }
}

/** One feed holding whatever bricks a test wants to place. */
function feed(bricks: BrickRecord[]): BrickFeed {
  return { sessionId: 's', bricks, endedTurns: [], store: { blobs: 0, bytes: 0 } }
}

describe('a brick is one dispatched request', () => {
  it('counts two attempts of one step as two bricks', () => {
    const ledger = new BrickLedger('s')
    for (const attempt of [0, 1]) {
      ledger.observe({ kind: 'dispatch', at: attempt * 100, options: { provider: 'p', model: 'm' } })
      ledger.observe({ kind: 'attempt-start', at: attempt * 100, turn: 3, step: 7, attemptId: `a${String(attempt)}` })
      ledger.observe({ kind: 'attempt-end', at: attempt * 100 + 50, outcome: 'committed', eventType: 'assistant/message', seq: 500 + attempt })
    }
    const bricks = ledger.attemptsOf(3, 7)
    expect(bricks.map((brick) => brick.identity.attemptOrdinal)).toEqual([0, 1])
    expect(new Set(bricks.map((brick) => brick.identity.id)).size).toBe(2)
  })

  it('counts an auxiliary call as a brick, with a record of its own', () => {
    const ledger = new BrickLedger('s')
    ledger.observe({ kind: 'dispatch', at: 10, options: { provider: 'p', model: 'm', purpose: 'compaction' } })
    const [aux] = ledger.records()
    expect(aux?.route.purpose).toBe('compaction')
    expect(aux?.identity.turn).toBe(0)
    // It belongs to no Turn, and says so instead of borrowing one.
    expect(targetOf(aux!)).toEqual({ kind: 'none', reason: 'no-compaction-id' })
  })

  it('drops an observation it cannot attribute instead of making a brick up', () => {
    const ledger = new BrickLedger('s')
    const orphan: Observation = {
      kind: 'settled',
      snapshot: { seq: 42, time: 1, settlement: 'message', usage: USAGE },
    }
    ledger.observe(orphan)
    expect(ledger.records()).toEqual([])
    expect(ledger.unattributedCount).toBe(1)
  })
})

describe('the client fold never claims to be a request', () => {
  it('marks its bricks estimated, and aims them at the step rather than an attempt', () => {
    const data = boardFromReadings([
      { turn: 3, step: 7, tone: 'good', label: '99%', ended: true, usage: { inputTokens: 10, cacheReadTokens: 90 }, seq: 42 },
    ])
    expect(data.estimated).toBe(true)
    const [brick] = data.columns[0]!.bricks
    expect(brick?.estimated).toBe(true)
    // Step-exact, not attempt-exact: the fold measured a step, and that is all it may claim.
    expect(brick?.target).toEqual({ kind: 'historical-step', turn: 3, step: 7, loadSeq: 42 })
    // And it does not pretend to carry an auxiliary call either.
    expect(data.aux).toEqual([])
  })
})

describe('a target never invents a Turn', () => {
  it('gives every auxiliary brick a lane entry, not a Turn column', () => {
    const data = boardFromFeed(feed([
      record(),
      record({ turn: 0, step: 0, route: { provider: 'p', model: 'm', purpose: 'session-title' } }),
    ]))
    expect(data.columns.every((column) => column.turn > 0)).toBe(true)
    expect(data.aux).toHaveLength(1)
    expect(data.aux[0]!.turn).toBe(0)
  })

  it('maps each target kind to the accuracy it is worth', () => {
    const exact: BrickTarget['kind'][] = ['assistant-step', 'tool-call', 'retry-chain', 'compaction']
    for (const kind of exact) {
      const row = kind === 'assistant-step' ? 'assistant-step' : kind
      expect(accuracyOf(row)).toBe('exact')
    }
    // A Turn's header is not the request; nothing in the reveal produces it today, and if
    // something ever does, it must not claim to be exact.
    expect(accuracyOf('turn-header')).toBe('context')
    expect(accuracyOf('none')).toBe('none')
  })

  it('aims a retried step’s bricks at the chain, and its failed half never at the step’s message row', () => {
    const failed = record({ retry: { retryId: 'r1', provider: 'p', mode: 'normal', policyKey: 'k', retry: 1, delayMs: 5 } })
    const retried = record({ ordinal: 1, retryChainId: 'r1' })
    expect(targetOf(failed)).toEqual({ kind: 'retry-chain', turn: 3, step: 7, retryId: 'r1' })
    expect(targetOf(retried)).toEqual({ kind: 'retry-chain', turn: 3, step: 7, retryId: 'r1' })
  })
})
