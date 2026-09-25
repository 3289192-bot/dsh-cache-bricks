import type { ConversationNodeContext, ConversationNodeDefinition, ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { CacheUsage } from './logic';
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
    interface ChatNodeDataMap {
        /** One Turn's per-step prompt-cache row, anchored outside the Turn's fold. */
        'cache-bricks': CacheBricksNodeData;
    }
}
/** One assistant step's own accounting (one `llm/stream` call). */
export interface StepSample {
    readonly step: number;
    /** Token accounting from the stream's usage chunk (or assistant/message fallback). */
    readonly usage: CacheUsage | undefined;
    /** Provider id from the finalized assistant message, when available. */
    readonly provider: string | undefined;
    /** step/start event time, or null when outside the loaded window. */
    readonly stepStartTime: number | null;
    /** First non-empty token delta event time, or null when none recorded. */
    readonly firstTokenTime: number | null;
    /** Event time of the usage record this sample was last computed from. */
    readonly usageTime: number | null;
    /**
     * Durable seq of the last event this sample was measured from.
     *
     * It is what lets a folded brick ask the session for the history it needs
     * (`loadThrough(seq)`) even though the fold has no attempt identity of its own.
     */
    readonly seq?: number;
}
/** State accumulated for one Turn: one sample per assistant step. */
export interface CacheBricksState {
    readonly turn: number;
    readonly steps: ReadonlyMap<number, StepSample>;
    /** True once the Turn's `turn/end` has been seen. */
    readonly ended: boolean;
}
/** Published view data: the Turn's steps in step order. */
export interface CacheBricksNodeData {
    readonly turn: number;
    readonly steps: readonly StepSample[];
    readonly ended: boolean;
}
/**
 * One Turn's per-step prompt-cache reading, published as a HIDDEN chat node.
 *
 * The node is a data carrier, not a row: the Chat flow renders only
 * `visibility === 'visible'` nodes (`isVisibleChatNode`), while the Chat node
 * store's `values()` keeps every materialized node — so this node never appears
 * in (or is folded by) the conversation, and the composer-dock chip reads it
 * from the store with `useChat`. Nothing about the display depends on the
 * Turn's process disclosure.
 *
 * Why a Turn: the row needs one sample per assistant step. The Turn number is
 * the stable identity the Chat store is keyed by, and a Turn-level context sees
 * every step's live chunk usage as it streams, so the dock reading grows
 * chip by chip while the Turn runs.
 *
 * A Turn whose provider never reports usage publishes nothing.
 */
export declare const cacheBricksDefinition: ConversationNodeDefinition<CacheBricksState>;
export type { ConversationNodeContext, ConversationViewNode };
