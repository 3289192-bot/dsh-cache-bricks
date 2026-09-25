/**
 * The ledger: folds what the runtime reports into one brick per **real model
 * request attempt**.
 *
 * Three facts about DSH 0.1.7-rc.1 shape this design, all verified in the
 * installed source:
 *
 * 1. `llm/stream` is a waterfall that carries the full outgoing request but **no
 *    turn, step or attempt id**. The attempt identity arrives separately on
 *    `agent/assistant-stream`'s `start` frame (`turn`, `step`, `attemptId`,
 *    `revision`). So a dispatch is paired with an attempt through a per-session
 *    FIFO: whichever side arrives first, the two meet in the middle.
 * 2. `llm/retry` and `llm/retry-started` are **durable session events**, not
 *    Cordis events. They come in through the session feed, and a retry is what
 *    makes one `(turn, step)` hold more than one brick.
 * 3. Context pressure and composition are *last-wins slots*, explicitly not one
 *    atomic request observation. They are therefore snapshotted **at dispatch**
 *    and frozen onto the brick, never read back after the fact.
 *
 * The ledger is pure: it consumes normalized observations and writes to a blob
 * store. No DSH imports, no timers, no IO — so a whole session, including retries
 * and failures, can be replayed in a unit test.
 */
import { BlobStore } from './blob-store';
import type { BrickFeed, BrickFinish, BrickRecord } from '../shared/brick';
/** What the adapter saw in the outgoing request, already hashed and stored. */
export interface DispatchOptions {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly stop?: readonly string[];
    /** Set for auxiliary calls the loop did not make for a Turn. */
    readonly purpose?: 'compaction' | 'session-title';
    readonly messageCount?: number;
    /** Developer messages among them: the carriers of tool additions and removals. */
    readonly developerMessageCount?: number;
    /** Declarations the model could call at this point in the history. */
    readonly toolSchemaCount?: number;
    /** Declarations the header itself listed, when the history added more. */
    readonly toolSchemaDeclared?: number;
    /** Declarations contributed by tool history. */
    readonly toolSchemaAdded?: number;
    /** Declarations the history activated (`tool-addition` blocks), whether or not the header already listed them. */
    readonly toolSchemaActivated?: number;
    /** Declarations waiting on a later developer message (`deferLoading`). */
    readonly deferredToolCount?: number;
    /** How many developer messages of this request changed the tool set. */
    readonly toolUpdateMessages?: number;
    /** Content ref of the request's tool history. */
    readonly toolHistoryRef?: string;
    readonly systemHash?: string;
    readonly toolsHash?: string;
    readonly messagesHash?: string;
    /**
     * Content ref of the per-message ref list, for prefix forensics and for reading
     * individual messages back: every entry is itself a ref into the store.
     */
    readonly messageHashesRef?: string;
    /** Messages this request had to store because no earlier request had them. */
    readonly messagesStored?: number;
    /** Leading messages this request shared with the previous attempt of the session. */
    readonly sharedMessagePrefix?: number;
    /** Content ref of the full outgoing request (config, system, tools, messages). */
    readonly requestRef?: string;
}
/** A `request/header` snapshot: the config plus the schemas the request ran with. */
export interface HeaderSnapshot {
    readonly seq: number;
    readonly reason: 'initial' | 'resume' | 'change' | 'series';
    readonly startsSeries?: boolean;
    readonly adapterDefaults?: {
        readonly reasoningEffort?: boolean;
        readonly maxTokens?: boolean;
    };
    readonly headerHash?: string;
    readonly headerRef?: string;
    readonly systemHash?: string;
    readonly toolsHash?: string;
    readonly toolSchemaCount?: number;
}
/** A `request/context` snapshot: route and capacity. */
export interface ContextSnapshot {
    readonly provider: string;
    readonly model: string;
    readonly contextWindow?: number;
    readonly systemPromptUpdate?: 'in-history';
}
/** The context environment as it stood when a request was dispatched. */
export interface PressureSnapshot {
    readonly contextWindow?: number;
    readonly pressureTokens?: number;
    readonly projectedTokens?: number;
    readonly surfaceTokens?: number;
    readonly systemTokens?: number;
    readonly toolsTokens?: number;
    readonly messageTokens?: number;
    readonly baselineKind?: 'none' | 'estimated' | 'usage';
    readonly baselineTokens?: number;
    readonly surfaceDeltaTokens?: number;
    readonly totalMeterTokens?: number;
    readonly nodeCount?: number;
    readonly meterRef?: string;
}
/** One scheduled retry, as recorded by `llm/retry`. */
export interface RetrySnapshot {
    readonly retryId: string;
    /** The attempt the retry replaces, when the runtime reported it. */
    readonly turn?: number;
    readonly step?: number;
    readonly provider: string;
    readonly mode: 'normal' | 'always';
    readonly policyKey: string;
    readonly retry: number;
    readonly maxRetries?: number;
    readonly delayMs: number;
    readonly failureMessage?: string;
    readonly failureCode?: string;
}
/** Provider usage, exactly as reported. */
export interface UsageSnapshot {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
}
/** How one attempt ended, from the durable log. */
export interface SettlementSnapshot {
    readonly seq: number;
    readonly time: number;
    /** Which `(turn, step)` this settles. Both events carry it; it is what identifies the
     * draft, and guessing "the newest one" is how a late settlement lands on the wrong
     * attempt. */
    readonly turn?: number;
    readonly step?: number;
    readonly settlement: 'message' | 'attempt';
    readonly usage?: UsageSnapshot;
    readonly interrupted?: boolean;
    readonly finishReason?: BrickFinish['reason'];
    readonly failure?: NonNullable<BrickFinish['failure']>;
    readonly streamRef?: string;
    readonly replayRef?: string;
}
/** A normalized stream chunk: counts and terminal facts, not the payload. */
export type ChunkObservation = {
    readonly type: 'text';
    readonly chars: number;
} | {
    readonly type: 'reasoning';
    readonly chars: number;
} | {
    readonly type: 'tool-call';
    readonly callId: string;
    readonly name?: string;
    readonly argsChars: number;
} | {
    readonly type: 'usage';
    readonly usage: UsageSnapshot;
} | {
    readonly type: 'finish';
    readonly reason: BrickFinish['reason'];
    readonly failure?: NonNullable<BrickFinish['failure']>;
} | {
    readonly type: 'other';
};
/** Everything the adapter can tell the ledger. */
export type Observation = {
    readonly kind: 'dispatch';
    readonly at: number;
    readonly options: DispatchOptions;
} | {
    readonly kind: 'attempt-start';
    readonly at: number;
    readonly turn: number;
    readonly step: number;
    readonly attemptId?: string;
    readonly revision?: number;
} | {
    readonly kind: 'chunk';
    readonly at: number;
    readonly chunk: ChunkObservation;
    /**
     * Set by the pass-through wrapper around an auxiliary call's stream. Auxiliary
     * calls produce no `agent/assistant-stream` frames, so their chunks arrive only
     * this way and must be routed to the auxiliary brick rather than to whichever
     * Turn attempt happens to be current.
     */
    readonly auxiliary?: true;
} | {
    readonly kind: 'turn-end';
    readonly turn: number;
} | {
    readonly kind: 'attempt-end';
    readonly at: number;
    /** True when this closes an auxiliary call rather than a Turn attempt. */
    readonly auxiliary?: true;
    readonly outcome: 'committed' | 'abandoned';
    /**
     * Which durable event the attempt committed to, and its `seq`, when the live
     * end frame reported a commit. The durable settle event can arrive later (or,
     * for a pre-dispatch failure, never), so the frame is the reliable signal.
     */
    readonly eventType?: 'assistant/message' | 'assistant/attempt';
    readonly seq?: number;
} | {
    readonly kind: 'settled';
    readonly snapshot: SettlementSnapshot;
} | {
    readonly kind: 'header';
    readonly snapshot: HeaderSnapshot;
} | {
    readonly kind: 'context';
    readonly snapshot: ContextSnapshot;
} | {
    readonly kind: 'pressure';
    readonly snapshot: PressureSnapshot;
} | {
    readonly kind: 'retry';
    readonly snapshot: RetrySnapshot;
} | {
    /**
     * The durable `tool/call` record. The live `tool-call-delta` frames already
     * created the call (with its timing); this adds the raw argument JSON, which
     * is what the Tools tab shows.
     */
    readonly kind: 'tool-call';
    readonly at: number;
    readonly seq: number;
    readonly callId: string;
    readonly name: string;
    readonly argumentsRef?: string;
    readonly argumentsChars?: number;
} | {
    readonly kind: 'tool-result';
    readonly at: number;
    readonly callId: string;
    readonly isError?: boolean;
    readonly error?: {
        readonly name: string;
        readonly code: string;
        readonly reason?: string;
    };
    readonly resultChars?: number;
    readonly resultRef?: string;
} | {
    /**
     * The durable `compaction/start` record. Its `compactionId` is what the transcript's
     * compaction row is keyed by, and it is attached to the auxiliary call it belongs to.
     */
    readonly kind: 'compaction';
    readonly compactionId: string;
} | {
    readonly kind: 'flush';
    readonly at: number;
};
/** Limits that keep a long session's ledger bounded. */
export interface LedgerOptions {
    /** Bricks kept per session, newest last. */
    readonly maxBricks?: number;
    /** Blob store used for raw payloads. */
    readonly store?: BlobStore;
    /**
     * What the bricks from this ledger should claim about where they came from.
     *
     * `host` (the default) is the live tap. `replay` is the same fold run over a session's
     * own log, where the request capture and the dispatch-time context do not exist — the
     * record says so instead of leaving fields that look measured.
     */
    readonly observedBy?: 'host' | 'replay';
}
/** The per-session ledger. */
export declare class BrickLedger {
    private readonly sessionId;
    private readonly maxBricks;
    private readonly store;
    private readonly observedBy;
    private readonly drafts;
    private readonly pendingDispatches;
    private attemptCounts;
    /** Retry chain id per `(turn, step)`, so the attempt that runs it can be stamped. */
    private readonly retryChains;
    /** Observations that could not be attributed to an attempt, and were dropped. */
    private unattributed;
    private readonly endedTurns;
    private current;
    /** The auxiliary call in flight, if any: auxiliary calls are serialized. */
    private auxiliary;
    private header;
    private contextRoute;
    private pressure;
    constructor(sessionId: string, options?: LedgerOptions);
    /** The raw-payload store, so the adapter can stash blobs and hand back refs. */
    get blobStore(): BlobStore;
    /**
     * Fold one observation.
     * @param observation - a normalized runtime observation.
     * @returns the brick that changed, when the observation completed or updated one.
     */
    observe(observation: Observation): BrickRecord | undefined;
    /**
     * Record an auxiliary call as its own brick.
     *
     * It gets one immediately, at `turn 0`, because there is no attempt frame coming
     * to complete a pairing; its stream is observed through the pass-through wrapper
     * the collector returns for it.
     */
    private startAuxiliary;
    /**
     * How many observations were dropped because no attempt could be identified for them.
     *
     * It is surfaced so "we lost something" is visible rather than silent — the alternative,
     * attaching it to the newest draft, is how a brick comes to hold another request's data.
     */
    get unattributedCount(): number;
    /** Every brick seen so far, oldest first. */
    records(): BrickRecord[];
    /** The feed the browser consumes. */
    feed(): BrickFeed;
    /** Bricks for one `(turn, step)`, in attempt order. */
    attemptsOf(turn: number, step: number): BrickRecord[];
    /**
     * Pair a live attempt with the dispatch that produced it.
     *
     * The order is not guaranteed: the loop constructs the attempt before calling
     * `llm.stream`, but the frames and the waterfall are observed through different
     * channels. Whichever arrives second completes the pair.
     */
    private startAttempt;
    /** Count chunks, catch the first token, usage and finish. */
    private applyChunk;
    /** The live attempt frame ended: committed to the log or abandoned. */
    private endAttempt;
    /**
     * Enrich a brick with its durable settlement.
     *
     * The live end frame already said which event the attempt committed to; this
     * adds what only the log carries (authoritative usage, `interrupted`, the
     * embedded stream, the settlement `seq`).
     */
    private settle;
    /**
     * Attach a compaction id to the auxiliary call that performed it.
     *
     * The compaction row in the transcript is keyed by this id, while the auxiliary model
     * call is keyed by nothing at all — so this is the only link between the brick and the
     * row it belongs to. The call itself is the most recent `compaction` auxiliary call that
     * has not been claimed yet.
     *
     * @param compactionId - the id from the durable `compaction/start` event.
     * @returns the brick that changed, when an unclaimed one was found.
     */
    private attachCompaction;
    /** A scheduled retry belongs to the attempt that failed. */
    private attachRetry;
    /** Attach the durable call record (raw arguments) to the brick that made it. */
    private attachToolCall;
    /** A tool result belongs to the attempt that emitted the call. */
    private attachToolResult;
    /**
     * Close dispatches that never got an attempt frame.
     *
     * A dispatch with no attempt is not noise: it is either an auxiliary call the
     * loop made outside a Turn (`session-title`, `compaction`) or a request that a
     * `llm/stream` listener vetoed before any frame existed. Both are worth a brick.
     */
    private flushOrphans;
    /**
     * The drafts of one `(turn, step)` waiting to be settled by the log, oldest first.
     *
     * `(turn, step)` is a **bucket, not an identity**: one step can hold several attempts
     * (that is what a retry is), so it can narrow a settlement down to the attempts of that
     * step and no further. Within the bucket the rule is **FIFO**: the log settles a step's
     * attempts in the order they started, so the oldest unsettled one is the one being
     * settled. Picking "the newest" or "the newest running" instead would hand an early
     * attempt's verdict to a later one the moment two are in flight together — which is
     * exactly the interleave a retry creates.
     */
    private readonly awaiting;
    /** Queue a draft as awaiting its durable settlement. */
    private queueAwaiting;
    /**
     * Consume the oldest unsettled attempt of one step.
     *
     * @param turn - the Turn the settlement names.
     * @param step - the step the settlement names.
     * @returns the draft, or undefined when that step has no unsettled attempt left.
     */
    private takeAwaiting;
    /** Drop a draft from its step's settlement queue, because it will not be settled again. */
    private forgetAwaiting;
    /** One exact attempt of a step, by its ordinal. */
    private draftAt;
    private evict;
    /** Freeze a draft into the record the UI reads. */
    private materialize;
}
/** Prompt size of a record, for callers that want it without importing metrics. */
export declare function promptSizeOf(record: BrickRecord): number | undefined;
