> 历史开发记录：版本、兼容性、性能与验收表述对应当时的构建。当前发布说明以 README 和 publication.md 为准；文中的本机路径及真实会话标识已替换为示例。

# 0.1.5-lite — the 0.1.4-lite.f line, renamed (2026-09-27)

No behaviour changed: this is the 0.1.4-lite.f line under a name that carries no patch reading.

Lite's whole point is that it stays small — one settled request, one brick, no window, no scene, no
index — and that is unchanged here, byte for byte. The rename exists for the same reason the full
line's does: the tip of the 0.1.4 line is the base the next line builds on, and "0.1.4-lite.f" reads
as a patch of 0.1.4-lite. The full line moves in step as **0.1.5**.

| half | sha256 |
|---|---|
| host `lib/index.js` | `74754a0a…` |
| client `lib/client.js` | `c73c1f87…` |

Verification on the renamed tree: type checking, **95 unit tests**, the built-host check and **49
browser fixture checks** pass — the same numbers 0.1.4-lite.f reported. The renamed package was then
installed on the DSH **0.1.6-alpha.1** instance (the runtime lite actually runs on) and verified
there, since that is where this line has to hold.

# 0.1.4-lite.f — the motion moves to the compositor (2026-09-27)

Lite's bricks were already cheap to *compute*: one brick per settled request, no window, no index, no
scene. Its animation was not. A drop transitioned `bottom` and a new Turn transitioned `right` on
every brick — layout properties, so each one re-ran style and layout on every frame: three actions
(a brick, a second brick, a new Turn) cost **303 layout passes and 60 ms of main-thread task time**.
On a machine that asks for reduced motion it cost 130 layouts only because the motion was skipped
entirely, which is also why its bricks appeared out of nowhere there.

This release ports the full line's mechanism, and nothing else:

- the drop is a `transform` animation (`420ms cubic-bezier(.45,.02,.95,.55)`, from one row above) —
  same curve, same duration, compositor property;
- a new Turn slides **the grid** once by a cell (260ms `ease-out`) instead of transitioning `right`
  on every brick;
- the dashed drop slot is the grid's first child: it rides both motions and animates nothing itself
  (its coordinates were always grid coordinates, so it also lands on the cell it names);
- no position property is transitioned anywhere, so a pan needs no special case — and
  `prefers-reduced-motion` no longer switches the drop off (0.1.x never consulted it for this
  motion; only the full line's card flip does).

Measured with CDP `Performance.getMetrics`, same probe, three actions:

| build · setting | layouts | recalc | script | task |
|---|---|---|---|---|
| frozen lite · reduce | 130 | 131 | 2 ms | 27 ms |
| frozen lite · no-preference | **303** | 304 | 1 ms | **60 ms** |
| **0.1.4-lite.f · reduce** | **6** | 39 | 2 ms | **11 ms** |
| 0.1.4-lite.f · no-preference | **7** | 41 | 2 ms | **12 ms** |

The host half is byte-identical to frozen lite (`lib/index.js` `74754a0a…`), so nothing in the DSH
contract surface moved. 95 unit tests and **49/49 browser fixture checks** pass; the fixture's
reduced-motion check now asserts the deliberate behaviour (the bricks are drawn *and* the drop runs,
with no position property animated).

# dsh-cache-bricks 0.1.4-lite

**The frozen Lite release.** One sentence, and everything else follows from it:

> One settled real model request is one brick, and a brick's colour is one thing: how much of that
> request's prompt came out of the cache.

Install:

```sh
dsh plugin --profile web add github:3289192-bot/dsh-cache-bricks#v0.1.4-lite
```

Supported runtime: **DSH 0.1.7-rc.2, web profile** (the peer range is exact).

What is in the frozen release, in the order it was built:

1. **the kernel** — three taps, one brick per settled attempt, eleven fields, a 1,024-brick ring in
   memory, nothing written to disk;
2. **the board** — 0.1.3's art direction and its whole window (rails, fades, the `⤓ 最新` chip, the
   drop slot, reduced-motion), with the colour set restored to 0.1.3's four bands;
3. **the log read** — an old session is filled once from its own artifact when a browser opens it,
   live traffic winning every step it has seen;
4. **the freeze itself** — `docs/cache-brick-contract.md` is the definition, `docs/verification.md`
   is the evidence, `docs/0.1.4-performance.md` is what it costs against the two other lines.

**A new line, cut from 0.1.3's parts rather than trimmed out of it.** The product is one sentence
again:

> One settled real model request is one brick, and a brick's colour is one thing: how much of that
> request's prompt came out of the cache.

