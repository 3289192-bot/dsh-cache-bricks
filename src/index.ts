/**
 * Node-half entry.
 *
 * The cache badge is a browser-facing plugin, but its data cannot be gathered in
 * the browser: the outgoing request, the attempt identity, the retry records and
 * the token-meter snapshot only exist on the host. This half therefore installs a
 * **read-only** collector (see `./host/collect`) and serves what it gathered over
 * its own HTTP namespace.
 *
 * It adds no tool, no prompt section and no request rewrite: the plugin's only
 * interaction with the model-call path is an `llm/stream` observer that returns
 * `next()` untouched. The two server-side facts that make this safe are the
 * waterfall contract (returning anything else would replace the model's stream)
 * and the deep-frozen loop request (writing to it throws), both verified against
 * the installed runtime.
 */
import { installCollector, type CollectorOptions } from './host/collect'
import type { HostContextLike } from './host/collect'

export const name = 'dsh-cache-badge'

/**
 * Install the collector.
 *
 * `webServer` is requested through `ctx.inject` rather than a module-level
 * `inject`, so the collector still observes on a composition that serves no HTTP
 * (headless, TUI) — it simply has no routes to publish to.
 *
 * @param ctx - the plugin context.
 * @param config - optional capacity and serving options from the plugin row.
 */
export function apply(ctx: unknown, config?: CollectorOptions): void {
  installCollector(ctx as HostContextLike, config ?? {})
}
