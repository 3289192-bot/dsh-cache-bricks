> 历史开发记录：版本、兼容性、性能与验收表述对应当时的构建。当前发布说明以 README 和 publication.md 为准；文中的本机路径及真实会话标识已替换为示例。

# dsh-cache-bricks 0.1.5

The 0.1.4-f line, renamed. No byte of the plugin's code changed.

0.1.4 went six review rounds past the name it shipped under (a through f). The next line — the pro
line, whose brick colour is a reuse verdict rather than a hit rate — has to build on the end of that
line, and a base that reads "0.1.4-f" reads as a patch of 0.1.4. So the tip is frozen under a version
that carries no such reading: **0.1.5**. The lite line moves in step as **0.1.5-lite** — the same
renumber, the same zero behaviour change.

What this version contains is exactly the 0.1.4-f feature set: history read a scene at a time with a
per-step cache and paged windows, the compositor motion model, the two drops, and the reduced-motion
fix. None of it is touched here — not the brick contract, not the scene model, not a threshold, not an
animation constant.

Both halves of the built artifact are byte-identical to the 0.1.4-f build:

| half | sha256 | vs 0.1.4-f |
|---|---|---|
| host `lib/index.js` | `2b86ca45…` | identical |
| client `lib/client.js` | `72b85c73…` | identical |

The package version is not embedded in either bundle, so the renumber changes no byte the running
instance serves: the client bundle keeps its content hash, and a page refresh is the whole
installation step.

Verification on the renamed tree: type checking, **441 unit tests** (3 skipped), the contract-drift
check, the built-host check and **83 browser fixture checks** pass — the same numbers 0.1.4-f
reported.

Local install:

```sh
DSH_HOME=/path/to/dsh-home dsh plugin --profile web add \
  file:/path/to/dsh-home/backups/cache-bricks-0.1.5/dsh-cache-bricks-0.1.5.tgz
```

# dsh-cache-bricks 0.1.4-f

The drops run again on a machine that asks for reduced motion.

0.1.4 dropped every new brick with a `bottom` transition and never consulted
`prefers-reduced-motion`; the only motion it gated on that preference was the card flip. 0.1.4.b moved
the drop to a Web Animations `transform` and — with the flip's gate copied along — silenced it for any
reader whose system asks for reduce. On such a machine the board stopped dropping entirely: bricks
appeared in place, which reads as stiff, and the second drop this line just restored never showed.

The drop and the new-Turn slide no longer consult the preference, which is what 0.1.4 did. The card
flip keeps its gate, because that is where 0.1.4 honoured it. Measured in the fixture with
`prefers-reduced-motion: reduce` forced on, same probe on both builds:

| | birth | settle |
|---|---|---|
| 0.1.4-e | tops `789..789`, **0/119 frames animating** | 0/121 |
| 0.1.4-f | tops `774..789`, **101/120 frames animating** | 100/121 |
| 0.1.4 | tops `774..789`, 100/119 frames animating | (repainted in place) |

The fixture's two-drop check now runs under the suite's reduced-motion default, so this cannot
regress silently: it asserts both drops lift the brick and that every frame of both animations names
`transform` and no layout property.

Type checking, **441 unit tests** (3 skipped), the built-host check, the contract-drift check and
**83 browser fixture checks** pass on this release.

# dsh-cache-bricks 0.1.4-e

The brick drops twice again, and the dashed cell rides the board.

A brick has two moments in a reader's view: it is **born** (the collector's draft — no usage yet, so it
reads `n/a`) and it **settles** (the same brick, wearing its reading). 0.1.4 marked both with motion;
0.1.4.b–d only marked the birth, so the reading arrived as a number changing in place while nothing
moved. This release states the lifecycle on the brick itself (`Brick.settled`, set by both builders —
`settlement !== 'running'` from the collector, always true for a folded reading) and lets the board
drop the brick again on the settle edge, with the same motion it was born with: 420 ms of
`cubic-bezier(.45,.02,.95,.55)`, starting one brick-height above the cell.

The second drop is the same animation on the same property: one `transform` keyframe pair on one
element, replaced (not stacked) via a stable animation id. Measured frame by frame in the fixture:
the draft is born at 774 and lands at 789 over 420 ms; the settlement repaints it to its reading and
drops it from 774 to 789 again over 420 ms — and every frame of both animations touches `transform`
only, never a layout property.