`0.1.3` had grown well past that — request captures, a blob store, a replay reader, an inspector,
navigation targets, a diff, a type face, history paging — and each of those had grown its own
structure. `0.2.1` tried to solve the weight by moving history into SQLite, which is a different
product. This release goes back to the sentence and keeps only what serves it.

## What it is

- **Observe → calculate → drop.** Host half taps `llm/stream` (a real request was dispatched),
  `agent/assistant-stream` (identity: `turn`, `step`, `attemptId`) and `session/event` (the billed
  settlement). Browser half draws bricks in the gutter.
- **A brick is 11 fields** — identity, the three disjoint token buckets, the ratio, two timestamps
  and the tone. No prompt, no tools, no stream, no refs, no navigation target, no settlement seq.
- **A retry is a second brick**, because a retried step is two real requests with two billings.
- **A brick lands on settlement**, not on dispatch: there is no number to draw until the provider
  billed one.
- **In-memory ring, 1024 bricks, oldest dropped** — and the board says how many it dropped. A page
  reload starts a new ring. Live telemetry, not an audit log.
- **Colour only:** green at ≥ 70% cached, red below, grey when the provider reported no cache field
  or the prompt is under 1000 tokens. The reading is printed with one decimal, floored, so `0.9999`
  is `99.9%` and only a full hit prints `100%`.

## What is gone

Blob store, replay, request summarizer, context snapshots, header/tool hashing, diff, stream
timeline, brick ledger, panel, inspector, navigation, reveal, targets, the type face and the flip,
the conversation-node fold, the history catalog — and with them the client's dependency on the chat
store: a brick arrives complete over the plugin's own route.

## The board is 0.1.3's, in full

The art direction came over whole, because it is the part a reader feels: the quiet 18%-green slab
with a tone edge and a hairline of light, 12px tabular digits floored to one decimal, the 420 ms
gravity curve for a landing brick and the 260 ms slide when a finished Turn's stack steps left, the
dashed drop slot for the running Turn, the 1px floor, the rounded tinted panel — and **both rails**,
with the thumb anchored at the live corner, drag and track-paging and wheel-over-the-rail, edge
fades in every direction that has more, and a `⤓ 最新` chip that exists only while the board is
showing history. `prefers-reduced-motion` turns all of it off.

What the rails pan over is the ring, not a stored history: the board is still live telemetry.

## The amber band is back (0.1.4-lite.1)

The first Lite build answered with three colours — green at ≥70%, red below, grey when there is
nothing to say — because that is what the Lite specification asked for. A reader noticed within the
hour that 0.1.3's middle band was missing, and the live board agreed with them: of 1,121 bricks on
screen, **12 sat between 70% and 90%** (81.3%, 89.7%, 88.7%, 73.4%, …) and were painted as healthy.

They are not healthy. At 0.85 a tenth of the prefix was re-billed, which on a 500k-token prompt is
50k tokens at full price — worth seeing before it becomes a red one. The band is restored with
0.1.3's own colours (fill `rgba(234, 179, 8, 0.85)`, digits `#2a1c00`, edge `#ca8a04`, bold), and
the thresholds are now: red below 70%, amber below 90%, green at or above. A prompt under 1000
tokens stays grey, as before.

## An old session is not a blank gutter

The ring is live-only, so a session that has not called a model since the process started used to
open as nothing at all. Now the host reads that session's **own log once**, when a browser first
asks for its bricks: its settled attempts become the same eleven-field bricks, oldest first, into
the same ring — the billed usage, the compact-stream fallback, the failed attempts that are grey
because nobody measured a miss.

- once per session, and only for a session somebody looks at — never a startup scan;
- only settlements and `turn/end` are read: no prompt, no tool call, no request envelope;
- **live wins**: a step this process has already seen is left alone, so the log fills the past and
  cannot duplicate or renumber the present;
- the feed reports `backfilled`, and the board says how much of it is history;
- `backfill: false` in the plugin row turns it off entirely.

## Size

| | 0.1.3 | 0.1.4 (Lite) |
|---|---|---|
| `lib/client.js` | 125,235 B | **21,210 B** (six times smaller, rails and all) |
| `lib/index.js` | 78,049 B | **19,316 B** |
| per-token work | observe + fold every delta | **none** — deltas are not read |
| stored per brick | request, tools, stream, refs | 11 fields, in memory |

## Install

```sh
dsh plugin --profile web add github:3289192-bot/dsh-cache-bricks#v0.1.4
```

Supported runtime: **DSH 0.1.7-rc.2, web profile** (the peer range is exact).

## Verification

94 unit tests, 47 browser fixture checks (real layout, real pixels, real drags), the built-host
check, and a live run against a running instance where a real model call produced a real brick —
plus the log reader run against this machine's real session artifacts.
See [the verification record](verification.md).
