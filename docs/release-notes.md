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
