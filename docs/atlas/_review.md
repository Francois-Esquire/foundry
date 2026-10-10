# Atlas code review

Maintainer note, excluded from the Blume site. Dated 2026-10-09. A
read-only review of `apps/atlas` and the rest of the repository, done to
answer the open questions in the other notes from the code, and to find what
already exists before anything new is built. Paths are under
`apps/atlas/src` unless they say otherwise. Line numbers are as of
`a7f764d`.

The rule this serves, from [`_phases.md`](./_phases.md): build on what
exists, do not rebuild it.

## The library already exists, behind tests

Most of what the proposed API needs is written. It is reachable only from
tests because the CLI that used it is gone.

| Need | What exists | Reached from |
| --- | --- | --- |
| Scan | `lib/semantics.ts:879` `generateSemantics(options)`, with injectable `analyzeLocal` and `derive` | `cli/scan.ts`, tests |
| History | `lib/semantics-history.ts:862` `generateSemanticsHistory` | `cli/scan.ts` with `--history` |
| Internals | `lib/internal-analysis.ts:19` `runInternalAnalysis({ ..., through })` | `cli/scan.ts`, tests |
| One package, in process | `lib/analyze.ts` `analyzeSurface`, over `lib/workspace-surface.ts:35` | `apply.ts`, tests |
| Terminal report | `lib/render/index.ts:36` `renderSurface(report, { format, density })`: terminal, text, Markdown; compact, normal, expanded | tests only |
| Older text reports | `lib/report.ts`: 17 `render*` functions, including `renderReport:636` over the same `SurfaceReport` | tests only |
| Codemods, reduction | `lib/operators.ts` registry (`getOperator`, `listOperators`); `lib/apply.ts` `applyReductionPlan` | tests only |
| Codemods, architectural | `architectural-operator.ts` → `operator-composition` / `-decomposition` → `operator-plan` → `operator-readiness` (`assessOperatorPlanReadiness`, `authorizeMutationPlan`) | tests only |
| Progress | `onProgress` with `phase`, `plan` (what will be invalidated, before analysis), and `unit` events, `semantics.ts:135-147` | the CLI uses `phase` only; the event type is not exported |
| Dry run | `dryRun`: fingerprint and plan without analysis. Still hashes every file, runs a dependency-cruiser pass and reads git | tests only |
| Whole pipeline | `test/lib/workspace-e2e.test.ts:4-58` drives analyze → ingest → intelligence → projections → operators → readiness → render | the de facto shape of the library |

Two codemod stacks exist: the reduction operators that `apply.ts` executes,
and the architectural operators that readiness authorizes. They meet at
`authorizeMutationPlan`. The codemod work wires these two together; it does
not add a third.

## Duplicates and leftovers

