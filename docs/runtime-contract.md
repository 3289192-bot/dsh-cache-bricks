# Runtime contract this plugin is built on

> **0.1.4 (Lite).** Only the facts this line actually depends on — the taps, the settlement, the
> socket and the seat. Facts about navigation, history loaders, replay and the conversation's
> internals are not here because Lite does none of those things; they live on in the full line's
> record (`git show v0.1.3:docs/runtime-contract.md`).
>
> Everything below was verified against the installed **0.1.7-rc.2** tree; the line is pinned to
> that version by peer range, and a core that changes any of it should fail loudly rather than
> draw a wrong brick.

## Collecting a request

| Fact | Evidence |
|---|---|
| `llm/stream` is a **waterfall** around every streaming model call, retries included | `dsh-llm/lib/types/index.d.ts:43-45` (`@mode waterfall`) |
| A listener **is** the dispatch: its return value is the stream the loop consumes | `cordis/lib/index.js:317-325` |
| The payload is the full outgoing request (`provider, model, messages, tools, sessionId, purpose, …`) and arrives **deep-frozen** | `dsh-llm/lib/types/types.d.ts:486-533`; freezing at `dsh-agent-loop/lib/index.js:1222-1235` |
| The payload carries **no turn, step or attempt id** — the attempt id is minted *after* the request is built | same type; `dsh-agent-loop/lib/index.js:1048-1049` |

**Consequence:** the tap counts a dispatch and returns `next()` untouched. It reads nothing else out
of the request: a brick has no prompt, so there is nothing in there for it.

## Identity: the live frames

| Fact | Evidence |
|---|---|
| Frames on `agent/assistant-stream`: `start {attemptId, revision, turn, step}`, `chunk {…, index, time, chunk}`, `end {…, outcome}` | `dsh-agent/lib/types/runtime-types.d.ts:107-137` |
| The frame payload is `{agent: {session: {id}}, frame}`, so a frame names its own session | same type; observed on the running instance |
| `start` carries **no timestamp** | same type |
| A text or reasoning `chunk` is one frame per token-level delta | observed on the running instance: ~1,500 frames for one long answer |

**Consequence:** `start` fixes the attempt's ordinal and its start time; a `usage` chunk is kept as a
*placeholder* until the settlement replaces it. Every other chunk is not read at all — that is the
difference between a plugin that costs nothing per token and one that costs a little per token.

## Settlement: what makes a brick

| Fact | Evidence |
|---|---|
| `assistant/message` = `{turn, step, message, stream, usage?, interrupted?}` — it **carries the billed usage** | `dsh-session/lib/types/types.d.ts:330-343` |
| `assistant/attempt` = `{turn, step, stream}` — a failed attempt, and it carries **no usage**: the numbers are inside the stream | `dsh-session/lib/types/types.d.ts:344-348` |
| One settled attempt is one such event, in log order; a retried step therefore writes one event per attempt | measured: a real retried step writes `assistant/attempt → llm/retry → llm/retry-started → assistant/attempt → … → assistant/message`, all inside one `step/start … step/end` bracket |
| Token buckets are **disjoint**: `inputTokens` is uncached input, `cacheReadTokens` / `cacheWriteTokens` are separate | `dsh-llm/lib/types/types.d.ts:153-175` |
| A `usage` chunk also arrives on the live stream as the call finishes | `dsh-llm/lib/types/types.d.ts:431-436`; observed live |

**Consequence:** the brick is emitted by the settlement, never by the frame. Where the event has no
usage of its own (a failed attempt), the last `usage` chunk inside the event's compact stream is
read; where there is none at all, the brick is grey — which is why a transport failure is grey, not
red. Nobody measured a miss.

## Serving the browser

| Fact | Evidence |
|---|---|
| Host routes: `ctx.webServer.register({kind: 'exact'\|'prefix', path, handler})`, a raw `node:http` handler, wrapped in `ctx.effect` | `dsh-host-webserver/lib/types/index.d.ts:30-44` |
| **A custom route gets no authentication** — only `/api` has the cookie policy | `dsh-host-webserver/README.md:113`, `dsh-client-connection/README.md:39` |
| The harness's own request policy is reachable as `ctx.get('connection').requestRejection(request)` | verified against the running instance |
| SSE is supported (the handler may hold the response) and is never gzipped | `dsh-host-webserver/lib/index.js:113` |
| The page carries `<base href="./">`, so client calls must be **document-relative** | `dsh-host-frontend-static/README.md:44` |
| A `link:`-installed host half needs a process restart to change; the **client bundle is hot-swapped**, and its URL is content-hash versioned (`…/client.js&rev=…`) | `dsh-app-boot/lib/index.js:1356-1363`; observed on the running instance |

**Consequence:** the plugin serves `/cache-bricks` behind the harness policy plus a loopback and
same-origin check, and the browser half resolves its URLs against `document.baseURI`.

## The seat

| Fact | Evidence |
|---|---|
| `conversation.composer.dock` is a session-scoped seat: its props carry `sessionId` | `dsh-client-ui-conversation/lib/types/client/contract/slots.ts`; observed on the running instance |
| A seat may render nothing: the board is a body-level overlay, because no seat exists in the blank gutter beside the transcript | the full line measured this in 1.7.1 and the layout has not changed |
| The scrollport carries `[data-conversation-scroll]`; rendered rows carry `[data-chat-turn]` / `[data-chat-node-key]` | `dsh-client-ui-chat/lib/client.js:4402`, `:1745`, `:2328` |
| A client plugin's bundle is a classic script calling `window.__ModuleLoader__.load({factory})`, with only the shell's module table available to `require` | observed; enforced by this package's `tsdown.config.ts` purity gate |

**Consequence:** the board anchors itself to the transcript's own scrollport, measures the blank
column to its left (`[data-chat-turn]` gives the content's left edge), and registers one seat that
renders `null`.
