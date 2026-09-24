/**
 * The one way this plugin gets from a brick to the transcript it came from.
 *
 * There used to be two, and neither was a mechanism:
 *
 * - the panel opened from the collected record, and knew nothing about the conversation;
 * - the jump paged history in by clicking the Turn navigator and then the "load older"
 *   control up to eight times, hoping each click would land. It clicked controls that belong
 *   to another component's state machine, and it could not reach anything that navigator
 *   could not — which is most of a long session. Worse, when it stopped short it flashed a
 *   *nearby* row, so a reader was told the request had been found when it had not.
 *
 * The official client session face has the real thing:
 *
 * - `ISession.loadThrough(seq)` — `dsh-api-session-controller`, documented as **the turn-jump
 *   loader**: it pages history backwards until the window covers `seq`, repeated calls lower a
 *   shared target, and `snapshot.loadingOlder` is the busy signal for the whole jump
 *   (`lib/types/client/contract/session.d.ts:130-141`);
 * - `ISession.eventSource` — the observable **contiguous event window**
 *   (`lib/types/client/contract/events.d.ts:57-63`). This is what the inspector reads to show
 *   the conversation around a brick: the durable events themselves, not a scrape of the DOM;
 * - `ISession.getSnapshot()` — `hasMore` / `loadingOlder` (`contract/snapshot.d.ts`).
 *
 * It is reached through the sessions service — "the sessions-service face injected as
 * `ctx.sessions`" (`contract/sessions.d.ts:1-8`), whose binding carries
 * `SessionBinding.session` (`sessions/service.d.ts:76-84`) — and resolved **lazily, at use
 * time**: the service is provided *after* this plugin's client half applies (measured on
 * 0.1.7-rc.1: `undefined` inside `apply`, present two seconds later), so nothing here may
 * be captured at startup.
 *
 * Everything is structural and injectable — the plugin imports none of these packages at
 * runtime — so the whole strategy is testable without a browser.
 */
import type { BrickTarget } from './target';
/** One entry of the session's contiguous event window. */
export interface WindowEntry {
    /** `event` is durable, `transient` is a client-only live chunk. */
    readonly type?: string;
    readonly event?: {
        readonly type?: string;
        readonly seq?: number;
        readonly time?: number;
        readonly data?: unknown;
    };
}
/** The event window, as the session face publishes it. */
export interface WindowSnapshot {
    readonly entries?: readonly WindowEntry[];
    readonly hasMore?: boolean;
}
/** The session lifecycle fields a jump cares about. */
export interface SessionSnapshotLike {
    readonly hasMore?: boolean;
    readonly loadingOlder?: boolean;
}
/** The parts of the official client session this plugin uses. */
export interface SessionFace {
    /** Page history backwards until the window covers `seq`. */
    loadThrough(seq: number): Promise<void>;
    getSnapshot?(): SessionSnapshotLike;
    eventSource?: {
        getSnapshot(): WindowSnapshot;
    };
}
/** One durable event with its log position. */
export interface DurableEvent {
    readonly type: string;
    readonly seq: number;
    readonly time?: number;
    readonly data: Record<string, unknown>;
}
/**
 * The client session face for one session, when the sessions service can be reached.
 *
 * Structural on purpose: the plugin has no build-time dependency on the session controller,
 * and a core that renames or reshapes the service must degrade to "no loader" rather than
 * throw inside a click handler.
 *
 * @param service - whatever `ctx.get('sessions')` returned, unvalidated.
 * @param sessionId - the session the board is showing.
 * @returns the face, or undefined when this core cannot provide one.
 */
export declare function sessionFaceOf(service: unknown, sessionId: string | undefined): SessionFace | undefined;
/** Every durable event in the window, oldest first. */
export declare function durableEventsOf(window: WindowSnapshot | undefined): DurableEvent[];
/** Every durable event the session face is holding right now. */
export declare function durableEvents(face: SessionFace): DurableEvent[];
/**
 * Whether the window the session currently holds covers one log position.
 *
 * `hasMore === false` answers it outright — there is no older history left, so every seq the
 * session has is in the window. Otherwise the window is the log's **tail**, and its oldest
 * event is what the coverage question turns on.
 *
 * @param face - the session face.
 * @param seq - the durable seq the window must reach.
 * @returns true when the window starts at or below `seq`.
 */
export declare function covers(face: SessionFace, seq: number): boolean;
/** How one load ended: every branch is a different sentence in the panel. */
export type LoadStatus = 
/** The brick has nothing in the transcript to reach (contract target `none`). */
'nothing-to-load'
/** The row was already rendered: the loader was never asked. */
 | 'not-needed'
/** The sessions service is not reachable on this core, or has no binding for this session. */
 | 'no-loader'
/** The record carries no durable seq for this attempt, so there is nothing to page to. */
 | 'no-seq'
/** The window already covered it: no network, no waiting. */
 | 'already-loaded'
/** The official loader brought it in. */
 | 'loaded'
/** The loader was asked and the window still does not cover it. */
 | 'timeout';
