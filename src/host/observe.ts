/**
 * Translating what the runtime emits into ledger observations.
 *
 * Everything here takes **plain data shaped like the runtime's own payloads** and
 * returns the normalized observations the ledger folds. No DSH import is needed
 * (the runtime types are structural), which is deliberate: the same code runs on
 * 0.1.6-alpha.1 and 0.1.7-rc.1, and it can be unit-tested by handing it fake
 * events instead of standing up a harness.
 *
 * The one rule that matters more than any field: an observation must never
 * influence the request. The `llm/stream` tap reads the options and returns
 * `next()` untouched; nothing in this module mutates its input.
 */
import { contentRef } from '../shared/sha256'
import type { BrickFinish } from '../shared/brick'
import type {
  ChunkObservation,
  ContextSnapshot,
  DispatchOptions,
  HeaderSnapshot,
  Observation,
  RetrySnapshot,
  SettlementSnapshot,
  UsageSnapshot,
} from './brick-ledger'
import type { BlobStore } from './blob-store'

/** The subset of `GenerateOptions` this observer reads. */
export interface RequestLike {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
  readonly system?: string
  readonly tools?: readonly unknown[]
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
  readonly toolHistory?: ToolHistoryLike
  readonly messages?: readonly MessageLike[]
  readonly sessionId?: string
  readonly purpose?: 'compaction' | 'session-title'
}

/**
 * The subset of `ToolHistory` (0.1.7-rc.2+) this observer reads.
 *
 * `tools` is the complete active set at the start of the history; each `updates` entry is a
 * developer message plus the definitions its `tool-addition` blocks activated, already
 * resolved from the historical request header the block referenced.
 */
export interface ToolHistoryLike {
  readonly tools?: readonly unknown[]
  readonly updates?: readonly {
    readonly messageId?: string
    readonly additions?: readonly unknown[]
  }[]
}

/** True when a declaration is deferred until a later developer message activates it. */
export function isDeferredTool(tool: unknown): boolean {
  return tool !== null && typeof tool === 'object' && (tool as { deferLoading?: unknown }).deferLoading === true
}

/** The name a declaration is keyed by, when it carries one. */
function toolNameOf(tool: unknown): string | undefined {
  const name = (tool as { name?: unknown } | null)?.name
  return typeof name === 'string' && name !== '' ? name : undefined
}

/**
 * The definitions a tool history contributes, in the order the history added them.
 * @param history - the request's `toolHistory`, when it carries one.
 * @returns the added declarations; empty for every core that predates the field.
 */
export function toolAdditionsOf(history: ToolHistoryLike | undefined): readonly unknown[] {
  const additions: unknown[] = []
  for (const update of history?.updates ?? []) {
    for (const tool of update.additions ?? []) additions.push(tool)
  }
  return additions
}

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
export function effectiveToolsOf(tools: readonly unknown[], additions: readonly unknown[]): readonly unknown[] {
  const seen = new Set<string>()
  const effective: unknown[] = []
  for (const tool of [...tools, ...additions]) {
    const name = toolNameOf(tool)
    if (name !== undefined) {
      if (seen.has(name)) continue
      seen.add(name)
    }
    if (isDeferredTool(tool)) {
      const { deferLoading: _deferred, ...rest } = tool as Record<string, unknown>
      effective.push(rest)
      continue
    }
    effective.push(tool)
  }
  return effective
}

/** The additions that genuinely extend the declared list, i.e. names it did not already carry. */
export function newToolAdditionsOf(tools: readonly unknown[], additions: readonly unknown[]): readonly unknown[] {
  const declared = new Set<string>()
  for (const tool of tools) {
    const name = toolNameOf(tool)
    if (name !== undefined) declared.add(name)
  }
  return additions.filter((tool) => {
    const name = toolNameOf(tool)
    return name !== undefined && !declared.has(name)
  })
}

/** The subset of a request message this observer reads. */
export interface MessageLike {
  readonly id?: string
  readonly role?: string
  readonly content?: unknown
  readonly source?: unknown
}

