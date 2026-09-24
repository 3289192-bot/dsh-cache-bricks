# The brick contract (frozen)

> **A brick is one actually executed model request attempt.**

That sentence is the whole model. Everything the board draws, every field the panel shows
and every future feature is derived from it; nothing is allowed to redefine it. This file
exists so that the next change — by a person or by an agent — adds *data* instead of
quietly moving the boundary again.

## What a brick is

| | |
|---|---|
| One brick | one dispatch to a model that really happened |
| Two bricks | two dispatches, even for one `(turn, step)` — that is what a retry is, and the two have separate bills and separate cache outcomes |
| Zero bricks | anything that is not a dispatch: a tool result, a `request/header`, a context event, a session event, a UI node |

It follows that a brick is **attempt-level**, never step-level and never turn-level. The
collector's tap is `llm/stream`, one event per real dispatch, and that is the tap that
defines the population.

### What is deliberately *not* a brick

- **A step folded by the client**, when no host collector is running. It is one per step,
  carries usage but no attempt identity, and must never be counted as a request — it is drawn
  with a dashed edge and a dimmed slab, carries no activity face (`~`), and the board shows a
  `no attempt telemetry` notice while any of them are on it (`estimated: true`). It keeps its
  cache tone: the percentage is measured, the *granularity* is what is missing.
- **Anything the model was not asked to do.** Compaction and session-title calls *are*
  requests and *are* bricks; tool execution, context injection and log bookkeeping are not.

## The three layers

```text
BrickIdentity   what request this is        sessionId : turn : step : attemptOrdinal
BrickRecord     the flight recorder         identity + route + usage + metrics + request
                                            + context + tools + retry + finish + raw refs
BrickTarget     where it belongs on screen  retry-chain | assistant-step(turn, step, part)
                                            | tool-call(callId) | compaction(compactionId) | none
```

**Identity and target are different questions**, and the mapping between them is **N:1**:
the transcript publishes rows per *step*, so a retried step's two bricks share one row
(and the retry chain row is where the pair is shown together). Therefore:

> **brick : transcript row is not 1:1. brick : navigation target is 1:1.**

A landing is `exact` when it hits the brick's declared target — not when it finds a row
nobody else points at. A target that resolves to nothing reports `none`; there is no
"nearest" fallback, and re-adding one is a regression, not a nicety.

### Two gestures, one loader, explicit outcomes

```text
one click    →  Conversation preview  (the record is local; its log is read for it, the chat is not moved)
double click →  locate                (closes the preview; the panel's own "locate in transcript" is the same path)
                     │
                     └→ ensureBrickTargetLoaded(face, { seq: target.loadSeq, turn })
                             │  ISession.loadThrough(seq) — the official loader
                             │  then, while the Turn's own start is not in the window, page back to it
                             └→ the row, or one of the statuses below
```

Every locate ends as exactly one of these, and the Inspector prints all three rows
(`Transcript loaded` / `Chat projection` / `Reason`) so a reader can tell a plugin problem
from a host problem:

| Status | Means |
|---|---|
| `exact` | the brick's own row is on screen and was scrolled to |
| `step-other-half` | the step is on screen, but the half the attempt began in has no rendered row, so the step's **other half** was reached — reported as such, never highlighted |
| `loaded-awaiting-render` | the history is covered and the exact row is still unavailable; **the cause is not established** (a late React commit, a subtree the view keeps closed, a stale target and a host that drew none of the page all look the same from here) |
| `target-unavailable` | nothing can stand for this brick (`nothing-to-load`), no log position is known (`no-seq`), no session face is reachable (`no-loader`), or the history was asked for and still does not reach it (`timeout`) |
| `host-projection-blocked` | kept in the type for compatibility; **no longer emitted** — "the loader confirmed coverage and no row appeared" is not proof of a host failure |

The host failure this plugin exists to catch is nonetheless real and reproduced: on an
unpatched 0.1.7 core the `system-message` Definition withdraws a materialized node and takes
the whole flush with it (`docs/runtime-contract.md`; the fix and its regression tests live in
`host-patches/system-message-never-withdraw/`). A missing DOM row cannot tell that apart from
a late commit or a hidden subtree, so the plugin reports the observable fact and points at the
check (`node patch.mjs --check`) instead of naming a culprit on the evidence of an absence.

## What each visual channel means

```text
┌───────────────────────────────┐
│           BRICK               │
├───────────────────────────────┤
│ 正面 = Cache Health           │  深绿 → 黄 → 红；未上报 = 灰
│ 背面 = 官方 span              │  扁平、1px 圆角、无描边无阴影
│                               │  opacity .78（背景 lane）/ 1（model·tool）
│                               │  model lane 带官方 TTFT 横向渐变
│   Input   → 蓝   (保留)        │  var(--dsw-alias-state-business-primary)
│   Model   → 紫                 │  brand 60% + error-secondary
│   Tool    → 橙                 │  var(--dsw-alias-state-warn-label)
│   Context → 绿   (保留)        │  success 68% + label-secondary
│   System  → 灰                 │  var(--dsw-alias-label-secondary)
│ 状态不抢颜色：                 │
│   Retry       ↻               │
│   Error       红边 / !         │  var(--dsw-alias-state-error-primary)
│   Interrupted ⏹               │
│   Max tokens  ⌁               │
└───────────────────────────────┘
```

The type face prints **nothing**: the colour is the reading. The lane word, the finer kind and
the specific (`TOOL` · `工具` · `bash`) are derived and carried in the tooltip, the accessible
name and the panel — places that have room for words. A split brick is two colours in a row,
model half left and tools half right, and that seam direction is part of the contract.

Its **appearance** is the official trajectory span, not an invented material: a flat fill (no
bevel, no gloss, no drop shadow), one-pixel corners, the official per-lane opacity, and the
official model-lane TTFT gradient — the first `ttftMs / durationMs` of the width in the
lighter waiting colour. Two hundred bricks of a *style* nobody else uses would be a second
design system; this is the first one, at brick size.

| Channel | Field | Notes |
|---|---|---|
| Cache | `metrics.cacheHitRatio`, `usage.*` | the brick's main reading; three disjoint buckets, absent field = `n/a`, never `0%` |
| Type | `kind` (+ `activityShare`) | one of four types plus the split; derived from what the attempt produced, painted in its official lane |
| Detail | `detail` | the specific behind the type: the tool it called, the model it ran, the purpose it served |
| Lifecycle | `abnormal` | a corner glyph (`↻ ! ■ ⌁`), never a colour of its own |
| Context | `identity.turn/step`, `attemptOrdinal` | where the request sits; a retry is a second brick of the same step |
| Navigation | `target` | one of five kinds; see above |
| Behaviour | `tools[]` | the call ids the attempt produced, with their refs and timings |
| Auxiliary | `route.purpose`, `compactionId` | a real request outside any Turn; shown in the board's `SYS` lane |

## Extending it

Adding cost, TTFT percentiles, TPS, context occupancy, cache breakpoints, model routing,
subagent lineage, compaction history or request diffs is **a new field on `BrickRecord`**
(or a new `BlobStore` ref for anything large). None of them may change *what counts as a
brick*, and none may introduce a second population of bricks beside the dispatched ones.

If a feature seems to need a different definition of "a brick", the feature is wrong or the
question is really about *targets* — which is where the retry chain lives.

## Enforcement

The definition is not only prose: `tests/brick-contract.spec.ts` asserts it against the
model (two attempts of one step are two bricks, the fold never claims an attempt, a target
never invents a Turn, only target rows are `exact`). Changing the meaning of a brick means
changing that file deliberately — which is the point.
