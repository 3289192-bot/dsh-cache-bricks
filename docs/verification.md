# Verification record

> **This record began with `dsh-cache-bricks` 0.1.0**, a new project whose code and verification record start from
> `dsh-cache-badge` 1.7.2 (frozen, unchanged, with its own package id). The name,
> the package id and the version line are new; the brick contract, the data model and the three
> fixes below are inherited verbatim, and the 0.1 gate at the top of this file is their
> re-measurement.
>
> For whoever reads this later, the three defects that shaped that code: the collector's feed used
> to *replace* the folded history (1.7.2-a), a folded brick could not be opened in the conversation
> (1.7.2-a, `historical-step`), and history had no type because the log was read by a poorer reader
> than the live path (1.7.2-c, `src/core/replay.ts`).

## 0.1.3 — a landing you can see

One fix on top of 0.1.2, developed against the local instance and ported here. The brick contract,
the data model, the rendering rules and the colour thresholds are untouched; the colour work
continues on the local line.

Reported from the running board: double-clicking a brick from a long Turn located nothing and
highlighted nothing, because the row lives inside the Turn's **capped process group**
(`[data-step-process-body]`, `max-height` plus `overflow-y: auto`) and only the conversation's own
scrollport was moved. The group came on screen; the row stayed where it was inside it. The second
half was worse: the flash *was* applied — to the correct DOM row — where the group clipped it, and
the panel still said `exact / 已定位`.

- **inside out**: `scrollToRow` moves the group's port first (`behavior: 'auto'`, because two
  animations at once make the row a moving target), re-measures the row, and only then scrolls the
  conversation. `scrollIntoView()` is deliberately not used: sticky chrome, follow-scroll and
  prepend anchoring all live on this surface, and one call that scrolls every ancestor at once
  would fight them. The anchor is the official attribute, with a structural fallback to the
  innermost scrollable ancestor, so a rename degrades instead of regressing;
- **visible, or it did not happen**: the board waits for the *row's* rect to settle rather than the
  conversation's `scrollTop` — the latter says nothing about a row inside a port — and then checks
  `rowVisible()`: inside the conversation's box **and** inside every port between them. If it is not
  visible there is no flash, and the verdict is `exact-not-visible`, printed by the panel as "found,
  not visible" and explained by the notice.

Verification on this release:

- `pnpm run typecheck` clean; **371 unit tests passing, 2 skipped** (0.1.2's 367 plus the reveal and
  panel cases this fix adds);
- `pnpm run test:scroll` — **47/47** in a real browser (unchanged from 0.1.2: this fix adds no
  browser fixture, because the level it needs lives in the unit fixture below);
- `tests/reveal.spec.ts` — the fixture grew the scroll level it was missing, which is why the
  existing browser checks could not see this bug: every row used to be one `scrollTop` away from
  the conversation. It now models a capped group with its own `scrollTop`, rows nested under it, and
  **live** geometry. Three cases: the port is scrolled first to a value that brings the row inside
  it and the conversation is asked afterwards; a group that cannot scroll yields
  `exact-not-visible` instead of a landing; and an element that merely has the metrics is not
  treated as a port when it has nothing to scroll;
- `tests/panel.spec.ts` — the detail prints "found, not visible" and "nothing was highlighted" for
  that verdict, and still prints the ordinary landing for a row that is visible;
- `pnpm run verify:host` — all checks passed on the built artifact;
- measured on the running instance: `[data-step-process-body]` exists with `max-height: 400px` and
  holds `assistant-step*` / `tool-call*` rows — the mechanism, in the real DOM. The end-to-end
  gesture on a long Turn is the confirmation a reader performs on their own screen.

## 0.1.2 — public GitHub distribution

The 0.1.2 release starts from the local `v0.1.1` stable commit; the public GitHub line starts at `v0.1.2`. No `src/` runtime implementation changed. The changes are distribution and documentation: the package version, exact `0.1.7-rc.2` DSH client peer range, prebuilt `lib/` files, portable verification-script defaults, synthetic release screenshots, and a GitHub-only release workflow.

