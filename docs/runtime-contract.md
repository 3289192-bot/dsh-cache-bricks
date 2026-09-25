# Runtime contract this plugin is built on

Every fact below was read out of the installed DSH 0.1.7-rc.2 runtime source (paths
relative to the `@deepseek-ai/` root under `$DSH_HOME/runtime/node_modules`) before
the code that depends on it was written. The 0.1.6-alpha.1 line was also checked
historically; 0.1.2 supports only 0.1.7-rc.2.

**0.1.7-rc.2 re-check.** The instance moved from rc.1 to rc.2 on 2026-09-24. Every surface
below was re-read against rc.2 (byte-diff of the rc.1 tarballs out of the npm cache against
the installed rc.2 tree, plus greps of the compiled bundles). Two things changed and both are
carried in the code: the request gained a **history-relative tool declaration list**
(`toolHistory`, `ToolUpdate`, `deferLoading` — dormant in rc.1, activated in rc.2), and the
client's live chunk row is named **`assistant/live-chunk`** (`assistant/chunk` is a session
*format-migration* name, which is what the fold used to listen for). Everything else — the
frame union, the durable events, the trajectory tokens, every DOM anchor the jump uses, and
the assembler guard the host patch exists for — is unchanged.

Keeping this list is not documentation for its own sake: three of the design
decisions in `src/host/` look odd until you know which of these facts forced them.

The frozen definition of a brick — what counts as one, and what may be added to a brick —
lives in [`brick-contract.md`](./brick-contract.md). This file is the *evidence* behind it:
every runtime fact the plugin leans on, with the file and line it was read from.

## The one rule about navigation

> **Brick : transcript row is *not* one-to-one. Brick : navigation target *is*.**

A brick is one model request **attempt**; the Chat view publishes rows per **step**, and a
retried step is two attempts sharing one row (it even resets that row's state on
`llm/retry`). So a brick declares a **target** — the semantic place it belongs — and
"exact" means *the landing hit the target the brick declared*, not *the brick owns a row
nobody else can point at*. Everything in the jump section below follows from that rule, and
so does the acceptance test: `verify:ui` speaks of `target-exact`, never of "its own row".

## Collecting a request

| Fact | Evidence |
|---|---|
| `llm/stream` is a **waterfall** around every streaming model call, retries included | `dsh-llm/lib/types/index.d.ts:43-45` (`@mode waterfall`), emitted at `dsh-llm/lib/index.js:2371` |
| A listener **is** the dispatch: its return value is the stream the loop consumes, and not calling `next()` vetoes the adapter call | `cordis/lib/index.js:317-325`; rule in `dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:16` |
| The payload is the full outgoing request — `provider, model, reasoningEffort?, messages, system?, tools?, toolHistory?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose?` | `dsh-llm/lib/types/types.d.ts:486-533` |
| Loop-built requests arrive **deep-frozen** — listeners read, never rewrite | `dsh-llm/lib/types/index.d.ts:37-42`; freezing at `dsh-agent-loop/lib/index.js:1222-1235` |
| The payload carries **no turn, step or attempt id** | same type; attempt id is minted *after* the request is built (`dsh-agent-loop/lib/index.js:1048-1049`) |
| `messages` are documented as "exactly as the provider sees them", but the adapter may still project files/images afterwards | `dsh-llm/lib/types/types.d.ts:472-478`; projection at `dsh-llm/lib/index.js:2218-2228` |
| **rc.2 only:** the request also carries `toolHistory` — the declarations the history started with plus what later `developer/message` `tool-addition` blocks activated — and a declaration may be flagged `deferLoading` | `toolHistory: session.toolHistory()` at `dsh-agent-loop/lib/index.js:1257`; `ToolHistory` at `dsh-llm/lib/types/types.d.ts:476-488`; `ToolUpdate` at `:366-380`; `deferLoading` at `:458-461` |
| **rc.2 only:** the adapter folds that history into the declaration list **after** the waterfall (`projectToolUpdates`), so a listener at `llm/stream` sees the pre-projection list | projection at `dsh-llm/lib/index.js:786` (function) and `:2312` (inside `adapterStream`), waterfall at `:2371`; `withoutDeveloperMessages` inside the same function |
| rc.1 has none of this: `toolHistory`/`projectToolUpdates` appear **0 times** in rc.1's `dsh-llm` and `dsh-agent-loop` bundles, and `deferLoading` is a dormant field | byte-diff of `@deepseek-ai/dsh-llm@0.1.7-rc.1` (npm cache) against the installed rc.2 tree |

