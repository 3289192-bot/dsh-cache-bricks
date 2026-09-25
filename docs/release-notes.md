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
