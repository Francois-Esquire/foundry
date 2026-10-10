# Atlas phases

Maintainer note, excluded from the Blume site. Dated 2026-10-09. The order
of the work on the `feat/atlas` branch, so that each piece has a place and
nothing is started out of turn. The other notes hold the detail; this one
holds the sequence and the ground rules. What exists today, with evidence,
is in [`_review.md`](./_review.md).

## Ground rules

1. **The analyses are the asset; leave them alone.** Everything under
   `apps/atlas/src/lib` that computes a result (symbols, gravity, churn,
   concepts, locality, responsibilities, rewiring, opportunities, plans,
   readiness) stays as it is. New work does not reshape it to fit.
2. **Build on what exists.** Most of the library is written and reachable
   only from tests. The first move is always to expose or reuse, and only
   then to write. Before adding anything, check [`_review.md`](./_review.md)
   and the connection points below.
3. **New views are lenses.** A lens is a read-only function over the
   dataset, plus the workspace's own declarations where it needs them, that
   produces a view: labels, groupings, measures. It lives beside the
   analyses, never inside one.
4. **A change to existing analysis code needs a named reason,** recorded
   under [Changes to existing code](#changes-to-existing-code) before the
   change. Loading, caching, the CLI, the server, and the viewer can change
   as the phases need.
5. **Retire duplicates instead of adding a third.** Where two things do one
   job, the new work uses one and the other goes when nothing needs it.
6. **Foundations, not frameworks.** Each phase builds the least that the
   next phase needs. Domains are the example: their shape is set early, and
   they grow only when codemods or the map show a need.

## Connection points

Where new work attaches. All exist today.

| Point | What it hands off | Used by |
| --- | --- | --- |
| `generateSemantics` (`lib/semantics.ts`) | The dataset; `onProgress` with phase, plan, and unit events; `dryRun` | Library `scan`, the refresh after a codemod |
| `generateSemanticsHistory` | History checkpoints | Library `scan` with history |
| `runInternalAnalysis`, `packageInternals` (`lib/internal-analysis.ts`) | One package's internal structure, through a chosen stage, from the package or from its local report | The materializer, `scan.package`, nesting and locality lenses |
| `output/`, the dataset | Every analysis's result, versioned | The reader, lenses, the viewer, `report`, `check` |
| `lib/dataset.ts` `datasetReader` | The one typed read of a dataset, through a `fetch` or file-system transport | `scan`'s results, the viewer, `report`, lenses |
| `lib/render` `renderSurface` | Terminal, text, Markdown; three densities | `atlas report` |
| `lib/render/views.ts` | The renderer-neutral view model | Terminal output of lenses |
| `lib/semantics-stages.ts` | Stage versions, dependencies, fingerprints | Versioning lenses |
| Projection context (`lib/workspace-projection.ts:376`) | `workspace.json` plus intelligence, indexed once | Lens mechanics |
| `AnalysisConfig.anchors` | Declared package boundaries the analyses respect | Domains, when they need to reach the gates |
| `operators.ts`, `apply.ts` | Reduction plans: preview, write, verify, restore | `atlas apply` |
| `operator-readiness.ts` | Authorization of architectural plans | `atlas plan`, rules, domains |
| `server/server.ts` `startServer` | A dataset and the viewer on a port | Library `serve`, collections |
| `docs/scripts/build-example.ts` | A static viewer plus dataset | `atlas export` |
| `@foundry/lib` | Atomic files, file locks, digests | The cache and state code |
| Marbles (`apps/marbles`) | Exports layout, tsup bundling, `.foundry/<tool>/`, `workspace.json` | Patterns to mirror; not importable |

## How the efforts are written

Planned 2026-10-10. Each phase is a list of efforts, numbered so other
notes and commits can name them. An effort says what it does, what it
builds on, what it touches, when it is done, and what it waits for.

Detail falls off by phase, on purpose. Phase 1 is planned to the file.
Phase 2 is planned to the lens. Phases 3 to 5 open with the decision that
unblocks them and stay coarse until the phase before them lands, so that
nothing is planned against code that has not been written.

The forks in [`_api.md`](./_api.md#forks) were settled on 2026-10-10.
Each effort is implemented, reviewed, and committed on its own, one commit
per effort.

## Phase 1: shape the API

Mostly exposing what is written. Detail in [`_api.md`](./_api.md).
Paths are under `apps/atlas` unless they say otherwise.

**1.0 Settle the forks.** Done 2026-10-10; see
[`_api.md`](./_api.md#forks).

**1.1 Build and install.** Done 2026-10-10.
- `scripts/build.ts` keeps only `package.json#dependencies` external, so
  `@foundry/*` workspace packages are inlined without adding tsup.
- The analysis workers run under `process.execPath`; only a host outside
  Bun, such as Vitest's Node host, falls back to `bun` from the PATH.
- The missing-assets message names the path it looked in and no
  repository command.
- The CLI build emits no sourcemap and clears `dist/cli` first.
- `test/package.test.ts` carries Marbles' `privateImports` check over the
  installed `dist`, scans with an empty PATH, and checks the
  missing-assets message.

**1.2 `scan` into the library.** Done 2026-10-10.
- `cli/scan.ts` is now `lib/scan.ts`: `scan(root, options?)`,
  `scan.workspace(root, options?)`, and `scan.package(root, name)`. The
  first two return a `Scan` or `WorkspaceScan` (the output directory, the
  manifest read back, and the history manifest when asked); `scan.package`
  returns `PackageInternals`, every stage through the review, and saves
  nothing.
- One `ScanOptions` for both scans: `state`, `onProgress`, `history`. The
  exported `ScanProgressEvent` is the dataset's events plus `internals`
  (with a 1-based `index` of `total`) and history's events wrapped as
  `history`.
- `scan.workspace` writes `manifests/` too, so its dataset loads in the
  viewer; `scan` adds `internals/`. Order: publish, internals, history.
- `cli/workspace.ts` is now `lib/state.ts`: `workspaceState(root,
  state?)` and `resolveRoot`. The id is unchanged.
- The CLI formats the events to stderr as before; the fixture dataset
  compares equivalent before and after (`compareSemanticsDatasets`, with
  internals timing stripped), and `test/lib/scan.test.ts` covers the three
  functions and history.

**1.3 State and cache.** Done 2026-10-10.
- One lock, the state directory's: `lib/state.ts` `lockState` takes
  `<state>/<id>/lock` with `@foundry/lib/file-lock` `tryFileLock` and
  `breakStale`, as Marbles takes its locks. `scan` and `scan.workspace` hold
  it for the whole run (`whileScanning` in `lib/scan.ts`), history
  included; `scan.package` saves nothing and takes none. A second scan
  fails at once, not waiting, with `Workspace <root> is being scanned by
  process <n>. If no scan is running, remove <lock>.` (or `… by this
  process.`); a lock whose process has exited is taken over. The cache
  lock (`acquireCacheLock`) and its acquire and release in
  `generateSemantics` are gone, so whatever calls `generateSemantics` next,
  such as the 3.6 refresh after a codemod, must go through the state lock.
- `@foundry/lib/atomic-file` gains `writeFileAtomicSync`, the sync twin of
  `writeFileAtomic` (exclusive `randomUUID` temporary, removed on failure).
  `writeJsonAtomic` is a one-line call to it and writes the same compact
  JSON, so dataset bytes are unchanged. Moving Marbles' own sync writer
  (`apps/marbles/src/lib/state/json.ts` `writeJson`) onto it is a later
  cleanup.
- The workspace record `<state>/<id>/workspace.json`. Once the lock is
  held, `{ id, root, schemaVersion: 1 }` is written if there is no record
  yet (`recordWorkspace`). As soon as the dataset is published, at the end
  of `publishWorkspace` (after the swap and `manifests/`, before internals
  and history), the full record is written with `atlasVersion` and
  `lastScannedAt`, which are set together (`recordSavedDataset`). A later
  internals or history failure still leaves a record that matches the
  saved dataset. `WorkspaceRecord` is not exported, and nothing lists the
  state root yet (5.1).
- The workspace id is Marbles' 12-hex id, the first 12 hex digits of the
  resolved root's SHA-256; `WorkspaceState` gains `directory` and `id`, and
  `workspaceState` still creates nothing. Existing state directories are
  orphaned and cost one rescan.
- `docs/scripts/build-example.ts:13` slices the id to 12 digits until 1.8
  replaces the script.
- `@foundry/lib` is a devDependency of Atlas, inlined by the 1.1 build.
- Tests: `test/lib/scan.test.ts` starts a second `scan.workspace` from the
  first scan's first progress event and checks it fails, that the first
  saves its dataset, and that no `lock` or `lock.break` remains; a live
  foreign holder is refused with no record written; a scan that fails in
  history after saving its dataset releases the lock and records the save;
  the record's contents. `test/lib/state.test.ts` covers `lockState` with
  hand-written lock files. `test/atlas.test.ts` checks the id for `/`
  against an independently computed digest.

**1.4 The dataset, complete.** Done 2026-10-10. Dataset schema 4.
- Internals are derived inside `generateSemantics`, opted into with
  `internals: true` (`scan` passes it, `scan.workspace` does not), from
  each complete package's local report and through its `Writer`, before
  the swap, by `writeInternals` in `lib/internal-analysis.ts`, which emits
  the `internals` progress events within the `write` phase. They are listed on the package's manifest entry as
  `internals`, which is absent when the scan left internals out or the
  package failed, and saved without `timing`, so an unchanged package's
  file is reused by inode. No separate cache is needed: from a local
  report the six stages take tens of milliseconds, against hundreds for a
  fresh `runInternalAnalysis`, and on the fixture and two Foundry packages
  the output is byte-identical to it. `recordSavedDataset` still runs
  after the publish, which now includes internals.
- `lib/internal-analysis.ts` gains `packageInternals(local)`, the six
  stages in a straight line, and a private `analyzeInternals(local,
  through)`, today's stage chain with its timings, which
  `runInternalAnalysis` now calls; `runInternalAnalysis` is unchanged in
  signature and output.
  `PackageInternals` is `packageInternals`' return type. `scan.package`,
  the materializer, and `test/helpers/reference-internals.ts` (which had
  its own copy of the stage chain) use `packageInternals`. Logged below.
- The stage graph's `materialization` depends on
  `packageArchitectureReview` too. This is documentary: nothing consumes
  the materialization fingerprint yet.
- `manifests/` is gone. Each package entry carries `declaredDependencies`
  (`SemanticsDeclaredDependencies`: the four kinds its `package.json` has,
  ranges as written), parsed once in discovery with the package's name and
  carried on `SemanticsWorkspaceUnit`; the codex reads them from the
  manifest (`CodexSource.declaredDependencies`), with no per-package fetch,
  and uses the library's `SemanticsDeclaredDependencyKind`. The `name`
  fields of `SemanticsManifestPackage` and `SemanticsWorkspaceUnit`,
  always equal to `id`, are gone.
- `history/couplings.json` and `files.couplings` are deleted: a
  field-for-field copy of `workspace.json#evolution.couplings` that nothing
  read, which also ends its loss on a `--history` scan.
  `SemanticsModuleRecord.history` is `evolution`, and the caution
  `history-unavailable` is `evolution-unavailable`, since these are the
  plain scan's Git facts, not checkpoints.
- Under `failFast`, a failed package publishes nothing: one guard at the
  end of the derive phase, when every failure is known, throws
  `Packages failed analysis: <id> (<error>)`, so nothing after it runs and
  the previous dataset survives. It replaces the post-publish check in
  `lib/scan.ts`. A package the derivation leaves out, or whose cached
  report is missing, records an `error` and an `errors` entry; without
  `failFast` the partial dataset is published as before. The second case
  is a type guard: a reused report slot always holds its report, so no
  test reaches it. An internals crash always aborts the generation, with
  or without `failFast`; before, it came after the publish.
- `manifest.json` names every file in the dataset, itself or through
  `modules/index.json`, except those under `history/`, which
  `history/manifest.json` names when the dataset includes history; history
  is still published after the dataset. `test/helpers/dataset-files.ts`
  `listedFiles` lists them; `test/lib/scan.test.ts` checks every file under
  `output/` is listed, for `scan`, `scan.workspace`, and a `--history`
  scan, and `test/lib/semantics.test.ts` that every listed file exists.
- The viewer checks for schema 4 as a literal (the constant goes in 1.5).
  `web/load-internals.ts` reads the path from `pkg.internals`, and says
  "The dataset has no package named <id>.", "This dataset was saved
  without internals. Run atlas scan to include them.", or, for a failed
  package, "Atlas could not analyze this package, so it has no internals."
- `--history` is worded as Git checkpoints in the CLI help, the README, and
  `start-here.md`, as `reference/cli.md` has it.
- The fixture dataset compares equivalent before and after
  (`compareSemanticsDatasets`), apart from the schema version, the package
  entries' fields, `manifests/` and the couplings file, internals `timing`,
  and the renamed caution; `packages/`, `workspace.json`, `projections/`,
  and the module and edge shards show no differences.

**1.5 One reader, internal.** Done 2026-10-10. Not exported; `scan`
returns its results through it.
- `lib/dataset.ts` `datasetReader(transport, { pin? })` is the one read of
  a dataset. The transport is a function from a dataset-relative path to
  its JSON, or `undefined` when the dataset has no such file:
  `lib/dataset-files.ts` `fileTransport(output)` in Node, and a private
  `fetch` transport in `web/dataset.ts`, the one place that names the
  viewer's data root `./data/`, behind `viewerDataset({ signal, pin })`.
  Both transports name the file they could not parse.
- The reader checks the manifest against `SEMANTICS_DATASET_SCHEMA_VERSION`
  and history's against `SEMANTICS_HISTORY_SCHEMA_VERSION`. History's
  manifest is found by its fixed path, after the dataset's manifest is
  checked, so the pin applies to it too; every other file through what the
  manifest records. A reader holds its manifest, module index, and history
  (the promises, so concurrent reads share one request): one reader is one
  read. A package that `failed` has neither report nor internals. `packageReport(name)` and `internals(name)` read the manifest plus
  one file, never a shard. Typed errors: `DatasetNotFoundError` (no
  manifest, for 1.6's `serve` to map) and `DatasetReplacedError` (a
  manifest other than the `pin`, the `generatedAt` the caller holds).
- `lib/dataset-layout.ts`, a leaf with no imports, holds `DATASET_FILES`,
  `HISTORY_DIRECTORY`, `HISTORY_FILES`, `encodePackageFile`, and the
  per-package and history path helpers, for the writers
  (`semantics.ts`, `semantics-history.ts`), the cache, the worker, and
  `scan.ts`. `decodePackageFile`, used only by a test, is gone.
- `lib/internal-analysis-types.ts` holds `PackageInternals`, spelled out
  from the stage report types, and the read-side `verifyInternals(value,
  name)`, which replaces the viewer's check. `packageInternals` returns the
  type and does not call it: it cannot be incomplete. Logged below.
- `WorkspaceScan` gains the accessors `workspaceReport()` and
  `packageReport(name)` (`PackageReport`, an alias of `SurfaceReport`
  beside the reader in `lib/dataset.ts`, re-exported from `scan.ts`), and
  `Scan` gains `internals(name)`. They are own function properties; each
  reads through a fresh reader pinned to the saved manifest and then reads
  the manifest again, as the viewer does, so a later scan of the workspace
  makes them fail with `DatasetReplacedError`; `JSON.stringify` leaves them
  out.
  `scan.ts` reads the manifest back through the reader instead of a cast.
- The codex keeps its picks: `readCodexSource(dataset)` takes a reader,
  and `CodexSource.survey` is `dataset`. `web/codex/resolve.ts` and
  discovery share `SEMANTICS_DECLARED_DEPENDENCY_KINDS` from
  `semantics-types.ts`.
- `web/load-internals.ts` reads through one pinned reader, then makes a
  second one-shot pinned read of the manifest once the files are in. The
  plan said the manifest would be read once, not twice; that changed in
  review. The second read is the old closing check: if the manifest before
  and after is the same publish, every file read between came from it, so
  a scan that replaces the dataset mid-read cannot mix two datasets. One
  fewer request did not justify losing that. It reports "A later scan replaced the dataset.
  Reload Atlas to see it." Each drill-down reads the manifest twice, the
  internals, the module index, and the package report only for recorded
  change.
- Browser safety, three ways: value imports of `internal-analysis` and the
  other analysis modules stay out of the reader; a Biome override sets
  `noNodejsModules` on the reader, the layout, every `lib/*-types.ts`, and
  `web/**`; and `vite.config.ts` fails the build when the viewer's graph
  imports a `node:` specifier, or a bare built-in name that resolves to
  nothing or to Vite's `__vite-browser-external` stub (a bare name with a
  browser package, such as `buffer`, passes). Vite 8 inlines the stub as an
  empty object with no name in `dist/web`, so the build is where it is
  caught. One-off controls with `events`, `node:path`, and `buffer`
  confirmed each case and were reverted.
- Tests: `test/lib/dataset.test.ts` over an in-memory transport
  (`test/helpers/dataset-transport.ts`, which also counts reads);
  `test/lib/scan.test.ts` reads back the fixture through the accessors,
  counts one package's reads over the file system, and reads the codex
  source through `fetch` and the file system and compares;
  `test/web/dataset.test.ts` covers the `fetch` transport; and
  `test/atlas.test.ts` drives `loadAtlas` and `loadInternals` over the real
  server and a real scan.
- No file outside the reader and the layout names a dataset path. What a
  search still finds is a different thing: `/data/` in `server/server.ts`
  and `./data/` in `web/dataset.ts` (the data root), the cache's and the
  worker's own files, the workspace record's `workspace.json`,
  `semantics-equivalence.ts`'s glob keys, and `semantics-serve.ts` until
  1.6 retires it. On the server side, which 1.6 and 1.8 own, the
  `scripts/dev.ts` `"/data"` proxy and `docs/scripts/build-example.ts`'s
  `"data"` copy name the data root too.
- `semantics-equivalence.ts` keys `history/manifest.json` as well, so
  `compareSemanticsDatasets` ignores history's timings inside a dataset;
  before, only the `kind` override did.

**1.6 `serve`.** Done 2026-10-10.
- `lib/serve.ts` `serve(root, { port, state })` resolves the workspace
  state, finds the viewer, checks the saved dataset through the reader
  (`datasetReader(fileTransport(output)).manifest()`), and starts
  `startServer`, whose `webRoot` option is now `viewer`. It returns an
  `AtlasServer`: `url`, `root` (resolved
  through symlinks, which the CLI prints since it no longer calls
  `workspaceState`), and `stop()`, which is `server.stop(true)`: open
  connections are closed, the promise resolves once the port is free, and a
  second call does nothing. The name avoids Bun's and Node's `Server`.
- `DatasetNotFoundError` becomes `No dataset found for <root> in <output>.
  Run atlas scan to save one.`, with the reader's error as its cause; a
  dataset with another schema version fails with the reader's own message.
  So `atlas serve` on a workspace never scanned, or saved at schema 3, now
  exits 1 instead of serving a viewer that shows the error. `serve` takes no
  lock; a concurrent scan's atomic swap is seen by later requests.
- `viewerRoot()`, an internal export of `lib/serve.ts`, is the viewer
  lookup moved out of `cli/index.ts`: `../web` from a built entry and
  `dist/web` from source, told apart by `import.meta.filename` as the worker
  is (`lib/semantics.ts`). Built entries go directly in `dist/cli`, beside
  the worker; `scripts/build.ts` says so. Its message is now
  `The viewer's files are missing from <dir>. Reinstall the package, or
  build it first when running from source.`
- The default command calls `viewerRoot()` before it scans, so a checkout
  without a build fails at once; `atlas scan` never checks. A port in use
  is still found after the scan, since the dataset must exist to serve.
- `DEFAULT_PORT` (4173) is `serve`'s default, and `serve` refuses a port
  that is not an integer from 0 to 65535 with the CLI's message, through
  the `checkPort` both share. `--port` is optional in `cli/args.ts`, which
  prints the constant in its help, and `scripts/dev.ts`
  applies it to Vite. Otherwise `scripts/dev.ts` keeps a data-only
  `startServer` (it needs no built viewer), and
  `docs/scripts/build-example.ts` is unchanged until 1.8 replaces it.
- `server/server.ts` calls `globalThis.Bun` instead of `import … from
  "bun"`, which the bundler turns into a destructure of `globalThis.Bun`
  that throws as the module loads under Node. `serve` throws `Atlas serve
  needs Bun (>=1.3.14).`, the range read from `package.json#engines`, first,
  so a Node importer of the 1.10 entry can still load `scan`.
  `@foundry/lib/atomic-file` gains `isMissingPath` (ENOENT or ENOTDIR),
  which replaces the copied `missing` checks in `server/server.ts` and
  `lib/dataset-files.ts` and serves `viewerRoot`.
- `lib/semantics-serve.ts` and its test are gone.
- `test/lib/serve.test.ts` runs on Vitest's Node host and checks that
  `serve` loads there and rejects with the Bun message. The rest are in
  `test/atlas.test.ts`, under Bun: `serve` serves `index.html` and the
  manifest byte for byte, reports the realpath root, frees its port on `stop` (the port binds
  again) and stops twice; a missing dataset and a schema-3 dataset are
  refused. `test/package.test.ts` checks the new missing-viewer message
  through the installed `serve` and the default command, which fails
  without scanning.

**1.7 Configuration.**
- Resolve `.foundry/atlas/` as Marbles resolves `.foundry/marbles/`
  (`apps/marbles/src/source.ts`), copied rather than imported.
- Read `foundry.config.json#semantics` as a fallback during 0.x, now
  validated rather than cast. `history.strategy` rejects unknown values.
  `semantics.output` is removed, since the state directory decides where
  output goes.
- Discovery reads `pnpm-workspace.yaml` as well as
  `package.json#workspaces`. The default roots stop being Foundry's
  (`semantics-discover.ts:26`); a workspace's own declaration wins.
- The configuration's contents feed the scan fingerprint, so a changed
  configuration invalidates the cache.
- `AnalysisConfig` stays built in. The `@foundry/workspaces` anchor in it
  (`lib/config.ts:816-819`) is analysis configuration, so removing it is
  logged under [Changes to existing code](#changes-to-existing-code) first.

**1.8 Commands.** The CLI as the library plus formatting.
- A typed command table, as Marbles has, in `cli/args.ts`.
- The CLI's `Output saved to <dir>` becomes `Dataset saved to <dir>`, with
  `test/package.test.ts` and the docs that quote it (`reference/cli.md`,
  `start-here.md`, `guides/scan-a-workspace.md`).
- Paths are plural in the parser, `path...`, and a second path is refused
  with a message that names the collection work, until phase 5.
- `--json` and `--quiet` on every command that prints a result; exit codes
  documented.
- `atlas report <package>`: reads `packages/<name>.json` through the reader
  and calls `renderSurface` with `--format` and `--density`. Package
  reports only, because `renderSurface` takes a `SurfaceReport`, which is a
  package; there are no file reports yet.
- `atlas export <dir> [path]`: `docs/scripts/build-example.ts` moved into
  the library and the CLI. The docs script calls it and stops recomputing
  the state layout.
- Viewer fixes from the publish list: the idle caption "The Foundry
  archipelago" goes, and the `atlas-world` class keeps its space when
  settings are open.
- `reference/cli.md` follows.

**1.9 Foundations for phase 2.** Shapes only; nothing is built on them yet.
- The domain declaration type and its validation, read by the 1.7
  loader. The sketch is in
  [`_domains.md`](./_domains.md#what-a-domain-is).
- The lens contract as a type: inputs, output, version. Written down in
  `_domains.md` or a lens note, with no implementation.

**1.10 Exports and the installed package.** Last, because it publishes the
others.
- The `exports` map: `.` only, with `scan`, `serve`, and the result types.
  The analysis worker ships beside it.
- The exported dataset types carry a `Semantics*` prefix
  (`SemanticsManifest`); alias them or document the prefix.
- `serve` returns an `AtlasServer`, prefixed (unlike `Scan`) so it does
  not collide with Bun's or Node's `Server`.
- The entry names its exports explicitly, with no `export *`, so
  `viewerRoot`, `DEFAULT_PORT`, and `checkPort` in `lib/serve.ts` stay
  internal.
- The entry sits one directory under `dist/`, beside the worker, so that
  the worker and `viewerRoot` find their files (`scripts/build.ts`).
- `test/package.test.ts` imports the library from the installed tarball and
  runs `scan`, `scan.workspace`, `scan.package`, and `serve` against the
  fixture.
- Public pages for the library, beside the CLI pages.
- Two public names to decide before 0.1: `SemanticsPackageStatus`
  `"skipped"` is never written, and the invalidation reason
  `"history-changed"` names Git state, which the glossary calls evolution,
  not history.

**Phase 1 is done** when the library and the CLI work over unchanged
analyses, the installed-package test covers every export and the binary,
and the "Before the first publish" list in [`_roadmap.md`](./_roadmap.md)
is empty apart from the release tooling item, which belongs to the release
scripts, not to Atlas.

## Phase 2: lenses and domains

Detail in [`_domains.md`](./_domains.md) and [`_viewer.md`](./_viewer.md).

**2.0 Decide when lenses run.** At scan time, written into the dataset, so
that the viewer and third parties read them and nobody recomputes; or at
read time, from the reader. The domain lens reads declarations that change
without a rescan, so at scan time the fingerprint must cover them.
Recommendation: scan time, with the declarations in the fingerprint, in
keeping with the dataset as the product.

**2.1 The lens layer.** A sibling of the analyses in `lib`: the projection
mechanics (a context built once, pure functions), the codex's
source-to-value pipeline over the 1.5 reader, a contract that allows
derivation, and an entry in `SEMANTIC_STAGE_VERSIONS`. Terminal output
through `lib/render/views.ts`. Done when one trivial lens is computed,
versioned, published, and printed.

**2.2 The viewer's duplicates, one lens each.** For each, the lens is
written in `lib`, the viewer reads it, and the viewer's own computation is
deleted. Where the viewer and `lib` disagree, the maintainer picks the
threshold.
- Landmarks against `highFan`: the viewer counts cross-package edges with 5
  and the 95th percentile; `lib` counts internal edges with 3 and the 90th.
- Change craters against hotspots.
- Neighborhoods against responsibility regions. Two clusterings of one
  island; one goes. This is a maintainer decision, and it ties to the
  viewer's "two groupings" observation.
- Composite districts (`web/hierarchy.ts`) and file roles
  (`web/district-layout.ts:132`), which have no counterpart in `lib`.
- Package-pair traffic needs no lens: the dependency graph projection
  carries it, and the viewer's three re-aggregations go.

**2.3 Placement: where it lives against where it is used.** The motivating
case. Per symbol from `consumerPackages` and its neighbors; per file and
per folder as sums over cross-package module edges. Labels Fits and
Departs, before any domain exists.

**2.4 Nesting.** The directory tree, path regions, seams, and scopes from
`internals/`, joined to root-relative ids.

**2.5 Proximity.** What sits close without being related, and what is
related without sitting close: `pathAgreesWithRegion`, change coupling,
boundary interactions.

**2.6 Domains.** The domain lens over 2.3: declared domains joined to
symbol ids, module paths, and consumers, adding the Shares a domain label.
Waits for 1.9.

**2.7 In the terminal.** `atlas report` gains the lens sections through
`views.ts`, with `--json`.

**2.8 Naming.** The viewer's Belonging / Files toggle is typed as a lens
(`web/ui/atlas-state.ts:18`); rename it.

Shape has no effort of its own: the graph projection, layers, gravity, and
file counts already answer it.

## Phase 3: rules and codemods

Detail in [`_codemods.md`](./_codemods.md#decisions-needed).

**3.0 Measure the refresh.** A cold scan, a warm scan, and a scan after a
one-file edit, on a throwaway copy of the repository, which needs no
permission to edit the checkout. Every refresh decision waits for the
numbers.

**3.1 Rules.** The shape `{ operator, subject, effect }`, declared in the
configuration from 1.7, with subjects addressed by path and `path#symbol`.

**3.2 Wire the two stacks** at `authorizeMutationPlan`. No third.

**3.3 `atlas check`.** Rules against the dataset; exit 1 on a violation.

**3.4 `atlas plan`.** One plan for one site, read-only.

**3.5 `atlas apply` for `internalize-export`.** Fresh analysis,
revalidation, a dirty tree blocks, preview by default, write with
`--write`, verify, restore on failure.

**3.6 Refresh after every write.** Internals are already reused per
package since 1.4, derived from the cached local reports; what remains is
passing the project `apply` builds through instead of building three. Sized
by 3.0.

**3.7 Domains reaching the gates,** through anchors, if a codemod needs
them. The analysis changes logged below come due here.

**3.8 A second codemod kind,** chosen by the maintainer.

## Phase 4: the viewer

Detail in [`_viewer.md`](./_viewer.md#questions).

**4.0 Decide the viewer's direction.** Why the engraved survey was
rejected; whether the problem is legibility, the metaphor, or polish; who
the reader is. Everything below except 4.1 waits for these.

**4.1 Reader settings and renderer settings.** Renderer controls (tone
mapping, bloom, the stage inspector) move behind a developer flag. Needs
none of the 4.0 answers and can be done at any time.

**4.2 The four questions by default,** from the phase 2 lenses, with
departures as the strongest signal.

**4.3 Directories drawn,** and a domain drawn across islands.

**4.4 Loading.** Covered by the lazy reader in 1.5; what remains is the
viewer reading only what the current zoom needs.

## Phase 5: many workspaces

Detail in [`_workspaces.md`](./_workspaces.md#questions).

**5.0 Decide the use case** and the first set of workspaces to build
against. The shape, a collection dataset, is recommended already.

**5.1 A collection record,** listing the workspaces, built on the 1.3
`workspace.json` records.

**5.2 The collection dataset:** qualified ids and the cross-workspace edges
from declared dependencies.

**5.3 Many paths for real** in the commands, the library, and `serve`,
which serves each dataset under its own prefix. `AtlasServer.root` is
singular until then.

**5.4 The viewer's data root per workspace,** which 1.5 reduces to one
place, `DATA_ROOT` in `web/dataset.ts`; the server's `/data/` mount and the
`scripts/dev.ts` proxy move with it.

## Changes to existing code

Every change to analysis code, with its reason, before it is made.

| Change | Reason | Status |
| --- | --- | --- |
| Symbol ids carry no kind | `symbols.ts:133` forms `path#name`; an interface and a const of one name share an id, and five lookup maps keep the last one. | Confirmed. No change for now: a facet without a kind matches every symbol of that id. Revisit only if a codemod needs to tell them apart. |
| Anchors matched by name only in concept recentering | `concept-recentering.ts:1383`; an anchor declared by path is invisible there. | Only if domains feed anchors (phase 3). |
| The worker passes no `AnalysisConfig`, and the fingerprint does not cover it | `semantics-worker.ts:39`; per-workspace anchors would be ignored, and a changed config would leave stale caches. | Only if domains feed anchors (phase 3). |
| `analyzeInternals` and `packageInternals` extracted from `runInternalAnalysis` | The materializer derives each package's internals from the local report it already holds, instead of analyzing the package again; `runInternalAnalysis` is unchanged in signature and output. | Done in 1.4. |
| `PackageInternals` moves to `lib/internal-analysis-types.ts`, spelled out from the stage report types | The reader validates saved internals in the browser, which cannot import the analysis code that `packageInternals`' return type came from. No behavior change; `packageInternals` returns the same shape. | Done in 1.5. |
| The `@foundry/workspaces` anchor is built in | `lib/config.ts:816-819`; it blocks `fold-package` for any package of that name in any scanned repository. | Remove in 1.7. A Foundry scan loses its one anchor until workspaces can declare their own (3.7). |
