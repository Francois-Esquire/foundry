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
| `manifest.json` | Schema version, counts, coverage (`complete` or `partial`), discovery (the package patterns as the workspace declaration lists them, `declarationSource` for which file that is, `packagePatternsUnmatched` for patterns that matched no directory, `excludeUnmatched` for exclusions that matched no unit, `unitsDiscovered` for every directory a pattern matched, `packagesFound` for the units that are packages, `unitsAnalyzed`, and the units skipped and why), the paths of the workspace-level files, each lens's file and schema version (`lenses`), generation details (mode, phases, reuse, failures), and one entry per package: its status, its declared dependencies (`declaredDependencies`: each of `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies` its `package.json` has, every range as written), and the paths of its report, projection, module shard, and internals (`internals`, absent when the scan left internals out or the package failed) |
| `workspace.json` | The whole workspace report: architecture, boundaries, concepts, evolution (churn, hotspots, change coupling, and change radius from the Git log, when there is one), the graph, ingestion diagnostics, and the workspace intelligence |
| `packages/<name>.json` | One package's full report |
| `packages/<name>.projection.json` | That package's renderer-neutral projection |
| `modules/index.json` | Every file: id, package, path, role, kind, and which shard holds it |
| `modules/<name>.json` | File records for one package: concept roles, cross-package imports in and out, graph facts, gravity, evolution (churn, hotspot signals, co-change pairs) from the Git log, cautions |
| `modules/edges/<name>.json` | Every directed import whose source file the package owns |
| `projections/dependency-graph.json` | The package dependency graph the viewer lays islands out from |
| `projections/overview.json`, `package-roles.json`, `directions.json`, `boundaries.json`, `implementation-flow.json`, `behavior-flow.json`, `patterns.json`, `manifest.json` | The other workspace views |
| `concepts/index.json` | Every concept: id, name, kind, packages, centers, coverage |
| `lenses/<id>.json` | A view the scan derives from the dataset, one file per lens. `package-sizes.json`: every package in the dependency graph, sorted by name, with `analyzed` (whether the scan analyzed it), `layer` (its dependency layer, 0 for a package that depends on no other, `null` when the graph could not place it), and its size as a file count: `modules.byKind` counts its files of each kind (`source`, `test`, `story`, `config`, `other`, and `unknown` for a file the module index gives no kind), and `modules.total` is their sum. `file-roles.json`: every package whose internals the dataset holds, sorted by name, with `highFanInCutoff` (the fan-in at or above which its internal topology calls a module high fan-in, 0 when no module has a dependent) and every module of its topology, sorted by path: `module` (the workspace-relative path), `fanIn` (the package's own source modules that import it), `highFanIn`, and `role` when it has one (`junction`, `mixed`, `commons`, or `unknown`); and `missing`, the packages the scan analyzed but saved no internals for. A package that failed is in neither. `responsibility-groups.json`: the same packages, each with its `groups` (responsibilities joined by a greedy modularity merge over the import edges and symbol flow between them: `id` (`responsibility-group:` and the first 12 hex digits of the SHA-256 of the sorted member ids, one per line), the member responsibility ids as `responsibilities`, `anchor`, the most connected member, with its `label` and `anchorWeight`, and `anchorModule`, the anchor's workspace-relative module with the highest internal fan-in) and `independent`, the responsibilities joined to none; and `missing`, as above. `frequent-change.json`: the `gate` it applied (`eligibleKinds` and `minCommitPercentile`, the hotspots' commit gate), every package whose report holds churn, sorted by name, with its `history` (`analyzedAt`, `historyComplete`, and `since` when the churn window does not cover the full history) and its `files` at or above the gate (`file`, the workspace-relative path; `commits` and `linesChanged` in the churn window; `commitPercentile`), and `missing`, the analyzed packages without churn (no Git, or none collected). `placement.json`: where each place is used against where it lives. A consumer module is a source file outside the place that uses it: in the same package, one that imports the symbol (type-only imports included); in another, one that references it at least once beyond its import. A module that only forwards a symbol (`export … from`) is none, so a barrel earns no use. `places` lists, sorted by `place`, then `level`, then `package`, every exported symbol (`path#name`; a symbol its module does not export is not placed or counted), source file, folder (a technical root such as `src` and the package root excepted), and package (by its path) that a consumer module in another package uses, with `level`, `package` (the manifest id it lives in), `home.modules` (its consumer modules in its own package, outside the place; always none for a package), `away` (its consumer modules in each other package, by manifest id, the most first), `unindexed` (consumer modules in no package of the module index, never part of a label), and `label`: `departs` when one other package holds at least `policy.dominantShare` (0.6) of its consumer modules, named in `toward`; `fits` when its own package does; `spread` when no package does. A package's own modules never count for the package, so a package never fits. `packages` holds every package with internals, sorted by name, with its `path`, its `counts` of places by level and label (`unconsumed` for a place no consumer module uses), `unindexed` (the distinct files outside the module index that consume any of its places, mostly a failed package's files and scripts at the workspace root; with no kind, they cannot be told from tests, so they count as possible consumers), and its report's `shapeSignals` and `primaryConsumer`, copied; `missing` the analyzed packages saved without internals, whose places are not labelled |
| `internals/<name>.json` | The package's internal structure: topology, symbol locality, responsibilities, primitive conventions, rewiring scenarios, and the review of them. Written by every CLI scan and the library's `scan`, not by `scan.workspace` |
| `history/…` | Checkpoints, timeline, entities, snapshots, and deltas; see [history](/atlas/guides/history) |

The dataset is published in one move: a scan writes next to the old output,
internals included, and swaps directories when it finishes, so a reader never
sees a half-written dataset. A scan in which a package fails publishes
nothing and keeps the previous dataset. Files that came out identical to the
previous scan are linked, not rewritten; a package's internals are derived
from its package-local results, so an unchanged package's internals file is
reused. Lenses run on every scan, after internals and before the manifest is
written, and their files are reused the same way when they come out
identical; each lens has its own schema version, so a lens can change
without the dataset's. History is published after the dataset, into `history/`.

## The cache

```text
cache/
  workspace-inputs.json     the last scan's input hashes
  packages/<name>.local.json, .local.meta.json     package-local results
  packages/<name>.json, .meta.json                 assembled reports
  history/                  cached checkpoint analyses, with --history
```

The server never exposes the cache.