On the 0.1.2 release checkout:

- `pnpm install --frozen-lockfile` and `pnpm run typecheck` succeeded;
- `pnpm run build` produced the host, client, invariant, and type artifacts;
- `pnpm test` passed **367 tests, 2 skipped** across 23 files;
- `pnpm run verify:host` passed all built-host checks;
- `node scripts/test-scroll.mjs --shot <directory> --showcase` passed **47/47** in Chromium with React 18 and synthetic DSH services. The two public screenshots are cropped from this synthetic run, not a private conversation.

The live 0.1.7-rc.2 instance was still running 0.1.1 during this packaging work. Its live behavior is recorded below; a separate full live UI run against the 0.1.2 package was not performed. The 0.1.2 support scope is rc.2 only. Historical 0.1.6-alpha.1 contract comparisons below do not extend that support scope.

## 0.1.1 — stable

This is the line's first **stable** release: the brick contract, the data model and the rendering
rules are frozen here, and anything after it starts at 0.1.2 and has to justify itself against this
record.

What it contains, in one place:

- the identity of a new project (`dsh-cache-bricks`, plugin id `cache-bricks`, `/cache-bricks/*`
  routes, `data-cache-bricks-*` DOM attributes, `[dsh-cache-bricks]` logs), cut from
  `dsh-cache-badge` 1.7.2 and independent of it;
- three inherited fixes: the collector's feed **joins** the replayed history per attempt, history
  bricks are **navigable** (`historical-step` and, from the replay, attempt-exact targets), and
  history **has a type** because the session log is folded by the same observations the live tap
  uses (`src/core/replay.ts`, three provenances `host` / `replay` / `client`);
- the palette from 0.1.0.a: **amber below 90%, red below 70%**, with the critical wording moved off
  "the cache was rebuilt" (a false diagnosis at 43%, which is red now).

Re-measured on this exact commit, so the stable claim is not inherited on faith:

- `pnpm run typecheck` clean;
- `pnpm test` — **367 passed, 2 skipped** in 23 files;
- `pnpm run test:scroll` — **47/47** in a real browser, including the palette check that drives
  99% / 85% / 60% through the real mapping and asserts the three tone materials reach the pixels;
- `pnpm run verify:host` — all checks passed on the built artifact;
- `pnpm run check:contracts` — the client contract is member-identical across the two cores;
- live on :18090 (the new package is what the instance serves: `/cache-bricks/*` 200,
  `/cache-badge/*` 404): the board renders, the type face is painted for reconstructed history, and
  no page error is raised. No amber or red brick exists on this machine's data to point at — the
  lowest cache read in any session log is 99.7% — which is why the palette is verified against
  fixtures and pinned boundaries rather than against a live low-cache step.

## 0.1.0.a — the palette answers sooner

The tone boundaries move from **red below 10% / amber below 80%** to **red below 70% / amber below
90%** (`CRITICAL_BELOW`, `WARN_BELOW` in `src/client/logic.ts`).

That is not a cosmetic shift, and the constants say why: at 10% only a rebuilt cache could reach
red, so red *meant* "the prefix was thrown away". At 70% red means "this call re-billed most of its
prompt" — a 30% loss on a 400k prompt is 120k tokens at full price, and it used to be painted amber
and scrolled past. Amber moves with it for the same reason: a tenth of a long prefix re-billed is
the tail this board exists to watch.

The wording moved with the thresholds: the critical reason is now "most of the prefix was
re-billed" rather than "the cache was rebuilt", which would be a false diagnosis at 43% — and 43%
is red now.

Boundaries are pinned on both sides, in `tests/logic.spec.ts`: 69.9% red / 70% amber / 89.9% amber
/ 90% green, with the earlier cases re-stated (a 43% hit is red rather than a warning). The
`minor` floor is untouched: a prompt under 1,000 tokens stays grey whatever its ratio, so the new
red cannot be diluted by tiny steps.

