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

## The pan does not materialize (0.1.4.a)

The demand above is correct, and until 0.1.4.a it was sent from **inside the frame that produced it**.
A drag cuts a new scene every few pixels, and answering one demand is not free: `HistoryScene`
replays the log slice, React re-renders the board from it, and both happen synchronously on the
thread the pointer is being read on. Historical length makes it worse in the expected way — the
window is copied, indexed and merged at session scale — so a long session was un-draggable while
0.1.4's *drawing* was already a window.

Measured on the browser fixture with a 2,000-Turn board and one 120-move drag
(`scripts/test-scroll.mjs`, counters published by `window.__dshCacheBricksStats`):

| while the pointer is down | 0.1.4 | 0.1.4.a |
|---|---|---|
| board re-renders | **121** (one per move) | **0** |
| scenes asked of the data layer | one per painted frame | **0** |
| scenes materialized | per frame | **1**, on release (plus one re-cut that converges) |
| events handed to `replaySession` | the frame's slice, per frame | one slice, ≤ ⅛ of the window |

Three costs, one per layer, all in the same feedback loop:

1. **the wire is deferred.** `syncScene` parks the demand (`pendingScene`) while a hand-driven pan is
   in flight — the same `PAN_QUIET_MS` window the bricks' own animation already waits for — and
   sends it once the pan ends, shortened to `PAN_RELEASE_MS` (80 ms) on pointer release. The bricks
   do not wait for it: a pan is pure geometry, every brick the reader pans past is drawn from data
   already in hand, and only the *exactness* of the bricks on screen arrives a quiet window late.
   Nobody reads a brick's type while the board is flying past;
2. **the window is asked about itself before it is copied.** `durableEvents` walks and sorts the
   entire durable window, and the render path did that on every render — including the ones a drag
   caused — only for `window()` to compare a key and answer "it did not move". The runtime already
   publishes that answer: `SessionEventWindow.revision` (`contract/events.d.ts:59`).
   `windowKeyOfSnapshot` reads the revision, plus the entry count and the durable ends for a core
   that publishes none, and `noteWindow` materializes the events only when the key changed;
3. **the board's data is memoised.** `readingsOf` and `boardFromSources` rebuilt the whole board on
   every render and handed `setColumns` a new array, which invalidated the board's tallest-column
   memo and bought another paint. Both are memos now, and `setColumns` ignores an array it already
   has.

The demand's own semantics are unchanged: the same `scenePlanOf` overscan, the same
`SCENE_STEP_QUANTUM` snapping, the same memo. What changed is *when* the board is allowed to spend
it — and a keyboard pan, a wheel notch and a rail drag all end the same way, with one ask.

## The motion model (0.1.4.b)

0.1.4.a made a pan cheap *in the data layer*. The view was still steppy, and the reason was the
animation model rather than the pixel count: a pan landed on whole cells (`Math.round`), and every
position was written as `right`/`bottom` and animated by **transitioning those same properties** —
two layout properties per brick, a hundred bricks at a time, every frame of every animation.

What changed is where motion lives, not what a brick is:

| | 0.1.4.a | 0.1.4.b |
|---|---|---|
| A pan | rounded to a cell, then every brick re-written | the pointer's own fraction, carried by **one plane per face** as `translate3d` |
| A cell crossing | — | the only moment the grid is rewritten (invisible: the slabs move a cell in layout while the plane gives exactly that cell back in transform) |
| A release | the pan stayed where it was rounded to | 130 ms magnetic settle onto the nearest whole cell, on the compositor |
| A new Turn | `right` transitioned on **every visible brick** | one plane FLIP: the cells are painted once, then one transform animates home |
| A new brick | `bottom` transitioned on that brick | that brick's own `transform` animation (260 ms, 1 px settle) |
| The board's box | `height`/`top` transitioned | written exactly once; the host is a boundary, not an animation |
| The rail thumb | `left`/`top` | `translateX`/`translateY`, from the same float pan as the plane |
| The invariant | — | **no `transition` or animation on `top`/`left`/`right`/`bottom`/`width`/`height`, anywhere in the board** |

The data layer never sees a fraction. The window is still whole cells, the scene demand is still
whole Turns and steps, and the DOM keeps each brick's resting cell in `right`/`bottom` — which is
what the DOM-reading checks assert. The fraction exists only between the planner and the plane, and
it is bounded by the **motion ring**: one extra column and one extra row painted on every side of
the window (clipped by the face, never interactive, never announced), so a plane carrying up to a
whole cell can never expose an edge.

