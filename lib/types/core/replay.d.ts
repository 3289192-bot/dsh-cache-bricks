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
import type { BrickFeed } from '../shared/brick';
import { BlobStore } from './blob-store';
import { type ChunkObservation } from './brick-ledger';
/** One durable session event, as the session's own log carries it. */
export interface ReplayEvent {
    readonly type: string;
    readonly seq: number;
    readonly time?: number;
    readonly data?: Record<string, unknown>;
}
/** What one replay produced, including what it could not read. */
export interface ReplayReport {
    /**
     * The replayed session as a feed — the same shape the host collector serves, so the board
     * builds it with the same function (`boardFromFeed`) and the two sources cannot drift.
     */
    readonly feed: BrickFeed;
    /** Durable events that turned into observations. */
    readonly replayed: number;
    /** Events read and deliberately not turned into anything (tool results are folded, not bricked). */
    readonly ignored: number;
    /**
     * Settlements that could not be attached to an attempt.
     *
     * Non-zero means the log named a step with nothing awaiting settlement — reported rather than
     * hidden, exactly as the live collector reports it, because the alternative is a brick
     * wearing another attempt's accounting.
     */
    readonly unattributed: number;
}
/** Options for {@link replaySession}. */
export interface ReplayOptions {
    /** Share a store with the live collector, so identical streams dedupe across both. */
    readonly store?: BlobStore;
    /**
     * Cap on replayed bricks, oldest dropped first.
     *
     * A scene replay passes its own slice's attempt count so the cap cannot decide what a reader
     * sees; it is left optional for a caller replaying something unbounded on purpose.
     */
    readonly maxBricks?: number;
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
    readonly ordered?: boolean;
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
    readonly raw?: 'eager' | 'lazy';
}
/**
 * How many raw payloads the replays have hashed since this module loaded.
 *
 * Monotonic and module-wide, so a reader takes the difference across a replay instead of
 * expecting a per-replay reset. The replay's counterpart of the live collector's
 * `store.stats()`: what a replay pays even when every blob is already stored.
 */
export declare function replayBlobPuts(): number;
/**
 * How many raw payloads lazy replays left unhashed since this module loaded.
 *
 * The mirror image of {@link replayBlobPuts}: with `raw: 'lazy'` nothing is canonicalized, so this
 * is the number of `put` calls that would have happened and did not. A reader takes the difference
 * across a replay, and a scene replay that reports a growing number here and zero there is the
 * whole claim of the lazy path.
 */
export declare function replayBlobPutsSkipped(): number;
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
export declare function compactChunks(stream: readonly unknown[]): Array<{
    at: number;
    chunk: ChunkObservation;
}>;
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
export declare function replaySession(sessionId: string, events: readonly ReplayEvent[], options?: ReplayOptions): ReplayReport;
