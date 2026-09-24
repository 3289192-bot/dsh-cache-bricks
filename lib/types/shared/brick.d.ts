/**
 * The brick record: everything DSH exposes about **one real model request
 * attempt**.
 *
 * A brick is an attempt, not a step. A single `(turn, step)` can dispatch more
 * than one request — a retry is a second real request with its own tokens, its
 * own cache accounting and its own failure — and collapsing the two into one
 * brick would hide exactly the case worth investigating: "the first request blew
 * the cache, failed, and the retry came back clean".
 *
 * Scalar telemetry lives on the record. Anything big (the outgoing request, the
 * timed stream, replay state, the request header snapshot) is stored once in a
 * content-addressed store and referenced by hash, so 273 near-identical 600K-token
 * requests do not become 273 copies. A monitoring plugin that duplicates the very
 * prefix it is measuring would be its own worst joke.
 *
 * Field names mirror the runtime's own vocabulary; the host collector fills only
 * what the installed line actually emits.
 */
/** Which model call this brick is, in durable terms. */
export interface BrickIdentity {
    /** Stable id for the brick: `${sessionId}:${turn}:${step}:${attemptOrdinal}`. */
    readonly id: string;
    readonly sessionId: string;
    readonly turn: number;
    readonly step: number;
    /**
     * 0 for the first dispatch of this `(turn, step)`, 1 for the first retry, ...
     * Distinguishes a retried request from the one it replaced.
     */
    readonly attemptOrdinal: number;
    /** Live attempt id, when the runtime hands one out (process-local). */
    readonly attemptId?: string;
    /** Log revision the attempt was dispatched against, when known. */
    readonly revision?: number;
}
/** How the attempt settled in the durable log. */
export type BrickSettlement = 'running' | 'message' | 'attempt' | 'abandoned';
/** Where the request went and how it was configured. */
export interface BrickRoute {
    readonly provider: string;
    readonly model: string;
    /**
     * Set for an auxiliary call the agent loop did not make for a Turn
     * (`compaction`, `session-title`). Such a call has no Turn or Step, so its brick
     * is recorded at `turn 0` and never occupies a board column.
     */
    readonly purpose?: 'compaction' | 'session-title';
    /** Reasoning effort actually dispatched, when the request carried one. */
    readonly reasoningEffort?: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly stop?: readonly string[];
    /** Context window in tokens, when the runtime reports one for this attempt. */
    readonly contextWindow?: number;
    /** True when the adapter filled `reasoningEffort` in rather than the caller. */
    readonly reasoningEffortDefaulted?: boolean;
    /** True when the adapter filled `maxTokens` in rather than the caller. */
    readonly maxTokensDefaulted?: boolean;
}
/**
 * Provider usage for the attempt.
 *
 * The three prompt buckets are **disjoint** in DSH: `inputTokens` is the
 * uncached input, cache reads and cache writes are counted separately. So the
 * prompt is their sum and the ratios below need no guessing about a provider's
 * own `prompt_tokens` convention.
 */
