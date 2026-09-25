import type {
  ConversationNodeContext, ConversationNodeDefinition, ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { CacheUsage } from './logic'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One Turn's per-step prompt-cache row, anchored outside the Turn's fold. */
    'cache-bricks': CacheBricksNodeData
  }
}

/** Stable business identity for one Turn. */
function turnIdFor(turn: number): string {
  return `turn:${turn}`
}

/** The Turn a node id names, for a rebuild whose state is gone. */
function turnOfId(id: string): number | undefined {
  const match = /^turn:(\d+)$/u.exec(id)
  return match === null ? undefined : Number(match[1])
}

/**
 * Node ids this Definition has already materialized, for the lifetime of the page.
 *
 * The assembler refuses a rebuild that withdraws one of them, and losing that rebuild loses
 * the history page that triggered it — so this is a correctness guard, not a cache.
 */
const publishedTurns = new Set<string>()

/** One assistant step's own accounting (one `llm/stream` call). */
export interface StepSample {
  readonly step: number
  /** Token accounting from the stream's usage chunk (or assistant/message fallback). */
  readonly usage: CacheUsage | undefined
  /** Provider id from the finalized assistant message, when available. */
  readonly provider: string | undefined
  /** step/start event time, or null when outside the loaded window. */
  readonly stepStartTime: number | null
  /** First non-empty token delta event time, or null when none recorded. */
  readonly firstTokenTime: number | null
  /** Event time of the usage record this sample was last computed from. */
  readonly usageTime: number | null
  /**
   * Durable seq of the last event this sample was measured from.
   *
   * It is what lets a folded brick ask the session for the history it needs
   * (`loadThrough(seq)`) even though the fold has no attempt identity of its own.
   */
  readonly seq?: number
}

/** State accumulated for one Turn: one sample per assistant step. */
export interface CacheBricksState {
  readonly turn: number
  readonly steps: ReadonlyMap<number, StepSample>
  /** True once the Turn's `turn/end` has been seen. */
  readonly ended: boolean
}

/** Published view data: the Turn's steps in step order. */
export interface CacheBricksNodeData {
  readonly turn: number
  readonly steps: readonly StepSample[]
  readonly ended: boolean
}

/** The event fields this node reads, structurally (avoids a runtime type import). */
interface TurnEvent {
  readonly type: 'turn/start' | 'turn/end' | 'step/start' | 'step/end' | 'assistant/chunk' | 'assistant/live-chunk' | 'assistant/message' | (string & {})
  readonly time: number
  readonly seq?: number
  readonly data: {
    readonly turn: number
    readonly step: number
    readonly chunk?: { readonly type: string; readonly text?: string; readonly name?: string; readonly argumentsDelta?: string; readonly usage?: CacheUsage }
    readonly usage?: CacheUsage
    readonly message?: {
      readonly source?: { readonly provider?: string }
      readonly provenance?: { readonly provider?: string }
    }
  }
}

/**
 * Events this Definition accepts, with their lifecycle role.
 *
 * The live half is `assistant/live-chunk` — the client-only transient row the session
 * controller publishes between durable events (`AssistantLiveChunkEvent`,
 * `dsh-api-session-controller`: its `event.type` is literally that string, and `seq` is a
 * **fractional** ordering key between two durable seqs). `assistant/chunk` is the name the
 * session *format migrations* use; it is accepted too so a replayed or older window still
 * folds, but it is not what this core emits.
 */
const START_EVENTS = new Set(['turn/start', 'step/start'])
const UPDATE_EVENTS = new Set(['assistant/live-chunk', 'assistant/chunk', 'assistant/message', 'turn/end', 'step/end'])

/** True for the live transient chunk event, under either of its names. */
function isLiveChunk(type: string): boolean {
  return type === 'assistant/live-chunk' || type === 'assistant/chunk'
}

/** Empty sample for a step before any of its events is observed. */
function emptySample(step: number): StepSample {
  return {
    step,
    usage: undefined,
    provider: undefined,
    stepStartTime: null,
    firstTokenTime: null,
    usageTime: null,
  }
}

/** Copy the Turn state with one step's sample patched. */
function patchStep(state: CacheBricksState, step: number, patch: Partial<StepSample>): CacheBricksState {
  const steps = new Map(state.steps)
  steps.set(step, { ...(steps.get(step) ?? emptySample(step)), ...patch })
  return { ...state, steps }
}

/** Whether a chunk carries a non-empty delta — the first-token boundary. */
function isTokenDeltaEvent(event: TurnEvent): boolean {
  const chunk = event.data.chunk
  if (chunk === undefined) return false
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta': return chunk.text !== ''
    case 'tool-call-delta': return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default: return false
  }
}

/** Pure fold: one session event into the Turn's per-step state. */
/**
 * The seq to stamp on a sample this event just updated.
 *
 * **Integers only.** A durable session seq is an integer; the live transient chunk row is
 * ordered by a fractional key (`durableCursor + 1 - 1/(k+1)`) so it can sit between two
 * durable events. That key is a sort order, not a log position — stamping it on a sample
 * would hand `loadThrough()` a seq the session log does not have.
 */
