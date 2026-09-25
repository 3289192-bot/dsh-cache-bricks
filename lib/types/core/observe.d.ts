import type { BrickFinish } from '../shared/brick';
import type { ChunkObservation, DispatchOptions, Observation, UsageSnapshot } from './brick-ledger';
import type { BlobStore } from './blob-store';
/** The subset of `GenerateOptions` this observer reads. */
export interface RequestLike {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly stop?: readonly string[];
    readonly system?: string;
    readonly tools?: readonly unknown[];
    /**
     * Session-folded tool history (0.1.7-rc.2 and later).
     *
     * The loop attaches it to every request it builds (`toolHistory: session.toolHistory()`),
     * and it holds the declarations the history *started* with plus the additions later
     * developer messages contributed. The adapter projects it away before the provider call
     * (`projectToolUpdates`), and this observer runs **before** that projection, so the
     * effective declaration list has to be reconstructed here. On 0.1.7-rc.1 and
     * 0.1.6-alpha.1 the field does not exist and `tools` is already the complete list.
     */
    readonly toolHistory?: ToolHistoryLike;
    readonly messages?: readonly MessageLike[];
    readonly sessionId?: string;
    readonly purpose?: 'compaction' | 'session-title';
}
/**
 * The subset of `ToolHistory` (0.1.7-rc.2+) this observer reads.
 *
 * `tools` is the complete active set at the start of the history; each `updates` entry is a
 * developer message plus the definitions its `tool-addition` blocks activated, already
 * resolved from the historical request header the block referenced.
 */
export interface ToolHistoryLike {
    readonly tools?: readonly unknown[];
    readonly updates?: readonly {
        readonly messageId?: string;
        readonly additions?: readonly unknown[];
    }[];
}
/** True when a declaration is deferred until a later developer message activates it. */
export declare function isDeferredTool(tool: unknown): boolean;
/**
 * The definitions a tool history contributes, in the order the history added them.
 * @param history - the request's `toolHistory`, when it carries one.
 * @returns the added declarations; empty for every core that predates the field.
 */
export declare function toolAdditionsOf(history: ToolHistoryLike | undefined): readonly unknown[];
/**
 * The declaration list the model can call **at this point in the history**.
 *
 * The two halves overlap, and that is the whole subtlety of rc.2's shape: `tools` is the
 * complete list the request header recorded — with not-yet-activated declarations flagged
 * `deferLoading` — while `toolHistory`'s additions are the ones a later developer message
 * activated, which are *already in that list*. Concatenating the two would count and store the
 * same tool twice (measured: `["read","write","write"]`).
 *
 * So the list is deduplicated by name, first occurrence winning, and the `deferLoading`
 * bookkeeping flag is dropped: the adapter strips it before dispatch (`projectToolUpdates`'s
 * `withoutDeveloperMessages`/`immediateTools`), and a flag the provider never sees must not be
 * able to move a hash whose entire job is to say "the tools changed here".
 *
 * @param tools - the request's declarations, as built.
 * @param additions - what its tool history activated.
 * @returns the effective declarations; equal to `tools` whenever the history adds nothing the
 *   header did not already declare.
 */
