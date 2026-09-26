# History as a scene

> **0.1.4.** The brick contract (`brick-contract.md`) is untouched: a brick is still one real
> model request attempt, and nothing here changes what a brick *is*. This document is about
> **how many of them are materialized at once**, and why the answer is "the ones on screen".

## The shape of the problem

The board has been a window since 1.7.1: `CacheTetrisBoard` creates DOM only for the cells the
pan leaves inside the frame, so a session with fifty thousand bricks draws the same three hundred
elements a session with fifty does.

The **data** layer never got that treatment. It read the session's whole durable window and
replayed all of it, and the ledger that a replay fills has always had a cap
(`DEFAULT_MAX_BRICKS = 400`). While a window was one session's tail — the last few Turns of the
process that is running — the cap never bit.

It bites the moment the window can grow at the older end, which is what paging does
(`ISession.loadOlder()` prepends 50-message pages into the same window). Then:

```
newest ~400 attempts   →  replayed   →  exact types
everything older       →  dropped by the ledger
                       →  filled by the client fold
                       →  cache reading kept, type degraded to `output`
```

The fold is honest about this — it cannot see reasoning or tool channels, so it refuses to guess
(`kind: 'output', estimated: true, origin: 'fold'`) — but the result is the worst possible
placement of the gap: exact bricks at the live edge, untyped bricks wherever the reader has
deliberately walked to.

## The model

Four levels of detail, three of which existed already:

| Level | What it is | Where it comes from | Cost |
|---|---|---|---|
| **LOD 0 — world** | one reading per step: turn, step, cache ratio, seq, ended | the client fold (`StepReading`), which comes from the conversation the chat has rendered | one small object per step |
| **LOD 1 — scene** | exact attempts for the Turns and steps on screen: type, retry chain, tool calls, settlement, navigation target | a **slice** of the durable window, replayed (`history-scene.ts`) | the viewport, once per scene |
| **LOD 2 — live detail** | the same, plus the request capture this process actually made | the host collector's ledger (still capped at 400 records — see below) | process-local |
| **LOD 3 — raw payloads** | request envelope, tool schemas, stream, per-blob | `BlobStore`, content-addressed, shared per session | 48 MiB budget, on demand |

LOD 0 is what makes the board *wide*: every step the reader can pan to has a brick, and the rails
know how long the history is. LOD 1 is what makes it *true* where the reader is looking.

## The three mechanisms

### 1. The index (`indexEvents`)

The durable log brackets a step: `step/start { turn, step }` … `assistant/message` /
`assistant/attempt` … `tool/call` / `tool/result` / `llm/retry` / `llm/retry-started` … `step/end
{ turn, step }`. Everything an attempt owns is inside its bracket — measured on a real log, a
retried step is `assistant/attempt → llm/retry → llm/retry-started → assistant/attempt → … →
assistant/message`, all inside one. So one scan of the window produces `(turn, step) → [startSeq,
endSeq]`, and a scene is a range query over it.

Two facts the brackets do **not** hold, and the slice therefore carries by identity:

- **the header and context in force.** `request/header` and `request/context` are sticky in the
  ledger — one governs every attempt after it — and the log writes them once per request series
  (a real 300-event window held exactly one of each). A slice that starts mid-session must carry
  the last one written before it, or its bricks lose the route, the tool declarations and the
  system hash that make them comparable with live ones;
- **`turn/end`.** A Turn's finished-ness is not a property of its bricks, and the board uses it to
  release the lead cell. The mark can sit thousands of events after the steps a scene asks for.

The index is rebuilt only when the window actually changes (its length, oldest seq or newest seq),
which is at settlement granularity, not per frame.

### 2. The demand (`scenePlanOf`, `prefetchDue`)

The board is the only part of the plugin that knows the viewport, and the data layer is the only
part that can materialize records: `onScene` is the single wire between them. The demand is the
visible Turns and steps **plus one screen of overscan on each axis**, and it is sent only when the
answer changes.

The demand is snapped outward to a page of `SCENE_STEP_QUANTUM` (8) steps. That is not an
optimisation but a stability property: a scene that adds a retry brick shifts which step sits at
which row, so an exact demand could ask for a slightly different slice every time it was answered.
Snapping makes the request a page — stable while the reader moves inside it, and cheap to memoise.

`prefetchDue` asks the *loaded* history's edge, not the pan: a board showing everything it holds
is at the left edge whether or not there is anything to pan to. One screen, never fewer than two
columns.

### 3. The pager (`HistoryPager`)

The board asks for a page on every paint while it is within the prefetch margin, so the guard is
the design:

- nothing is asked when the session says `hasMore === false`;
- nothing is asked while a page is in flight — the official `loadOlder()` silently drops a second
  call, so a caller that did not track this could not tell a dropped page from an empty one;
- **a window that did not move is never asked twice.** `loadOlder` never rejects and never reports
  what it did, so the only evidence that it worked is that the window moved — its `revision`, its
  length, or its oldest seq (`windowStateOf`). This is the difference between paging and a request
  loop.

A page can also arrive from outside the board (a jump, the conversation's own loader), which is
what the optional window subscription is for: `onWindowChange` listens to
`eventSource.subscribe()` and `session.subscribe()` when the core publishes them, and the board
re-reads when the oldest seq moves. A core that publishes neither still works — a landed page
re-renders the conversation it belongs to.

## What the two caps mean now

`DEFAULT_MAX_BRICKS = 400` is unchanged, and it is still right — but for one job instead of two.
It is the **live collector's forensic retention**: the last 400 real request captures of this
process, whose large payloads are separately budgeted by `BlobStore` (48 MiB, content-addressed).
It is *not* a board capacity, and a scene replay no longer inherits it: a scene sizes its ledger
from its own slice (`attempts + 8`), which cannot exceed the screen.

The remaining work, in one line each, for whoever picks this up:

- the **live cap follows the window**, which is a mistake in the other direction — shrinking it to
  match a small viewport would throw away request captures that cannot be recovered, so it should
  stay fixed and be renamed for what it is;
- **LOD 3 is still manual**: a brick on screen is exact, but its raw payload comes from the
  collector's blob endpoint when that process captured it, and a replayed brick's refs are only
  resolvable when the same payload was captured live (refs are content hashes, so dedupe is
  automatic and misses are honest);
- **a scene is a replay, not a reader**: opening the inspector for a replayed brick still uses the
  log-reading path in `navigation.ts`, which is a second, older implementation of the same idea.
