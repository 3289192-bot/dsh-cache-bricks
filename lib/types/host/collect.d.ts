/**
 * The host half: watch real model calls, and drop a brick when one settles.
 *
 * Three taps, and the smallest possible amount of work behind each:
 *
 * | tap | what it is for | what is done with it |
 * |---|---|---|
 * | `llm/stream` | the request itself | counted — a request that settles is a brick, and the count says so |
 * | `agent/assistant-stream` | identity (`turn`, `step`, `attemptId`) and live chunks | `start` opens an attempt; a `usage` chunk is a placeholder; **deltas are not looked at** |
 * | `session/event` | the durable settlement with the billed usage | the brick: one per `assistant/message` / `assistant/attempt` |
 *
 * That is the whole collector. There is no blob store, no request summarizer, no context
 * snapshot, no retry bookkeeping and no tool tracking, because none of them are part of a brick
 * (see `shared/cache-brick.ts`). The only structural care taken is the one that matters: this
 * code runs **inside the model-call path**, so every read of a payload is guarded, `next()` is
 * always returned untouched, and nothing is ever thrown back into the caller.
 */
import { AttemptTracker } from './attempt-tracker';
import { BrickFeeds, type SessionFeed } from './brick-feed';
/** The parts of the plugin's Cordis context this half uses, structurally. */
export interface HostContextLike {
    on(event: string, listener: (...args: never[]) => unknown, options?: {
        global?: boolean;
        prepend?: boolean;
    }): unknown;
    get(name: string): unknown;
    inject(names: string[], callback: (ctx: HostContextLike) => void): unknown;
    effect(callback: () => void): unknown;
}
/** Capacity and serving options, from the plugin row's config. */
export interface CollectorOptions {
    /** Bricks kept per session, newest last. */
    readonly capacity?: number;
    /** Sessions kept. */
    readonly sessions?: number;
    /** Route prefix; defaults to `/cache-bricks`. */
    readonly basePath?: string;
    /**
     * Read a session's own log once, when a browser first asks for its bricks (default true).
     *
     * This is the only history this build touches, and it is why an old session is not a blank
     * gutter: the log's settled attempts become the same eleven-field bricks, oldest first, into the
     * same ring. Set false for a host that must not read session artifacts at all.
     */
    readonly backfill?: boolean;
    /** Extra log roots to search, in order; defaults to `$DSH_SESSION_ROOT` then `$DSH_HOME/sessions`. */
    readonly logsRoots?: readonly string[];
    /** Set false to observe without serving (headless profiles, tests). */
    readonly serve?: boolean;
}
/** The collector's own surface, for tests and hosts. */
export interface Collector {
    readonly feeds: BrickFeeds;
    feed(sessionId: string): ReturnType<SessionFeed['snapshot']> | undefined;
    sessions(): string[];
    subscribe(sessionId: string, sink: (feed: ReturnType<SessionFeed['snapshot']>) => void): () => void;
    /** A reader is looking at this session: read its log once, if that has not happened yet. */
    looked(sessionId: string): void;
    dispose(): void;
}
/**
 * Install the collector.
 * @param ctx - the plugin's Cordis context.
 * @param options - capacity and serving options.
 * @returns the collector, so a host or a test can read it directly.
 */
export declare function installCollector(ctx: HostContextLike, options?: CollectorOptions): Collector;
/** The tracker type, re-exported for a host that wants to read a feed directly. */
export type { AttemptTracker };