**Consequence:** an attempt is identified by pairing a dispatch with the start
frame of `agent/assistant-stream` through a per-session FIFO — whichever channel
reports first, the two meet in `BrickLedger`. The tool declaration list is what the
`toolsHash` is for, and on rc.2 it has to be the **effective** list (header declarations plus
history additions): hashing only the header's own list would let a tool added mid-conversation
pass as "tools identical", which is exactly the reading the diff exists to give.

## Stream, settlement and retry

| Fact | Evidence |
|---|---|
| Frames: `start {attemptId, revision, turn, step}` (**no timestamp**), `chunk {…, index, time, chunk}`, `end {…, outcome}` | `dsh-agent/lib/types/runtime-types.d.ts:107-137` |
| `chunk.time` is `Date.now()` epoch ms, reused by the durable stream | `dsh-agent-loop/lib/index.js:396-409` |
| `assistant/message` = `{turn, step, message, stream, usage?, interrupted?}`; `assistant/attempt` = `{turn, step, stream}` — **no usage** | `dsh-session/lib/types/types.d.ts:330-348` |
| Neither event carries a finish reason: it lives only in the stream's final `finish` chunk | `dsh-llm/lib/types/types.d.ts:431-436` |
| A **pre-dispatch failure commits no event at all**; a settled attempt always commits one | `dsh-agent-loop/lib/index.js:1064`, `:1098-1105` |
| The live `end` frame names the durable event the attempt committed to: `outcome = {kind, eventType, seq}` — so the settlement `seq` is knowable **before** the durable event arrives | `dsh-agent/lib/types/runtime-types.d.ts:107-137` (`AssistantStreamFrame`) |
| `llm/retry` / `llm/retry-started` are **durable session events, not Cordis events** | `dsh-llm-retry/lib/types/types.d.ts:4-41` |
| `LlmFailure` = `{message, code, status?, providerRetryAfterMs?, requestId?, offloadImages?}` | `dsh-llm/lib/types/types.d.ts:25-44` |
| Token buckets are **disjoint**: `inputTokens` is uncached input, cache read/write separate | `dsh-llm/lib/types/types.d.ts:153-175`, `dsh-llm-deepseek/lib/index.js:1739` |
| The client's live chunk row is a **transient window entry** named `assistant/live-chunk` (`{attemptId, turn, step, chunk}`), and its `seq` is a **fractional** ordering key (`durableCursor + 1 - 1/(k+1)`) that sorts it between two durable events | `dsh-api-session-controller/lib/types/client/contract/events.d.ts:5-20` (`AssistantLiveChunkEvent`, `SessionEventLikeEntry`); emitted at `lib/client.js:1413`, `:1476` |
| `assistant/chunk` is **not** a live event on this line: the name survives only in the session format migrations | `dsh-session-format-v0-to-v1/lib/index.js`, `dsh-session-format-v1-to-v2/lib/index.js`; 0 occurrences in the controller, chat, conversation and trajectory bundles |

**Consequence:** TTFT is measured on the wall clock from the dispatch observation
to the first token chunk (never mixed with `performance.now()`), and the live end
frame — not the durable event — is the reliable settlement signal. Because that frame
carries the settling event's `seq`, the ledger attaches a durable settlement by **seq**,
falling back to FIFO within `(turn, step)` — never to "the newest attempt", which hands an
earlier attempt's verdict to a later one exactly when a retry makes two of them overlap.
The client-side fold reads the transient row for the same reason the collector reads the live
frame: it is the only thing that moves while a step is still streaming. It stamps a sample's
`seq` (which later becomes a `loadThrough()` argument) **only from an integer seq** — the
transient key is a sort order, not a position in the log.

## Context, tools, headers

