/**
 * Replaying a session's own log into bricks.
 *
 * The collector sees **this process's** live events. The session log has always held the same
 * events — a settled attempt carries its whole compact stream, its usage, what the step called
 * and whether it was retried — so "history" is not a poorer kind of data. It was only being
 * read by a poorer reader: the browser used to fold the log down to per-step usage readings
 * (`StepReading`), which is why a brick older than the collector lost its type, its lifecycle
 * and its ability to navigate.
 *
 * This module is the other reader, and it is deliberately the **same** one the live tap uses:
 * the same observation builders (`./observe`), the same fold (`./brick-ledger`). A live event
 * and a replayed event go through one code path, so a brick can never mean one thing while it
 * is streaming and something else after a restart.
 *
 * What the log does not hold, and a replayed brick therefore cannot claim:
 *
 * - the **outgoing request** (the dispatched messages), so no message hashes, no shared-prefix
 *   count and no request envelope — the `request/header` event carries the route and the tool
 *   declarations, not the messages;
 * - the **context snapshot** at dispatch (pressure, projected, the token meter);
 * - the **dispatch instant**, which is why a replayed TTFT is measured from `step/start`
 *   (slightly earlier than the live tap's boundary) — see {@link replaySession}.
 * - the provider's **raw request**, which only the live adapter call has.
 *
 * Everything else — usage, cache accounting, reasoning/text/tool counters, retry chains,
 * attempt ordinals, tool call ids and results, finish reason, settlement seq, and therefore the
 * activity type and the navigation target — is reconstructed exactly, from the same alphabet
 * the live path reads.
 *
 * Pure: no IO, no timers, no DSH imports, so both halves can run it. The one piece of module
 * state is a count of the raw payloads the replays have hashed ({@link replayBlobPuts}), which
 * observes the work without taking part in it: two replays of one log still produce one feed.
 */
import type { BrickFeed, BrickRecord } from '../shared/brick'
import { BlobStore, type BlobStoreStats, type StoredBlob } from './blob-store'
import { BrickLedger, type ChunkObservation, type Observation } from './brick-ledger'
import {
  contextObservation,
  finishOf,
  headerObservation,
  retryObservation,
  settlementObservation,
  toolCallObservation,
  toolResultObservation,
  usageOf,
  type StreamRecordLike,
} from './observe'

/** One durable session event, as the session's own log carries it. */
export interface ReplayEvent {
  readonly type: string
  readonly seq: number
  readonly time?: number
  readonly data?: Record<string, unknown>
}

/** What one replay produced, including what it could not read. */
export interface ReplayReport {
  /**
   * The replayed session as a feed — the same shape the host collector serves, so the board
   * builds it with the same function (`boardFromFeed`) and the two sources cannot drift.
   */
  readonly feed: BrickFeed
  /** Durable events that turned into observations. */
  readonly replayed: number
  /** Events read and deliberately not turned into anything (tool results are folded, not bricked). */
  readonly ignored: number
  /**
   * Settlements that could not be attached to an attempt.
   *
   * Non-zero means the log named a step with nothing awaiting settlement — reported rather than
   * hidden, exactly as the live collector reports it, because the alternative is a brick
   * wearing another attempt's accounting.
   */
  readonly unattributed: number
}

/** Options for {@link replaySession}. */
export interface ReplayOptions {
  /** Share a store with the live collector, so identical streams dedupe across both. */
  readonly store?: BlobStore
  /**
   * Cap on replayed bricks, oldest dropped first.
   *
   * A scene replay passes its own slice's attempt count so the cap cannot decide what a reader
   * sees; it is left optional for a caller replaying something unbounded on purpose.
   */
  readonly maxBricks?: number
  /**
   * The caller guarantees `events` is already in ascending `seq` order.
   *
   * A scene replay is handed a slice of the durable window, and the slice sorts itself once
   * while it is being cut (`history-scene.ts`) — so the copy-and-sort below would re-order a
   * window-sized array to arrive at the order it was already given. With this flag the replay
   * walks the array as given: no copy, no sort, no throwaway array as big as the window.
   *
   * The guarantee is not verified, and it is the whole contract: an unsorted array is read in
   * the order it is in, so bricks come out in event order and a timing face measured from a
   * `step/start` that has not been read yet falls back to the settlement's own time. A caller
   * that cannot promise the order leaves the flag out and keeps the sort.
   */
  readonly ordered?: boolean
  /**
   * Whether the raw payloads a replay passes are stored and hashed, or left where they are.
   *
   * `eager` (the default) is what the collector's own observations want: every payload is
   * canonicalized and SHA-256'd into the store, which is how a brick's raw view is served.
   *
   * `lazy` is what a *replay of history* wants. Nobody asked for those payloads — the reader asked
   * for a board — and hashing them costs a canonical pass plus a digest per settled attempt, per
   * tool result and per header, on the same thread that is drawing. The payloads are not lost: they
   * are the session's own events, which the client is holding, so a reader who opens a brick's raw
   * view can be handed the bytes from the log at that moment (`navigation.ts` reads them by seq).
   * A lazy replay therefore makes **no** `put` calls at all, which is what
   * {@link replayBlobPutsSkipped} counts.
   */
  readonly raw?: 'eager' | 'lazy'
}

