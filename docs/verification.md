# Verification record — 0.1.4-lite (frozen)

> Frozen at `v0.1.4-lite` (marker `0.1.4lite-final-frozen`). 95 unit tests, 48 browser fixture
> checks, the built-host check, a live run where a real model call produced a real brick, and the
> log reader run against this machine's real session artifacts. Overhead against 0.1.3 and the full
> line: [0.1.4-performance.md](0.1.4-performance.md).

> This is a **new line**, cut from `v0.1.3` as a parts library rather than trimmed out of it. The
> 0.1.x record it came from is preserved on that tag (`git show v0.1.3:docs/verification.md`);
> what follows is the evidence for this line only.

## What was taken from 0.1.3, and what was not

| 0.1.3 module | here |
|---|---|
| `host/collect.ts` — the attempt correlation | **ported and reduced**: three taps, no summarizer, no context snapshot, no tool/retry tracking (`host/collect.ts`, ~190 lines) |
| `core/observe.ts` | **ported in part**: the usage reader and the compact-stream fallback live on inside `host/attempt-tracker.ts` |
| `client/logic.ts` — the cache arithmetic | **ported**: `promptTokensOf`, `hitRatioOf`, floored `percentLabel` (`shared/cache-brick.ts`) |
| `tetris.ts` — layout and stack geometry | **ported**: brick size, `fitBoard`, `cellPlacement`, the lead cell, the live anchor (`client/board-geometry.ts`) |
| `client/feed.ts` — the transport | **ported and reduced**: snapshot + one SSE event name, document-relative URLs kept |
| `core/brick-ledger.ts` | **dropped**: a brick is not a record of a request |
| `core/blob-store.ts`, `core/replay.ts` | **dropped**: nothing is stored, nothing is replayed |
| `client/{panel.tsx,reveal,navigation,target,bricks,tetris-view,tetris}.ts`, `shared/{brick,diff,metrics,sha256,stream-timeline}.ts` | **dropped** |
| the conversation-node fold (`client/cache-bricks-node.ts`) | **dropped**: the board no longer reads the chat to learn what happened |

## Evidence

- `pnpm run typecheck` — clean;
- `pnpm test` — **95 unit tests**, 6 files:
  - `cache-brick.spec.ts` (12) — the arithmetic: disjoint buckets summed, `null` ≠ `0`, floored
    printing, the three tones, the small-prompt rule, the five-character bound;
  - `attempt-tracker.spec.ts` (12) — identity from the frame, usage from the settlement, the
    compact-stream fallback, 5,000 deltas changing nothing, nothing drawn while in flight, a
    settlement the tracker never saw start, the retry shape copied out of a real log, the ring;
  - `session-log.spec.ts` (12) — the log reader: frames located structurally (including a frame
    that carries a checksum and a torn final frame that must be ignored rather than guessed at),
    settlements folded oldest first, usage taken off the event or out of the compact stream,
    auxiliary records counted and not bricked, and the reader run against **this machine's biggest
    real log** (2,281 frames → 3,747 records → 548 settlements);
  - `collect.spec.ts` (16) — the waterfall contract (`llm/stream` returns the very stream), a
    token-delta flood costing zero pushes, a hostile request object absorbed, a retry chain
    producing two bricks, the route registered on the web server, and the backfill: an old
    session filled from its log when a reader asks (and only then), a step seen live left alone,
    one read per session however often it is asked, and nothing read at all with `backfill: false`;
  - `host-feed.spec.ts` (11) — the ring and its `dropped` count, LRU sessions, `/bricks` and
    `/sessions`, the missing session id, the loopback and same-origin refusals, the harness policy
    first, and the SSE snapshot;
  - `board-geometry.spec.ts` (31) — capacity, the lead cell, the live anchor, columns by Turn with
    a retry stacked after the attempt it replaced, turn-end marking, the hover text, and the window
    and rail arithmetic ported from 0.1.3 with its tests (a pan in whole cells, the index range a
    paint walks, the tallest-column limit, the pan held against appends and left alone when the ring
    ages out, and every rail invariant — thumb within track, floor at the live end, no travel when
    the content fits);