export interface BrickUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
}
/** Numbers derived from the record; nothing here comes from a new provider API. */
export interface BrickMetrics {
    /** `inputTokens + cacheReadTokens + cacheWriteTokens`. */
    readonly promptTokens?: number;
    readonly cacheHitRatio?: number;
    readonly uncachedRatio?: number;
    readonly cacheWriteRatio?: number;
    readonly reasoningRatio?: number;
    /** `promptTokens / contextWindow`. */
    readonly contextOccupancy?: number;
    /** Dispatch to first token, in ms. */
    readonly ttftMs?: number;
    /** Dispatch to terminal frame, in ms. */
    readonly durationMs?: number;
    /** Output tokens per second over the generation window, when measurable. */
    readonly tps?: number;
    readonly dispatchedAt?: number;
    readonly firstTokenAt?: number;
    readonly usageAt?: number;
    readonly finishAt?: number;
    readonly chunkCount: number;
    readonly textChars: number;
    readonly reasoningChars: number;
    readonly toolCallCount: number;
}
/** Request identity: hashes prove sameness, refs hold the bytes. */
export interface BrickRequest {
    /**
     * `seq` of the `request/header` event this attempt was built from. (Not to be
     * confused with `developer/message`'s `headerSeq`, which cites a header to
     * define tool additions.)
     */
    readonly headerEventSeq?: number;
    /** Why a new header was logged: first request, resume, a change, or a series. */
    readonly headerReason?: 'initial' | 'resume' | 'change' | 'series';
    readonly startsSeries?: boolean;
    readonly messageCount?: number;
    readonly toolSchemaCount?: number;
    /**
     * Declarations the request header itself carried, when `toolSchemaCount` is larger.
     *
     * From 0.1.7-rc.2 the declaration list is history-relative: `toolSchemaCount` is what the
     * model could call **at this point in the conversation** (base list plus the additions
     * earlier developer messages activated), while this is the size of the list the header
     * declared. Only set when the two differ.
     */
    readonly toolSchemaDeclared?: number;
    /** Declarations this request gained from tool history (`tool-addition` blocks). */
    readonly toolSchemaAdded?: number;
    /**
     * Declarations the history activated, whether or not the header already listed them.
     *
     * rc.2's header already carries the complete list (deferred entries flagged), so the usual
     * case is an activation the set already contained — `toolSchemaAdded` counts only the ones
     * that genuinely extended it, and this counts the activations themselves.
     */
    readonly toolSchemaActivated?: number;
    /** Declarations flagged `deferLoading`, activated only by a later developer message. */
    readonly deferredToolCount?: number;
    /** Developer messages in the request (the carriers of tool additions and removals). */
    readonly developerMessageCount?: number;
    /** Tool-history updates the request carried, i.e. how many developer messages changed tools. */
    readonly toolUpdateMessages?: number;
    /** Content ref of the request's `toolHistory`, for reading the additions back verbatim. */
    readonly toolHistoryRef?: string;
    readonly systemHash?: string;
    readonly toolsHash?: string;
    readonly messagesHash?: string;
    /**
     * Content ref of the per-message hash list. Two attempts that share a prefix
     * share a prefix of this list, which is what makes "the prefix broke at message
     * 273" answerable without copying the messages.
     */
    readonly messageHashesRef?: string;
    /** How many leading messages this request shared with the previous attempt. */
    readonly sharedMessagePrefix?: number;
    /** How many messages had to be stored for this request (the rest were shared). */
    readonly messagesStored?: number;
    readonly headerHash?: string;
    /** Content-addressed refs into the blob store. */
    readonly requestRef?: string;
    readonly headerRef?: string;
}
/** The context environment **frozen at dispatch time**. */
export interface BrickContext {
    readonly pressureTokens?: number;
    readonly projectedTokens?: number;
    readonly contextWindow?: number;
    /** Heuristic split, labelled as such in the UI: not provider billing. */
    readonly systemTokens?: number;
    readonly toolsTokens?: number;
    readonly messageTokens?: number;
    /** Token-meter snapshot taken when the request was dispatched. */
    readonly meterRef?: string;
    readonly surfaceTokens?: number;
    readonly totalMeterTokens?: number;
    readonly surfaceDeltaTokens?: number;
    readonly baselineKind?: 'none' | 'estimated' | 'usage';
    readonly baselineTokens?: number;
    readonly nodeCount?: number;
}
/** A tool call this attempt produced and whatever came back. */
export interface BrickToolCall {
    readonly callId: string;
    readonly name: string;
    /** Raw JSON as emitted by the model. */
    readonly argumentsRef?: string;
    readonly argumentsChars?: number;
    readonly callAt?: number;
    readonly resultAt?: number;
    readonly durationMs?: number;
    readonly resultRef?: string;
    /** True when the tool reported failure. */
    readonly isError?: boolean;
    readonly error?: {
        readonly name: string;
        readonly code: string;
        readonly reason?: string;
    };
    readonly truncated?: boolean;
}
/** A retry that replaced a failed attempt. */
export interface BrickRetry {
    readonly retryId: string;
    readonly provider: string;
    readonly mode: 'normal' | 'always';
    readonly policyKey: string;
    readonly retry: number;
    readonly maxRetries?: number;
    readonly delayMs: number;
    readonly failureMessage?: string;
    readonly failureCode?: string;
}
/** How the attempt ended. */
export interface BrickFinish {
    readonly reason: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error';
    readonly failure?: {
        readonly message: string;
        readonly code: string;
        readonly status?: number;
        readonly providerRetryAfterMs?: number;
        readonly requestId?: string;
        readonly offloadImages?: number;
    };
}
/** Raw material kept for forensics, all by reference. */
export interface BrickRaw {
    /** Timed, lossless stream record for this attempt. */
    readonly streamRef?: string;
    /** Provider-private replay state, when the adapter exposes one. */
    readonly replayRef?: string;
    /** True when a blob was dropped for exceeding the store's per-blob limit. */
    readonly truncated?: boolean;
}
/** One model request attempt. */
export interface BrickRecord {
    /**
     * Which half folded this brick.
     *
     * `host` is the collector: the full record, with the request, the stream and the
     * context snapshot kept by reference. `client` is the reduced record the browser
     * can derive from the session event feed on its own, used when no host half is
     * serving the session — fewer fields, and the panel says so rather than showing
     * empty rows as if they had been measured.
     */
    readonly observedBy?: 'host' | 'client';
    readonly identity: BrickIdentity;
    readonly settlement: BrickSettlement;
    readonly interrupted?: boolean;
    /** Durable log sequence of the settling event, when there is one. */
    readonly settlementSeq?: number;
    readonly settlementTime?: number;
    readonly route: BrickRoute;
    readonly usage?: BrickUsage;
    readonly metrics: BrickMetrics;
    readonly request: BrickRequest;
    readonly context?: BrickContext;
    readonly tools: readonly BrickToolCall[];
    readonly retry?: BrickRetry;
    /**
     * The retry chain this attempt belongs to, when it is part of one.
     *
     * A failed attempt carries the `llm/retry` record itself (`retry`); the attempt
     * that then ran as the retry carries no durable record of its own, so the chain id
     * is stamped on it by the ledger. Both bricks point at the same chat row — the
     * official `model-retry` node — which is the only place the pair is shown together.
     */
    readonly retryChainId?: string;
    /**
     * The compaction this auxiliary call performed, when it is the one that did it.
     *
     * It is the key of the transcript's compaction row (`compaction{compactionId}`), and the
     * only link between that row and the model call — the two are anchored at different
     * events, so a `seq` cannot stand in for it.
     */
    readonly compactionId?: string;
    readonly finish?: BrickFinish;
    readonly raw: BrickRaw;
}
/** Server → client payload: the board's data channel. */
export interface BrickFeed {
    readonly sessionId: string;
    readonly bricks: readonly BrickRecord[];
    /**
     * Turns whose `turn/end` has been observed — the only honest source for "this
     * task is finished". Deriving it from a brick's settlement would call a Turn
     * finished while its tools are still running.
     */
    readonly endedTurns?: readonly number[];
    /** Store counters, so the UI can show whether it is holding raw bytes. */
    readonly store: {
        readonly blobs: number;
        readonly bytes: number;
    };
    /**
     * Observations the collector dropped because no attempt could be identified for them.
     *
     * Non-zero means telemetry was lost — reported rather than hidden, because the way to
     * "not lose" it used to be attaching it to whichever attempt happened to be newest.
     */
    readonly unattributed?: number;
}
/** Compact hover text for one brick: the reading plus what makes it notable. */
export declare function brickHeadline(record: BrickRecord): string;
