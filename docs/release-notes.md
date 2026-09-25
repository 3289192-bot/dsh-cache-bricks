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