/** The subset of `StreamChunk` this observer reads. */
export type ChunkLike =
  | { readonly type: 'text-delta'; readonly text?: string }
  | { readonly type: 'reasoning-delta'; readonly text?: string }
  | { readonly type: 'tool-call-delta'; readonly id?: string; readonly name?: string; readonly argumentsDelta?: string }
  | { readonly type: 'usage'; readonly usage?: UsageLike }
  | { readonly type: 'finish'; readonly reason?: FinishLike }
  | { readonly type: string }

/** The subset of `TokenUsage` this observer reads. */
export interface UsageLike {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** The subset of `FinishReason` this observer reads. */
export interface FinishLike {
  readonly kind?: string
  readonly failure?: {
    readonly message?: string
    readonly code?: string
    readonly status?: number
    readonly providerRetryAfterMs?: number
    readonly requestId?: string
    readonly offloadImages?: number
  }
}

/** The subset of an `assistant/message` / `assistant/attempt` event this observer reads. */
export interface AssistantEventLike {
  readonly seq?: number | undefined
  readonly time?: number | undefined
  readonly data?: {
    readonly turn?: number
    readonly step?: number
    readonly usage?: UsageLike
    readonly interrupted?: true
    readonly stream?: readonly StreamRecordLike[]
  } | undefined
}

/** The subset of an `AssistantStreamRecord` this observer reads. */
export type StreamRecordLike =
  | { readonly type: 'chunk'; readonly time?: number; readonly chunk?: ChunkLike }
  | { readonly type: string }

/** The subset of a `request/header` event this observer reads. */
export interface HeaderEventLike {
  readonly seq?: number | undefined
  readonly data?: {
    readonly reason?: string
    readonly startsSeries?: true
    readonly header?: {
      readonly config?: Record<string, unknown>
      readonly adapterDefaults?: { readonly reasoningEffort?: boolean; readonly maxTokens?: boolean }
      readonly tools?: readonly unknown[]
    }
  }
}

/** The subset of a `request/context` event this observer reads. */
export interface ContextEventLike {
  readonly data?: {
    readonly provider?: string
    readonly model?: string
    readonly contextWindow?: number
    readonly systemPromptUpdate?: string
  } | undefined
}

/** The subset of an `llm/retry` event this observer reads. */
export interface RetryEventLike {
  readonly data?: {
    readonly retryId?: string
    /** The attempt the retry replaces. The runtime carries these; dropping them would
     * leave the ledger to guess which draft the retry belongs to. */
    readonly turn?: number
    readonly step?: number
    readonly provider?: string
    readonly mode?: string
    readonly policyKey?: string
    readonly retry?: number
    readonly maxRetries?: number
    readonly delayMs?: number
    readonly failure?: { readonly message?: string; readonly code?: string }
  } | undefined
}

/** The subset of a `tool/call` event this observer reads. */
export interface ToolCallEventLike {
  readonly time?: number | undefined
  readonly seq?: number | undefined
  readonly data?: { readonly callId?: string; readonly name?: string; readonly arguments?: string } | undefined
}

/** The subset of a `tool/result` event this observer reads. */
export interface ToolResultEventLike {
  readonly time?: number | undefined
  readonly data?: {
    readonly message?: { readonly toolCallId?: string; readonly content?: unknown; readonly isError?: boolean }
    readonly error?: { readonly name?: string; readonly code?: string; readonly reason?: string }
  } | undefined
}

/** Normalize provider usage, keeping absent buckets absent. */
export function usageOf(usage: UsageLike | undefined): UsageSnapshot | undefined {
  if (usage === undefined) return undefined
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  return {
    inputTokens: input,
    outputTokens: output,
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  }
}

/** Normalize a finish reason, which the runtime expresses as a tagged object. */
export function finishOf(reason: FinishLike | undefined): { reason: BrickFinish['reason']; failure?: NonNullable<BrickFinish['failure']> } | undefined {
  const kind = reason?.kind
  if (kind !== 'stop' && kind !== 'tool-calls' && kind !== 'max-tokens' && kind !== 'aborted' && kind !== 'error') {
    return undefined
  }
  const failure = reason?.failure
  if (failure === undefined || failure.message === undefined || failure.code === undefined) return { reason: kind }
  return {
    reason: kind,
    failure: {
      message: failure.message,
      code: failure.code,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs }),
      ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
      ...(failure.offloadImages === undefined ? {} : { offloadImages: failure.offloadImages }),
    },
  }
}