function seqOf(event: TurnEvent): { seq?: number } {
  return typeof event.seq === 'number' && Number.isSafeInteger(event.seq) ? { seq: event.seq } : {}
}

function applyEvent(state: CacheBricksState, event: TurnEvent): CacheBricksState {
  switch (event.type) {
    case 'turn/start':
      return { ...state, turn: event.data.turn }
    case 'step/start': {
      const existing = state.steps.get(event.data.step)
      return patchStep(state, event.data.step, {
        stepStartTime: existing?.stepStartTime ?? event.time,
        ...seqOf(event),
      })
    }
    case 'assistant/live-chunk':
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      if (chunk === undefined) return state
      if (chunk.type === 'usage') {
        return patchStep(state, event.data.step, {
          usage: chunk.usage as CacheUsage,
          usageTime: event.time,
          ...seqOf(event),
        })
      }
      if (isTokenDeltaEvent(event) && (state.steps.get(event.data.step)?.firstTokenTime ?? null) === null) {
        return patchStep(state, event.data.step, { firstTokenTime: event.time })
      }
      return state
    }
    case 'assistant/message': {
      const existing = state.steps.get(event.data.step)
      const usage = event.data.usage as CacheUsage | undefined
      // Real AssistantMessage carries `source.provider`; keep `provenance` as a
      // structural fallback for adapters/versions that use the older field.
      const message = event.data.message
      const provider = existing?.provider
        ?? message?.source?.provider
        ?? message?.provenance?.provider
      // Providers that report no separate usage chunk still settle usage on the
      // finalized message; keep whichever accounting is present.
      const settled = existing?.usage ?? usage
      return patchStep(state, event.data.step, {
        usage: settled,
        provider,
        usageTime: existing?.usageTime ?? (usage === undefined ? null : event.time),
        ...seqOf(event),
      })
    }
    case 'turn/end':
      return { ...state, ended: true }
    default:
      return state
  }
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
export const cacheBricksDefinition: ConversationNodeDefinition<CacheBricksState> = {
  kind: 'cache-bricks',
  target: 'chat',
  match: (event) => {
    const type = event.type
    if (!START_EVENTS.has(type) && !UPDATE_EVENTS.has(type)) return null
    const { turn } = event.data as { turn?: number }
    if (typeof turn !== 'number') return null
    return { id: turnIdFor(turn), role: START_EVENTS.has(type) ? 'start' : 'update' }
  },
  start: (_context, match) => {
    const event = match.event as TurnEvent
    const base: CacheBricksState = { turn: event.data.turn, steps: new Map(), ended: false }
    return applyEvent(base, event)
  },
  update: (context, match) => applyEvent(context.state, match.event as TurnEvent),
  publication: (match) => {
    // The row changes the moment a step's accounting lands, so it is published
    // while later steps are still streaming; turn/end only marks the Turn closed.
    const event = match.event as TurnEvent
    if (isLiveChunk(event.type) && event.data.chunk?.type === 'usage') return 'immediate'
    if (event.type === 'assistant/message' || event.type === 'turn/end') return 'immediate'
    return 'none'
  },
  buildLocationData: () => null,
  buildViewNode: (context): ChatConversationViewNode | null => {
    const state = context.state
    const steps = state === undefined
      ? []
      : [...state.steps.values()]
        .filter((sample) => sample.usage !== undefined)
        .sort((left, right) => left.step - right.step)
    // **A node this Definition already materialized may never be withdrawn.** The
    // conversation assembler throws when a rebuild turns a node into `null`
    // (`dsh-client-ui-conversation`, `buildTargetUpserts`: "withdrew materialized target …
    // return the same key with hidden visibility instead"), and that throw loses the whole
    // flush — which is how a *page of history that had just been loaded* failed to render and
    // left the jump with nothing to land on.
    //
    // Two rebuilds can empty this node's steps without the turn having gone anywhere: a
    // prepend replays the window, and a step whose usage arrived on a client-only
    // `assistant/live-chunk` has no durable record to replay. So a turn that has published
    // once keeps publishing, with whatever it can still see — the node is hidden anyway, and
    // the board derives its bricks from the usage it does hold.
    const published = publishedTurns.has(context.id)
    if (!published && (state === undefined || steps.length === 0)) return null
    publishedTurns.add(context.id)
    const turn = state === undefined ? turnOfId(context.id) : state.turn
    if (turn === undefined) return null
    return {
      key: context.key,
      kind: 'cache-bricks',
      id: context.id,
      target: 'chat',
      anchorSeq: context.matches.at(-1)?.event.seq ?? context.start?.event.seq ?? 0,
      location: context.matches.at(-1)?.location ?? context.start?.location ?? { kind: 'unresolved' },
      // Hidden on purpose: the composer-dock chip renders this reading, not the
      // Chat flow (see the Definition doc above).
      visibility: 'hidden',
      data: {
        turn,
        steps,
        ended: state?.ended === true,
      } satisfies CacheBricksNodeData,
    }
  },
}

export type { ConversationNodeContext, ConversationViewNode }