| Fact | Evidence |
|---|---|
| `request/header` = `{header: EpochHeader, reason: 'initial'\|'resume'\|'change'\|'series', startsSeries?}`, appended **before** dispatch | `dsh-session/lib/types/types.d.ts:389-398`; `dsh-agent-loop/lib/index.js:1184-1219` |
| `request/context` = `{provider, model, contextWindow?, systemPromptUpdate?}` | `dsh-session/lib/types/types.d.ts:229-239` |
| Adapter-filled config fields are flagged: `header.adapterDefaults.{reasoningEffort,maxTokens} === true` | `dsh-llm/lib/types/call-config.d.ts:24-31` |
| `tool/call` = `{turn, step, callId, name, arguments}` with the **raw** argument JSON; `tool/result` = `{turn, step, message, error?, meta?}`; timing comes from the envelopes' `time` | `dsh-session/lib/types/types.d.ts:349-388` |
| `TokenMeter.measure(session, header?)` is host-side and side-effect free (writes no events) | `dsh-token-meter/lib/index.js:606-611`, `README.md:12` |
| `contextPressure` and `contextBreakdown` are **last-wins slots, explicitly not one atomic request observation**; the breakdown is a heuristic, not billing | `dsh-token-meter/lib/types/projection.d.ts:17-22`, `:41-49` |
| `tokenUsage` crosses the wire as session **totals only**; the per-turn slot stays host-side | `dsh-token-meter/lib/types/usage-projection.js:118` |
| Host-side synchronous projection read: `ctx.sessionProjections.stateOf(session, key)` | `dsh-session-projection/lib/types/index.d.ts:167-175` |

**Consequence:** the context environment is snapshotted **at dispatch** and frozen
onto the brick, and the heuristic split is labelled `≈` in the UI.

## What one attempt produced

The back face of a brick classifies an attempt by *what it did*, so the shapes the
runtime allows are the vocabulary it has to be built from — and nothing more.

| Fact | Evidence |
|---|---|
| Assistant content blocks are `text` \| `reasoning` \| `image` \| `file` \| `tool-call`, and the map is merge-extensible | `dsh-llm/lib/types/types.d.ts:115-124` (`ContentBlockMap`), `:45-90` (the five blocks) |
| `tool-addition` \| `tool-removal` exist in that map but are **reserved for Session V4 persistence**: "providers and UI reject them until their producers and consumers are implemented together" | `dsh-llm/lib/types/types.d.ts:92-107`, comment at `:110-114` |
| A `request`'s only self-declared kind is `purpose?: 'compaction' \| 'session-title'` — two values, nothing finer | `dsh-llm/lib/types/types.d.ts:505` |
| Lifecycle is separate from content and already carries five outcomes: `stop` \| `tool-calls` \| `max-tokens` \| `aborted` \| `error` | `dsh-llm/lib/types/types.d.ts:431-436`; `dsh-session/lib/types/types.d.ts:330-348` (`interrupted`) |

**Consequence:** the board's activity face is four normal types — output (text,
image and file all land there), reasoning, tool, and the reasoning+tools split —
plus one auxiliary type for the two `purpose` values. Retry, error, abort and the
output limit are **not** types: they are markers painted on whichever type the
attempt already is, which is also how the runtime keeps them apart.

## The official colours the board borrows

The type face does not invent a palette: it paints the same lanes the app's own trajectory
view paints, by reading the same tokens, so the board and the timeline agree and both follow
whatever theme is loaded.

| Fact | Evidence |
|---|---|
| The trajectory timeline paints its spans by token: `user` → `var(--dsw-alias-state-business-primary)`, `message` → `brand-primary-new-colorprimary-new-color` 60% + `state-error-secondary`, `subtool` → `var(--dsw-alias-state-warn-label)`, `context` → `state-success-primary` 68% + `label-secondary`; a failure is `[data-error=true]` → `var(--dsw-alias-state-error-primary)` | `dsh-client-ui-trajectory/lib/client.js` — the compiled module CSS: `[data-timeline-span=user]`, `[data-timeline-span=message]`, `[data-timeline-span=subtool]`, `[data-timeline-span=context]`, `[data-error=true]`, and the `--trajectory-assistant-decoding-color` variable |
| The design tokens resolve per theme on `body`, not on `:root`, so a plugin must read them through an element that inherits from it (its own `getComputedStyle`, or a CSS expression on its own node) | live 0.1.7-rc.1 dark theme: `--dsw-alias-bg-base` `#151517`, `--dsw-alias-state-warn-label` `#dd8629`, `--dsw-alias-label-secondary` `#cfd3d6` |
| The span shape itself: `height: 8px; border-radius: 1px; opacity: .78; background: var(--dsw-alias-label-secondary)` — **no rim and no shadow** — with `[data-timeline-span=message\|tool\|subtool]` overriding the opacity to 1 | `dsh-client-ui-trajectory/lib/client.js` (`.span` rule and the span overrides) |
| The model span carries a **TTFT gradient**: `linear-gradient(to right, <ttft colour> 0, <ttft colour> var(--trajectory-assistant-ttft), <decoding colour> …, …)`, where the ttft colour is the decoding colour at 54% into `--dsw-alias-bg-layer-2` | `client.js` (`[data-timeline-span=message][data-assistant-timing=true]`, `--trajectory-assistant-ttft-color`) |

