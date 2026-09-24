/**
 * Comparing two bricks: the reason this plugin exists.
 *
 * A single brick says "this request cached 0.2%". The interesting question is
 * always *what changed* between the request that cached 99.4% and the next one
 * that cached nothing — and DSH records enough to answer it: the request header
 * (with the reason it was re-logged), the tool schemas, the system prompt, the
 * message list, the route and the context snapshot are all observable, and each
 * one can be hashed. Equal hashes mean an identical payload; a changed hash means
 * the prefix broke there.
 *
 * Pure: it takes two records and returns rows. No DOM, no runtime imports.
 */
import type { BrickRecord } from './brick';
/** One compared field. */
export interface DiffRow {
    /** Grouping used by the panel: identity, route, request, context, cache, result. */
    readonly group: 'route' | 'request' | 'cache' | 'context' | 'result';
    readonly label: string;
    readonly before: string;
    readonly after: string;
    /** True when the two sides differ — the thing to look at. */
    readonly changed: boolean;
    /** Set for hash comparisons: equal hashes prove an identical payload. */
    readonly identicalPayload?: boolean;
    /**
     * True for rows that display a movement rather than a value (`+1,842`). They
     * describe the difference, so they are never counted as a difference.
     */
    readonly informational?: boolean;
}
/** The result of comparing two attempts. */
export interface BrickDiff {
    readonly rows: readonly DiffRow[];
    /** Every changed row, in panel order. */
    readonly changed: readonly DiffRow[];
    /** One sentence naming the first thing that broke, for the panel header. */
    readonly verdict: string;
}
/**
 * Compare two attempts of the same session.
 * @param before - the earlier brick.
 * @param after - the later brick.
 * @returns rows plus the changed subset and a one-line verdict.
 */
export declare function diffBricks(before: BrickRecord, after: BrickRecord): BrickDiff;
