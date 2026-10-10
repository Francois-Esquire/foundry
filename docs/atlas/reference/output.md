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
always set together. A scan that fails after saving the dataset, in
internals or history, still leaves a record that matches it. Listing the
state root's directories and reading their records finds every workspace
scanned under it.

`output/` holds the dataset. The viewer reads it over `/data/…`, unchanged, and
anything else can read it from disk. `cache/` holds per-package results and
the workspace fingerprint that make the next scan incremental; delete the
whole state directory to force a full rebuild.

Package names appear in file names with `/` replaced by `__`:
`@acme/db` becomes `@acme__db.json`.

## The dataset

| File | What it holds |
| --- | --- |
| `manifest.json` | Schema version, counts, coverage (`complete` or `partial`), discovery (roots scanned and missing, units skipped and why), the path of every other file, generation details (mode, phases, reuse, failures), and one entry per package with its status |
| `workspace.json` | The whole workspace report: architecture, boundaries, concepts, evolution (churn, hotspots, couplings), the graph, ingestion diagnostics, and the workspace intelligence |
| `packages/<name>.json` | One package's full report |
| `packages/<name>.projection.json` | That package's renderer-neutral projection |
| `modules/index.json` | Every file: id, package, path, role, kind, and which shard holds it |
| `modules/<name>.json` | File records for one package: concept roles, cross-package imports in and out, graph facts, gravity, history, cautions |
| `modules/edges/<name>.json` | Every directed import whose source file the package owns |
| `projections/dependency-graph.json` | The package dependency graph the viewer lays islands out from |
| `projections/overview.json`, `package-roles.json`, `directions.json`, `boundaries.json`, `implementation-flow.json`, `behavior-flow.json`, `patterns.json`, `manifest.json` | The other workspace views |
| `concepts/index.json` | Every concept: id, name, kind, packages, centers, coverage |
| `history/couplings.json` | Co-change file pairs from the Git log, written by a scan without `--history` |
| `manifests/<name>.json` | A byte-for-byte copy of each package's `package.json` |
| `internals/<name>.json` | The package's internal structure: topology, symbol locality, responsibilities, primitive conventions, rewiring scenarios, and the review of them; recomputed on every scan |
| `history/…` | Checkpoints, timeline, entities, snapshots, and deltas; see [history](/atlas/guides/history) |

The dataset is published in one move: a scan writes next to the old output
and swaps directories when it finishes, so a reader never sees a half-written
dataset. Files that came out identical to the previous scan are linked, not
rewritten.

## The cache

```text
cache/
  workspace-inputs.json     the last scan's input hashes
  packages/<name>.local.json, .local.meta.json     package-local results
  packages/<name>.json, .meta.json                 assembled reports
  history/                  cached checkpoint analyses, with --history
```

The server never exposes the cache.
