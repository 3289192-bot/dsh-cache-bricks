/**
 * Node-half entry.
 *
 * A browser cannot see a model call: the request, the usage the provider billed and the attempt
 * identity only exist on the host. This half watches them and turns each settled request into a
 * brick; the other half draws it. Nothing is stored — see `shared/cache-brick.ts` for what a
 * brick is, and for the list of things this version deliberately does not carry.
 *
 * It adds no tool, no prompt section and no request rewrite: the plugin's only interaction with
 * the model-call path is an `llm/stream` observer that returns `next()` untouched. The two
 * server-side facts that make this safe are the waterfall contract (returning anything else
 * would replace the model's stream) and the deep-frozen loop request (writing to it throws),
 * both verified against the installed runtime.
 */
import { type CollectorOptions } from './host/collect';
export declare const name = "dsh-cache-bricks";
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
export declare function apply(ctx: unknown, config?: CollectorOptions): void;