/** Map one live stream chunk to counts and terminal facts. */
export function chunkObservation(chunk: ChunkLike): ChunkObservation {
  switch (chunk.type) {
    case 'text-delta':
      return { type: 'text', chars: (chunk as { text?: string }).text?.length ?? 0 }
    case 'reasoning-delta':
      return { type: 'reasoning', chars: (chunk as { text?: string }).text?.length ?? 0 }
    case 'tool-call-delta': {
      const delta = chunk as { id?: string; name?: string; argumentsDelta?: string }
      return {
        type: 'tool-call',
        callId: delta.id ?? '',
        ...(delta.name === undefined ? {} : { name: delta.name }),
        argsChars: delta.argumentsDelta?.length ?? 0,
      }
    }
    case 'usage': {
      const usage = usageOf((chunk as { usage?: UsageLike }).usage)
      return usage === undefined ? { type: 'other' } : { type: 'usage', usage }
    }
    case 'finish': {
      const finish = finishOf((chunk as { reason?: FinishLike }).reason)
      return finish === undefined
        ? { type: 'other' }
        : { type: 'finish', reason: finish.reason, ...(finish.failure === undefined ? {} : { failure: finish.failure }) }
    }
    default:
      return { type: 'other' }
  }
}

/** Read the last `usage` chunk out of a durable compact stream. */
export function usageFromStream(stream: readonly StreamRecordLike[] | undefined): UsageSnapshot | undefined {
  let found: UsageSnapshot | undefined
  for (const record of stream ?? []) {
    if (record.type !== 'chunk') continue
    const chunk = (record as { chunk?: ChunkLike }).chunk
    if (chunk?.type !== 'usage') continue
    found = usageOf((chunk as { usage?: UsageLike }).usage) ?? found
  }
  return found
}

/**
 * Read the terminal finish out of a durable compact stream.
 *
 * Neither `assistant/message` nor `assistant/attempt` carries a finish reason at
 * the top level — it exists only as the stream's final `finish` chunk.
 */
export function finishFromStream(stream: readonly StreamRecordLike[] | undefined): ReturnType<typeof finishOf> {
  let found: ReturnType<typeof finishOf>
  for (const record of stream ?? []) {
    if (record.type !== 'chunk') continue
    const chunk = (record as { chunk?: ChunkLike }).chunk
    if (chunk?.type !== 'finish') continue
    found = finishOf((chunk as { reason?: FinishLike }).reason) ?? found
  }
  return found
}

/** Read the adapter's private replay state out of a durable stream. */
function replayFromStream(stream: readonly StreamRecordLike[] | undefined): unknown {
  for (const record of stream ?? []) {
    if (record.type !== 'chunk') continue
    const chunk = (record as { chunk?: { type?: string; replayState?: unknown } }).chunk
    if (chunk?.type === 'finish' && chunk.replayState !== undefined) return chunk.replayState
  }
  return undefined
}

/**
 * Cheap structural fingerprint of a message, used to guard the hash memo.
 *
 * The runtime promises that a durable message's identity and content survive
 * every boundary, so hashing a 600K-token history on every request would be pure
 * waste. But a memo keyed on the id alone would silently report "prefix shared"
 * for content that changed, which is worse than being slow — so a cache hit also
 * requires this fingerprint (role, block count and types, total characters) to
 * match. An edit that keeps the same id, the same block shape *and* the same
 * character count can still slip through; nothing in the runtime can produce one.
 */
function messageFingerprint(message: MessageLike): string {
  const content = Array.isArray(message.content) ? (message.content as readonly unknown[]) : []
  let chars = 0
  let types = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') {
      types += '?'
      continue
    }
    const record = block as Record<string, unknown>
    types += typeof record.type === 'string' ? (record.type[0] ?? '?') : '?'
    if (typeof record.text === 'string') chars += record.text.length
    else if (typeof record.arguments === 'string') chars += record.arguments.length
    else if (typeof record.content === 'string') chars += record.content.length
  }
  return `${message.role ?? '?'}|${String(content.length)}|${types}|${String(chars)}`
}

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
export class RequestSummarizer {
  private readonly store: BlobStore
  private readonly memo = new Map<string, string>()
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
  private readonly previousHashes: Record<'turn' | 'auxiliary', readonly string[]> = { turn: [], auxiliary: [] }

