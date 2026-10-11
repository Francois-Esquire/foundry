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
  plans/           authorization records that atlas plan saved
  apply/journal.json  while an atlas apply is unfinished
  output.next/     while an apply's scan is staged, briefly
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

The inputs hash covers what the incremental cache covers, and shares its
blind spots: declaration files (`.d.ts`), installed packages, and the
lockfile are not hashed, and the workspace's own `tsconfig.json` is not
read, since the scan builds its own compiler options. A change to one of
them leaves the dataset current; scan again after one. After an apply's
write rolls back, the cache holds the written sources' analysis, so the
next scan analyzes the package and derives the workspace again, about 30 s
on a workspace of 1,500 files: slower, never wrong, and the saved dataset,
which the rollback never touched, stays current.

`plans/` holds one record per authorized plan, named by a digest of the
saved plan's id: the mutator, the saved plan's id and fingerprint, the rules
that permit it, and the fingerprints a later apply checks again. A plan
that is not authorized deletes its site's record, and an apply whose scan
published deletes the record it applied.

`apply/journal.json` exists only while an `atlas apply --write` is
unfinished. It is flushed to disk before the first source write and holds
`{ schemaVersion, site, planId, phase, startedAt, files }`, each file as
`{ file, mode, original, originalHash, writtenHash }`, `original` being the
file's bytes in base64 and the hashes SHA-256. `phase` is `writing` until
every check after the write passed, then `verified`. While it is `writing`,
the next `atlas apply` restores the files and deletes it, and `scan`,
`plan`, and `check` refuse; once `verified`, `plan`, `apply`, and `check`
refuse until a scan publishes, which then deletes it. `output.next/` is the
scan after a write, staged and then swapped in; only an interrupted apply
leaves it behind, and the next apply removes it. It is not
part of the dataset, and a scan leaves it alone.

Package names appear in file names with `/` replaced by `__`:
`@acme/db` becomes `@acme__db.json`.

## The dataset

The dataset's schema version is 5, recorded as `schemaVersion` in
`manifest.json`. `manifest.json` names every file in the dataset, itself or
through `modules/index.json`, except those under `history/`, which
`history/manifest.json` names when the dataset includes history.

