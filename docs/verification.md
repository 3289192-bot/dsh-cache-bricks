# Verification record

Evidence that the attempt-level black box works, from five layers that check
different things. Each layer exists because the one below it could not catch what
it catches.

## 1.7.1 — the click/navigation repair, and what is still owed

`1.7.1-clickfix.1` was an uploaded patch to the client half (single click previews the
conversation and reads its log; double click locates and highlights; six client files). It was
reviewed here against the real source, and **three defects in it were fixed before freezing as
`1.7.1`**:

1. **It did not type-check.** The package was produced with transpile-only tooling; under this
   repo's `exactOptionalPropertyTypes` the read-failure report passed `seq: number | undefined`
   into an optional field. (`src/client/index.tsx`.)
2. **It deleted a documented fallback.** `findRow` had been changed from "prefer the half the
   attempt began in, otherwise the step's other half" to a hard filter. A reasoning brick whose
   reasoning half the host does not draw could then no longer be located at all, even with its
   step on screen. Now: the reveal loop only ever accepts the brick's own half; **after** the
   whole settle budget, if that half was never rendered, the step's other half is reached and
   reported as `step-other-half` — `context`, never `exact`, never highlighted, and the notice
   says which half was missing instead of claiming a miss or a success.
3. **The screen-reader label lost the Turn number** ("double click locates" without saying
   where). Restored: `定位到第 N 轮并高亮`.

The first version of fix (2) was itself wrong and is worth recording: it gave up on the declared
half after one 50 ms tick, which turned this patch's own "reasoning mounts 850 ms late" case
into a fallback on the visible response row — measured, not theorised (the patch's browser check
`Later reasoning mount is not replaced by earlier visible response` timed out). The budget is now
always spent before "never rendered" is concluded.

**Verified before the freeze**

| Layer | Result |
|---|---|
| `pnpm run typecheck` | clean (the patch as uploaded was not) |
| `pnpm run test` | **316 passed | 2 skipped** — the 10 tests encoding the old interaction contract were updated, 4 new ones pin the new behaviour (own-half preference, the other-half fallback, "never exact", the panel's rendering of it) |
| `pnpm run build` | 84.03 kB client bundle; comments and host half intact |
| `node scripts/verify-host-artifact.mjs` | **31 checks**, all passed (`lib/index.js` is byte-identical to the 1.7.0 build, SHA-256 `58ad4ffa…` — the patch does not touch the collector, so no host restart) |
| `pnpm run check:contracts` | 0.1.6-alpha.1 vs 0.1.7-rc.2: every member identical |
| `node scripts/test-clickfix.mjs` (the patch's own suite) | **29/29** in real Chromium + React 18 (mocked DSH services) |
| `pnpm run verify:live` | green on the live instance: 10,193 messages carried, 234 stored (97.7% shared), tools hash constant, TTFT measured, no request stores a message it already shared |
| `pnpm run verify:ui` | **partially run and then stopped at the operator's request.** It had reached the interaction checks that matter most here — census 48 bricks (45 with a row, 0 needing a group opened, 0 unlocatable), `one click opens the record and does not move the conversation` ✓ — before being cancelled, so the real-instance pass is **not** complete |

**Still owed (the honest list)**

- A full real-instance `verify:ui` against the frozen bundle, in particular the two checks that
  changed with this contract: `selecting a brick reads its conversation without a second click`
  and `a single click previews without marking a row`, plus the promise that survives unchanged —
  `reading the conversation leaves the chat where it was`. The patch's own author flagged the
  same gap: whether the real host holds its viewport while `loadThrough` prepends history is
  only observable on a live instance.
- The preview pages back up to 24 times to reach a Turn's start; on a very long Turn that is a
  lot of history to prepend at once, and the viewport behaviour in that case is the one thing
  the mocked fixture cannot exercise.
- The locale is now mixed: the new tab `对话` and the two buttons/notices are Chinese while the
  other seven tabs and the diagnostic rows stay English. Deliberately left as the patch author
  wrote it, pending a decision.

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

`host-patches/system-message-never-withdraw/` carries the minimal fix and its evidence:

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
| daily (0.1.6-alpha.1) | **Installed but not running.** The profile pins `link:<PLUGIN_PATH>`, `dsh.profile.bundles` ends with it, and the symlink resolves. Its host half activates on the instance's next start; the client half needs no further work. |

The two-sided board, the type labels and the click-to-jump are **client-half only**,
so `pnpm run build` is enough for a running instance to pick them up. The rc.2 sync changed
**both** halves — the collector gained the tool-history capture and the per-kind prefix
baseline — so that round needs a `dsh web` restart to be live.

To verify daily once it is up (the same checks, different port):

```sh
node scripts/live-verify.mjs --port 18083 --home '<DSH_HOME_DAILY>'
node scripts/ui-verify.mjs --port 18083 --home '<DSH_HOME_DAILY>'
node -e "process.env.DSH_LIVE_PORT='18083'" && pnpm exec vitest run tests/panel-live.spec.ts
```

The two lines share the client contract (`pnpm run check:contracts` reports them
member-identical) and the collector speaks structural types only, so the code path
is the same one verified on 017; what a daily run would add is confirmation that
0.1.6 emits the same payloads in practice.