  constructor(store: BlobStore) {
    this.store = store
  }

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
  private refForMessage(message: MessageLike): { ref: string; added: boolean } {
    const memoizable = typeof message.id === 'string' && message.source !== undefined
    const key = memoizable ? `${message.id!}#${messageFingerprint(message)}` : undefined
    if (key !== undefined) {
      const cached = this.memo.get(key)
      if (cached !== undefined) return { ref: cached, added: false }
    }
    const stored = this.store.put(message)
    const ref = stored?.hash ?? contentRef(stableJson(message))
    if (key !== undefined) this.memo.set(key, ref)
    return { ref, added: stored?.added === true }
  }

  /**
   * Summarize one outgoing request.
   * @param options - the request the runtime is about to dispatch (read only).
   * @returns the options block for the brick, including how much of the message
   *   prefix it shares with the previous request **of the same kind** (a Turn request
   *   is measured against the previous Turn request, an auxiliary call against the
   *   previous auxiliary call — an auxiliary prompt is not the conversation).
   */
  summarize(options: RequestLike): DispatchOptions {
    const messages = options.messages ?? []
    const refs: string[] = []
    let storedMessages = 0
    for (const message of messages) {
      const { ref, added } = this.refForMessage(message)
      refs.push(ref)
      if (added) storedMessages += 1
    }
    // The baseline is the previous request **of the same kind** (see `previousHashes`): an
    // auxiliary call's prompt is not the conversation, so it must not become the thing the
    // next Turn request is measured against.
    const kind = options.purpose === undefined ? 'turn' : 'auxiliary'
    const baseline = this.previousHashes[kind]
    let shared = 0
    while (shared < refs.length && shared < baseline.length && refs[shared] === baseline[shared]) {
      shared += 1
    }
    this.previousHashes[kind] = refs

    const tools = options.tools ?? []

    // 0.1.7-rc.2 makes the declaration list history-relative: `tools` is what the
    // history started with, and `toolHistory` holds the additions later developer
    // messages activated. The adapter folds the two together before dispatch, but this
    // observer runs before that projection — so the effective list is reconstructed
    // here. It matters for the one thing the request block is *for*: the tools hash is
    // what the diff blames when a cached prefix breaks, and hashing only the base list
    // would let an added tool pass as "tools identical". With no additions (every
    // rc.1 / 0.1.6 request, and any rc.2 session that never defers a tool) the effective
    // list *is* the base list, so both the hash and the stored blob are unchanged.
    const additions = toolAdditionsOf(options.toolHistory)
    const effectiveTools = effectiveToolsOf(tools, additions)
    const addedTools = newToolAdditionsOf(tools, additions)
    const deferredTools = tools.filter(isDeferredTool).length
    let developerMessages = 0
    for (const message of messages) {
      if (message.role === 'developer') developerMessages += 1
    }
    const toolHistoryRef = options.toolHistory === undefined ? undefined : this.store.put(options.toolHistory)

    // Messages are stored **one by one** (see `refForMessage`), because that is
    // where the sharing is: request 274 differs from 273 by a handful of messages
    // out of 525, so storing the array per request would duplicate a megabyte
    // every call — a cache monitor that hoards the very prefix it measures.
    const messagesRef = this.store.put({ refs })

    // Tool schemas are the same 27 definitions on every request of a session, so
    // they get their own blob and dedupe across requests; inlining them in the
    // envelope made every request pay for them again just because the message
    // list had grown.
    const toolsRef = effectiveTools.length === 0 ? undefined : this.store.put({ tools: effectiveTools })

    // The envelope itself is tiny and changes only with the ref list.
    const requestRef = this.store.put({
      provider: options.provider,
      model: options.model,
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
      ...(options.system === undefined ? {} : { system: options.system }),
      toolSchemaCount: effectiveTools.length,
      ...(addedTools.length === 0 ? {} : { toolSchemaDeclared: tools.length, toolSchemaAdded: addedTools.length }),
      ...(additions.length === 0 ? {} : { toolSchemaActivated: additions.length }),
      ...(deferredTools === 0 ? {} : { deferredToolCount: deferredTools }),
      ...(developerMessages === 0 ? {} : { developerMessageCount: developerMessages }),
      ...(toolsRef === undefined ? {} : { toolsRef: toolsRef.hash }),
      ...(toolHistoryRef === undefined ? {} : { toolHistoryRef: toolHistoryRef.hash }),
      // The ref list lives in its own blob (also exposed as `messageHashesRef`),
      // so the envelope holds a pointer instead of a second copy of 600 refs.
      ...(messagesRef === undefined ? {} : { messageRefsRef: messagesRef.hash }),
      messageCount: refs.length,
    })

    return {
      provider: options.provider ?? 'unknown',
      model: options.model ?? 'unknown',
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      messageCount: messages.length,
      ...(developerMessages === 0 ? {} : { developerMessageCount: developerMessages }),
      toolSchemaCount: effectiveTools.length,
      ...(addedTools.length === 0 ? {} : { toolSchemaDeclared: tools.length, toolSchemaAdded: addedTools.length }),
      ...(additions.length === 0 ? {} : { toolSchemaActivated: additions.length }),
      ...(deferredTools === 0 ? {} : { deferredToolCount: deferredTools }),
      ...(options.toolHistory === undefined ? {} : { toolUpdateMessages: options.toolHistory.updates?.length ?? 0 }),
      ...(toolHistoryRef === undefined ? {} : { toolHistoryRef: toolHistoryRef.hash }),
      ...(options.system === undefined ? {} : { systemHash: contentRef(options.system) }),
      ...(effectiveTools.length === 0 ? {} : { toolsHash: contentRef(stableJson(effectiveTools)) }),
      messagesHash: contentRef(refs.join(',')),
      messagesStored: storedMessages,
      ...(messagesRef === undefined ? {} : { messageHashesRef: messagesRef.hash }),
      sharedMessagePrefix: shared,
      ...(requestRef === undefined ? {} : { requestRef: requestRef.hash }),
    }
  }
}

