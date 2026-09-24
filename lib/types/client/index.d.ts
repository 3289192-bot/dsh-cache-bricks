import type { Context } from '@deepseek-ai/cordis';
import { type LoadReport } from './navigation';
/** How one load ended, in one short sentence for the panel. */
export declare function loadText(report: LoadReport): string;
/**
 * Services required by the cache-badge browser half.
 *
 * Only `slots` is a hard dependency (always present on the web surface). The
 * conversation-node registry — where a node Definition is registered — is
 * core-owned and its service key has changed across core versions (0.1.7
 * exposes `ctx.uiConversation.events`; legacy `ctx.conversationEvents` still
 * exists on other cores). It is resolved structurally with `ctx.get` instead
 * of being injected or read as a property: a loader entry is a sibling of the
 * core entry that provides the service, so property access without `inject`
 * throws `cannot get property "<name>" without inject` and would fail apply —
 * not degrade. `ctx.get` reads the global service store and returns
 * `undefined` when absent, so a missing or renamed registry disables only the
 * board, never pending or boot failure.
 */
export declare const inject: string[];
/** Register the per-Turn reading and the brick board that paints it. */
export declare function apply(ctx: Context): void;