/**
 * Raw payloads the replays have hashed since this module loaded.
 *
 * A replayed payload is canonicalized and SHA-256'd whether or not the store already holds it,
 * so a replay that adds nothing still pays for every raw payload in its window — each settled
 * attempt's stream, every tool result, the request header (the `put` calls in `./observe`).
 * The store's own `hits`/`misses` count lookups, not the hashing that precedes them, so they
 * cannot answer "what did this replay actually cost?"; this counter can. It is observation
 * only: nothing about what is stored, when, or under which key changes because of it.
 */
let blobPuts = 0
let blobPutsSkipped = 0

/**
 * How many raw payloads the replays have hashed since this module loaded.
 *
 * Monotonic and module-wide, so a reader takes the difference across a replay instead of
 * expecting a per-replay reset. The replay's counterpart of the live collector's
 * `store.stats()`: what a replay pays even when every blob is already stored.
 */
export function replayBlobPuts(): number {
  return blobPuts
}

/**
 * How many raw payloads lazy replays left unhashed since this module loaded.
 *
 * The mirror image of {@link replayBlobPuts}: with `raw: 'lazy'` nothing is canonicalized, so this
 * is the number of `put` calls that would have happened and did not. A reader takes the difference
 * across a replay, and a scene replay that reports a growing number here and zero there is the
 * whole claim of the lazy path.
 */
export function replayBlobPutsSkipped(): number {
  return blobPutsSkipped
}

/**
 * A store that stores nothing, for a replay whose raw payloads are already somewhere else.
 *
 * Every `put` answers `undefined`, so the observers in `./observe` attach no refs and no payload is
 * canonicalized or hashed. `get`/`has` answer "not here" rather than lying, and `stats` reports an
 * empty store — which is exactly what this replay's store is.
 */
class LazyStore extends BlobStore {
  override put(): undefined {
    blobPutsSkipped += 1
    return undefined
  }

  override get(): undefined {
    return undefined
  }

  override has(): boolean {
    return false
  }

  override stats(): BlobStoreStats {
    return { blobs: 0, bytes: 0, hits: 0, misses: 0, skipped: 0, evicted: 0 }
  }
}

/**
 * A store handle that counts the `put` calls the replay makes through it, and is otherwise the
 * store it wraps.
 *
 * The puts being counted are the observers' — `settlementObservation` and its neighbours hash
 * every raw payload they are handed — so the count has to sit on the handle the replay passes
 * them. A counter inside `BlobStore` could not do this job: the scene replay shares that store
 * with the live collector, and the collector's captures are not replay work. Every other path
 * delegates unchanged, so dedupe, eviction and `stats()` read exactly as they did.
 */
class ReplayStore extends BlobStore {
  private readonly inner: BlobStore

  constructor(inner: BlobStore) {
    super()
    this.inner = inner
  }

  override put(value: unknown): StoredBlob | undefined {
    blobPuts += 1
    return this.inner.put(value)
  }

  override get(hash: string): unknown {
    return this.inner.get(hash)
  }

  override has(hash: string): boolean {
    return this.inner.has(hash)
  }

  override stats(): BlobStoreStats {
    return this.inner.stats()
  }

  override clear(): void {
    this.inner.clear()
  }
}

/** `${turn}:${step}`, the key a step's start time is remembered under. */
function stepKey(turn: number, step: number): string {
  return `${String(turn)}:${String(step)}`
}

