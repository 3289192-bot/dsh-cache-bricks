import type { Context } from '@deepseek-ai/cordis';
/**
 * The service this half needs. Declared here rather than at module scope so a composition
 * without a slot registry fails to activate this half only — the host half keeps counting
 * requests, and the board simply never appears.
 */
export declare const inject: string[];
/**
 * Register the board's seat.
 *
 * `conversation.composer.dock` is the session-scoped seat that carries `sessionId`; the board
 * anchors itself to the transcript's own scrollport from there.
 *
 * @param ctx - the plugin context.
 */
export declare function apply(ctx: Context): void;