export declare function effectiveToolsOf(tools: readonly unknown[], additions: readonly unknown[]): readonly unknown[];
/** The additions that genuinely extend the declared list, i.e. names it did not already carry. */
export declare function newToolAdditionsOf(tools: readonly unknown[], additions: readonly unknown[]): readonly unknown[];
/** The subset of a request message this observer reads. */
export interface MessageLike {
    readonly id?: string;
    readonly role?: string;
    readonly content?: unknown;
    readonly source?: unknown;
}
/** The subset of `StreamChunk` this observer reads. */
export type ChunkLike = {
    readonly type: 'text-delta';
    readonly text?: string;
} | {
    readonly type: 'reasoning-delta';
    readonly text?: string;
} | {
    readonly type: 'tool-call-delta';
    readonly id?: string;
    readonly name?: string;
    readonly argumentsDelta?: string;
} | {
    readonly type: 'usage';
    readonly usage?: UsageLike;
} | {
    readonly type: 'finish';
    readonly reason?: FinishLike;
} | {
    readonly type: string;
};
/** The subset of `TokenUsage` this observer reads. */
export interface UsageLike {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
}
/** The subset of `FinishReason` this observer reads. */
export interface FinishLike {
    readonly kind?: string;
    readonly failure?: {
        readonly message?: string;
        readonly code?: string;
        readonly status?: number;
        readonly providerRetryAfterMs?: number;
        readonly requestId?: string;
        readonly offloadImages?: number;
    };
}
/** The subset of an `assistant/message` / `assistant/attempt` event this observer reads. */
export interface AssistantEventLike {
    readonly seq?: number | undefined;
    readonly time?: number | undefined;
    readonly data?: {
        readonly turn?: number;
        readonly step?: number;
        readonly usage?: UsageLike;
        readonly interrupted?: true;
        readonly stream?: readonly StreamRecordLike[];
    } | undefined;
}
/** The subset of an `AssistantStreamRecord` this observer reads. */
export type StreamRecordLike = {
    readonly type: 'chunk';
    readonly time?: number;
    readonly chunk?: ChunkLike;
} | {
    readonly type: string;
};
/** The subset of a `request/header` event this observer reads. */
export interface HeaderEventLike {
    readonly seq?: number | undefined;
    readonly data?: {
        readonly reason?: string;
        readonly startsSeries?: true;
        readonly header?: {
            readonly config?: Record<string, unknown>;
            readonly adapterDefaults?: {
                readonly reasoningEffort?: boolean;
                readonly maxTokens?: boolean;
            };
            readonly tools?: readonly unknown[];
        };
    };
}
/** The subset of a `request/context` event this observer reads. */
export interface ContextEventLike {
    readonly data?: {
        readonly provider?: string;
        readonly model?: string;
        readonly contextWindow?: number;
        readonly systemPromptUpdate?: string;
    } | undefined;
}
/** The subset of an `llm/retry` event this observer reads. */
export interface RetryEventLike {
    readonly data?: {
        readonly retryId?: string;
        /** The attempt the retry replaces. The runtime carries these; dropping them would
         * leave the ledger to guess which draft the retry belongs to. */
        readonly turn?: number;
        readonly step?: number;
        readonly provider?: string;
        readonly mode?: string;
        readonly policyKey?: string;
        readonly retry?: number;
        readonly maxRetries?: number;
        readonly delayMs?: number;
        readonly failure?: {
            readonly message?: string;
            readonly code?: string;
        };
    } | undefined;
}
/** The subset of a `tool/call` event this observer reads. */
export interface ToolCallEventLike {
    readonly time?: number | undefined;
    readonly seq?: number | undefined;
    readonly data?: {
        readonly callId?: string;
        readonly name?: string;
        readonly arguments?: string;
    } | undefined;
}
/** The subset of a `tool/result` event this observer reads. */
export interface ToolResultEventLike {
    readonly time?: number | undefined;
    readonly data?: {
        readonly message?: {
            readonly toolCallId?: string;
            readonly content?: unknown;
            readonly isError?: boolean;
        };
        readonly error?: {
            readonly name?: string;
            readonly code?: string;
            readonly reason?: string;
        };
    } | undefined;
}
/** Normalize provider usage, keeping absent buckets absent. */
export declare function usageOf(usage: UsageLike | undefined): UsageSnapshot | undefined;
/** Normalize a finish reason, which the runtime expresses as a tagged object. */
export declare function finishOf(reason: FinishLike | undefined): {
    reason: BrickFinish['reason'];
    failure?: NonNullable<BrickFinish['failure']>;
} | undefined;
/** Map one live stream chunk to counts and terminal facts. */
export declare function chunkObservation(chunk: ChunkLike): ChunkObservation;
/** Read the last `usage` chunk out of a durable compact stream. */
export declare function usageFromStream(stream: readonly StreamRecordLike[] | undefined): UsageSnapshot | undefined;
/**
 * Read the terminal finish out of a durable compact stream.
 *
 * Neither `assistant/message` nor `assistant/attempt` carries a finish reason at
 * the top level — it exists only as the stream's final `finish` chunk.
 */
