---
title: Output
description: The dataset a scan writes, file by file.
---

```text
<state>/<id>/
  workspace.json   the workspace record
  lock             held while a scan runs
  output/          the dataset
  cache/           per-package results and the workspace fingerprint
```

`<id>` is the workspace id: the first 12 hex digits of the SHA-256 of the
workspace's resolved path.

`workspace.json` here is the workspace record, not the dataset's workspace
report. A scan writes `id`, `root`, and `schemaVersion` when it starts, if
there is no record yet. When it saves the dataset it adds `atlasVersion`,
the Atlas version that saved it, and `lastScannedAt`, when; the two are
always set together. A scan that fails in history, after saving the
dataset, still leaves a record that matches it. Listing the state root's
directories and reading their records finds every workspace scanned under
it.

`output/` holds the dataset. The viewer reads it over `/data/…`, unchanged, and
anything else can read it from disk. The viewer and the library read it
through the same reader, which refuses a manifest whose `schemaVersion` is not
the one this Atlas writes. `cache/` holds per-package results and
the workspace fingerprint that make the next scan incremental; delete the
whole state directory to force a full rebuild.

Package names appear in file names with `/` replaced by `__`:
`@acme/db` becomes `@acme__db.json`.

## The dataset

The dataset's schema version is 4, recorded as `schemaVersion` in
`manifest.json`. `manifest.json` names every file in the dataset, itself or
through `modules/index.json`, except those under `history/`, which
`history/manifest.json` names when the dataset includes history.

| File | What it holds |
| --- | --- |
| `manifest.json` | Schema version, counts, coverage (`complete` or `partial`), discovery (the package patterns as the workspace declaration lists them, `declarationSource` for which file that is, `packagePatternsUnmatched` for patterns that matched no directory, `excludeUnmatched` for exclusions that matched no unit, `unitsDiscovered` for every directory a pattern matched, `packagesFound` for the units that are packages, `unitsAnalyzed`, and the units skipped and why), the paths of the workspace-level files, generation details (mode, phases, reuse, failures), and one entry per package: its status, its declared dependencies (`declaredDependencies`: each of `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies` its `package.json` has, every range as written), and the paths of its report, projection, module shard, and internals (`internals`, absent when the scan left internals out or the package failed) |
| `workspace.json` | The whole workspace report: architecture, boundaries, concepts, evolution (churn, hotspots, change coupling, and change radius from the Git log, when there is one), the graph, ingestion diagnostics, and the workspace intelligence |
| `packages/<name>.json` | One package's full report |
| `packages/<name>.projection.json` | That package's renderer-neutral projection |
| `modules/index.json` | Every file: id, package, path, role, kind, and which shard holds it |
| `modules/<name>.json` | File records for one package: concept roles, cross-package imports in and out, graph facts, gravity, evolution (churn, hotspot signals, co-change pairs) from the Git log, cautions |
| `modules/edges/<name>.json` | Every directed import whose source file the package owns |
| `projections/dependency-graph.json` | The package dependency graph the viewer lays islands out from |
| `projections/overview.json`, `package-roles.json`, `directions.json`, `boundaries.json`, `implementation-flow.json`, `behavior-flow.json`, `patterns.json`, `manifest.json` | The other workspace views |
| `concepts/index.json` | Every concept: id, name, kind, packages, centers, coverage |
| `internals/<name>.json` | The package's internal structure: topology, symbol locality, responsibilities, primitive conventions, rewiring scenarios, and the review of them. Written by every CLI scan and the library's `scan`, not by `scan.workspace` |
| `history/…` | Checkpoints, timeline, entities, snapshots, and deltas; see [history](/atlas/guides/history) |

The dataset is published in one move: a scan writes next to the old output,
internals included, and swaps directories when it finishes, so a reader never
sees a half-written dataset. A scan in which a package fails publishes
nothing and keeps the previous dataset. Files that came out identical to the
previous scan are linked, not rewritten; a package's internals are derived
from its package-local results, so an unchanged package's internals file is
reused. History is published after the dataset, into `history/`.

## The cache

```text
cache/
  workspace-inputs.json     the last scan's input hashes
  packages/<name>.local.json, .local.meta.json     package-local results
  packages/<name>.json, .meta.json                 assembled reports
  history/                  cached checkpoint analyses, with --history
```

The server never exposes the cache.
