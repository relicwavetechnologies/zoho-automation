# Upstream Pi provenance

This directory contains a source snapshot of the official Pi agent harness:

- Repository: <https://github.com/earendil-works/pi>
- Tag: `v0.80.3`
- Commit: `a23abe4a695df8b69b613f73e9fdda2a8af894d4`
- Imported: 2026-07-29
- License: MIT; see `LICENSE`

The snapshot is tracked directly by the parent Divo repository. It deliberately
contains no nested `.git` directory and has no independent Git history.

Divo-owned runtime code lives under `divo/`. Changes to upstream Pi core should
remain exceptional and documented so a future upstream refresh can distinguish
the Divo layer from the source snapshot.