/** JSON with object keys sorted, so equal payloads hash equally. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
    if (item instanceof AbortSignal) return undefined
    const source = item as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      if (key === 'signal') continue
      sorted[key] = source[key]
    }
    return sorted
  }) ?? 'null'
}

/** Build the observation for a `request/header` event. */
export function headerObservation(event: HeaderEventLike, store: BlobStore): Observation | undefined {
  const data = event.data
  if (data?.header === undefined) return undefined
  const reason = data.reason
  const headerHash = contentRef(stableJson(data.header))
  const ref = store.put(data.header)
  const tools = data.header.tools ?? []
  const snapshot: HeaderSnapshot = {
    seq: event.seq ?? 0,
    reason: reason === 'resume' || reason === 'change' || reason === 'series' ? reason : 'initial',
    ...(data.startsSeries === true ? { startsSeries: true } : {}),
    ...(data.header.adapterDefaults === undefined ? {} : { adapterDefaults: data.header.adapterDefaults }),
    headerHash,
    ...(ref === undefined ? {} : { headerRef: ref.hash }),
    ...(tools.length === 0 ? {} : { toolsHash: contentRef(stableJson(tools)) }),
    toolSchemaCount: tools.length,
  }
  return { kind: 'header', snapshot }
}

/** The subset of a `compaction/start` event this observer reads. */
export interface CompactionEventLike {
  readonly data?: { readonly compactionId?: string } | undefined
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
export function compactionObservation(event: CompactionEventLike): Observation | undefined {
  const compactionId = event.data?.compactionId
  if (typeof compactionId !== 'string' || compactionId === '') return undefined
  return { kind: 'compaction', compactionId }
}

/** Build the observation for a `request/context` event. */
export function contextObservation(event: ContextEventLike): Observation | undefined {
  const data = event.data
  if (data?.provider === undefined || data.model === undefined) return undefined
  const snapshot: ContextSnapshot = {
    provider: data.provider,
    model: data.model,
    ...(data.contextWindow === undefined ? {} : { contextWindow: data.contextWindow }),
    ...(data.systemPromptUpdate === 'in-history' ? { systemPromptUpdate: 'in-history' as const } : {}),
  }
  return { kind: 'context', snapshot }
}

/** Build the observation for an `llm/retry` event. */
export function retryObservation(event: RetryEventLike): Observation | undefined {
  const data = event.data
  if (data?.retryId === undefined || data.retry === undefined) return undefined
  const snapshot: RetrySnapshot = {
    retryId: data.retryId,
    ...(data.turn === undefined ? {} : { turn: data.turn }),
    ...(data.step === undefined ? {} : { step: data.step }),
    provider: data.provider ?? 'unknown',
    mode: data.mode === 'always' ? 'always' : 'normal',
    policyKey: data.policyKey ?? '',
    retry: data.retry,
    ...(data.maxRetries === undefined ? {} : { maxRetries: data.maxRetries }),
    delayMs: data.delayMs ?? 0,
    ...(data.failure?.message === undefined ? {} : { failureMessage: data.failure.message }),
    ...(data.failure?.code === undefined ? {} : { failureCode: data.failure.code }),
  }
  return { kind: 'retry', snapshot }
}

/**
 * Build the observation for an `assistant/message` or `assistant/attempt` event.
 *
 * Usage comes from `data.usage` when present and from the embedded stream
 * otherwise: `assistant/attempt` never carries usage, so a failed attempt would
 * otherwise look free.
 */
export function settlementObservation(event: AssistantEventLike, store: BlobStore): Observation | undefined {
  const data = event.data
  if (data?.turn === undefined || data.step === undefined) return undefined
  const stream = data.stream
  const usage = usageOf(data.usage) ?? usageFromStream(stream)
  const finish = finishFromStream(stream)
  const streamRef = store.put(stream ?? [])
  const replay = replayFromStream(stream)
  const replayRef = replay === undefined ? undefined : store.put(replay)
  const snapshot: SettlementSnapshot = {
    seq: event.seq ?? 0,
    time: event.time ?? Date.now(),
    // The event names the attempt it settles; carrying the identity is what lets the
    // ledger find the draft instead of assuming the newest one is it.
    turn: data.turn,
    step: data.step,
    settlement: data.usage === undefined && usage === undefined ? 'attempt' : 'message',
    ...(usage === undefined ? {} : { usage }),
    ...(data.interrupted === true ? { interrupted: true } : {}),
    ...(finish === undefined ? {} : { finishReason: finish.reason }),
    ...(finish?.failure === undefined ? {} : { failure: finish.failure }),
    ...(streamRef === undefined ? {} : { streamRef: streamRef.hash }),
    ...(replayRef === undefined ? {} : { replayRef: replayRef.hash }),
  }
  return { kind: 'settled', snapshot }
}

/** Build the observation for a durable `tool/call` event. */
export function toolCallObservation(event: ToolCallEventLike, store: BlobStore): Observation | undefined {
  const data = event.data
  if (data?.callId === undefined) return undefined
  const ref = data.arguments === undefined ? undefined : store.put(data.arguments)
  return {
    kind: 'tool-call',
    at: event.time ?? Date.now(),
    seq: event.seq ?? 0,
    callId: data.callId,
    name: data.name ?? '',
    ...(ref === undefined ? {} : { argumentsRef: ref.hash }),
    ...(data.arguments === undefined ? {} : { argumentsChars: data.arguments.length }),
  }
}

/** Build the observation for a durable `tool/result` event. */
export function toolResultObservation(event: ToolResultEventLike, store: BlobStore): Observation | undefined {
  const message = event.data?.message
  const callId = message?.toolCallId
  if (callId === undefined) return undefined
  const ref = store.put(message?.content ?? null)
  return {
    kind: 'tool-result',
    at: event.time ?? Date.now(),
    callId,
    ...(message?.isError === undefined ? {} : { isError: message.isError }),
    ...(event.data?.error === undefined
      ? {}
      : {
        error: {
          name: event.data.error.name ?? 'Error',
          code: event.data.error.code ?? 'unknown',
          ...(event.data.error.reason === undefined ? {} : { reason: event.data.error.reason }),
        },
      }),
    ...(ref === undefined ? {} : { resultRef: ref.hash }),
  }
}