The browser suite now exercises the mapping end to end rather than only the table: the fixture's
three steps carry 99% / 85% / 60%, so they travel the real path (ratio -> `badgeStatus` -> tone ->
fill), and one new check asserts the three tone materials actually reach the pixels
(`rgba(34, 197, 94, 0.18)` / `rgba(234, 179, 8, 0.85)` / `rgb(220, 38, 38)`). Screenshots of that
board are in the record's companion run: green floor row, amber middle row, red stack above it.

Gate: `pnpm run typecheck` clean; `pnpm test` **367 passed, 2 skipped**; `pnpm run test:scroll`
**47/47** (was 46 — the palette check is the new one); `pnpm run verify:host` all checks passed;
`pnpm run build` clean.

Worth recording for whoever looks for a red brick on this machine and does not find one: the local
workload's cache reads are 99.7% at their **lowest** (15 live bricks, and no step under 70% in any
session log), so the new bands have no real data here. The palette is therefore verified against
fixtures and boundaries, not against a live red brick.

## 0.1.0 — the new project's gate

This is the re-measurement of the inherited code under the new name, id and version line. Nothing
in the sources changed except the identity (`dsh-cache-badge` -> `dsh-cache-bricks`, the plugin id,
the route namespace, the DOM attribute prefix and the log prefix), so a green gate here means the
rename did not cost anything.

- `pnpm run typecheck` clean;
- `pnpm test`: **360 passed, 7 skipped** in 23 files. The skips are the checks that talk to a
  running instance, and they skip for a reason worth recording: the instance on :18090 is still
  the **frozen** `dsh-cache-badge` (it was composed at startup), so `/cache-bricks/*` answers 404
  until this package is installed and `dsh web` restarts. The offline half of that check — the
  replay against the newest real session log — runs and passes:
  **2061 events -> 311 bricks, 0 unattributed, types `tool/mixed/output/reasoning`, targets
  `assistant-step`/`tool-call`, 8 ended Turns**;
- `pnpm run test:scroll`: **46/46** in a real browser (the window, the rails, the printed readings);
- `pnpm run verify:host`: all checks passed on the built artifact (fake ctx, a replayed session with
  a retry, read back through the plugin's own route);
- `pnpm run check:contracts`: the client contract is still member-identical across the two cores;
- `pnpm run build`: `lib/client.js` 123.76 kB (gzip 36.92), `lib/index.js` 78.05 kB (gzip 22.00).

## 1.7.2-c — historical brick reconstruction

The third defect in the same seam, and the one that made the other two worth generalising: a brick
older than the collector had no **type**. Not because the session log lacked the activity — it
carries the settled attempt's whole compact stream — but because the browser folded the log down to
per-step usage readings, and the board painted every folded brick as a blank dashed placeholder.

So the fold itself was shared instead of re-implemented: `observe.ts`, `brick-ledger.ts` and
`blob-store.ts` moved to `src/core/` (they were always pure — no DSH imports, no IO), and
`src/core/replay.ts` runs the collector's own observations over a session's durable events.

Reconstructed per attempt, from the log alone: usage and the three cache buckets, reasoning/text/tool
counters off the compact stream's runs, tool call ids/arguments/results, retry chains and attempt
ordinals, the finish reason, the settlement `seq` — and therefore the **activity type**, the
**lifecycle** and an **attempt-exact navigation target**. Not reconstructed, and reported as absent:
the outgoing request and its message hashes, the dispatch-time context snapshot, the provider's raw
request, and the dispatch instant (a replayed TTFT is measured from `step/start`).

The board now merges three sources per attempt — live collector, replayed log, per-step fold — and
`BrickRecord.observedBy` carries `host` / `replay` / `client`, which the panel reports verbatim and
the faces paint differently (solid / dimmed solid / dashed placeholder).

Verification:

- `pnpm run typecheck` clean; **365 tests in 22 files** (was 356 in 21). `tests/replay-log.spec.ts`
  holds both layers: fixtures that pin the semantics (a retried step becomes two bricks with the
  chain's row; the compact stream's runs are counted once; a settlement that names no step is
  counted rather than guessed at) and a check against the newest real session under
  `DSH_SESSION_ROOT`;
- that real-log check, on this machine's newest session: **1725 events -> 257 bricks, 0
  unattributed, types `tool/mixed/output/reasoning`, targets `assistant-step/tool-call`, 6 ended
  Turns** — the same input the per-step fold turned into one type with no row to go to;
- `pnpm run test:scroll` still **46/46** (the window, the rails and the printed readings against
  the rewritten merge), and `pnpm run verify:host` / `check:contracts` unchanged;
- live 18090, session `e7166b4f` (collector state long gone, feed empty): the board shows **10
  bricks, 0 dashed, 0 placeholders, 0 page errors**, labels in one decimal, and every brick's
  accessible name reads "reconstructed from the session log (one brick per settled attempt; no
  request capture)". Flipping the board with its own control shows the **activity face painted** —
  purple Model bricks, orange Tool bricks and the purple/orange split — where the fold produced a
  wall of `~`;