**Consequence:** `TRAJECTORY_TONE` in `src/client/tetris.ts` holds those expressions verbatim,
and the type face is drawn as a span of that lane: flat fill, one-pixel corners, no rim, no
shadow, official opacity (`SPAN_OPACITY`), and — for the model lane — the official TTFT
gradient, whose share comes from the brick's own `ttftMs / durationMs`. The resting colour is
the official one mixed down towards `--dsw-alias-bg-base` so a board of two hundred bricks
stays readable, and the brick being read wears the official colour untouched. `input` and `context` are defined but unreachable — no request is a user input or an
injection — and a test asserts that, so a future kind cannot quietly borrow them.

## Serving the browser

| Fact | Evidence |
|---|---|
| Host routes: `ctx.webServer.register({kind: 'exact'\|'prefix', path, handler})`, raw `node:http` handler, wrapped in `ctx.effect` | `dsh-host-webserver/lib/types/index.d.ts:30-44`; example `dsh-client-modules/lib/index.js:545-552` |
| **A custom route gets no authentication** — only `/api` has the cookie policy | `dsh-host-webserver/README.md:113`, `dsh-client-connection/README.md:39` |
| An exact route under `/api/...` shadows the framework's authenticated prefix route | matcher at `dsh-host-webserver/lib/index.js:327-330`; a shipped plugin does exactly this without its own check |
| SSE is supported (the handler may hold the response) and is never gzipped | `dsh-host-webserver/lib/index.js:113`; example `dsh-voice-mode` `src/index.ts:990-1057` |
| The page carries `<base href="./">`, so client calls should be document-relative | `dsh-host-frontend-static/README.md:44` |
| A `link:`-installed host half is loaded from the linked directory, but **replacing it needs a process restart**; only the client bundle is hot-swapped | `dsh-app-boot/lib/index.js:1356-1363`; `cordis-plugin-development/references/host-plugin.md:60` |

**Consequence:** the plugin serves its own namespace behind a loopback +
same-origin guard, and the browser half resolves URLs relative to `document.baseURI`.

## Jumping from a brick to its Turn

The bricks live in a body-level overlay, not in the conversation, so "click a brick
and land on that request" has to go through the DOM the chat view publishes. Every
anchor below is a row that **is** the brick's declared target — a brick that cannot reach
one reports `none` instead of landing nearby (see the rule on the first screen):

| Fact | Evidence |
|---|---|
| The scrollport carries `[data-conversation-scroll]`; a Turn's row carries `[data-chat-turn="N"]` (and rows are the only elements with it) | `dsh-client-ui-chat/lib/client.js:4402` (`closest("[data-conversation-scroll]")`), `:1745`, `:2328` (row attribute), `:4577` (read back) |
| Every rendered chat item carries `[data-chat-node-key]` — `[anchorSeq:]kind + id` with **no separator** between kind and id (`tool-call` + `call_00_x` publishes as `tool-callcall_00_x`) — plus `data-chat-flow-kind` | `client.js:1740-1748` (`ChatNodeSeat` writes them), key composition at `:1735` |
| The assistant step's node id is exactly `${turn}:${step}`, which is what an `assistant-step` **target** maps to. It is *not* a brick's identity: a brick is an attempt, and a retried step is two attempts on this one id | `client.js:7515-7525` (`assistantDefinition`, `kind: 'assistant-step'`); identity reset at `:7338` |
| One step can be two rows sharing that key, told apart by `data-chat-group-part` = `reasoning` \| `response` | `client.js:1668-1669`, `:1735`, `:1743` |
| A collapsed process group holds its rows as `hidden="until-found"` and the view registers the official `beforematch` listener on them — dispatching that event is the supported reveal, not stripping the attribute | `client.js:1594` (`setAttribute("hidden", "until-found")`), `:1600` (`addEventListener("beforematch", reveal)`) |
| The Turn's own disclosure is `button[data-turn-process="N"]` with `aria-expanded` | live DOM on 0.1.7-rc.1 (`data-turn-process-messages`, `data-turn-process-tool-calls` also present) |
| The official retry node is `kind: 'model-retry'` **keyed by `retryId`**, built from the durable `llm/retry` / `llm/retry-started` events | `client.js:9315-9340` (`retryDefinition.match` → `id: retryId`) |
| The official compaction node is **anchored at its own checkpoint seq**, not at the auxiliary model call's settlement: `chatNode(context, "compaction", marker.seq, marker)` — so a `seq` cannot bridge the two and the row is matched by its `compactionId` instead | `client.js:8861-8885` (`compactionDefinition.buildViewNode`) |
| The official Turn navigator renders `button[data-index]` marks whose **label** names the Turn — `chat.turnNavigation.jump` = `Jump to turn {turn}` / `跳转到第 {turn} 轮` — and clicking one runs the nav state machine | `client.js:3590` (`data-index`), `:3593` (aria-label), `:3600-3602` (`onNavigate`), labels at `:5333` (`zh`) and `:5510` (`en`) |
| The "load older" control is a button inside a container whose class ends in `older` (`EvIC1a_older`), rendered **only while `hasMore`** — so its absence means the session's first Turn is already mounted | `client.js:1609` (CSS class), `:1625` (class map), `:5157-5163` (`hasMore && …`, `onClick: scroll.loadEarlier`) |

