/**
 * The brick panel: everything the collector knows about one model request, in
 * seven tabs, plus the comparison with another brick.
 *
 * It renders from a `BrickRecord` and nothing else — no store access, no fetching
 * inside the component. Large payloads (the request, the stream, the header,
 * replay state) are fetched by the caller and handed in through `raw`, which
 * keeps the component testable by rendering it to static markup and keeps the
 * blob traffic in one place.
 *
 * The panel is mounted by the seat component and positioned as a floating card,
 * because the transcript is not ours to insert into.
 */
import type { ReactElement } from 'react';
import type { BrickRecord } from '../shared/brick';
import type { BrickDiff } from '../shared/diff';
import type { RevealAccuracy, RevealRow } from './target';
import type { LoadReport, TranscriptView } from './navigation';
import type { BrickLocateResult } from './reveal';
/**
 * What the last click on this brick actually reached.
 *
 * It is passed in rather than inferred, because the whole point is that the panel must
 * not upgrade a near miss to a success: `exact` is this request's own row, `context` is
 * somewhere near it, `none` is nowhere.
 */
export interface JumpReport {
    readonly turn: number;
    readonly step: number;
    readonly accuracy: RevealAccuracy;
    readonly row: RevealRow;
    /** What the unified loader did on the way, so a miss can name its own cause. */
    readonly load?: LoadReport;
    /** Which location answer this jump produced. */
    readonly locate?: BrickLocateResult;
}
/** The tabs, in order. */
export declare const PANEL_TABS: readonly [{
    readonly id: "transcript";
    readonly label: "对话";
}, {
    readonly id: "overview";
    readonly label: "Overview";
}, {
    readonly id: "request";
    readonly label: "Request";
}, {
    readonly id: "context";
    readonly label: "Context";
}, {
    readonly id: "stream";
    readonly label: "Stream";
}, {
    readonly id: "tools";
    readonly label: "Tools";
}, {
    readonly id: "retry";
    readonly label: "Retry / Errors";
}, {
    readonly id: "raw";
    readonly label: "Raw";
}];
/** Blob kinds the panel can ask for. */
export type RawKind = 'request' | 'header' | 'toolHistory' | 'stream' | 'replay' | 'messages';
/** Props for {@link BrickPanel}. */
export interface BrickPanelProps {
    readonly record: BrickRecord;
    readonly tab: string;
    readonly onTab: (tab: string) => void;
    readonly onClose: () => void;
    /** Take the reader to this brick's own row in the transcript (the board's double click). */
    readonly onLocate?: () => void;
    /** Compare against the previous brick of the same session. */
    readonly onCompare?: () => void;
    readonly diff?: BrickDiff;
    /** What the last click reached, so the panel can say it without flattering it. */
    readonly jump?: JumpReport;
    /**
     * The conversation around this brick, read from the session window.
     *
     * Loaded automatically when a brick is selected. The preview does not navigate or
     * highlight the main transcript; double-click / the Locate button does that separately.
     */
    readonly transcript?: TranscriptState;
    /** Ask the session for the history this brick's turn needs. */
    readonly onLoadTranscript?: () => void;
    /** Loaded payloads, keyed by kind. */
    readonly raw?: Partial<Record<RawKind, unknown>>;
    readonly onLoadRaw?: (kind: RawKind) => void;
    readonly store?: {
        readonly blobs: number;
        readonly bytes: number;
    };
}
/** The comparison view: what changed between two real requests. */
export declare function DiffTable({ diff }: {
    diff: BrickDiff;
}): ReactElement;
/** The panel. */
/**
 * What the transcript tab knows: nothing yet, loading, read, or why it could not be read.
 *
 * The distinction between "not asked yet" and "could not be read" is the point: the first is
 * a button, the second is a sentence naming the reason, and neither is an empty box.
 */
export interface TranscriptState {
    readonly status: 'idle' | 'loading' | 'ready' | 'unavailable';
    readonly view?: TranscriptView;
    readonly report?: LoadReport;
}
export declare function BrickPanel(props: BrickPanelProps): ReactElement;
