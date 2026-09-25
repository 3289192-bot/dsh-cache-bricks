import { BlobStore } from '../core/blob-store';
import type { BrickFeed } from '../shared/brick';
/** Structural view of the Cordis context this plugin uses. */
export interface HostContextLike {
    on(name: string, listener: (...args: never[]) => unknown, options?: {
        global?: boolean;
        prepend?: boolean;
    }): unknown;
    get(name: string): unknown;
    inject(names: readonly string[], callback: (ctx: HostContextLike) => void): unknown;
    effect(callback: () => void | (() => void)): unknown;
}
/** Options for {@link installCollector}. */
export interface CollectorOptions {
    /** Bricks kept per session in memory. */
    readonly maxBricks?: number;
    /** Session states kept before the least recently used is dropped. */
    readonly maxSessions?: number;
    /** Bytes kept per session in the blob store. */
    readonly maxStoreBytes?: number;
    /** Route namespace base path. */
    readonly basePath?: string;
    /** Disable the HTTP surface (used by tests). */
    readonly serve?: boolean;
}
/** The collector handle, exposed so a host can inspect what was gathered. */
export interface Collector {
    readonly store: BlobStore;
    feed(sessionId: string): BrickFeed | undefined;
    sessions(): readonly string[];
    blob(ref: string): unknown;
    subscribe(sessionId: string, sink: (feed: BrickFeed) => void): () => void;
    dispose(): void;
}
/**
 * Install the collector on a host context.
 * @param ctx - the plugin's Cordis context.
 * @param options - capacity and serving options.
 * @returns the collector, so tests and hosts can read from it directly.
 */
export declare function installCollector(ctx: HostContextLike, options?: CollectorOptions): Collector;