**Consequence:** `reveal.ts` resolves the brick's declared target — retry chain, the
step's declared half, its first tool call, or the compaction row — opening a collapsed
group through its own disclosure or through `beforematch`. There is no fallback to a
neighbouring row and no "nearest step": a target that resolves to nothing is reported as
`none`, with the row kinds mapped to accuracy by `accuracyOf` (`exact` for the four rows
that are the target, `context` for the Turn header, which nothing produces today). It also
loads: paging a Turn in is a *step on the way*, and the landing is decided afterwards. Two
things this buys over a Turn-level jump: a Turn is not a navigation unit (one Turn here is
thousands of pixels tall), and **not every step has a row** — a step with no assistant
content produces no `assistant-step` row at all, which is why the call id and the retry
chain are targets too.

**Granularity boundary:** bricks are per **attempt**, the chat's rows are per **step**,
and a retried step is therefore two bricks and one row. The view does not merely reuse
that row — it *resets it*: `resetForRetry` clears the assistant-step state when `llm/retry`
arrives (`dsh-client-ui-chat/lib/client.js:7338`, called from the Definition's update at
`:7479`, and from `start` at `:7537`), so there is no attempt-level assistant node to aim
at and the retry chain row is the only place the pair is shown together.

### The official loader, and how a plugin reaches it

For a long time this section said a plugin could not reach the loader. That was half right:
the **seat-prop** route is closed, and the **service** route is open.

| Fact | Evidence |
|---|---|
| The official history loader is `ISession.loadThrough(seq: SessionSeq): Promise<void>` — the doc comment calls it "the turn-jump loader": it pages backwards until the window covers `seq`, repeated calls lower a shared target, and `snapshot.loadingOlder` is the busy signal | `dsh-api-session-controller/lib/types/client/contract/session.d.ts:130-141` |
| The sessions service is injected as **`ctx.sessions`** — "The outward sessions-service face — what `ctx.sessions` exposes to feature packages" | `.../contract/sessions.d.ts:1-8` |
| `ctx.sessions.binding(sessionId)` gives the identity-stable binding, whose `.session` is the outward face carrying `loadThrough` | `.../contract/sessions.d.ts:153`, `.../sessions/service.d.ts:76-84` |
| The service is **not available while a plugin's `apply` runs** — it is provided by the root context (`rootCtx.reflect.provide("sessions", this)`) once the controller activates. Measured on 0.1.7-rc.1: `ctx.get('sessions')` is `undefined` inside `apply` and present two seconds later | `dsh-api-session-controller/lib/client.js:3192` + measurement |
| `ISession.eventSource` is the observable **contiguous event window** (`ObservableSnapshot<SessionEventWindow>`, read with `getSnapshot()`, `hasMore` on the window), which is how a plugin reads the conversation itself | `.../contract/events.d.ts:57-63`, `dsh-client-store/lib/types/contract.d.ts:3-12` |
| The **seat-prop** route really is closed: `conversation.composer.dock` is rendered with empty props and `conversation.chat.node` receives only `entryKey`, `hookContext`, `fallback` | `dsh-client-ui-conversation/lib/client.js:17461`, `dsh-client-ui-chat/lib/client.js:1749-1755` |
| `llm/retry` and `llm/retry-started` carry `turn` **and** `step` alongside `retryId` — the attempt identity a collector must not drop | `dsh-llm-retry/lib/types/types.d.ts:17-41` |