The dashed next-cell ghost — the box that says "the running Turn's next brick lands here" — was a
host-level overlay that animated its own `right`/`bottom` (and sat 6 px off, because the host's grid
is inset by the rails). It is the motion plane's first child now: it pans with the board and slides
with the stack on the compositor, animates nothing itself, and sits on the cell it names.

Type checking, **441 unit tests** (3 skipped), the built-host check, the contract-drift check and
**83 browser fixture checks** pass on this release (two new: the two drops, and the ghost). See
[verification details](verification.md).

# dsh-cache-bricks 0.1.4-d

The fall keeps the motion it always had, on the property it now uses.

0.1.4.b moved animation from `bottom`/`right` transitions to `transform` — the right change, since
transitioning layout properties re-ran style recalc and layout on every frame of every animation —
but it moved the *numbers* too: the fall became a 260 ms hop with a 1 px settle. The old motion was
420 ms of `cubic-bezier(.45,.02,.95,.55)` starting one brick-height above the cell: slow to start,
accelerating into the landing. Both properties interpolate identically, so this release simply
writes the old numbers on the new property, and a new Turn slides on 260 ms `ease-out` again.

Measured by seeking the animation (`Animation.currentTime`) and reading the brick's visual position,
on 0.1.4 and on this build: the curves agree to **0.1 px** at every sampled instant, and the work is
unchanged — one element, one compositor property, a new Turn still costs one layout where 0.1.4
cost a hundred.

Type checking, **439 unit tests** (3 skipped), the built-host check and **81 browser fixture checks**
pass on this release; the two new checks drive the fall and the slide (the suite otherwise runs with
reduced motion, so neither had ever been exercised). See [verification details](verification.md) and
[history as a scene](history-scene.md).

# dsh-cache-bricks 0.1.4-c

The data layer stops rebuilding the session: **a pan costs the screen, a page costs the page, and a
brick's raw bytes cost nothing until somebody looks at them.**

0.1.4.a/b made the drawing a window and the motion compositor work. Three places in the data layer
were still proportional to history rather than to the screen, and this release closes them:

- **a world instead of a merge.** `boardFromSources` re-folded every reading the session had on
  every scene change. It is now a base (the fold, rebuilt when the fold changes) patched by the
  scene on screen and by the collector's feed, rebuilding only the Turns that changed.
- **a step is a fact.** The scene cache held three whole scenes and dropped them whenever the window
  moved. A finished step's events never change again, so steps are cached by their own bracket and
  headers: two screens share their overlap, and coming back to one is a lookup.
- **a page lands on the page.** The window index is extended by the events a page brought, not
  rebuilt from the hundred thousand already indexed.
- **raw payloads are lazy.** A scene replay no longer canonicalizes and SHA-256s every stream, tool
  result and header into the blob store. They are the session's own events; opening a brick's raw
  view reads the one you asked for, from the log, at that moment.

Measured on the browser fixture, ten thousand Turns (thirty thousand steps):

| | 0.1.4.b | 0.1.4.c |
|---|---|---|
| ten screen reviews | 678 ms | **202 ms** |
| re-reading three already-read screens | 196 ms | **61 ms** |
| a page on a 120,000-event window | 13.1 ms | **2.72 ms** |
| raw payloads hashed by a drag over fresh scenes | every scene | **0** |

Install:

```sh
dsh plugin --profile web add github:3289192-bot/dsh-cache-bricks#v0.1.4-c
```

Type checking, **439 unit tests** (3 skipped), the built-host check and **79 browser fixture checks**
pass on this release. See [verification details](verification.md) and
[history as a scene](history-scene.md).

# dsh-cache-bricks 0.1.4-b

Motion moves to the compositor: **a pan follows the pointer by the pixel, and nothing animates a
position property any more.**

0.1.4.a made a pan cheap in the data layer and left how it *moves* alone. A drag was rounded to
whole cells — `0 → 1 → 2`, not `0px → 1px → 2px` — and every position was animated by transitioning
`right`/`bottom` (and `height`/`top` on the host). Those are layout properties: every frame of every
animation re-ran style recalc and layout, on a hundred bricks at once. The board's most ordinary
animation, a new Turn sliding in, cost **102 layouts and 103 style recalcs**. It now costs **1 and 1**.