- `pnpm run test:board` — **48/48 browser fixture checks** in Chromium with React 18 and a real
  layout. The data side: the board finds the gutter and stays inside it, the three tones reach the
  pixels (`rgba(34, 197, 94, 0.18)` / `rgb(220, 38, 38)` / `rgba(100, 116, 139, 0.35)`), `n/a` is
  printed rather than `0%`, a retry is a second brick in the same column above the one it replaced,
  a finished Turn reserves its drop column, Turns are columns one pitch apart, a ring that dropped
  1,022 bricks says so, and a 60-brick session draws only the columns that fit. The art side:
  0.1.3's material down to the border, the inset highlight, `500 12px` tabular digits and the bold
  red. The window: both rails are scrollbars that sit inside the board, the thumb starts at the
  live end, an inert rail is dimmed and not a tab stop, the drop slot is drawn only while the
  newest Turn runs, dragging the thumb pages back through whole Turns and keeps the grid, the chip
  appears with what is hidden and returns to the live corner in one click, Home/End reach both ends,
  the wheel pans over the rail and still scrolls the conversation anywhere else, a Turn taller than
  the board gives the vertical rail travel and keeps its newest brick in frame, the arrow keys move
  it and a fade then says what is above, a board filled from the session log says how much of it is
  history, and a reader who asked for less motion gets no transitions at all;
- `pnpm run verify:host` — the **built** `lib/index.js`, loaded as the harness loads it: the tap
  returns the model's stream untouched, one settled request becomes one brick over the real route,
  and the brick's keys are exactly the eleven fields (no `request`, `tools`, `raw`, `route` or
  `settlementSeq`);
- `pnpm run verify:live` — against the running instance (see below).

### The band a reader caught (0.1.4-lite.1)

Three tones shipped; a reader asked why the colours did not match 0.1.3's logic, and the answer was
that 0.1.3's *board* (`bricks.ts` → `toneOfRatio` → `badgeStatus`) has four bands and this line had
folded the amber one into green. Measured on the live instance before the change: **12 of 1,121
bricks** sat in the 70–90% band (81.3%, 89.7%, 88.7%, 73.4%, …), 4 were red, 1,105 green and 10
grey — so the difference was exactly those twelve, painted healthy when a tenth of their prefix had
been re-billed.

Restored: `warn` with 0.1.3's values (fill `rgba(234, 179, 8, 0.85)`, digits `rgb(42, 28, 0)`, edge
`#ca8a04`, weight 700), thresholds `bad < 0.7`, `warn < 0.9`, `good >= 0.9`, both boundaries in the
calmer band as in 0.1.3. Pinned by the unit tests (band edges, the two boundaries, the small-prompt
rule) and by the fixture, which now asserts the amber *pixels* rather than the label.

Worth recording as a process note: the two silences were already handled (no cache field, and a
prompt too small to be a signal stay grey), and the `hasCacheEvidence` rule that looked like another
difference never applied to bricks at all — 0.1.3's board passed `hasCacheEvidence: true`
unconditionally. One band was the whole difference.

### The bugs the browser fixture caught

- **Bricks drawn blank.** The first browser run failed five checks with bricks that were *positioned
  but blank*: `place()` painted a brick's colour and text only on the **update** path, so every
  brick created by the first feed arrived with no face and no hover text. The unit tests assert
  placement, and placement was correct.
- **No animation for the reader who asked for less.** The reduce-motion page showed transitions:
  the condition in `createSlab` was inverted (`smooth || prefersReducedMotion()`), and nothing but a
  real page with the emulated media feature would have said so.
- **The board was anchored to the window, not to the conversation.** The first live screenshot showed
  its panel sitting *under the sidebar*: the grid was right-aligned so the bricks looked right, but
  the tinted panel covered the session list. 0.1.3 anchored the board to the right of the gutter and
  this build had pinned it to the window's left edge. Measured, not guessed — and the fixture now
  asserts the invariant: *its right edge sits against the transcript it belongs to*.
- **Every frame came out four bytes short.** The frame scanner walked the block chain but ignored
  the optional 4-byte content checksum, so a real artifact decoded as *one* frame (its header) and
  the reader reported "0 settlements" on a log that holds 548. Nothing but a real log would have
  said so — which is why that check is in the suite.
- **A stale pan pinned the window.** Panning in one feed and then replacing the content (the ring
  drops its oldest Turns) left the board holding a pan the new content could not honour: the column
  axis clamped to zero while the row pan stayed at 0, so a running Turn taller than the board kept
  its newest brick off the top of the frame with no way to scroll to it. The window now resumes
  following when a pan is clamped away entirely — a pan the content cannot honour is a leftover, not
  a reading — and the fixture asserts the invariant directly: **while following, the brick that just
  landed is in frame.**

## The live run

The built plugin was run in a **real harness**: an isolated home (`<temporary-DSH-home>`,
since deleted) with a custom `lite` profile, the tarball installed through the official command
(`dsh plugin --profile lite add file:…/dsh-cache-bricks-0.1.4.tgz`, which also added the bundle
entry), booted as `dsh --profile lite --host 127.0.0.1 --port 18099`. Then, over its real HTTP
surface:

