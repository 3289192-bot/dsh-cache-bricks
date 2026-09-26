/**
 * Reading a session's own log — once, on request.
 *
 * This is the one place Lite touches history, and it is deliberately narrow: a session's
 * `.jsonl.zstd` artifact is opened **only when a browser asks for that session's bricks**, read in
 * one pass, and turned into the same eleven-field bricks the live path produces. Nothing is
 * stored: the bricks go into the same in-memory ring, which drops the oldest as it always does.
 *
 * The log is the harness's own artifact, so the decoding follows the harness's own reader
 * (`dsh-session-persistence-jsonl`): **Zstandard frames are located structurally** — magic,
 * descriptor, block headers — rather than by scanning for the magic bytes, which can also occur
 * inside compressed data. A frame that is incomplete at the tail (a log being written right now) is
 * skipped rather than guessed at, exactly as a reader of a live file should.
 *
 * What is read out of a record is what a brick is made of, and nothing else:
 *
 * - `assistant/message` / `assistant/attempt` → one settled attempt each (`turn`, `step`, and the
 *   usage it was billed, or the last `usage` chunk of its compact stream);
 * - `turn/end` → the mark that lets a finished stack step one cell left;
 * - everything else → not read at all.
 *
 * A prompt, a tool call, a request envelope: never touched, because a brick does not carry them.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { CacheUsage } from '../shared/cache-brick'

/** One settled attempt, as the log records it. */
export interface LogSettlement {
  readonly turn: number
  readonly step: number
  readonly time?: number
  readonly usage?: CacheUsage
  readonly stream?: readonly unknown[]
}

/** What one pass over a session log produced. */
export interface LogRead {
  /** Settled attempts, oldest first — one brick each. */
  readonly settlements: readonly LogSettlement[]
  /** Turns whose `turn/end` the log holds. */
  readonly endedTurns: readonly number[]
  /** Records seen (a size, not a reading). */
  readonly records: number
  /** Settlement-shaped records with no `(turn, step)`: auxiliary calls, which have no column. */
  readonly skipped: number
  /** Frames decoded; a torn final frame is not one of them. */
  readonly frames: number
}

/** Big-endian Zstandard frame magic, as a uint32 read little-endian — the harness's own constant. */
const ZSTD_MAGIC = 4247762216

/**
 * Locate the complete frames in a log artifact.
 *
 * @param buffer - the bytes currently on disk.
 * @returns each frame's byte range, in order; an incomplete final frame is left out.
 */