- the same session, double-clicking a **replayed** brick: `exact` landing on
  `14:assistant-step55:1` (part `reasoning`), reported as "已定位：第 55 轮 · 第 1 步" with no
  step-level qualifier, because the replayed brick really is that attempt.

**What the client costs now:** `lib/client.js` grew 98.78 kB -> 123.71 kB (gzip 29.31 -> 36.93 kB),
which is the price of the shared fold running in the browser. It is memoised on the durable window,
and that window only grows when something settles — a long answer costs one replay per step, not one
per chunk.

## 0. rc.2 re-verification (2026-09-24)

The instance moved from 0.1.7-rc.1 to **0.1.7-rc.2**. What was re-run, and what it found:

| Layer | Command | rc.2 result |
|---|---|---|
| Interface diff | rc.1 tarballs out of the npm cache vs the installed rc.2 tree, plus greps of the compiled bundles | Two changes only: `toolHistory`/`ToolUpdate`/`deferLoading` activated (`toolHistory` appears **0 times** in rc.1's `dsh-llm`/`dsh-agent-loop`), and the client's live row is `assistant/live-chunk` (`assistant/chunk` exists only in the session format migrations). Frame union, durable events, trajectory tokens, DOM anchors and the assembler guard: unchanged. |
| Unit + artifact | `pnpm run test` (now against rc.2 devDeps) | **312 passed | 2 skipped** (21 files). |
| Built host artifact | `pnpm run verify:host` | 28 checks, all passed — including the new tool-history ones: the effective list is counted once (not `["read","write","write"]`), an activation of an already-declared tool is reported as an activation, the deferred flag is reported, and the stored list carries neither the duplicate nor the dispatch-only flag. |
| Cross-core contracts | `pnpm run check:contracts` | 0.1.6-alpha.1 vs rc.2: every member identical. |
| Live collector | `pnpm run verify:live` | 110 bricks on real rc.2 traffic, message sharing 98.3% (304 stored of 17,820 carried), tools hash constant across the session, TTFT 1.43–1.51 s, context frozen at dispatch, no request stores a message it already shared. |
| Real browser | `pnpm run verify:ui` | All checks passed; census `55 settled — 37 with a row, 0 needing a group opened, 0 with no visible artifact, 1 auxiliary call with no row by contract`; `landings: 4 exact, 0 context, 0 none`; `host: patched`. |
| Host patch (separate repo folder) | `patch.mjs --check` → `unpatched (patchable)`, then apply + `node --test` + `live-turn19.mjs` | Anchor byte-identical in the rc.2 bundle, so the same patch applies; **5/5** tests pass patched (**2/5** unpatched, so the regression test still bites); live: `jump: exact`, rendered turns `[2,3] → [1,2,3]`, 18 rows drawn for turn 1. |

Three checks in the *harness* were wrong and were fixed rather than worked around — each one
had simply never been reached by real data before:

- `ui-verify`'s lifecycle whitelist said `■` for an interrupted brick while the code, the
  README and the brick contract all say `⏹`; this session is the first to have put an
  interrupted brick on the board.
- `ui-verify`'s "no type face prints anything" read the slab's whole `textContent`, which
  includes the lifecycle corner glyph both faces carry **by design**; it now excludes the mark.
- `ui-verify`'s census counted an auxiliary brick as unlocatable. A session title has no row
  by contract (`target: none`), so the census now counts those separately and prints why —
  and the honest-reporting check samples one of them too.
- `live-verify`'s "every request after the first stores only its new messages" was a
  percentage heuristic that a first request (4 messages, all new) and an auxiliary call
  (1 message, unrelated prompt) fail correctly; it is now the exact invariant
  `stored ≤ count − shared`.
- The same run exposed a real metric defect, now fixed in the collector: `sharedMessagePrefix`
  was measured against the last request **of any kind**, so a session-title or compaction
  prompt became the baseline for the next Turn request and reported it as sharing nothing —
  a number the diff then repeated as a verdict. Baselines are now per kind.

## 1. Unit and artifact tests — `pnpm run test`

304 tests in 21 files on rc.1 (**312** after the rc.2 sync; `2 skipped` are the live panel check
when no instance is listening, and the collector-cost benchmark without `DSH_BENCH=1`).

`tests/navigation.spec.ts` covers the unified loader on its own: reaching the session face or
refusing to (`sessionFaceOf` survives a service that throws), what "the window covers this
position" means (`hasMore === false` answers it outright; otherwise the window's oldest event
does), and the five answers `ensureBrickTargetLoaded` can give — each one a different sentence
in the panel, and none of them a rounded-up success. `locateResultOf` is unit-tested for the
same reason: `host-projection-blocked` is only ever produced when the loader confirmed
coverage, so the difference between "the host drew nothing" and "the plugin failed" is a
property of the code, not of a comment.