/** The `texts`/`args` members of a compact run record, as strings. */
function membersOf(record: Record<string, unknown>): string[] {
  const list = record.type === 'tool-call-chunks' ? record.args : record.texts
  if (!Array.isArray(list)) return []
  return list.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * The length of a compact run's members, without ever joining them.
 *
 * The direct spelling is `members.join('').length`, and it is the wrong one here: a settled
 * stream carries every delta as its own member, so joining builds a second copy of the whole run
 * — for a long answer, the very megabyte the store is about to hash a second time — only to read
 * its length and drop it. Summing the members' own lengths is the same number, because both
 * count UTF-16 code units (a surrogate pair is two of them either way), and allocates nothing
 * per member.
 *
 * @param members - the run's delta members, as {@link membersOf} filtered them.
 * @returns the length the joined run would have had.
 */
function charsOf(members: readonly string[]): number {
  let chars = 0
  for (const member of members) chars += member.length
  return chars
}

/**
 * Read one **compact** stream into the ledger's chunk alphabet.
 *
 * The durable stream is not the live delta stream. It is the settled form of it: runs of
 * deltas (`reasoning-chunks` / `text-chunks` / `tool-call-chunks`, each with `time0` and a
 * `dt` list) framed by `block-start` / `block-end` records, plus `usage` and `finish`.
 *
 * The run records are the ones that carry the reading — their members are the deltas
 * themselves — so the counters come from them and the block records are read for nothing at
 * all: counting both would double every character. Timing comes from `time0`, which is what
 * makes a replayed first-token time exact rather than estimated from the settlement.
 *
 * @param stream - the compact stream a settled attempt carried.
 * @returns the chunk observations, in stream order, each stamped with its own time.
 */
export function compactChunks(stream: readonly unknown[]): Array<{ at: number; chunk: ChunkObservation }> {
  const observations: Array<{ at: number; chunk: ChunkObservation }> = []
  for (const raw of stream) {
    if (raw === null || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const type = record.type
    if (type === 'chunk') {
      const chunk = record.chunk as Record<string, unknown> | undefined
      const at = typeof record.time === 'number' ? record.time : 0
      if (chunk?.type === 'usage') {
        const usage = usageOf(chunk.usage as never)
        if (usage !== undefined) observations.push({ at, chunk: { type: 'usage', usage } })
        continue
      }
      if (chunk?.type === 'finish') {
        const finish = finishOf(chunk.reason as never)
        if (finish !== undefined) {
          observations.push({
            at,
            chunk: { type: 'finish', reason: finish.reason, ...(finish.failure === undefined ? {} : { failure: finish.failure }) },
          })
        }
        continue
      }
      // `block-start` / `block-end` are the frame around a run, not a reading: skipped on purpose.
      continue
    }
    if (type !== 'reasoning-chunks' && type !== 'text-chunks' && type !== 'tool-call-chunks') continue
    const at = typeof record.time0 === 'number' ? record.time0 : 0
    const members = membersOf(record)
    if (type === 'tool-call-chunks') {
      const callId = typeof record.id === 'string' ? record.id : ''
      observations.push({
        at,
        chunk: {
          type: 'tool-call',
          callId,
          ...(typeof record.name === 'string' ? { name: record.name } : {}),
          argsChars: charsOf(members),
        },
      })
      continue
    }
    observations.push({
      at,
      chunk: { type: type === 'text-chunks' ? 'text' : 'reasoning', chars: charsOf(members) },
    })
  }
  return observations
}

/**
 * Fold a session's durable events into attempt-level bricks.
 *
 * The order of a step's observations is the whole trick, and it mirrors the live path's:
 *
 * 1. `attempt-start` — synthesized from the settlement, because the durable log records when an
 *    attempt *settled*, not when it was dispatched. One settlement is one attempt, in log order,
 *    which is what makes a retried step come out as two bricks;
 * 2. its chunks, so the counters and the first-token time come from the attempt's own stream;
 * 3. `attempt-end` with the event's type — `assistant/attempt` means the attempt settled without
 *    committing a message, and that distinction must not depend on whether usage was present;
 * 4. `settled`, which adds the authoritative usage, the finish reason, the embedded stream
 *    (kept by reference) and the settlement `seq` the brick navigates by.
 *
 * @param sessionId - the session being replayed.
 * @param events - the durable events; sorted by `seq` here unless `ordered` says they already are.
 * @param options - store, brick cap, and whether the events are already in `seq` order.
 * @returns the replayed feed plus what the replay could not read.
 */
export function replaySession(
  sessionId: string,
  events: readonly ReplayEvent[],
  options: ReplayOptions = {},
): ReplayReport {
  const store = options.raw === 'lazy' ? new LazyStore() : new ReplayStore(options.store ?? new BlobStore())
  const ledger = new BrickLedger(sessionId, {
    store,
    observedBy: 'replay',
    ...(options.maxBricks === undefined ? {} : { maxBricks: options.maxBricks }),
  })
  const stepStarted = new Map<string, number>()
  const endedTurns = new Set<number>()
  let replayed = 0
  let ignored = 0

  const observe = (observation: Observation | undefined): undefined => {
    if (observation === undefined) {
      ignored += 1
      return undefined
    }
    ledger.observe(observation)
    replayed += 1
    return undefined
  }

  // The order a step's observations are folded in is the whole reading, so the events have to
  // arrive in `seq` order. A caller that promises they already do (`ordered`) is walked as
  // given; everyone else gets a copy sorted here, because sorting the array a caller lent us
  // would be a side effect of a read — and `sort` on a copy is the only reason the copy exists.
  const ordered = options.ordered === true ? events : [...events].sort((left, right) => left.seq - right.seq)

  for (const event of ordered) {
    const data = event.data ?? {}
    switch (event.type) {
      case 'request/header':
        observe(headerObservation({
          seq: event.seq,
          ...(event.time === undefined ? {} : { time: event.time }),
          data: data as never,
        }, store))
        break
      case 'request/context':
        observe(contextObservation({ data: data as never }))
        break
      case 'step/start': {
        const { turn, step } = data as { turn?: unknown; step?: unknown }
        if (typeof turn === 'number' && typeof step === 'number') {
          stepStarted.set(stepKey(turn, step), event.time ?? 0)
        }
        break
      }
      case 'assistant/message':
      case 'assistant/attempt': {
        const { turn, step } = data as { turn?: unknown; step?: unknown }
        if (typeof turn !== 'number' || typeof step !== 'number') {
          ignored += 1
          break
        }
        // `step/start` is the closest thing the log has to a dispatch instant: it is when the
        // loop began the step whose request this attempt is. A replayed TTFT is measured from
        // here, which is slightly earlier than the live tap's boundary — the panel says so.
        const at = stepStarted.get(stepKey(turn, step)) ?? event.time ?? 0
        ledger.observe({ kind: 'attempt-start', at, turn, step })
        for (const chunk of compactChunks((data.stream as readonly StreamRecordLike[] | undefined) ?? [])) {
          ledger.observe({ kind: 'chunk', at: chunk.at, chunk: chunk.chunk })
        }
        ledger.observe({
          kind: 'attempt-end',
          at: event.time ?? at,
          outcome: 'committed',
          eventType: event.type === 'assistant/attempt' ? 'assistant/attempt' : 'assistant/message',
          seq: event.seq,
        })
        observe(settlementObservation({
          seq: event.seq,
          ...(event.time === undefined ? {} : { time: event.time }),
          data: data as never,
        }, store))
        replayed += 1
        break
      }
      case 'tool/call':
        observe(toolCallObservation({
          seq: event.seq,
          ...(event.time === undefined ? {} : { time: event.time }),
          data: data as never,
        }, store))
        break
      case 'tool/result':
        observe(toolResultObservation({
          ...(event.time === undefined ? {} : { time: event.time }),
          data: data as never,
        }, store))
        break
      case 'llm/retry':
        observe(retryObservation({ data: data as never }))
        break
      case 'turn/end': {
        const turn = data.turn
        if (typeof turn === 'number') {
          endedTurns.add(turn)
          ledger.observe({ kind: 'turn-end', turn })
        }
        break
      }
      default:
        ignored += 1
        break
    }
  }

  const stats = ledger.blobStore.stats()
  const bricks: readonly BrickRecord[] = ledger.records()
  return {
    replayed,
    ignored,
    unattributed: ledger.unattributedCount,
    feed: {
      sessionId,
      bricks,
      endedTurns: [...endedTurns].sort((left, right) => left - right),
      store: { blobs: stats.blobs, bytes: stats.bytes },
    },
  }
}