| check | result |
|---|---|
| the host half loads in a real composition | booted with no plugin error; the plugin row is in the profile's bundle list |
| `GET /cache-bricks/sessions` | `{"sessions":[]}` — the route is live and honest about having seen nothing |
| `GET /cache-bricks/bricks?sessionId=nope` | `404` — an unknown session is not invented |
| `GET /cache-bricks/blob?ref=x` | `404` — the previous line's route is **gone**, because nothing is stored |
| `GET /cache-bricks/sessions` without the browser cookie | `401` — the harness's own policy runs first |
| the client bundle | served from that instance's module table (`…,dsh-cache-bricks/client.js,…`) |

### The swap, and the bricks it produced

The instance was moved onto this build with the official command, and — because a host-half change
needs a process restart — restarted through the user's own launcher (`launch-dsh-017.ps1
-Port 18090`), driven by a detached script that waited for the agent's turn to be written first
(`~/.dsh-017/swap-to-lite.log`). After the restart the served host half **is** this one:

| route | answer | what it means |
|---|---|---|
| `GET /cache-bricks/sessions` | `200` | the route is live |
| `GET /cache-bricks/bricks?sessionId=…` | `200` with bricks | Lite's route |
| `GET /cache-bricks/attempts?…` | `404` | the previous line's route is gone |
| `GET /cache-bricks/blob?ref=…` | `404` | nothing is stored, so there is nothing to fetch |

Then `pnpm run verify:live -- --expect-brick`, on real traffic:

- **a real model call produced a brick** — 14 bricks over 14 dispatched requests on the session
  that was running, each with exactly the eleven fields, tone agreeing with the ratio, and the
  ratio equal to `cacheReadTokens ÷ prompt` (measured: `514,560 / 514,708`);
- the GUI's board drew all 14, every one painted, every one printing `99.9%` / `100%` / `n/a`.

**And the live data immediately showed the case this design exists for.** Turn 6 step 1 arrived as
a retry chain: five attempts that settled with **no usage at all**, then the one that worked —

```
unknown  turn 6 step 1 attempt 0 | in 0     read 0       ratio null
unknown  turn 6 step 1 attempt 1 | in 0     read 0       ratio null
unknown  turn 6 step 1 attempt 2 | in 0     read 0       ratio null
unknown  turn 6 step 1 attempt 3 | in 0     read 0       ratio null
unknown  turn 6 step 1 attempt 4 | in 0     read 0       ratio null
good     turn 6 step 1 attempt 5 | in 166   read 505,472 ratio 99.9%
```

Six bricks for one step. A step-level board would have drawn one green brick and never shown that
the request failed five times first; and because the five were never billed, they are grey rather
than red — nobody measured a miss.

That reading also caught a **wording bug** on its first live minute: the hover text said "provider
reported no cache fields" for those five, which blames a provider for a request that never got far
enough to have an opinion. `titleOf` now separates the two silences — *no usage billed* (a failed or
superseded attempt) versus *usage billed but no cache field* (a silent provider) — and the test for
it is written from this live chain.

### What is still not claimed

- The board's own layout is verified in a **fixture** page (`scripts/test-board.mjs`, 18 checks)
  with a one-row transcript; the live run reports what it drew (a 475-pixel gutter, 14 bricks)
  rather than asserting a count, because a real transcript of another width changes the capacity.
- Turn 0 — auxiliary calls (a compaction, a session title) — is deliberately not drawn: it belongs
  to no Turn, so it has no column. Those requests are counted as dispatched and not as bricks.
- A request dispatched and not yet settled leaves a gap between `dispatched` and the bricks. That
  gap is reported rather than hidden; the board draws the settled ones. (Observed live: one session
  read `7 bricks / 8 dispatched` while a turn was in flight.)

## The release path, run before releasing

Publishing is a workflow, and a workflow that has never run on the tag is an assumption. So the
frozen tag was checked out into a clean worktree and every step of `.github/workflows/release.yml`
was run in order:

| step | result |
|---|---|
| `pnpm install --frozen-lockfile` | clean (no lockfile drift) |
| `pnpm run typecheck` | clean |
| `pnpm run build` | `lib/client.js` 21.72 kB, `lib/index.js` 30.90 kB |
| `pnpm test` | 95 tests, 0 failures |
| `pnpm run verify:host` | all checks passed on the built artifact |
| `pnpm run pack:latest` | `dsh-cache-bricks-0.1.4-lite.tgz` + `dsh-cache-bricks.tgz`, the two assets the release step uploads |

Two things that check caught, both of which would have made the publish silently do nothing:

- the workflow's tag trigger was **still pinned to the literal `v0.1.2`** on this branch (the same
  bug that forced v0.1.3 to be published by hand) — fixed to `v*`;
- the version had to stop at `0.1.4-lite` rather than `0.1.4-lite.1` for the workflow's asset name
  (`dsh-cache-bricks-${GITHUB_REF_NAME#v}.tgz`) to match what `pnpm pack` produces.

The built halves in the release tarball are byte-identical to what the running instance serves.