`tests/brick-contract.spec.ts` is separate on purpose: it asserts the frozen definition
(two attempts of one step are two bricks, an unattributable observation is dropped and
counted rather than attached, the client's fold never claims an attempt, a target never
invents a Turn), so moving that boundary has to be a deliberate edit.

Covered: the disjoint-bucket arithmetic and the honesty rules, the sha256 vectors,
the ledger's attempt folding (a retry becomes a second brick of the same step), the
observation mapping, the content-addressed store (dedupe, LRU, oversize refusal,
exact string round-trip), the diff's attribution order, the activity classification
and its 4+1 palette, the proportional reasoning/tool split and its clamp, the
lifecycle glyphs, the flip state, the panel's seven tabs, the built client bundle
executed through the module loader, and the manifest contract.

The read-only guarantee is pinned behaviourally, not by comment:

- the `llm/stream` tap returns the downstream stream **by identity** (asserted
  against a marker object; anything else would replace the model's stream);
- when the observation itself throws, `next()` is still returned;
- a deep-frozen loop request is observed without a write (which would throw).

## 2. Built host artifact — `pnpm run verify:host`

23 checks against `lib/index.js` installed on a context double: it subscribes to
the three event feeds, registers its route, replays a step whose first attempt
blows the cache and fails and whose retry finds it warm, then serves the feed
through the real route handler and reads it back.

```
brick verify-session:9:4:0 · attempt 0 · cache 0.00%  · attempt · error      · tools 0
brick verify-session:9:4:1 · attempt 1 · cache 99.23% · message · tool-calls · tools 1
```

## 3. Live collector — `pnpm run verify:live`

Against the running 017 instance, on its own real traffic (18 steps of one
session):

| Check | Result |
|---|---|
| plugin route, same-origin vs cross-origin | 200 / 403 |
| bricks carry provider usage | 18 of 18 |
| full request and timed stream kept by reference | yes, both readable back |
| request hashes and the shared message prefix | `tools ea854f9c9932` constant; `shared 582 / 584 / 586 / 588` |
| context frozen at dispatch | window 1,000,000 · pressure 468,616 → 473,123 · TokenMeter nodes 584 → 590 |
| TTFT measured from dispatch | 1.83–2.00 s |
| an individual message fetchable through the ref list | yes (556 refs shared between the last two requests) |
| unknown ref | 404, not invented |

**Storage sharing, which is the point of the content-addressed store:**

```
messages 10,314 carried, 590 stored (94.3% shared)
  586 messages → 2 stored     588 → 2     590 → 2
  store 714 blobs, 3.8 MB     (before the fix: 10.2 MB for six requests)
```

The cache hit rate of the observed session stayed at 99.85–99.97% across all of
this — the plugin reports on requests, it does not disturb them.

## 4. Live panel — `tests/panel-live.spec.ts`

The join the other three layers cannot prove: a brick the collector captured,
rendered by the real component, all seven tabs, with the real numbers — route,
cache percentage, TTFT, prompt size, header reason, hashes, shared prefix, the
dispatch-time context, the tool calls, the stored refs — and then two real
requests diffed into one sentence:

```
live panel check: session-…:26:8:0 · cache hit 99.91% → 99.97%:
  new request header (Header reason resume → series)
```

## 5. Real browser — `pnpm run verify:ui`

`scripts/ui-verify.mjs` drives the served GUI with Playwright. What it checks cannot be
checked anywhere else: the board is a DOM overlay built outside React (so no server render
contains it), its two sides are a CSS 3D flip and a derived material, and clicking a brick
has to move the *conversation* to that brick's own row.

The jump half is deliberately a **two-part** check, because a single "did it move" assertion
is what let a near-miss pass for a fix:

1. a **census** over every settled brick currently on the board — each one's declared
   target must resolve to a row (its step's half, a call it made, or its retry chain). This
   is cheap, covers everything, and is the number that says how many bricks are genuinely
   unlocatable. It is *not* "a row nobody else can point at": a retried step's two bricks
   share the retry row, and both are target-exact;
2. a **click proof** on a sample, requiring `exact` — the marked row must be one of the
   rows that attempt owns, the record must open, and the panel must report the same
   accuracy. `context` and `none` fail this check.

Against the running 017 instance:

```
instance http://127.0.0.1:18090 · session session-58aa2f08…
  ✓ the board has a usable size
  ✓ the cache side carries one slab per visible brick
  ✓ every reading is a percentage or an honest n/a
  ✓ lifecycle is drawn as glyphs, never as a colour of its own
  ✓ every brick already knows its activity type
  ✓ the type side is not built while it faces away
  ✓ the flip control is on the board
  ✓ the card starts on its cache side
  ✓ the flip turns the whole card over
  ✓ the control now offers the way back
  ✓ the activity side mirrors the bricks
  ✓ a split face is exactly the model/tool pair (the official thinking + acting lanes)
  ✓ every type face is an official span: flat, 1px corners, no shadow
  ✓ a split face is two flat halves, and only the model lane may carry a gradient
  ✓ every split brick is split left/right, never top/bottom (52 checked)
  ✓ official opacity: background lanes are dimmed, the lanes that matter are not
  ✓ the cache face keeps its own translucent tone
  ✓ no type face prints anything: the colour is the reading
  ✓ every face still names its lane and its specific where there is room
  ✓ the two sides agree on every brick
  ✓ the visible side is interactive and the hidden one is not
  ✓ the pointed-at brick lights up and settles back (color(srgb 0.933333 0.762745 0.580392) → rgb(221, 134, 41) → color(srgb 0.933333 0.762745 0.580392))
  ✓ the lit brick wears the official tool colour (rgb(221, 134, 41))
  ✓ a output brick lights up too, and settles back
  ✓ the card turns back to the readings
  · census: 86 settled bricks on the board — 35 with a row, 0 needing a group opened, 0 with no visible artifact at all
  · 51 brick(s) are behind history the chat has not loaded yet: session-58aa2f08-bf51-47c9-a278-b874bb5e5fcf:21:1:0, session-58aa2f08-bf51-47c9-a278-b874bb5e5fcf:21:2:0, session-58aa2f08-bf51-47c9-a278-b874bb5e5fcf:21:3:0
  ✓ every settled brick that produced something can be reached: a row, or a log position to load through
  ✓ there are settled bricks on the board whose row is already visible
  · sampling 2 brick(s) that need history loaded first
  ✓ one click opens the record and does not move the conversation
  · landings: 4 exact, 0 context, 0 none
  · host: patched (system-message keeps a materialized node; loaded pages project)
  · load-then-land: 21:1 0.5s, 21:2 0.2s (official loader paging a long session)
  ✓ every sampled brick that was already rendered landed target-exact
  · lane: no auxiliary brick in this session yet (compaction / session title)
  ✓ the inspector offers the trip to the transcript
  ✓ the panel's button lands the same row the double click does (exact)
  ✓ the transcript tab waits to be asked, and says what it will read
  ✓ reading the conversation never scrolls the chat (ready)
  ✓ reading the conversation leaves the chat where it was
  ✓ the transcript tab reads the log, not the DOM: labelled verbatim blocks (session-58aa2f08-bf51-47c9-a278-b874bb5e5fcf:21:1:0)
  ✓ the assistant block holds the text the log committed for this step

all checks passed
```

The auxiliary lane is checked live whenever the session has an auxiliary call, and the
line above is what "not yet" looks like: a compaction or session title has to have happened
for the lane to exist, and the run above had neither. Its geometry, its model wiring and its
"does not invent a Turn" rule are unit-covered meanwhile (`tetris`/`bricks`/contract).

The three closure fixtures live in the unit suites, where they can be forced rather than
waited for: one step with **two attempts in flight** settled in start order (`brick-ledger`),
the three classes of assistant content — reasoning-only, response-only, both — landing on
the half the attempt began in (`reveal`), and an auxiliary call with **no turn and no step**
resolving through its `compactionId` while a session title is declared unreachable
(`bricks`/`reveal`).

The census separates three things a single "unlocatable" number would confuse:

- a brick whose declared target resolves to nothing **although the attempt produced content or
  a call** and which carries no log position either — the only real defect, and asserted empty;
- a brick whose attempt produced *nothing at all* — measured once on a step observed mid-flight
  across a collector restart, `chunkCount: 0`, for which the view renders no row and `none` is
  therefore the correct landing;
- a brick **behind history the chat has not loaded** (51 of 86 in the run above). Those are not
  defects at all: the loader pages them in, which is what the sampled landings prove — the run
  samples two of them on purpose and requires `exact` from both.

The one click that opens the record is asserted to leave the conversation exactly where it was
(`scrollTop` unchanged), because loading and scrolling on every click is what made an earlier
version feel like it was yanking the page away.

The census is what the review asked for and what the earlier design could not produce:
with `nearest` removed, a brick that cannot be located is a **failure with a name**, not a
blue flash on somebody else's row. Playwright is not a dependency of this package, so the
script resolves `playwright-core` from `$PLAYWRIGHT_CORE`, the local `node_modules`, or the
global npm root, and exits 0 with a message when neither it nor a Chromium build is present
— the check never fails for a reason that is not the plugin's.

## 6. The host defect this feature ran into, and its fix

While verifying the loader, a brick behind un-loaded history landed `none` even though
`loadThrough(seq)` had succeeded — measured: `oldest=4173 → 2444`, events `807 → 2536`, and
the transcript still drew none of it. The cause is in the host, not in the loader:

```
[session-controller] event feed subscriber failed: Error:
conversation Definition "system-message" withdrew materialized target "chat";
return the same key with hidden visibility instead
```

`ConversationNodeAssembler.buildTargetUpserts` throws when a Definition turns a materialized
node into `null` (`dsh-client-ui-conversation/lib/client.js:2490-2496`), and the throw loses
the whole flush — the page of history that triggered the rebuild.
`systemMessageDefinition().buildViewNode` does exactly that whenever the prompt is not
*visible* (`dsh-client-ui-chat/lib/client.js:9223-9237`), which a prepend re-derives
differently. Its sibling `requestPromptDefinition` in the same file already carries the fix
(same key, `visibility: "hidden"`).

Isolation evidence (all on 0.1.7-rc.1, this instance):

| Probe | Result |
|---|---|
| this plugin's jump to a brick behind history | `none`, with that error in the console |
| **the harness's own Turn navigator** to the same turn | the same error, the same missing rows |
| the same navigator with this plugin's Definition **unregistered** | identical — so the plugin is not the cause |

The local `host-patches/system-message-never-withdraw/` experiment (not included in this public repository) carried the minimal fix and its evidence:

- `patch.mjs` — idempotent, `.orig` backup, three invariants mirroring the sibling Definition
  (never materialized + invisible → `null`; materialized + invisible → same key, hidden;
  visible → visible node);
- `system-message.spec.mjs` — 5 tests driving the **installed artifact** (the Definition is
  taken from the bundle exactly as the loader would): **2 pass / 3 fail unpatched**, **5/5
  patched**;
- `live-turn19.mjs` — the integration test: pick the oldest brick on the board, double-click,
  require `exact` **and** a drawn row. Unpatched: `jump: none · withdrew error: true · rows 0`.
  Patched: `jump: exact · rows 8 · rendered turns [23,24,25] → [11…25]`.

With the patch applied, the same live checks read:

```
· landings: 4 exact, 0 context, 0 none
· host: patched (system-message keeps a materialized node; loaded pages project)
· load-then-land: 21:1 0.6s, 21:2 0.2s (official loader paging a long session)
```

## Status of the two instances

| Instance | State |
|---|---|
| 017 (**0.1.7-rc.2**) | Installed, both halves active, re-verified above — including the two-sided board and the click-to-jump in a real browser. Client bundle rev served from `lib/client.js`; host half loaded at boot. **The host half in the running process predates the rc.2 sync** (it was loaded before the rebuild), so `toolHistory` capture, the per-kind prefix baseline and the excluded-mark checks take effect on the next `dsh web` start; the client half is picked up by a page reload. |
| daily (0.1.6-alpha.1) | **Historical check only; unsupported in 0.1.2.** At the time of this check, a local checkout link was installed but the instance was not running. No complete live UI run was recorded on this version. |

The two-sided board, the type labels and the click-to-jump are **client-half only**,
so `pnpm run build` is enough for a running instance to pick them up. The rc.2 sync changed
**both** halves — the collector gained the tool-history capture and the per-kind prefix
baseline — so that round needs a `dsh web` restart to be live.

Historical commands for a separate 0.1.6-alpha.1 instance (outside 0.1.2 support):

```sh
node scripts/live-verify.mjs --port 18083 --home /path/to/dsh-home
node scripts/ui-verify.mjs --port 18083 --home /path/to/dsh-home
node -e "process.env.DSH_LIVE_PORT='18083'" && pnpm exec vitest run tests/panel-live.spec.ts
```

The two lines share the client contract (`pnpm run check:contracts` reports them
member-identical) and the collector speaks structural types only, so the code path
is the same one verified on 017; what a daily run would add is confirmation that
0.1.6 emits the same payloads in practice.