**Consequence:** `navigation.ts` resolves the service lazily at use time (never at startup —
see the measurement above) and asks `loadThrough(loadSeq)` for the one position the brick
needs; `loadSeq` is the record's own settling seq, so "how much history do I need" is
answered by the attempt rather than by a count of pages to click. The inspector reads the
turn's events out of `eventSource`, which is why it can show a conversation whose rows the
chat has not drawn.

Two gestures, two questions: **one click opens the inspector** (the record is already in
hand, so it costs nothing and moves nothing), and **a double click — or the panel's own
button — locates the row**, loading the history that row needs first.

### The loaded page does not always render (host defect, 0.1.7-rc.1 and rc.2)

Loading and rendering are separate steps, and on 0.1.7-rc.1 **and rc.2** the second one can be
dropped by the conversation's own assembler. Re-checked on rc.2: the definition still returns
`null` for a materialized node, the assembler still throws on it (`node === null && previous
!== null`), and `patch.mjs --check` still reports the rc.2 bundle as `unpatched (patchable)` —
byte-identical anchor, so the same minimal patch applies.

| Fact | Evidence |
|---|---|
| A Definition that turns a materialized target into `null` makes the assembler **throw**, and the throw loses the whole flush — the page of history that triggered the rebuild | `dsh-client-ui-conversation/lib/client.js:2490-2496` (`buildTargetUpserts`: `if (node === null && previous !== null) throw new Error('conversation Definition "…" withdrew materialized target "…"')`) |
| `systemMessageDefinition().buildViewNode` returns `null` whenever the prompt stops being *visible*, which a prepend rebuild re-derives differently | `dsh-client-ui-chat/lib/client.js:9223-9237` |
| The sibling Definition in the same file already carries the fix — same key, `visibility: "hidden"` instead of `null` | `dsh-client-ui-chat/lib/client.js:9255-9285` (`requestPromptDefinition.buildViewNode`), helper at `:9206-9209` (`stableRequestPromptAnchor`) |
| Reproduction (unpatched): the harness's **own** Turn navigator jumping to a turn that has to be paged in logs the throw and draws no rows; the same run with this plugin's Definition unregistered behaves identically, so the plugin is not the cause | live, 0.1.7-rc.1; the local experiment's patch files are not part of this public repository |
| The locally verified fix used an idempotent host patch (three invariants, mirroring the sibling Definition), 5 regression tests driving the installed artifact, and a live test whose `--revert` run failed | local `patch.mjs`, `system-message.spec.mjs`, `live-turn19.mjs` (not published here) |

The plugin does **not** patch the host: a third-party Definition may not replace a built-in
one, so the honest plugin-side behaviour is to load through the official API and then report
which of the four things happened (`exact` / `host-projection-blocked` /
`loaded-awaiting-render` / `target-unavailable`) instead of rounding a miss up to a success.

## Cross-line check (0.1.6-alpha.1)

The unified loader is not a 0.1.7-only feature: the 0.1.6 core's session controller
(`@deepseek-ai/dsh-api-session-controller@0.1.6-alpha.1`, the one the globally installed `dsh`
carries) declares `loadThrough` on `ISession`, `binding(id)` on the sessions face, and provides
the `sessions` service the same way. The plugin's structural check is what decides at runtime —
a core without that shape gets `no-loader` and the inspector says so, rather than a jump that
silently does nothing.


`agent/assistant-stream` (identical frame union), `session/event`, `llm/stream`,
`llm/retry`, `tokenMeter`, `sessionProjections`, `webServer`, `request/header` and
`tool/call` are all present in the 0.1.6 line as well, so one collector serves both
instances. It is also why `toolHistory` is read as an **optional** field: 0.1.6-alpha.1 and
0.1.7-rc.1 do not send it, and the effective declaration list then *is* the base list, so the
same code produces the same hash on all three lines (asserted in `tests/observe.spec.ts`).
The host half imports no DSH package at runtime — it speaks structural
types only — which is what makes that claim testable rather than hopeful.