`will-change: transform` is set when a gesture or a hand-off starts and cleared when it ends: a
plane, a flipping card and the one falling brick are promoted, and nothing else. The alternative —
promoting a hundred bricks — buys a hundred compositor layers to solve what one plane solves.

Measured on the browser fixture, same script, same drag, this machine:

| | 0.1.4.a | 0.1.4.b |
|---|---|---|
| a new Turn arrives: `LayoutCount` | **+102** | **+1** |
| … `RecalcStyleCount` | **+103** | **+1** |
| a 12-move drag (996 cells crossed): `LayoutCount` | +17 | +13 |
| … sub-cell offset carried by the plane | none (all zero) | −35.8 px … 0.0 px, one value per frame |
| the fixture suite | 67/73 | **73/73** |

The new-Turn number is the one that matters: sliding the stack used to re-lay-out the grid on every
frame of a 190 ms animation, and now it costs one layout and one transform.

## The data layer becomes a window too (0.1.4.c)

0.1.4.a/b made the *drawing* a window and the *motion* compositor work. The data layer was still a
backlog in three places, and each of them was O(something larger than the screen):

| | before | 0.1.4.c |
|---|---|---|
| the board's merge | `boardFromSources` re-folded every reading on every scene change | a **world**: a base built from the fold when the fold changes, patched by the scene's steps and the collector's feed (`bricks.ts`, `BoardWorld`) |
| the scene cache | 3 whole scenes, dropped whenever the window moved | a **step** cache: a finished step's events never change, keyed by its bracket and the header/context in force, so two screens share their overlap and a re-read is a lookup |
| the window index | a full scan of every loaded event per page | a **delta**: the log is append-only, so a window that grew is indexed by its growth (`SceneIndexBuilder`, `durableEventsOutside`) |
| raw payloads | every replayed stream, tool result and header canonicalized and SHA-256'd | **lazy**: nothing is hashed; the payloads are the session's own events, read by seq when a reader opens one (`logRawPayload`) |

Measured on the browser fixture, 10,000 Turns / 30,000 steps (same script, same machine):

| | 0.1.4.b | 0.1.4.c |
|---|---|---|
| ten screen reviews, script time | 678 ms | **202 ms** |
| re-reading three already-read screens | 196 ms | **61 ms** (30 step hits, 0 misses) |
| a page landing on a 120,000-event window | 13.1 ms (full rescan) | **2.72 ms** (delta) |
| raw payloads hashed by a drag over fresh scenes | every scene | **0** (120 skipped) |

`sceneSlice` also walks each merged range on its own now: the old loop started at the first range
and ran to the last one, so a screen of six Turns near the end of a hundred-thousand-event window
read the whole stretch between them to build a slice of a few hundred events.

## The feel is a clock and a curve (0.1.4.d)

Moving motion onto the plane changed *how* it is animated, not *what it looks like* — but the numbers
went with the mechanism, and they should not have. The fall had been tuned with the transition it
used to be (`bottom 420ms cubic-bezier(.45,.02,.95,.55)`, from one brick-height above the cell, no
bounce); the plane's first version used a shorter, faster curve with a 1 px settle instead, and a
36x15 brick that arrives in ~105 ms reads as a hop rather than a drop.

`transform` and `bottom` interpolate the same way, so the old motion is restored by writing the old
numbers on the new property:

| | 0.1.4 | 0.1.4.c | 0.1.4.d |
|---|---|---|---|
| fall: duration · curve · from | 420 ms · `cubic-bezier(.45,.02,.95,.55)` · 15 px | 260 ms · `cubic-bezier(.35,.9,.4,1)` · 18 px, 1 px settle | **420 ms · `cubic-bezier(.45,.02,.95,.55)` · 15 px** |
| new Turn: duration · curve | 260 ms · `ease-out` | 190 ms · `cubic-bezier(.2,.8,.2,1)` | **260 ms · `ease-out`** |

Measured by seeking the animation itself (`Animation.currentTime`, so the page's frame production
cannot distort it) and reading the brick's visual top, on both builds: the curves agree to **0.1 px**
at every sampled instant — 0:15 · 100:14.3 · 200:12.3 · 300:8.9 · 400:3.8 · 415:2.4 px above the
cell — while the work is unchanged: one element, one compositor property, and a new Turn still costs
`LayoutCount +1` against 0.1.4's +100.

The check lives in `scripts/test-scroll.mjs` now, which also closes a blind spot: the whole suite
runs with `prefers-reduced-motion: reduce`, so neither the fall nor the slide had ever been
exercised. The motion section asks for motion explicitly (`page.emulateMedia`), drives one brick and
one Turn, and asserts the clock, the curve and the trajectory.

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