/** What one {@link ensureBrickTargetLoaded} call did. */
export interface LoadReport {
    readonly status: LoadStatus;
    /** The seq the window had to reach, when the record had one. */
    readonly seq?: number;
    /**
     * `false` when the reader also observed that the transcript drew no row for this brick.
     *
     * It is set by the *jump*, not by the loader, and the distinction is the point: a session
     * window that covers a log position is not the same thing as a transcript that renders it.
     * On 0.1.7-rc.1 those two come apart for any turn that has to be paged in, because the
     * conversation's own rebuild throws while flushing the loaded page (see
     * `docs/runtime-contract.md`, "the loaded page does not always render").
     */
    readonly rendered?: boolean;
}
/** Timing, injectable so tests need no timers. */
export interface LoadOptions {
    readonly wait?: (ms: number) => Promise<void>;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
}
/**
 * What has to be loaded for one brick: the log position, and — when there is none — whether
 * that is because the transcript cannot represent the brick at all.
 */
export interface LoadRequest {
    /** The durable seq the window must cover. */
    readonly seq?: number;
    /** A step cannot be rebuilt/read reliably without the beginning of its turn. */
    readonly turn?: number;
    /** Why there is nothing to load, when there is nothing. */
    readonly unreachable?: 'nothing-to-load' | 'no-seq';
}
/**
 * The load request for a brick's navigation target.
 * @param target - where the brick belongs.
 * @returns the request, with the reason when no loading can help.
 */
export declare function loadRequestOf(target: BrickTarget): LoadRequest;
/**
 * The load request for reading the turn a brick sits in.
 *
 * A folded brick has no navigation target — nothing in the transcript is *it* — but it is
 * still measured from a real log position, and that is what reading its turn needs.
 *
 * @param seq - the durable seq the record was measured from, when it has one.
 * @returns the request.
 */
export declare function loadRequestForTurn(seq: number | undefined): LoadRequest;
/**
 * Make sure the session window covers what a brick needs. **Loading only.**
 *
 * This is the single low-level entry point behind both the inspector and the jump: the
 * inspector calls it to have something to read, the jump calls it to make a row exist. Neither
 * decides anything else here — in particular this never scrolls, never opens a group and never
 * claims a landing.
 *
 * @param face - the session face, or undefined when the service is unreachable.
 * @param request - the log position, or why there is none.
 * @param options - injected timing.
 * @returns what happened, in a form the UI can repeat verbatim.
 */
export declare function ensureBrickTargetLoaded(face: SessionFace | undefined, request: LoadRequest, options?: LoadOptions): Promise<LoadReport>;
/**
 * The settlement may be halfway through a long turn. Page to its real start, not just the
 * settlement, so reading a loaded step does not turn into an empty preview. No DOM writes.
 * The guard stops stale preview requests from initiating further pages after another click.
 */
export declare function ensureTurnTranscriptLoaded(face: SessionFace | undefined, request: LoadRequest, isCurrent?: () => boolean): Promise<LoadReport>;
export interface TranscriptScope {
    /** Host records identify one settled attempt, not the first successful message of a step. */
    readonly exactAttempt?: boolean;
    readonly callIds?: readonly string[];
}
/** One thing that entered the turn on the model-visible surface. */
export interface TranscriptInput {
    /** `user` for a human prompt, otherwise the inject source the event named. */
    readonly source: string;
    readonly text: string;
}
/** One tool call of the step, with the result the log holds for it. */
export interface TranscriptCall {
    readonly callId: string;
    readonly name: string;
    /** Raw argument JSON, exactly as the model produced it. */
    readonly args: string;
    readonly result?: string;
    readonly isError?: boolean;
}
/** The conversation around one brick, read from the durable log. */
export interface TranscriptView {
    readonly turn: number;
    readonly step: number;
    /** What entered the turn: the human prompt, and any injected context. */
    readonly inputs: readonly TranscriptInput[];
    readonly reasoning: string;
    readonly text: string;
    /**
     * Which durable event carried this step's assistant half.
     *
     * `attempt` is the honest case where an attempt settled without committing a message — a
     * failed or retried one — so there is no assistant text to show and the panel says that
     * instead of showing an empty box.
     */
    readonly assistant: 'message' | 'attempt' | 'none';
    readonly calls: readonly TranscriptCall[];
    /** Whether the window covers the brick's own seq; false means "not loaded that far yet". */
    readonly covers: boolean;
    /** True when the beginning of the turn is present in the window. */
    readonly loaded: boolean;
}
/**
 * Read the conversation around a brick out of the session's own event window.
 *
 * This is the inspector's other half: the tile already holds everything the *collector*
 * measured, and this holds what the *session* recorded — the prompt that started the turn,
 * the assistant content this step committed, and the calls it made with their results. No
 * DOM is read and nothing is inferred: fields that are not in the window come back empty,
 * and `loaded` says whether the turn was there at all.
 *
 * @param face - the session face.
 * @param turn - the Turn to read.
 * @param step - the step inside it.
 * @param seq - the durable seq this brick was measured from, for the coverage answer.
 * @returns the view, or undefined when there is no turn to read (an auxiliary call).
 */
export declare function readTranscript(face: SessionFace, turn: number, step: number, seq: number | undefined, scope?: TranscriptScope): TranscriptView | undefined;
