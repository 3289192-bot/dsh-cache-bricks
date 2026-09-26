import type { CacheUsage } from '../shared/cache-brick';
/** One settled attempt, as the log records it. */
export interface LogSettlement {
    readonly turn: number;
    readonly step: number;
    readonly time?: number;
    readonly usage?: CacheUsage;
    readonly stream?: readonly unknown[];
}
/** What one pass over a session log produced. */
export interface LogRead {
    /** Settled attempts, oldest first — one brick each. */
    readonly settlements: readonly LogSettlement[];
    /** Turns whose `turn/end` the log holds. */
    readonly endedTurns: readonly number[];
    /** Records seen (a size, not a reading). */
    readonly records: number;
    /** Settlement-shaped records with no `(turn, step)`: auxiliary calls, which have no column. */
    readonly skipped: number;
    /** Frames decoded; a torn final frame is not one of them. */
    readonly frames: number;
}
/**
 * Locate the complete frames in a log artifact.
 *
 * @param buffer - the bytes currently on disk.
 * @returns each frame's byte range, in order; an incomplete final frame is left out.
 */
export declare function frameRanges(buffer: Buffer): Array<{
    start: number;
    end: number;
}>;
/**
 * Decode every complete frame of a log artifact.
 *
 * @param buffer - the bytes currently on disk.
 * @returns the decoded text of each frame, oldest first.
 */
export declare function decodeFrames(buffer: Buffer): string[];
/** The last `usage` chunk inside a settled attempt's compact stream. */
export declare function usageFromStream(stream: readonly unknown[] | undefined): CacheUsage | undefined;
/**
 * Fold decoded log text into settlements.
 *
 * The log is JSONL: a session header record first, then one event per line. A torn tail line (the
 * log is being appended to while it is read) is ignored, which is why parsing a line is allowed to
 * fail without failing the read.
 *
 * @param chunks - the decoded text of each frame, oldest first.
 * @returns the settlements, the ended Turns, and counts for the two things that were not read.
 */
export declare function readLog(chunks: readonly string[]): LogRead;
/** Where a session's log lives, given the roots to search. */
export interface LogRootsOptions {
    /** Roots to search, in order. Defaults to `$DSH_SESSION_ROOT`, then `$DSH_HOME/sessions`. */
    readonly roots?: readonly string[];
}
/** The roots a session log may be under, most specific first. */
export declare function logRoots(options?: LogRootsOptions): string[];
/**
 * Find one session's log artifact.
 *
 * Layout is the harness's own: `sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd`. The
 * workspace slug is not derivable from a session id, so the directory is found by name.
 *
 * @param sessionId - the session to find.
 * @param options - where to look.
 * @returns the artifact's path, or undefined when this process cannot see it.
 */
export declare function findSessionLog(sessionId: string, options?: LogRootsOptions): Promise<string | undefined>;
/** What one backfill did. */
export interface BackfillOutcome extends LogRead {
    /** The artifact it read. */
    readonly path: string;
}
/**
 * Read one session's log, if this process can find it.
 *
 * @param sessionId - the session to read.
 * @param options - where to look.
 * @returns the settlements and the counts, or undefined when there is no log to read.
 */
export declare function readSessionLog(sessionId: string, options?: LogRootsOptions): Promise<BackfillOutcome | undefined>;