What changed:

- **One motion plane per face.** The float part of a pan lives in a single `translate3d` on that
  element; a hundred bricks move because their plane moved. The data layer still sees whole cells —
  a whole cell crossed is the only moment the grid is rewritten, and it is invisible by construction.
- **A release settles.** 130 ms onto the nearest whole cell, from at most half a brick away, on the
  compositor. No easing while the hand is on the rail: pointer and board are the same number.
- **A new Turn flips one plane** (190 ms) instead of transitioning `right` on every brick, and a
  **new brick animates its own transform** (260 ms, a 1 px settle) instead of `bottom`.
- **The host's `height`/`top` transition is gone.** The box is a boundary; the bricks are anchored to
  the floor, so a taller band moves none of them.
- **A motion ring** (one extra column and row, painted outside the window, clipped, never
  interactive) is what lets the plane carry a fraction without exposing an edge.
- **The invariant, pinned by a test:** no `transition` or animation on
  `top`/`left`/`right`/`bottom`/`width`/`height` anywhere in the board. `will-change: transform` is
  set while a gesture or a hand-off runs and cleared after it — a plane, a flipping card and one
  falling brick, never a hundred promoted layers.

Install:

```sh
dsh plugin --profile web add github:3289192-bot/dsh-cache-bricks#v0.1.4-b
```

