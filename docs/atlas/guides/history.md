---
title: History
description: Add Git checkpoints to a scan and see how the workspace changed.
---

```sh
atlas scan /path/to/workspace --history
```

A plain scan already reads Git where it is available: churn, hotspots, and
change coupling come from the log. `--history` goes further and analyzes
the workspace as it was at earlier commits.

## What it needs

`git` on the PATH and a repository with at least one commit. Without one,
the scan saves the current dataset, then fails with
`Atlas: Command failed: git rev-parse HEAD` and exit code 1.

## What it does

Atlas walks the first-parent history of `HEAD` within the configured range
and selects checkpoints by the configured strategy: one per month by
default, at most twelve, with `HEAD` always included. Each checkpoint is
checked out into a temporary detached worktree, analyzed with the same
package-local analysis as the main scan, and removed. Your checkout, branch,
and index are not touched. Only committed state counts; uncommitted changes
are not part of any checkpoint.

Checkpoints are analyzed one after another, and a checkpoint analyzed
before is reused from the cache. There is no progress output during this
part of the scan.

## What it writes

The history scan replaces `output/history/` with:

```text
history/
  manifest.json        the checkpoints, their status, the policy, and the range
  timeline.json        every first-parent commit in range, checkpoints marked
  entities.json        how modules and packages persist across checkpoints
  snapshots/<commit>.json
  deltas/<from>__<to>.json   between consecutive successful checkpoints
```

Range, count, and strategy come from `semantics.history` in
[`foundry.config.json`](/atlas/reference/configuration). The CLI has no
flags for them.

## In the viewer

A package that exists at some checkpoint and not at `HEAD` appears as a
wreck, dated by the last checkpoint that had it. The side panel gains a
**Wrecks** section that lists them as former packages, and selecting one
opens a dive. A scan without `--history` replaces the dataset with a current-only
one, and the wrecks go with it.