| File | What it holds |
| --- | --- |
| `manifest.json` | Schema version, counts, coverage (`complete` or `partial`), discovery (the package patterns as the workspace declaration lists them, `declarationSource` for which file that is, `packagePatternsUnmatched` for patterns that matched no directory, `excludeUnmatched` for exclusions that matched no unit, `unitsDiscovered` for every directory a pattern matched, `packagesFound` for the units that are packages, `unitsAnalyzed`, and `unitsSkipped`, each unit skipped with its `path`, why (`reason`), and the `name` its `package.json` gives, when it has one that parses, whatever the reason; absent in a dataset an earlier Atlas saved), the paths of the workspace-level files, each lens's file and schema version (`lenses`), generation details (mode, phases, reuse, failures, and `inputs`, `{ hash, config }`: one SHA-1 over every input the analyses read, the sources, Git's commits and tracked files, the UTC day, the exclusions and profile, and the analysis version, and the exclusions-and-profile part alone; absent in a dataset an earlier Atlas saved; `plan` and `apply` recompute `hash` to tell whether the dataset is current; see below), and one entry per package: its status, its declared dependencies (`declaredDependencies`: each of `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies` its `package.json` has, every range as written), and the paths of its report, projection, module shard, and internals (`internals`, absent when the scan left internals out or the package failed) |
| `workspace.json` | The whole workspace report: architecture, boundaries, concepts, evolution (churn, hotspots, change coupling, and change radius from the Git log, when there is one), the graph, ingestion diagnostics, and the workspace intelligence |
| `packages/<name>.json` | One package's full report |
| `packages/<name>.projection.json` | That package's renderer-neutral projection |
| `modules/index.json` | Every file: id, package, path, role, kind, which shard holds it, and `fanIn` and `fanOut`, its import edges in and out within and across packages, counted from the edge shards (every file has them, a failed package's included; they equal its record's gravity wherever gravity was observed; since schema version 5) |
| `modules/<name>.json` | File records for one package: concept roles, cross-package imports in and out, graph facts, gravity, evolution (churn, hotspot signals, co-change pairs) from the Git log, cautions |
| `modules/edges/<name>.json` | Every directed import whose source file the package owns |
| `projections/dependency-graph.json` | The package dependency graph the viewer lays islands out from |
| `projections/overview.json`, `package-roles.json`, `directions.json`, `boundaries.json`, `implementation-flow.json`, `behavior-flow.json`, `patterns.json`, `manifest.json` | The other workspace views |
| `concepts/index.json` | Every concept: id, name, kind, packages, centers, coverage |
| `lenses/<id>.json` | A view the scan derives from the dataset, one file per lens. `package-sizes.json`: every package in the dependency graph, sorted by name, with `analyzed` (whether the scan analyzed it), `layer` (its dependency layer, 0 for a package that depends on no other, `null` when the graph could not place it), and its size as a file count: `modules.byKind` counts its files of each kind (`source`, `test`, `story`, `config`, `other`, and `unknown` for a file the module index gives no kind), and `modules.total` is their sum. `file-roles.json`: every package whose internals the dataset holds, sorted by name, with `highFanInCutoff` (the fan-in at or above which its internal topology calls a module high fan-in, 0 when no module has a dependent) and every module of its topology, sorted by path: `module` (the workspace-relative path), `fanIn` (the package's own source modules that import it), `highFanIn`, and `role` when it has one (`junction`, `mixed`, `commons`, or `unknown`); and `missing`, the packages the scan analyzed but saved no internals for. A package that failed is in neither. `import-traffic.json`: where packages import from one another, file by file. `pairs` lists, sorted by `from`, then `to`, by code unit, every ordered package pair the module edges cross, with `consumerFiles` (the files of `from` that import a file of `to`) and `supplierFiles` (the files of `to` that a file of `from` imports), each sorted by code unit; an edge with an end in no package of the module index is left out. How many edges a pair has is the dependency graph's `moduleEdges`. `responsibility-groups.json`: the same packages, each with its `groups` (responsibilities joined by a greedy modularity merge over the import edges and symbol flow between them: `id` (`responsibility-group:` and the first 12 hex digits of the SHA-256 of the sorted member ids, one per line), the member responsibility ids as `responsibilities`, `anchor`, the most connected member, with its `label` and `anchorWeight`, `anchorModule`, the anchor's workspace-relative module with the highest internal fan-in, and `modules`, the workspace-relative modules of its member responsibilities, sorted, each once) and `independent`, the responsibilities joined to none; and `missing`, as above. `frequent-change.json`: the `gate` it applied (`eligibleKinds` and `minCommitPercentile`, the hotspots' commit gate), every package whose report holds churn, sorted by name, with its `history` (`analyzedAt`, `historyComplete`, and `since` when the churn window does not cover the full history) and its `files` at or above the gate (`file`, the workspace-relative path; `commits` and `linesChanged` in the churn window; `commitPercentile`), and `missing`, the analyzed packages without churn (no Git, or none collected). `placement.json`: where each place is used against where it lives. A consumer module is a source file outside the place that uses it: in the same package, one that imports the symbol (type-only imports included); in another, one that references it at least once beyond its import. A module that only forwards a symbol (`export … from`) is none, so a barrel earns no use. `places` lists, sorted by `place`, then `level`, then `package`, every exported symbol (`path#name`; a symbol its module does not export is not placed or counted), source file, folder (a technical root such as `src` and the package root excepted), and package (by its path) that a consumer module in another package uses, with `level`, `package` (the manifest id it lives in), `home.modules` (its consumer modules in its own package, outside the place; always none for a package), `away` (its consumer modules in each other package, by manifest id, the most first), `unindexed` (consumer modules in no package of the module index, never part of a label), and `label`: `departs` when one other package holds at least `policy.dominantShare` (0.6) of its consumer modules, named in `toward`; `fits` when its own package does; `spread` when no package does. A package's own modules never count for the package, so a package never fits. `packages` holds every package with internals, sorted by name, with its `path`, its `counts` of places by level and label (`unconsumed` for a place no consumer module uses), `unindexed` (the distinct files outside the module index that consume any of its places, mostly a failed package's files and scripts at the workspace root; with no kind, they cannot be told from tests, so they count as possible consumers), and its report's `shapeSignals` and `primaryConsumer`, copied; `missing` the analyzed packages saved without internals, whose places are not labelled. `nesting.json`: how the workspace is nested. `folders` is one tree across every analyzed package, sorted by `id` (the workspace-relative path; `.` only for the workspace root when a package lives there), built from the module index so that a package saved without internals is in it too: every folder that holds a file of the index, directly or below, and every folder above a package root up to the top of the workspace. Each has `fileCounts.direct` and `fileCounts.descendant` (the index's files of every kind directly in it and anywhere below), `parent` (absent at the top), `package` (the manifest id of the nearest package root at or above it; absent for a folder above every package, such as `packages`), `packageRoot`, and `pathRegion` when the internal topology of the package that owns it lists the folder. A folder the topology does not list, such as one holding only JSON files, has no `pathRegion`. `pathRegions` lists each package's path regions from its internals (`package`, `id`, `files`, and `primaryFiles`, its source files); a region that holds no files has no entry, although a folder can still name it, as a package root with no file directly in it names `.`; and `seams` the primary edges from one path region into another (`package`, `from`, `to`, `moduleEdges`, `importSites`, and `symbolFlow`, the distinct symbol names crossing), both sorted by package; `missing` the analyzed packages saved without internals, which have folders but no path regions or seams. `proximity.json`: what sits close without being related, and what is related without sitting close. Close means one folder, as `nesting.json` names it; related means one responsibility, a responsibility relationship (an import between two, either way), or a co-change between source files, from the workspace report's pairs as stored. `close` lists, sorted by `folder`, each folder whose source files directly in it fall into two or more `groups`: each group is the folder's responsibilities joined by a relationship or a co-change, directly or through other responsibilities in the same folder (a responsibility with no file in the folder joins nothing), with its `responsibilities`, its `files` in the folder, and `apart`, those of its files that are also in `apart.files` (empty when none are; a group can consist only of files that are apart, so count such a file once); nothing relates one group to another. `unresolved` counts the folder's files that no responsibility holds, which are left out. `apart.files` lists the files whose responsibility's dominant folder is another folder (the responsibilities' `pathAgreesWithRegion`), with `folder`, `responsibility`, `responsibilityFolder`, and `distance`, the folder steps between the two. `apart.coChanges` lists the source-to-source co-change pairs whose files sit in different folders, with `distance`, `scope`, `staticPath` (whether imports reach one file from the other), `coChangeCommits`, and `jaccard`, sorted by `id`. `packages` holds each package with internals and its `unresolved` files; `missing` the analyzed packages saved without internals, which `close` and `apart.files` do not cover. `apart.coChanges` needs no internals. `domains.json`: the declared domains against the dataset, empty when none are declared. `domains` lists every domain, nested ones included, sorted by `name`, with `parents` (the domains it is nested in, outermost first), `places` (its own facets that name a place, with `kind`: `package` for a complete package's root, `file` for a file of the module index, `folder` for a directory above one, or `symbol` for a symbol id of a package report, exported or not), `unmatched` (its own facets that name none, such as a path not yet written or a file of a package that failed), and `reason` and `weight` when declared, as written. `placements` lists, sorted by `place`, then `level`, then `package`, every place of `placement.json` inside a domain: a path facet covers its path and everything below it, a symbol facet its symbol only, and a place is in every domain that covers it and in their parents. Each has `domains` (all of them), `placementLabel` (placement's label, kept), `away` (`total`, its consumer modules in other packages; `shared`, those lying in a place that shares one of its domains; and `unindexed`, placement's count of consumers outside the module index), `sharedDomains` (the domains they share), and `domainLabel`: `shares-domain` when a spread or departing place's away consumer modules all share one of its domains and none is unindexed, else the placement label, so `departs` here is a departure from its domains as well as from its package. `rules.json`: the declared rules against the dataset. `rules` lists them as declared, in canonical form (`effect`, `operator`, `subject`), in declaration order, since a rule is named by its index; `unmatched` the indexes of rules whose subject names no place, matched as `domains.json` matches a facet (a complete package's root, a file of the module index, a folder above one, or a symbol of a package report; a package at the workspace root names none), such as a misspelled path or symbol, which therefore breaks nothing; `violations`, sorted by `rule`, then `place`, then `package`, every `internalize-symbol` opportunity under a `require` rule's subject, with `rule`, `place` (`path#name`), `package` (the manifest id), `opportunity` (its id), and `plan`, its saved plan's `id`, `status`, and sorted blocker reasons as `blockers`, when the report holds one; and `missing`, each `require` rule and failed package it meets, which it could not be checked in. With no rules declared, all four are empty and nothing is read |
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

## A collection

Several workspaces read together keep nothing of their own under the state
root: each workspace's state directory is as above. Their collection
manifest is derived from the workspaces' saved manifests whenever it is
asked for. `atlas serve` with several paths serves it beside each
workspace's dataset, and `atlas export` with several paths writes the same
layout under the static viewer's `data/`:

```text
/data/
  collection-manifest.json   the collection manifest
  <id>/                      a workspace's dataset, unchanged, under its workspace id
```

The collection manifest's schema version is 1, recorded as `schemaVersion`
and independent of the dataset's. While a workspace's dataset cannot be
read (deleted, caught mid-swap by a scan, or saved with another schema
version), `/data/collection-manifest.json` answers `503` with
`Retry-After: 1` and a message naming the workspace.

| Field | What it holds |
| --- | --- |
| `workspaces` | Each workspace, ordered by resolved root: `id`, `label` (its `package.json` name, else its directory's name; where two are equal, `parent/name`, and where those are too, the id's first six digits in parentheses), `dataset` (`<id>/`, where its dataset is, relative to the collection manifest), `generatedAt` (its dataset manifest's), and `packages` (every package its manifest lists, qualified as `<id>:<package>`, sorted) |
| `crossings` | Each declared dependency of a package in one workspace on a package in another: `from` and `to` (qualified ids), `kind` (`dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies`), and `range` as written. Sorted by `from`, `to`, `kind`, and `range` |
| `ambiguous` | Each declared dependency whose name two or more other workspaces hold, which makes no crossing: `from`, `kind`, `name`, `range`, `candidates` (the qualified ids of the analyzed packages of that name), and `skippedIn` (the workspaces that hold the name only as a unit their scan skipped), when there are any |

A dependency is matched by the name it resolves to, after an `npm:` alias.
It makes no crossing when its range uses the `workspace:` protocol, when
its own workspace holds the name (as a package, or as a skipped unit with
that `name`), or when the one other workspace that holds it holds it only as
a skipped unit. The range is recorded, not checked against the version
found, and other protocols (`file:`, `link:`, `catalog:`, `jsr:`) are
matched by the name the dependency is written under.

## The cache

```text
cache/
  workspace-inputs.json     the last scan's input hashes
  packages/<name>.local.json, .local.meta.json     package-local results
  packages/<name>.json, .meta.json                 assembled reports
  history/                  cached checkpoint analyses, with --history
```

The server never exposes the cache.