Type checking, **424 unit tests** (2 skipped), the built-host check and **73 browser fixture checks**
pass on this release; eight of those are new, and they measure the model rather than describe it
(the same script run against 0.1.4.a's sources is 67/73). See
[verification details](verification.md) and [history as a scene](history-scene.md).

# dsh-cache-bricks 0.1.4-a

Dragging stops rebuilding the board: **a pan asks the data layer for nothing until the hand stops,
and once when it does.**

0.1.4's *drawing* was already a window — a long session paints the same thirty bricks a short one
does — but the *pan* was not. Every painted frame of a drag cut a new scene and answered it on the
spot: `replaySession` over that slice, then a full React render of the board from the replay, both
synchronously on the thread reading the pointer. Two more session-scale costs rode along in the same
render — the durable window was copied and sorted on every render only to be told it had not moved,
and the whole board was rebuilt and handed to `setColumns` as a fresh array — so the longer the
history, the worse a drag felt. Not because of brick count: because a drag walked most of the
session again, per frame.

What changed (timing only; the brick contract, scene model, data model and colour rule are
untouched):

- **The wire is deferred.** While a hand-driven pan is in flight the board parks the demand
  (`pendingScene`) — the same quiet window the bricks' own animation already waits for — and sends
  it once the pan ends, shortened to 80 ms on pointer release. Bricks do not wait for it: a pan is
  pure geometry, every brick the reader pans past is drawn from data already in hand, and only the
  *exactness* of the bricks on screen arrives one quiet window late. Nobody reads a brick's type
  while the board is flying past.
- **The window is asked about itself before it is copied.** The runtime already publishes
  `SessionEventWindow.revision`; `windowKeyOfSnapshot` reads that (plus the entry count and the
  durable ends, for a core that publishes none) and the render path materializes the events only
  when the key changed.
- **The board's data is memoised.** `readingsOf` and `boardFromSources` no longer rebuild the whole
  board on every render, and `setColumns` ignores an array it already holds — so the
  tallest-column memo survives a panel opening, a tab switch or a notice.

The same drag, both builds (2,000 Turns of durable history, 120 pointer moves, counters read while
the pointer is still down): 0.1.4 re-rendered the board **121** times, 0.1.4.a **0**; the scenes the
drag crossed are deferred rather than dropped, and the one it lands on is materialized on release
with a replay slice bounded by the screen, not the session.

Install:

```sh
dsh plugin --profile web add github:3289192-bot/dsh-cache-bricks#v0.1.4-a
```

Type checking, **420 unit tests** (2 skipped), the built-host check, and **65 browser fixture
checks** pass on this release — the nine new ones count a pan's cost instead of timing it, and six of
them fail against the 0.1.4 sources, which is what makes them evidence. See
[verification details](verification.md) and [history as a scene](history-scene.md).

# dsh-cache-bricks 0.1.4

History stops being a backlog and becomes a scene: **the board materializes what is on screen,
and pages the rest in when the reader walks towards it.**

0.1.3 replayed the whole loaded window and kept the newest 400 bricks of the result. That was
invisible while a window was one session's tail. The moment the board learned to page older
history in (`loadOlder` prepends 50-message pages), the replay outgrew its budget and the bricks
it dropped came back from the client fold — cache reading intact, **type** degraded to `output`,
because a fold cannot see reasoning or tool channels. The reader's symptom was precise and
annoying: exact bricks at the live edge, untyped bricks wherever they were actually looking.

What changed:

- **A scene, not a window.** The board says which Turns and steps it is showing (`onScene`, one
  screen of overscan each way, sent only when the answer changes). `client/history-scene.ts`
  indexes the durable events by step bracket, cuts the slice the screen needs — plus the
  `request/header`/`request/context` in force and each Turn's `turn/end`, which a bracket cannot
  hold — and replays **that**. The ledger budget is sized from the slice, so 400 stops deciding
  what a reader sees.
- **Paging, with an exit.** Near the left edge of the history it holds, the board asks for a page
  through the official `ISession.loadOlder()`; `HistoryPager` refuses to ask twice from the same
  window, refuses to overlap a page, and stops when the session says history is exhausted. A page
  that resolves without moving the window is never asked for again — that is the difference
  between paging and a request loop.
- **The pen no longer moves when history arrives.** Holding a panned window still against a new
  Turn counted *added columns*, so a prepended page looked like new Turns and shoved the reader
  two cells into the past per page. It now counts columns **newer** than the newest Turn seen.
- **A paint costs the viewport.** The window states its own column/row index range and the view
  walks only that; the tallest column is measured once per content array. A six-thousand-brick
  session paints the same thirty bricks a thirty-brick session does.

The brick contract, the data model, the rendering rules and the colour thresholds are unchanged.

Install:

```sh
dsh plugin --profile web add github:3289192-bot/dsh-cache-bricks#v0.1.4
```

Type checking, **413 unit tests** (2 skipped), the built-host check, and **56 browser fixture
checks** pass on this release, plus the contract-drift check against the installed 0.1.7-rc.2
cores. The paging and scene fixtures were confirmed to **fail** against the 0.1.3 arithmetic
before being kept. See [verification details](verification.md).

# dsh-cache-bricks 0.1.3

One fix on top of 0.1.2: **a landing now means a row the reader can see.**

A long Turn's process group is its own capped scrollport (`[data-step-process-body]`), so scrolling
only the conversation brought the group on screen and left the target row clipped inside it —
highlighted, and invisible, while the panel reported a successful landing. The reveal now scrolls
the group first, re-measures, then scrolls the conversation, and the board verifies real visibility
before it highlights anything. A row that is found and still clipped is reported as
`exact-not-visible` instead of as a landing.

The brick contract, the data model, the rendering rules and the colour thresholds are unchanged.

Install:

```sh
dsh plugin --profile web add github:3289192-bot/dsh-cache-bricks#v0.1.3
```

Type checking, 371 unit tests (2 skipped), the built-host check, and 47 browser fixture checks pass
on this release. See [verification details](verification.md).

# dsh-cache-bricks 0.1.2

First public GitHub release of the renamed `dsh-cache-bricks` package, based on the frozen 0.1.1 stable line. The brick identity, request collector, navigation, board rendering, and cache color thresholds are unchanged.

- One brick represents one real model request attempt, including retries.
- The cache face shows the request's hit rate; the reverse shows request activity.
- Click to read an attempt; double-click to locate its conversation row.
- Amber appears below 90% cache hit, red below 70%.
- Built `lib/` files are included for GitHub installation without an install-time build script.
- Supported runtime is **DSH `0.1.7-rc.2` Web profile only**. The package's DSH client peer dependencies now require that exact version.

Install:

```sh
dsh plugin --profile web add github:3289192-bot/dsh-cache-bricks#v0.1.2
```

If the old `dsh-cache-badge` package is present in that profile, remove it before installing this package to avoid two boards. Its `v1.7.1` release remains available as historical material.

The 0.1.2 build passed type checking, 367 unit tests (2 skipped), the built-host check, and 47 browser fixture checks. The browser screenshots in the README use synthetic request records. The local live instance remains on 0.1.1; no separate full live UI run was made after the 0.1.2 packaging changes. See [verification details](verification.md).