export declare function finishFromStream(stream: readonly StreamRecordLike[] | undefined): ReturnType<typeof finishOf>;
/**
 * Turns outgoing requests into refs and hashes, remembering per-message hashes so
 * a long conversation is neither re-hashed nor re-stored on every call.
 *
 * Two levels of sharing come out of this: the hash memo keeps a stable message
 * from being re-hashed, and the content-addressed store keeps it from being
 * re-stored. A 525-message request whose predecessor shared 523 of them therefore
 * costs two messages, one ref list and one small envelope — not a 1.7 MB copy.
 *
 * Identity-free one-shot inputs (`RequestUserInput`) have no stability promise at
 * all and are always hashed.
 */
export declare class RequestSummarizer {
    private readonly store;
    private readonly memo;
    /**
     * The previous request's message refs, **per kind of request**.
     *
     * An auxiliary call (`compaction`, `session-title`) runs on a prompt of its own that has
     * nothing to do with the conversation, so using it as the baseline for the next Turn request
     * would report that request as sharing nothing — a number the diff then repeats as "the
     * prefix is shared up to message 0 of 300". Keeping one baseline per kind means a Turn
     * request is compared with the previous Turn request (so the count reads as "how much of the
     * prefix survived", for a compaction too) and an auxiliary call with the previous auxiliary
     * call.
     */
    private readonly previousHashes;
    constructor(store: BlobStore);
    /**
     * Store one message and return its ref.
     *
     * The ref **is** the store's ref: computing it separately (say, by hashing the
     * message directly) would produce an address the store cannot resolve, and the
     * `has` check would then miss every time and re-store the whole history. The
     * memo is only a fast path — it saves re-serializing a message that a previous
     * request already stored — and it is keyed on the structural fingerprint so a
     * changed message can never reuse it.
     */
    private refForMessage;
    /**
     * Summarize one outgoing request.
     * @param options - the request the runtime is about to dispatch (read only).
     * @returns the options block for the brick, including how much of the message
     *   prefix it shares with the previous request **of the same kind** (a Turn request
     *   is measured against the previous Turn request, an auxiliary call against the
     *   previous auxiliary call — an auxiliary prompt is not the conversation).
     */
    summarize(options: RequestLike): DispatchOptions;
}
/** JSON with object keys sorted, so equal payloads hash equally. */
export declare function stableJson(value: unknown): string;
/** Build the observation for a `request/header` event. */
export declare function headerObservation(event: HeaderEventLike, store: BlobStore): Observation | undefined;
/** The subset of a `compaction/start` event this observer reads. */
export interface CompactionEventLike {
    readonly data?: {
        readonly compactionId?: string;
    } | undefined;
}
/**
 * Build the observation for a `compaction/start` event.
 *
 * This is the id the transcript's compaction row is keyed by — the chat view anchors that
 * node at its own checkpoint seq, **not** at the auxiliary model call's settlement seq, so
 * the id is the only thing that can bridge the two.
 *
 * @param event - the durable compaction event.
 * @returns the observation, or undefined when the event names no compaction.
 */
export declare function compactionObservation(event: CompactionEventLike): Observation | undefined;
/** Build the observation for a `request/context` event. */
export declare function contextObservation(event: ContextEventLike): Observation | undefined;
/** Build the observation for an `llm/retry` event. */
export declare function retryObservation(event: RetryEventLike): Observation | undefined;
/**
 * Build the observation for an `assistant/message` or `assistant/attempt` event.
 *
 * Usage comes from `data.usage` when present and from the embedded stream
 * otherwise: `assistant/attempt` never carries usage, so a failed attempt would
 * otherwise look free.
 */
export declare function settlementObservation(event: AssistantEventLike, store: BlobStore): Observation | undefined;
/** Build the observation for a durable `tool/call` event. */
export declare function toolCallObservation(event: ToolCallEventLike, store: BlobStore): Observation | undefined;
/** Build the observation for a durable `tool/result` event. */
export declare function toolResultObservation(event: ToolResultEventLike, store: BlobStore): Observation | undefined;