export function frameRanges(buffer: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = []
  // The artifact opens with a frame holding the session header, but tolerate a plaintext header:
  // the readable log begins at the first frame either way, and the bytes before it are not events.
  let offset = 0
  if (buffer.length >= 4 && buffer.readUInt32LE(0) !== ZSTD_MAGIC) {
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const at = buffer.indexOf(magic)
    if (at < 0) return frames
    offset = at
  }
  while (offset < buffer.length) {
    const start = offset
    // A frame needs at least magic + descriptor + one block header.
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    // Bits 3-4 are reserved and must be zero in a valid frame header.
    if ((descriptor & 24) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    // A frame may carry a 4-byte content checksum after its last block. Miss it and every frame
    // ends four bytes early — which is exactly what the real-log check below found.
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      // A reserved block type means this is not a frame boundary after all.
      if (blockType === 3) return frames
      // Raw and compressed blocks carry their bytes; an RLE block carries one.
      const payload = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payload) return frames
      offset += payload
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * Decode every complete frame of a log artifact.
 *
 * @param buffer - the bytes currently on disk.
 * @returns the decoded text of each frame, oldest first.
 */
export function decodeFrames(buffer: Buffer): string[] {
  const decoded: string[] = []
  for (const frame of frameRanges(buffer)) {
    try {
      decoded.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
    } catch {
      // A frame that fails validation ends the readable log rather than corrupting it.
      break
    }
  }
  return decoded
}

/** The last `usage` chunk inside a settled attempt's compact stream. */
export function usageFromStream(stream: readonly unknown[] | undefined): CacheUsage | undefined {
  let found: CacheUsage | undefined
  for (const record of stream ?? []) {
    if (record === null || typeof record !== 'object') continue
    const entry = record as { type?: unknown; chunk?: { type?: unknown; usage?: CacheUsage } }
    if (entry.type !== 'chunk' || entry.chunk?.type !== 'usage') continue
    if (entry.chunk.usage !== undefined) found = entry.chunk.usage
  }
  return found
}

/** A usage object, keeping absent cache buckets absent. */
function usageOf(usage: unknown): CacheUsage | undefined {
  if (usage === null || typeof usage !== 'object') return undefined
  const entry = usage as { inputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown }
  if (typeof entry.inputTokens !== 'number') return undefined
  return {
    inputTokens: entry.inputTokens,
    ...(typeof entry.cacheReadTokens === 'number' ? { cacheReadTokens: entry.cacheReadTokens } : {}),
    ...(typeof entry.cacheWriteTokens === 'number' ? { cacheWriteTokens: entry.cacheWriteTokens } : {}),
  }
}

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
export function readLog(chunks: readonly string[]): LogRead {
  const settlements: LogSettlement[] = []
  const endedTurns = new Set<number>()
  let records = 0
  let skipped = 0
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (line === '') continue
      let parsed: { type?: unknown; time?: unknown; data?: unknown }
      try {
        parsed = JSON.parse(line) as typeof parsed
      } catch {
        continue
      }
      records += 1
      const type = parsed.type
      if (type === 'turn/end') {
        const turn = (parsed.data as { turn?: unknown } | undefined)?.turn
        if (typeof turn === 'number') endedTurns.add(turn)
        continue
      }
      if (type !== 'assistant/message' && type !== 'assistant/attempt') continue
      const data = (parsed.data ?? {}) as { turn?: unknown; step?: unknown; usage?: unknown; stream?: unknown }
      if (typeof data.turn !== 'number' || typeof data.step !== 'number') {
        // An auxiliary call settles too and has no `(turn, step)`: no column, no brick.
        skipped += 1
        continue
      }
      const usage = usageOf(data.usage) ?? usageFromStream(Array.isArray(data.stream) ? data.stream : undefined)
      settlements.push({
        turn: data.turn,
        step: data.step,
        ...(typeof parsed.time === 'number' ? { time: parsed.time } : {}),
        ...(usage === undefined ? {} : { usage }),
        ...(Array.isArray(data.stream) ? { stream: data.stream } : {}),
      })
    }
  }
  return { settlements, endedTurns: [...endedTurns].sort((left, right) => left - right), records, skipped, frames: chunks.length }
}

/** Where a session's log lives, given the roots to search. */
export interface LogRootsOptions {
  /** Roots to search, in order. Defaults to `$DSH_SESSION_ROOT`, then `$DSH_HOME/sessions`. */
  readonly roots?: readonly string[]
}

/** The roots a session log may be under, most specific first. */
export function logRoots(options: LogRootsOptions = {}): string[] {
  if (options.roots !== undefined && options.roots.length > 0) return [...options.roots]
  const roots: string[] = []
  const explicit = process.env.DSH_SESSION_ROOT
  if (explicit !== undefined && explicit !== '') roots.push(explicit)
  const home = process.env.DSH_HOME
  roots.push(join(home !== undefined && home !== '' ? home : join(homedir(), '.dsh'), 'sessions'))
  return roots
}

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
export async function findSessionLog(sessionId: string, options: LogRootsOptions = {}): Promise<string | undefined> {
  for (const root of logRoots(options)) {
    let workspaces: string[]
    try {
      workspaces = await readdir(root)
    } catch {
      continue
    }
    for (const workspace of workspaces) {
      const dir = join(root, workspace, sessionId)
      try {
        const entries = await readdir(dir)
        const log = entries.find((name) => /^session\.v\d+\.jsonl\.zstd$/u.test(name))
        if (log !== undefined) return join(dir, log)
      } catch {
        // Not this workspace.
      }
    }
  }
  return undefined
}

/** What one backfill did. */
export interface BackfillOutcome extends LogRead {
  /** The artifact it read. */
  readonly path: string
}

/**
 * Read one session's log, if this process can find it.
 *
 * @param sessionId - the session to read.
 * @param options - where to look.
 * @returns the settlements and the counts, or undefined when there is no log to read.
 */
export async function readSessionLog(sessionId: string, options: LogRootsOptions = {}): Promise<BackfillOutcome | undefined> {
  const path = await findSessionLog(sessionId, options)
  if (path === undefined) return undefined
  const size = await stat(path).then((info) => info.size).catch(() => 0)
  // A log nobody has written to yet is not worth a read.
  if (size === 0) return undefined
  const buffer = await readFile(path)
  const chunks = decodeFrames(buffer)
  if (chunks.length === 0) return undefined
  return { path, ...readLog(chunks) }
}
