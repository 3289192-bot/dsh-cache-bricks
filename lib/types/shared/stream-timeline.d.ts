/**
 * Expanding a durable compact stream into a readable timeline.
 *
 * DSH stores one model stream as `AssistantStreamRecord`s: raw `chunk` records
 * for block boundaries, usage and finish, and *runs* for deltas
 * (`text-chunks` / `reasoning-chunks` / `tool-call-chunks`) where every original
 * delta boundary and timestamp is recoverable from `time0` plus the `dt` gaps.
 *
 * A per-delta timeline of a 4,000-fragment answer would be unreadable, so a run
 * becomes **one** entry that reports when it started, how long it took, how many
 * fragments it packed and how much text it carried — the shape of the stream,
 * which is what a cache investigation actually looks at.
 *
 * Pure: takes plain records, returns entries. No runtime import, no DOM.
 */
/** One line of the stream timeline. */
export interface TimelineEntry {
    /** Epoch milliseconds, on the same wall clock as the session log. */
    readonly at: number;
    readonly kind: 'text' | 'reasoning' | 'tool-call' | 'block-start' | 'block-end' | 'usage' | 'finish' | 'other';
    /** Stream block index, when the record carries one. */
    readonly index?: number;
    /** Human-readable detail: sizes for runs, the reason for a finish, and so on. */
    readonly detail: string;
    /** Fragments packed into this entry (1 for a raw record). */
    readonly fragments: number;
    /** Span covered by those fragments, in milliseconds. */
    readonly spanMs: number;
    /** Characters carried by this entry, for the totals above the timeline. */
    readonly chars: number;
}
/** What a timeline adds up to. */
export interface TimelineSummary {
    readonly chunks: number;
    readonly textChars: number;
    readonly reasoningChars: number;
    readonly toolCalls: number;
    readonly firstTokenAt?: number;
    readonly usageAt?: number;
    readonly finishAt?: number;
    readonly finishReason?: string;
}
/**
 * Expand stream records into timeline entries.
 * @param records - the durable stream, as stored by the runtime.
 * @returns entries in stream order; unreadable records are skipped.
 */
export declare function expandStreamRecords(records: readonly unknown[]): TimelineEntry[];
/**
 * Add a timeline up.
 * @param entries - entries from {@link expandStreamRecords}.
 * @returns the totals the panel shows above the timeline.
 */
export declare function summarizeTimeline(entries: readonly TimelineEntry[]): TimelineSummary;
/** Format a wall-clock time for the timeline gutter. */
export declare function timelineClock(at: number): string;
