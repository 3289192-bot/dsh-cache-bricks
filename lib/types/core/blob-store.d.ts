/** What the store hands back for a stored payload. */
export interface StoredBlob {
    /** Stable content hash, usable as a ref. */
    readonly hash: string;
    readonly bytes: number;
    /** False when the payload already existed (the common case). */
    readonly added: boolean;
}
/** Store counters, surfaced to the UI so memory use is never a mystery. */
export interface BlobStoreStats {
    readonly blobs: number;
    readonly bytes: number;
    readonly hits: number;
    readonly misses: number;
    /** Payloads refused for exceeding the per-blob limit. */
    readonly skipped: number;
    /** Payloads dropped to stay under the total byte budget. */
    readonly evicted: number;
}
/** Limits that keep a long session from growing without bound. */
export interface BlobStoreOptions {
    /** Largest single payload kept; bigger ones are refused and reported. */
    readonly maxBlobBytes?: number;
    /** Total bytes kept across all payloads; the least recently used go first. */
    readonly maxTotalBytes?: number;
    /** Hard cap on payload count, independent of their size. */
    readonly maxBlobs?: number;
}
/** Content-addressed store with LRU eviction. */
export declare class BlobStore {
    private readonly blobs;
    private readonly maxBlobBytes;
    private readonly maxTotalBytes;
    private readonly maxBlobs;
    private bytes;
    private hits;
    private misses;
    private skipped;
    private evicted;
    constructor(options?: BlobStoreOptions);
    /**
     * Store a payload and return its ref.
     * @param value - any JSON-serializable payload.
     * @returns the ref and size, or undefined when the payload is too large to keep.
     */
    put(value: unknown): StoredBlob | undefined;
    /**
     * Read a payload back.
     * @param hash - the ref returned by {@link put}.
     * @returns the payload, or undefined when it was never stored or has been evicted.
     */
    get(hash: string): unknown;
    /** True when a ref is still resolvable. */
    has(hash: string): boolean;
    /** Current counters. */
    stats(): BlobStoreStats;
    /** Drop everything (used when a session ends). */
    clear(): void;
    private evict;
}
