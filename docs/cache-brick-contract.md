# The cache brick

> **0.1.4 (Lite).** This file *is* the product definition. Everything the plugin does follows from
> the sentence in the first section; everything it does not do is listed in the second.

## The definition

**One settled real model request is one brick, and a brick's colour is one thing: how much of that
request's prompt came out of the cache.**

Six consequences, each of which is a rule:

1. **A brick is an attempt, not a step.** A step that was retried is two real requests, two
   billings and two cache outcomes; a board that merged them would hide the event it exists to
   show. The attempt ordinal is part of the brick's identity, so both are drawn.
2. **A brick lands when the request settles — not when it starts.** While a request is in flight
   there is no number to draw, and a brick that appeared early would have to guess one.
3. **The reading is `cacheReadTokens ÷ (inputTokens + cacheReadTokens + cacheWriteTokens)`.** The
   three buckets are disjoint (uncached, read, written), so writing cache is not a hit: a call that
   paid full price for 400k tokens *and* wrote them into the cache is not a 99% hit.
4. **`null` is not `0`.** A provider that reports no cache field has told us nothing, and the
   brick is grey and prints `n/a`. Painting it red would claim a miss nobody measured.
5. **The printed number never rounds up.** `0.9999` prints `99.9%`; only a full hit prints `100%`.
   A cache read-out that overstates is worse than no read-out.
6. **A colour, a number and an identity — nothing else.** See below.

## What a brick is

```ts
interface CacheBrick {
  id: string        // `${sessionId}:${turn}:${step}:${attempt}`
  turn: number
  step: number
  attempt: number   // 0 = first request of this step, 1 = the retry that replaced it

  inputTokens: number       // uncached — billed again
  cacheReadTokens: number   // served from the cache
  cacheWriteTokens: number  // written into it by this same call

  hitRatio: number | null   // null = the provider reported nothing
  startedAt: number
  finishedAt: number
  tone: 'good' | 'bad' | 'unknown'
}
```

Eleven fields, none of them a reference to anything. A brick is therefore a few dozen bytes, it
never needs to be stored, and losing one costs a reader nothing.

## The colours

| tone | when | what it means |
|---|---|---|
| `good` (green) | `hitRatio >= 0.9` | the prompt cache was reused |
| `warn` (amber) | `0.7 <= hitRatio < 0.9`, prompt ≥ 1000 tokens | a tenth of the prefix was re-billed |
| `bad` (red) | `hitRatio < 0.7`, prompt ≥ 1000 tokens | most of this prompt was paid for again |
| `unknown` (grey) | no cache field, or a prompt under 1000 tokens | nothing honest to say |

All three thresholds are constants with a reason, and all three are inherited from the frozen 0.1.x
palette: **0.7** so that red means "this call re-billed most of its prompt" rather than "the cache
was rebuilt from nothing", **0.9** because at 0.85 a *tenth* of a long prompt was re-billed — worth
seeing, not worth shouting about — and **1000 tokens** because a 300-token probe that misses is not
a cache regression, and painting it red would put noise exactly where the signal goes. Both
boundaries fall in the calmer band, as they did in 0.1.3: exactly 70% is amber, exactly 90% green.

**A note on the amber band's history here.** This line first shipped three tones — the amber band
folded into green — because the Lite specification written for it had exactly three. A reader
noticed within the hour, and the live board made the case concrete: of 1,121 bricks on screen, 12 sat
between 70% and 90% (81.3%, 89.7%, 88.7%, 73.4%, …) and read as healthy. They are not healthy and
they are not alarming; the band is back, with 0.1.3's own colours.

## History, on request

A brick is still made from one settled request — the question is only *where the settlement is
read from*. Two places, and the second is opt-in in the sense that it costs something:

| source | when | what it is |
|---|---|---|
| **live** | always | the process's own traffic, as it happens |
| **the session log** | once, when a browser first asks for that session's bricks | the harness's own `.jsonl.zstd` artifact, read in one pass, oldest first |

Read-only, once per session, and only for the session somebody is looking at — never a scan of
everything at startup. What is read out of it is what a brick is made of and nothing else:
`assistant/message` / `assistant/attempt` (one settled attempt each, with the billed usage, or the
last `usage` chunk of its compact stream) and `turn/end`. A prompt, a tool call, a request
envelope: never touched, because a brick does not carry them.

**The one rule:** a step this process has already seen live is left alone. The live attempt is the
one being billed, so the log may fill in the past but must not duplicate the present or steal its
attempt ordinal.

The feed reports how many bricks came from the log (`backfilled`), and the board says so, because a
board that quietly mixed a session's recorded past with this process's traffic would be claiming
more than it saw. Nothing is written back: the bricks go into the same in-memory ring, which drops
its oldest exactly as before.

## What a brick is not

Written down because these are the things that made the previous line heavy, and because a future
contributor will otherwise add them back one at a time:

- **no prompt, no messages, no system prompt** — a brick never stores what was sent;
- **no tools**: no calls, no schemas, no results, no arguments;
- **no request envelope**: no header, no hashes, no shared-prefix count, no context snapshot;
- **no stream**: no reasoning/text counters, no TTFT, no timeline, no TPS;
- **no diagnosis**: no retry metadata beyond the attempt ordinal, no diff, no failure chain;
- **no navigation**: no transcript row, no settlement seq, no target, no inspector;
- **no history**: no catalog, no index, no replay of old sessions, no durable store of any kind.

The board keeps a **ring of the newest bricks in memory** (1024 by default) and drops the oldest,
reporting how many it dropped. A page reload starts a new ring. That is deliberate: this is a live
telemetry read-out, not an audit log. If persistence is ever wanted, the honest form is the eleven
fields above appended to a file — a few dozen bytes per request — and never the conversation.
