/**
 * Content-addressed store for the big half of a brick record.
 *
 * The interesting raw material of a model call — the exact request the provider
 * received, the tool schemas, the request header, the timed stream — is large and
 * mostly identical from attempt to attempt: the 274th call of a session is the
 * 273rd plus a few thousand tokens. Storing it per brick would turn a cache
 * monitor into a duplication engine, so raw payloads are hashed and kept once.
 * Bricks then hold refs, and two bricks that share a prefix share the bytes.
 *
 * Dependency-free (a local SHA-256, no Node builtins), so the same code runs in
 * either half and the store stays a plain data structure with its own unit tests
 * (dedupe, eviction, oversize handling).
 */
import { contentRef, utf8Length } from '../shared/sha256'

/** What the store hands back for a stored payload. */
export interface StoredBlob {
  /** Stable content hash, usable as a ref. */
  readonly hash: string
  readonly bytes: number
  /** False when the payload already existed (the common case). */
  readonly added: boolean
}

/** Store counters, surfaced to the UI so memory use is never a mystery. */
export interface BlobStoreStats {
  readonly blobs: number
  readonly bytes: number
  readonly hits: number
  readonly misses: number
  /** Payloads refused for exceeding the per-blob limit. */
  readonly skipped: number
  /** Payloads dropped to stay under the total byte budget. */
  readonly evicted: number
}

/** Limits that keep a long session from growing without bound. */
export interface BlobStoreOptions {
  /** Largest single payload kept; bigger ones are refused and reported. */
  readonly maxBlobBytes?: number
  /** Total bytes kept across all payloads; the least recently used go first. */
  readonly maxTotalBytes?: number
  /** Hard cap on payload count, independent of their size. */
  readonly maxBlobs?: number
}

const DEFAULT_MAX_BLOB_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 48 * 1024 * 1024
const DEFAULT_MAX_BLOBS = 4096

/**
 * Envelope key under which every payload is stored.
 *
 * Without it a string payload that happens to be valid JSON (`'{"path":"a.ts"}'`,
 * i.e. exactly the raw tool arguments) would read back as an object, and a
 * forensic store that does not return what you put in is not a store. Wrapping is
 * unambiguous because the store always wraps.
 */
const ENVELOPE = 'v'

/** Canonical JSON: key order fixed, so equal values always hash equally. */
function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
    const source = item as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) sorted[key] = source[key]
    return sorted
  }) ?? 'null'
}

/** Content-addressed store with LRU eviction. */
export class BlobStore {
  private readonly blobs = new Map<string, { text: string; bytes: number }>()
  private readonly maxBlobBytes: number
  private readonly maxTotalBytes: number
  private readonly maxBlobs: number
  private bytes = 0
  private hits = 0
  private misses = 0
  private skipped = 0
  private evicted = 0

  constructor(options: BlobStoreOptions = {}) {
    this.maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
    this.maxBlobs = options.maxBlobs ?? DEFAULT_MAX_BLOBS
  }

  /**
   * Store a payload and return its ref.
   * @param value - any JSON-serializable payload.
   * @returns the ref and size, or undefined when the payload is too large to keep.
   */
  put(value: unknown): StoredBlob | undefined {
    const text = canonicalize({ [ENVELOPE]: value })
    const bytes = utf8Length(text)
    if (bytes > this.maxBlobBytes) {
      this.skipped += 1
      return undefined
    }
    const hash = contentRef(text)
    const existing = this.blobs.get(hash)
    if (existing !== undefined) {
      // Re-insert to mark it as recently used.
      this.blobs.delete(hash)
      this.blobs.set(hash, existing)
      return { hash, bytes: existing.bytes, added: false }
    }
    this.blobs.set(hash, { text, bytes })
    this.bytes += bytes
    this.evict()
    return { hash, bytes, added: true }
  }

  /**
   * Read a payload back.
   * @param hash - the ref returned by {@link put}.
   * @returns the payload, or undefined when it was never stored or has been evicted.
   */
  get(hash: string): unknown {
    const entry = this.blobs.get(hash)
    if (entry === undefined) {
      this.misses += 1
      return undefined
    }
    this.hits += 1
    this.blobs.delete(hash)
    this.blobs.set(hash, entry)
    const parsed = JSON.parse(entry.text) as Record<string, unknown>
    return parsed[ENVELOPE]
  }

  /** True when a ref is still resolvable. */
  has(hash: string): boolean {
    return this.blobs.has(hash)
  }

  /** Current counters. */
  stats(): BlobStoreStats {
    return {
      blobs: this.blobs.size,
      bytes: this.bytes,
      hits: this.hits,
      misses: this.misses,
      skipped: this.skipped,
      evicted: this.evicted,
    }
  }

  /** Drop everything (used when a session ends). */
  clear(): void {
    this.blobs.clear()
    this.bytes = 0
  }

  private evict(): void {
    while (
      this.blobs.size > this.maxBlobs
      || (this.bytes > this.maxTotalBytes && this.blobs.size > 1)
    ) {
      const oldest = this.blobs.keys().next()
      if (oldest.done === true) return
      const entry = this.blobs.get(oldest.value)
      this.blobs.delete(oldest.value)
      if (entry !== undefined) this.bytes -= entry.bytes
      this.evicted += 1
    }
  }
}