| What | Where | Disposition |
| --- | --- | --- |
| A second HTTP server | `lib/semantics-serve.ts` (node:http, `/semantics/`), V12 leftover, imported only by its test | Retire; `server/server.ts` is the server |
| Two report renderers | `lib/report.ts` `renderReport` and `lib/render` `renderSurface`, same input | `report` uses `renderSurface`; retire the older one when nothing needs it |
| The CLI's state layout, copied | `docs/scripts/build-example.ts:13,39` recomputes `sha256(root)` and `state/<id>/output` | Replace with the library `scan` and `export` |
| Atomic JSON write | `lib/semantics-cache.ts:95` `writeJsonAtomic`: pid temp name, no `wx`, no cleanup | Use `@foundry/lib/atomic-file` `writeFileAtomic`, or Marbles' sync `lib/state/json.ts:19` pattern |
| Cache lock with a race | `lib/semantics-cache.ts:354,367`: check, then write; two scans can both take it | Use `@foundry/lib/file-lock` `tryFileLock` and `processAlive`, as Marbles does |
| Workspace state directory | `cli/workspace.ts` hashes the realpath into `<state>/<sha256>/`; Marbles does the same in `apps/marbles/src/lib/state/workspace.ts:23` with a 12-hex id and a `workspace.json` record | Mirror Marbles, including `workspace.json`, so state can be listed |
| Three git runners | `git-history.ts:66`, `semantics-history.ts:146`, `semantics-history-timeline.ts:26` | One internal helper; `@foundry/workspaces/git` has no `log` and is not worth adopting |
| `command` option | `semantics.ts:1574` writes it to `manifest.generation.command`; the history twin is never read | Leave |
| The viewer recomputing the analysis | See [the viewer](#the-viewer) | Shared lenses |

## Configuration

- **No user-facing loader, by design so far.** `lib/config.ts:9-10`:
  "there is intentionally no user-facing config loader yet." The worker
  calls `analyzePackageLocal({ root, target })` with no config
  (`semantics-worker.ts:39`), so every scan uses the built-in
  `ANALYSIS_CONFIG`.
- **Two unrelated configs.** `AnalysisConfig` is policy and thresholds.
  `SemanticsConfig` (`semantics-types.ts:15-24`) is discovery and output:
  `roots`, `exclude`, `history`, `output`, read from
  `foundry.config.json#semantics` by `semantics-discover.ts:29-47` with a
  cast and a shallow merge.
- **The cache does not see `AnalysisConfig`.** The fingerprint hashes stage
  versions and `SemanticsConfig` fields only. A per-workspace analysis
  config needs a fingerprint component, or caches go stale.
- **Nothing shared to reuse.** Only Atlas reads `foundry.config.json`. The
  `.foundry/<tool>/` authoring folder exists only in Marbles
  (`apps/marbles/src/source.ts`), and is not importable.

## Dataset and versions

- **No reader outside the browser.** `cli/scan.ts:36` casts the manifest.
  `web/codex/source.ts` and `web/load-internals.ts` are the only code that
  knows dataset paths; `source.ts:74` checks `schemaVersion !== 3` as a
  literal. A deleted loader, `lib/workspace-load.ts` (removed in
  `3edd55c`), is a starting shape.
- **Versions.** Dataset 3, cache 2, history 1, package-local report 6,
  workspace 7, projection 1, `SurfaceReport` 35 (hard-coded in three
  places), analysis policy 24, intelligence policy 2, and one per
  internals stage. `lib/semantics-stages.ts` holds the stage graph:
  `SEMANTIC_STAGE_VERSIONS`, `SEMANTIC_STAGE_DEPENDENCIES`,
  `stageFingerprint`.
- **Outside the manifest.** `internals/` and `manifests/` are written by
  `cli/scan.ts:39-57` after the atomic swap. They are not in
  `manifest.files`, not under a stage fingerprint, and not published
  atomically.
- **`manifests/` ships raw `package.json` files.** The viewer fetches one per
  package at load, and a static export would publish every field.

## Cache and refresh

- Package-local results are reused when the package's sources and manifest
  are unchanged. Confirmed.
- Workspace derivation is all or nothing; its key covers every source hash,
  the module set, config, versions, the day, and git as the commit list
  plus the tracked-file set. A new commit with no source change
  re-derives every package.
- Internals run for every package on every scan, in process, one at a time,
  and call `analyzePackageLocal` again although the same result is cached
  under the same key. `test/helpers/reference-internals.ts:66-77` already
  does it the cached way.
- `apply.ts` builds three programs per call: an analysis before, a ts-morph
  project for the edit, and an analysis after. The after report is thrown
  away. `deriveWorkspaceSurface` accepts a `project`, but the layers above
  it do not pass one through. Its clock is `new Date()`, not the dataset's
  start of day.
- There is no `AbortSignal` anywhere in `lib`.

## Lenses

Nothing is a lens yet. Three things come close:

- **Projections** (`lib/workspace-projection*.ts`) have the mechanics: a
  context built once from `workspace.json`, pure functions, renderer-neutral
  output, a scan-time writer, a schema version. Their contract forbids
  inference ("nothing is inferred, ranked by a combined score, or
  reworded"), and adding one means editing five hand-kept places. The
  viewer reads one of the nine.
- **The codex** (`web/codex/`) has the pipeline: a source that lists every
  field it reads, values named by meaning, pure resolvers, bindings. It
  lives in the browser and reads with `fetch`.
- **Workspace intelligence** (graph, concepts, patterns) infers, with
  policy versions, but sits inside the report and the stage graph.

So a lens is a new sibling layer in `lib` that takes projection mechanics,
the codex's source-to-value pipeline moved out of the browser, its own
contract that allows derivation, and an entry in `SEMANTIC_STAGE_VERSIONS`.
Terminal output goes through `lib/render/views.ts`, the one
renderer-neutral view model.

The web already uses the word: the Belonging / Files map-layer toggle is
typed as a lens (`web/ui/atlas-state.ts:18`). One of the two needs another
name.

## Domains

- **Identifiers.** Symbol ids are `path#name` relative to the workspace
  root (`symbols.ts:116,133`; the root is `boundary.ts:306`), so
  `packages/core/src/ids.ts#InvoiceId` matches `SurfaceSymbol.id` directly.
  Module ids in the dataset are root-relative too. Internals ids are
  package-relative (`module:<path>`, `directory:<path>`), and join as
  `${package.root}/${module.id}`, as `web/internals.ts:38-40` already does.
- **Collisions.** The id drops the kind, which only deduplicates
  (`symbols.ts:123`). An interface and a const of one name share an id,
  and five lookup maps keep the last one (`package-local.ts:934`,
  `symbol-locality.ts:152`, `boundary-interactions.ts:284`,
  `internal-topology.ts:582`, `plan.ts:552`).
- **The motivating case.** "Used by one other package and nowhere else":
  - Package: exists. `fold-package` gates on `consumerPackages === 1`;
    `dependencies.ts:475-495` signals `single-consumer`; `primaryConsumer`.
  - Symbol: the data exists and nothing reads it. `SurfaceSymbol.consumerPackages`,
    `consumers`, `primaryConsumerShare`, `consumerModuleUsage`
    (`references.ts:193-215`). The only use is the top five in
    `report.ts:709-720`.
  - Module and directory: derivable from cross-package module edges; not
    computed.
  - Inside a package: `symbol-locality.ts` `placement`, and responsibility
    locality, have the right shape, over inferred regions.
- **The analyses refuse usage alone on purpose.** Concept miscentering
  returns `usage-only`, no finding, when another package leads only on
  consumption (`concept-miscentering.ts:103-108`). A domain lens adds the
  workspace's declared side; it does not reverse that choice.
- **Anchors.** Package-level `{ target, reason? }`, built in, one entry.
  They block `fold-package` and flow as context into ingest, concept
  ownership, recentering (`intent-protected`), the graph, and readiness
  (`anchor-violation`). Concept recentering matches anchors by package name
  only (`concept-recentering.ts:1383`), so an anchor by path is invisible
  there.
- **Nesting.** Inside a package: the directory tree and `locality.scopes`
  with parent chains are in `internals/`. Districts and composite districts
  exist only in the viewer. Across packages: nothing.

## The viewer

- **Recomputes the analysis.** Neighborhoods (`web/neighborhoods.ts`,
  `relationships.ts`) compete with the analysis's responsibility regions.
  Composite districts (`hierarchy.ts`) and file roles (`district-layout.ts:132`)
  have no counterpart in `lib`. Landmarks use ≥5 incoming and the 95th
  percentile where `lib` uses `highFan` with 3 and the 90th, and count
  cross-package edges where `lib` counts internal ones. Change craters use
  other thresholds than `lib`'s hotspots. Package-pair traffic is
  re-aggregated three times from file edges although the dependency graph
  projection carries it.
- **Leaves `lib` data unread.** Symbol locality (`commonScope`,
  `dominant*`), miscentering, gravity, the directory tree, path regions and
  seams all ship and none is drawn.
- **One workspace, hard-coded.** `./data/` in `codex/source.ts:59,113` and
  `load-internals.ts:16`; positions and pigment hash the package id alone.
- **Export exists.** `docs/scripts/build-example.ts` copies `dist/web` and
  `output/` to a static folder; relative fetches make it serverless.
- **Loading.** Every edge shard, module shard and package manifest at load;
  `manifest.json` up to three times per internals request. The survey
  identity check compares `generatedAt`, not content.
- **Weight.** About 20.7k lines; 9.1k of them painting, the three.js
  pipeline, and decoration. The tangles are `scene/paint-map.ts` (18
  positional parameters, a mode string), `scene/scene.ts` (one closure
  owning renderer, camera, hit testing and layers), and
  `ui/use-atlas-state.ts`.
- **Reusable as it is.** `codex/`, `internals.ts`, the pure district and
  belonging functions with their tests, geography and landmass settling,
  `server/server.ts`, the map-only and shell split.

## Elsewhere in the repository

- `@foundry/lib`: `atomic-file`, `file-lock`, `digest`, `json`
  (`canonicalizeJson`), `glob`, `paths`. Atlas uses none of it.
- Marbles: the `exports` layout (`.`, `./lib`, `./prebuilt`), tsup with
  `noExternal: [/^@foundry\//]`, a typed command table, `.foundry/marbles/`
  resolution, `workspace.json` state records, and `readStatus` listing the
  state root. None is in a shared package.
- `@foundry/workspaces` is a live file catalog with watchers. It is not a
  registry of scanned repositories and does not fit collections.
- Release: one shared version and `v*` tags; every public package needs
  `test:package`; a public package may not depend on a private one. Atlas
  builds with `packages: "external"` (`scripts/build.ts:11,20`), so any
  `@foundry/*` import must be bundled, Marbles-style, and checked by the
  package test. The analysis worker is found beside the entry file
  (`semantics.ts:174-179`), so every entry must ship it.
