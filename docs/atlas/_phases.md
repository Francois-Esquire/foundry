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
   dataset, plus the workspace's own settings where it needs them, that
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
| `lib/lenses/run.ts` `LENSES`, `writeLenses` | Every lens, in dependency order; the lens phase over the unpublished dataset | `generateSemantics`, each new lens |
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

**1.7 Configuration.** Done 2026-10-10.
- The configuration directory is `.foundry/atlas/`, walked as Marbles walks
  `.foundry/marbles/` (copied into `lib/atlas-config.ts`
  `configFiles`; a directory reached through a symbolic link is refused).
  Each configuration file default-exports a plain object, and each key is
  declared in one file only, a rule 1.9 keeps for `domains`. `AtlasConfig` is `{ exclude?, history? }`; there is no
  `defineConfig` or `domain()` helper, and 1.10 exports the type only.
- The files run in `lib/config-worker.ts`, a Bun worker of its own started
  like the analysis workers (`lib/worker-runtime.ts`), with the workspace as
  its working directory and a 30-second timeout after which it is killed
  with `SIGKILL`. It names each file before importing it, so a file that
  ends the process is named, and returns the validated default exports as
  JSON, which the loader validates again; each load imports them fresh. The
  build bundles it as `dist/cli/config-worker.js`.
- Validation is zod, strict, with one-line messages that put the subject
  first: `Configuration <file>: <setting> <issue>; got <value>.`, string
  values quoted. `exclude` entries and package patterns share one spelling,
  `boundary.ts` `normalizeWorkspacePath`.
  `history.strategy` and `history.range` are checked at load time.
- `foundry.config.json#semantics` is the fallback when there is no
  configuration directory, validated the same way. `semantics.output` and
  `semantics.roots` are rejected with a message naming the replacement, and
  a `semantics` key beside `.foundry/atlas/` is an error (a file there that
  does not parse is ignored).
- Execution invariants: the scan entry points in `scan.ts` (`prepare` and
  `scanPackage`) are the only load sites, through `loadConfiguration`.
  `generateSemantics` and `generateSemanticsHistory` take the resolved
  configuration and never load it, defaulting to `DEFAULT_CONFIGURATION`; history applies the working tree's
  configuration to every checkpoint. `serve` and the reader never run it.
  `generateSemantics` gains `output`, which `scan` sets to the state
  directory's.
- Discovery follows the workspace declaration only:
  `pnpm-workspace.yaml#packages` when it lists packages, else
  `package.json#workspaces`, through `boundary.ts` `workspaceDeclaration`,
  which the analyses read too (logged below). Every directory a package
  pattern matches is a unit; a directory two patterns match is recorded
  once. A workspace that declares no packages fails the scan with
  `Workspace <root> declares no packages. …`, checked once where the
  discovery is made (`requireDeclared`, in `generateSemantics` and
  `scanPackage`, which narrows it to `DeclaredDiscovery`); a history checkpoint from
  before the declaration existed is an empty snapshot. There is no
  configured override of the patterns, because the analyses build their
  program and ownership from the same patterns.
- Dataset schema 4, unpublished, keeps its number. The manifest's `roots`,
  `discovery.rootsScanned`, `discovery.rootsMissing`, and each package's
  `root` are gone; `discovery` gains `packagePatterns` (as declared),
  `declarationSource`, `packagePatternsUnmatched`, and `excludeUnmatched`.
  `unitsDiscovered` now counts every directory a package pattern matched
  (the former `directoriesInspected`, which is gone), and `packagesFound`
  the units that are packages. History's snapshot coverage changes the same
  way, and its policy drops `roots`.
- `configFingerprint({ exclude, profile })` is the one allow-list of
  configuration inputs, called the same way by the package-report
  fingerprint and by `historyFingerprint`. The declaration is covered by its
  files, which are hashed workspace inputs (`workspaceManifests`, which now
  includes `pnpm-workspace.yaml`).
- The `@foundry/workspaces` anchor is removed and `ANALYSIS_POLICY_VERSION`
  is 25 (logged below). A Foundry scan now finds `@foundry/docs` (`docs/` in
  its declaration), 15 packages in all, and no longer looks for `plugins/`.
- Tests: `test/lib/atlas-config.test.ts` (the loader),
  `test/lib/boundary.test.ts` (`workspacePatterns`, `normalizeWorkspacePath`,
  `findRepoRoot`), discovery and a pnpm
  twin of the fixture in `test/lib/semantics.test.ts`, the fingerprint in
  `test/lib/semantics-incremental.test.ts`, an empty checkpoint in
  `test/lib/semantics-history.test.ts`, a configured scan in
  `test/lib/scan.test.ts` (and `scan.package` on an undeclared workspace),
  a policy guard in `test/lib/config.test.ts`, and
  `test/package.test.ts` loads a fixture's configuration through the
  installed bin with an empty PATH.

**1.8 Commands.** Done 2026-10-10. The CLI as the library plus formatting.
- `cli/args.ts` holds the command table, shaped as Marbles' is: each
  command's usage, summary, the flags it takes (`flags: [...] as const`),
  and how it reads its positionals. `ArgsOf<C>` is the shared flags plus
  `Pick` of the command's own and its positionals; the parser and the help
  are generated from the table, and `reference/cli.md` and the README carry
  the help verbatim (`test/cli/args.test.ts` compares them). One strict
  `parseArgs` reads every option: an unknown flag is refused first, then
  `--help` wins, then a flag the command does not take is refused
  (`atlas serve does not take --history.`). **Behavior change:** flags no
  longer apply to every command, so `scan --no-open`, which the package
  test used to pass, is now a usage error.
- `cli/index.ts` holds the `RUN` table, one library call plus formatting
  per command, the output rules, the exit codes, and the signals. The
  default command is `open` inside the table and is not addressable as
  `atlas open`; a directory named like a command is written `./report`.
- Paths are `path...` in the parser, typed `readonly [string]`; a second
  path is refused until collections (phase 5): `atlas scan takes one
  workspace path. Reading several workspaces at once is not supported
  yet.`
- Output: stdout carries only results. `--json` prints `JSON.stringify` of
  the library's result on one line: `scan`'s `{ manifest, output,
  history? }`, the package report as saved, the export's `{ directory,
  manifest }`, the server's `{ root, url }`, and for the default command one
  line `{ ...scan, ...server }` once the server listens. `--quiet` silences
  progress only; the browser warning stays on stderr. `Output saved to` is
  `Dataset saved to`, after the glossary's dataset and output.
- Exit codes `0`, `1` (ran and failed), `2` (usage, with `Run atlas --help
  for usage.`). `check` (3.3) will exit `3` on a violation; this differs
  from Marbles, whose usage errors exit `1`, and from ESLint.
- `atlas report <package> [path...]` reads the saved dataset only, through
  `lib/dataset-files.ts` `savedDataset(root, state?)`, which `serve` now
  uses too (one check, its message unchanged: `No dataset found for <root>
  in <output>.`; `DatasetNotFoundError` takes an optional message, so the
  viewer's stays as it was). An unknown package's message lists the
  dataset's packages, in the reader. The render context is resolved in the
  CLI: `terminal` on a TTY else `text`, the terminal's width else 80,
  colour unless `NO_COLOR`, Unicode always. `RenderFormat` and the lists of
  formats and densities are exported from `render/context.ts`.
- `atlas export <dir> [path...]` writes a static viewer through
  `lib/export.ts` `exportViewer(root, directory, { state? })`, internal:
  the viewer (`viewerRoot`), then the saved dataset, then the guards, then
  the state lock for the copy, so no scan, history included, writes
  mid-copy. A never-scanned workspace fails before any lock or state
  directory exists. Every static viewer carries `.atlas-static-viewer.json`,
  listing the top-level entries Atlas wrote. The target must be absent,
  empty (ignoring `.DS_Store`), or a previous static viewer holding nothing
  outside its marker's list, so a `.git`, a `CNAME`, or any file of the
  user's is never deleted; a symbolic link or a file is refused, and so is
  a target that holds the workspace or overlaps the state directory or the
  viewer. The static viewer is staged in a sibling, `<dir>.export-<uuid>`
  (which also keeps `cp` from copying into its own source), the previous
  one moved aside and the new one swapped in, then the old one removed; a
  failure puts the previous static viewer back and reports the first error,
  and a crash can leave a sibling (`docs/public/.gitignore` covers the
  docs example's). The returned manifest is read from the copy. There is no
  `--force`. The lock's messages say "scanned or exported". `resolveRoot`
  now says `Workspace path does not exist: <path>`.
- `docs/scripts/build-example.ts` runs `atlas scan <root> --quiet`, then
  `atlas export <example> <root>`; reruns replace the example, and it no
  longer derives the state layout.
- The viewer fixes had landed in c205640: the caption is "The archipelago"
  and the world's class is `atlas-world atlas-panel-open`.
  `test/web/atlas-shell.test.ts` checks the two class tokens and
  `test/web/no-foundry.test.ts` that nothing under `src/web` but its notes
  names Foundry (principle 5).
- `scripts/dev.ts` reads its command line as `atlas serve`.

**1.9 Foundations for phase 2.** Done 2026-10-10. Shapes only; nothing is
built on them yet.
- `lib/domain-declaration.ts` holds `DomainDeclaration`
  (`{ name, facets?, domains?, reason?, weight? }`, written out, not
  inferred) and `domainsSchema`, a strict zod schema with a recursive
  getter. It is not a `*-types` file, since it holds zod code, so the
  browser override does not cover it. `AtlasConfig` gains `domains?`; the
  resolved `SemanticsConfig` carries `domains`, `[]` by default, and
  `configFingerprint` leaves it out. Nothing reads it yet.
- The rules, in [`_domains.md`](./_domains.md#how-a-workspace-declares-them):
  a name is the domain's id, `^[a-z][a-z0-9-]*$`, unique across the whole
  tree; a facet is a relative POSIX path, without surrounding whitespace,
  with an optional `#name` after a file, an identifier; `*`, `?`, and a
  leading `!` are reserved; a facet's path need not exist; a domain names at least one facet or nested domain; a facet is
  listed once per domain, and overlap across domains is allowed; nesting is
  membership; weight is 0 to 1, reported as written. `domains` follows
  1.7's one-file rule; splitting it across files can come later without
  breaking a configuration. `foundry.config.json#semantics` rejects it as
  an unknown key (`legacySchema`, the schema without `domains`).
- Before the schema walks the tree, a guard on the raw value refuses, by
  path, a domain that contains itself, one object listed twice, and nesting
  deeper than 64, since a configuration file is code and either would
  otherwise exhaust the stack. The worker wraps `parseConfigFile`, so any
  unexpected error while checking an export (a throwing getter) is still
  named `Configuration <file>: checking the default export threw: …`.
- Errors go through 1.7's formatter, `Configuration <file>:
  domains[0].facets[2] <issue>; got <value>`, and no message body holds
  the formatter's `; ` or a `. ` of its own. An issue marked
  `params: { wholeObject: true }` shows no `got`, so the empty-domain error
  reads `domains[0] declares no facets and no domains, so add a facet,
  whose path need not exist yet.`
- The lens contract is written down in [`_lenses.md`](./_lenses.md), with
  no code: 2.1 ships the type with its first lens. A lens reads a
  `LensReader` (the dataset reader without `history()` and `manifest()`)
  and the `LensSettings` it names.
- Tests: `test/lib/domain-declaration.test.ts` through `parseConfigFile`
  (every facet rule with its message and path, names, empty domains,
  duplicates, weights, reasons, unknown keys);
  `test/lib/atlas-config.test.ts` (domains read through the loader and a
  `_` helper, declared in two files, an invalid facet, the fallback
  rejecting them); `test/lib/semantics-incremental.test.ts` (changing only
  the domains reuses every package and derives nothing); and
  `test/lib/scan.test.ts` (an invalid domain fails a scan with a warm cache
  and leaves the saved dataset). The domains-only reuse test runs under the
  fixture's patterns and under a `*` pattern, beside a `collectWorkspaceInputs`
  test that `.foundry/` is never an input; both `*` tests fail without the
  filter. The domain tests cover a domain that contains itself, a shared
  object, 64 levels accepted and the 65th refused, and the worker's
  wrapper.
- `.foundry/` is never a workspace input. A `*` package pattern makes
  `cruiseWorkspace` start from every root directory, since `expandPattern`
  does not skip dot-directories, so `.foundry/atlas/*.ts` reached the
  sources fingerprint and a domains-only edit re-derived every package.
  `collectWorkspaceInputs` now leaves out every candidate under `.foundry/`
  (caching code; no analysis change). Only `.foundry/` is left out: a
  package may import from another dot-directory, such as `.storybook/`, and
  that file must keep invalidating. A workspace with no package patterns,
  the other case that globs the root, is refused by 1.7. Known analysis
  quirk, unchanged: under `*` the cruise still reads `.foundry/` modules,
  though they belong to no package and appear nowhere in the dataset
  (checked on a scanned `*` workspace).

**1.10 Exports and the installed package.** Done 2026-10-10.
- `package.json` has an `exports` map with `.` only, `types` first:
  `dist/lib/index.d.ts` and `dist/lib/index.js`. `src/lib/index.ts` names
  every export, with no `export *`, so `viewerRoot`, `DEFAULT_PORT`,
  `checkPort`, the reader, and the analyses stay internal. Values: `scan`
  (with `scan.workspace` and `scan.package`), `serve`,
  `DatasetNotFoundError`, `DatasetReplacedError`, `DATASET_SCHEMA_VERSION`,
  and `HISTORY_SCHEMA_VERSION`. Types: `Scan`, `WorkspaceScan`,
  `ScanOptions`, `ScanProgressEvent`, `PackageInternals`, `PackageReport`,
  `WorkspaceReport`, `AtlasServer`, `ServeOptions`, `DatasetManifest`,
  `HistoryManifest`, and `AtlasConfig`. `DomainDeclaration` is not
  exported; it is `NonNullable<AtlasConfig["domains"]>[number]`.
- Public names are the glossary's words, with an `Atlas` prefix only where
  the bare word would collide with a platform name (`Server`) or say
  nothing in a consumer's file (`Config`). `SemanticsManifest`,
  `SemanticsHistoryManifest`, and the two `SEMANTICS_*_SCHEMA_VERSION`
  constants are renamed at the source, since they are dataset and loading
  code; the other `Semantics*` types stay internal and are reached by
  indexed access, and editors show their internal names, as they show
  `SurfaceReport` for `PackageReport`. Both are documented on the library
  page. The constants' comments now say what the versions promise.
- The two public names from 1.4: `SemanticsPackageStatus` loses
  `"skipped"`, which nothing wrote (a skipped unit is
  `discovery.unitsSkipped`, not a package), so no schema version moves.
  The invalidation reason `"history-changed"` is `"evolution-changed"`, and
  the fingerprint component `history` is `evolution`, as the glossary says.
  The component name is hashed into every fingerprint, so
  `SEMANTICS_CACHE_SCHEMA_VERSION` goes to 3 and an old cache reads as a
  schema change rather than as changed evolution. Neither touches an
  analysis, so neither is in the changes table.
- `serve` rejects with a `DatasetNotFoundError` when nothing is saved (it
  goes through 1.8's `savedDataset`), so the exported class is what a
  caller catches. A schema mismatch stays a plain `Error` in 0.1.
- The build clears all of `dist`, so no file of an earlier layout is
  packed, then makes one Bun build with shared chunks: `src/cli/index.ts`
  is now `src/cli/atlas.ts`, and `atlas.js`, `index.js`,
  `semantics-worker.js`, `config-worker.js`, and `chunk-[hash].js` all go
  in `dist/lib`. Every file stays there, one directory under `dist`, so
  `workerEntry` finds the workers beside whichever chunk it was bundled
  into and `viewerRoot` finds `../web`. The CLI and the library share one
  copy of the code, so the error classes a consumer imports are the ones
  the accessors throw. tsup, declarations only, writes one
  `dist/lib/index.d.ts` (about 250 KB) that imports nothing:
  `ignoreDeprecations: "6.0"` for the `baseUrl` tsup injects, `paths` to
  `packages/lib/src` so no build of `@foundry/lib` is needed first, and
  `resolve` for `@foundry/*`. tsup is a devDependency at Marbles' range.
- `test/package.test.ts` installs once and runs flat tests: the bin (the
  layout is `dist/lib` and `dist/web` only, the exports map exactly, the
  declarations import nothing, and the private-import walk covers chunks
  and declarations); the library from a consumer script under Bun with an
  empty PATH (the six values exactly, `scan` and its accessors, a
  `DatasetReplacedError` after `scan.workspace` saves over it,
  `scan.package`, `serve` and `stop`, a `DatasetNotFoundError` from `serve`
  on an empty state root); a TypeScript consumer with `nodenext`, no
  ambient types, and no `skipLibCheck`, which imports every name, uses
  `satisfies AtlasConfig`, and is refused `viewerRoot`, `DEFAULT_PORT`,
  `internals` on a `WorkspaceScan`, and `scan.package` without a name;
  Node importing the package, where `serve` says it needs Bun; and, last,
  the missing viewer.
- `docs/atlas/reference/library.md` is the public page, beside the CLI
  page, linked from the introduction, the CLI and configuration pages, and
  the README. The glossary gains **History manifest** and the
  `AtlasConfig` spelling.

**Phase 1 is done.** The library and the CLI work over unchanged
analyses, the installed-package test covers every export and the binary,
and the "Before the first publish" list in [`_roadmap.md`](./_roadmap.md)
holds only the release tooling item, which belongs to the release scripts,
not to Atlas. Checked in 1.10: the caption and the `@foundry/workspaces`
anchor are gone, `semantics.output` is gone, `history.strategy` is
validated, `pnpm-workspace.yaml` is read, and the `atlas-world` class keeps
its space when a panel is open.

## Phase 2: lenses and domains

Detail in [`_lenses.md`](./_lenses.md), [`_domains.md`](./_domains.md),
and [`_viewer.md`](./_viewer.md).

**2.0 Decide when lenses run.** Decided 2026-10-10: at scan time, written
into the dataset, so that the viewer and third parties read them and nobody
recomputes, in keeping with the dataset as the product. The settings
lenses read (`LensSettings`, such as domains) never enter
`configFingerprint`, so an edit to them alone reuses every package's
results; every lens output is recomputed on every scan
until a per-setting digest has a consumer. 2.6 found none; the earliest is
a rule written in terms of domains (3.1). See
[`_lenses.md`](./_lenses.md#in-the-dataset).

**2.1 The lens layer.** Done 2026-10-10. The contract of
[`_lenses.md`](./_lenses.md), built, with one lens that is computed,
versioned, published, and renderable (printed under test; `atlas lens` in 2.7).
- `lib/lenses/lens-types.ts`, a browser-safe leaf, holds the contract
  (`Lens<I, Source, K>`, whose `id: I` ties `derive`'s result to
  `LensOutputs[I]`; `LensReader`; `LensSettings`), the `LensOutputs` map
  whose keys are `LensId`, `LENS_SCHEMA_VERSIONS`, the manifest entry
  `{ file, schemaVersion }`, and `lensEntries()`, built from the schema
  versions and `lensFile`, so the manifest builder does not import the
  runner. Each lens keeps its output type and schema version in its own
  `lib/lenses/<id>-types.ts`; the Biome browser override covers
  `lib/lenses/*-types.ts`.
- `lib/lenses/run.ts` holds `LENSES: readonly AnyLens[]`, every lens in
  dependency order (no `register`), and `writeLenses({ dir, draft,
  settings, write })`, the lens phase. Its reader is private: the manifest
  path answers the draft manifest and every other path reads the
  unpublished tree, each file parsed once for the phase and shared by every
  lens, except that a miss under `lenses/` is never kept. `LensReader` is
  the reader without `history()` and `manifest()`, plus `packages()` (id,
  status, and whether the dataset holds the package's internals) and
  `lens(id)`. Each lens gets its own reader, whose `lens(id)` allows only
  the lenses its `consumes` names, once they have run, and otherwise fails
  with `The <lens> lens reads the <id> lens without naming it in consumes,
  or before the <id> lens runs.` Settings are carried (`{ domains: config.domains }`);
  a lens sees only those it names, and none does yet.
- The first lens is `package-sizes` (`lib/lenses/package-sizes.ts`): each
  package's place in the dependency graph joined to its file count by
  kind, by manifest id and sorted with the projections' `byId`. Its size is
  the file count from the module index, by kind and in total; `analyzed`
  and `layer` are taken from the graph only so that the codex can drop its
  own join. It retires that join: `readCodexSource` reads the lens through
  `reader.lens("package-sizes")`, `resolveCodex` no longer counts modules
  or sorts packages, and it names each package without its scope, as it
  already named former packages. It is 2.1's trivial lens, not the shape
  effort the note below says is not needed. It reads no internals, so it
  carries no `missing` list; a lens that reads internals reports the
  packages without them as `missing` instead of failing.
- `generateSemantics` runs the `lenses` phase after `write`, internals
  included, and before the manifest is written: one call,
  `writeLenses({ dir: tmp, draft, settings, write })`. Every lens runs on
  every scan, and an output whose bytes are unchanged keeps its inode
  through the `Writer`. A lens that throws fails the scan and the tmp tree
  is removed; dry runs and history snapshots run no lenses.
- First, as its own change: the manifest builder is
  `lib/dataset-manifest.ts` `datasetManifest(input)`, pure, with one input
  object instead of 23 positional parameters, and objects rather than
  counts. The draft the lenses read and the published manifest are the
  same call, apart from `finishedAt` and the files and phases written in
  between. `totalDurationMs` is now `finishedAt − startedAt`, and
  `versions.packageSchema` is the named `SURFACE_REPORT_SCHEMA_VERSION`
  (`SurfaceReport["schemaVersion"]`, 35) instead of the first report's.
- `SemanticStage` gains `` `lens:${LensId}` ``. `lens:package-sizes`
  depends on `materialization`, which is now documented as the dataset
  before its lenses. Outputs are not reused by fingerprint (none is
  recorded) until a per-setting digest has a consumer.
- The manifest gains `lenses` (`{ [id]: { file, schemaVersion } }`). A
  schema 4 dataset saved before 2.1 has no such key; the reader gives it
  an empty map, so the type holds and the viewer asks for a scan. The
  reader's `lens(id)` reads the manifest plus one file and refuses a
  missing entry ("The dataset has no <id> lens. Run atlas scan again.") or
  another schema version ("Atlas reads <id> lens schema version N; this
  dataset's <id> lens has version M. Run atlas scan to save it again."), so
  a lens bump never needs a dataset schema bump. Dataset schema 4 keeps its
  number.
- `lib/render/index.ts` renders through one private `renderView`, which
  takes the view as a function of the density so that the context is
  resolved once; `renderSurface` uses it, and `renderLens(id, output,
  options)` renders a lens through `LENS_VIEWS` (`lib/render/reports/lenses.ts`,
  one view per `LensId`).
- Rejected: lenses over in-memory values (what third parties read would be
  a different thing from what the lens read); running after the publish and
  publishing again (two swaps, and a reader could see a dataset without
  its lenses); writing the manifest first (it would name the lens files
  before they exist, and the generation fields would need rewriting).
- Tests: `test/lib/lenses.test.ts` (the lens on literal values; the
  registry against the reader's and the stage graph's versions and the
  consumes order; the phase: the draft, `packages()`, one parse per file,
  a lens reading a lens it consumes, refusals for an undeclared read and a
  read before the lens runs, settings picked, a throw);
  `test/lib/dataset.test.ts` (`lens(id)`, and a manifest without
  `lenses`); `test/web/codex/source.test.ts` (the viewer over such a
  dataset); `test/lib/semantics.test.ts` (the manifest entry and the
  fixture's file, by hand); the inode tests in
  `test/lib/semantics-incremental.test.ts`, including a domains-only edit
  that keeps the lens file; `test/lib/render-lens.test.ts`; the codex tests;
  and `listedFiles`, so the "every file is listed" checks cover `lenses/`.
  The phase lists in `semantics.test.ts`, `scan.test.ts`, and
  `test/atlas.test.ts` gain `lenses`. The fixture dataset compares
  equivalent to the one before, apart from `lenses/package-sizes.json` and
  `manifest.lenses`; the `lenses` phase is in the generation metadata the
  comparison ignores.

**2.2 The viewer's duplicates, one lens each.** For each, the meaning is
defined once, in `lib`, the viewer reads it, and the viewer's own
computation is deleted. Decided 2026-10-10: where the viewer and `lib`
measure one thing with different thresholds, `lib`'s definition wins (ground
rule 1); where the viewer measures something `lib` does not, the measure
moves into a lens under its own name. Five sub-efforts, one commit each, in
this order, which is deliberate (2.2e comes before 2.2d):
- **2.2a `file-roles`**, which also carries high fan-in: file roles
  (`web/district-layout.ts` `classifyFiles`) and the summits and landmarks
  against `highFan`. The landmarks were planned as their own 2.2c; they are
  folded into 2.2a, so there is no 2.2c. Done; below.
- **2.2b `responsibility-groups`**: composite districts (`web/hierarchy.ts`)
  as a lens.
- **2.2e `frequent-change`**: change craters against hotspots. It reads
  the hotspot commit gate from `ANALYSIS_CONFIG`, which is the built-in
  analysis policy, not the workspace's Configuration; the rule is in
  [`_lenses.md`](./_lenses.md#rules). Done; below.
- **2.2d Retire neighborhoods**: responsibility regions are the grouping;
  the viewer's neighborhoods (`web/neighborhoods.ts`, `relationships.ts`)
  go. They do not place files, so no layout helper stays. Done; below.
- **2.2f Pair traffic**: no lens. The dependency graph projection carries
  each pair's count, so the viewer's re-aggregations go; the endpoint files
  are one join in the codex. Done; below.

**2.2 is done** (2026-10-10). The viewer computes nothing the analysis
defines: every meaning it drew from its own counting is now `lib`'s, through
a lens or the projection, except the per-module import counts, which equal
`gravity.fanIn` and `fanOut` (pinned in `test/lib/semantics.test.ts`) and
are kept so that the codex reads no module shard (resolved in 4.4b: the
module index carries them, and the recount is gone); and the `_review.md`
finding that the viewer recomputes the analysis is resolved (the review
itself is a dated snapshot, left as it was).
- 2.2a `file-roles`: file roles unchanged (1,517 of 1,517 Foundry files
  agree); summits and landmarks follow the topology's high fan-in, 62 to 78
  on Foundry (38 kept, 24 gone, 40 new); relief needs the package's
  internals.
- 2.2b `responsibility-groups`: districts unchanged; 6 of 29 anchors move
  to the anchor responsibility's file with the highest internal fan-in.
- 2.2e `frequent-change`: craters follow the hotspot commit gate, 289 to 79
  change-marked files on Foundry; the viewer reads no package report.
- 2.2d: neighborhoods retired; responsibilities are the only grouping, shown
  once an island is entered; the codex reads no module shard, 4.16 MB to
  1.65 MB at load on Foundry.
- 2.2f: no visible change; four re-aggregations of every file edge are gone.
- Cost: four lenses at scan time, about 200 ms in the lens phase on
  Foundry; reading package reports for `frequent-change` raises a scan's
  peak memory by 0.6–0.8 GB, accepted for 0.1.

**2.2a `file-roles`.** Done 2026-10-10.
- `lib/lenses/file-roles.ts`: for every package whose internals the dataset
  holds, every module of its topology with its file role (`junction`,
  `mixed`, `commons`, `unknown`, first match wins, exactly
  `classifyFiles`' order), its `fanIn`, and `highFanIn`, beside the
  package's `highFanInCutoff`; and `missing`. Nothing is measured again:
  fan-in, the `high-fan-in` role, and the cutoff are what the topology saved
  (`topology.modules[].fanIn`, `topology.roles`,
  `summary.highFanCutoff.fanIn`), so a package whose saved cutoff is 0 has
  no high fan-in module. Role and high fan-in are separate fields.
- `lib/lenses/package-internals.ts`, browser-safe, is the one join:
  `readPackageInternals(reader)` gives the packages with internals, with
  their roots, and `missing` (complete packages without internals; a
  failed package is in neither), and `rootRelative(root, module)` joins a
  module id to its root, adding nothing for `""` or `"."`. The lens and
  `web/internals.ts` `bindInternals` both use it. That fixes the viewer's
  join for a package at the workspace root: `bindInternals` joined with
  `filter(Boolean).join("/")`, which made `./src/a.ts` of a root `.` and
  matched no file. The Biome browser override names the file.
- The codex reads the lens once, at load: each module's `internalFanIn`
  and `highFanIn` (always set, 0 and false without internals), and each
  package's `highFanInCutoff` (0 when it has no cutoff, as without
  internals) and `fileRoles`, the lens's entry (`undefined` without
  internals). Fan-in is needed at load because relief is drawn for every
  island at overview (`scene/relief-layer.ts` builds every island's terrain
  once, `scene/terrain.ts`), not only in a dive.
- Roles are bound on entering an island, from that load-time entry:
  `loadInternals(packageId, territory.fileRoles, pin, …)` passes it to
  `bindInternals`, which keeps `fileRoles` by file id, and the lens is not
  read again. The dive's internals are read under the pin of the dataset
  the map loaded, so they and the entry come from one scan. Landmarks and
  drainage read the roles from `NaturalEvidence.fileRoles`; only the
  district arrangement attaches them to files (`AtlasFile.fileRole`, which
  was `architectureKind`) for its role marks, so the overview, and belonging
  regions, carry none. `classifyFiles` and `prominentFile` are deleted.
- One measure for the whole summit: membership is `highFanIn`, and
  `summitHeight` and `landmarkRadius` take internal fan-in against the
  package's cutoff (`1.8 × log₂((1 + internalFanIn) / cutoff)`, and
  `min(6, 2 + 0.8 × √(5 × internalFanIn / cutoff))`, so a module at its
  cutoff gets `2 + 0.8√5`), with one guard for a package without a cutoff.
  `Landmark.role` is `Landmark.basis`, and `dependents` is `high-fan-in`,
  labeled "High fan-in". Every high fan-in file's text, in a landmark or
  in Place, leads with its internal fan-in and its package's cutoff, then
  gives its import edges as the different, workspace-wide count ("N import
  edges reach it from across the workspace").
- The codex still counts each module's `dependents` and `dependencies`
  from the edge shards; they equal the module record's `gravity.fanIn` and
  `fanOut` on every module of the fixture (pinned in
  `test/lib/semantics.test.ts`) and of Foundry (1,517 of 1,517).
- Decided: the landmarks follow `lib`'s high fan-in. What the map shows
  now, measured on Foundry at this commit (15 packages, 1,517 files):
  - Roles are unchanged: the lens and `classifyFiles` agree on every file
    (1,517 compared; 33 junction, 94 mixed, 29 commons, 79 unknown), and on
    the semantics fixture (7 files).
  - Summits went from 62 to 78: 38 stay, 24 go, 40 appear.
  - Gone: files imported mostly from other packages or from tests. Entry
    points and barrels (`packages/artifacts/src/index.ts`, 45 incoming and
    fan-in 2; `packages/agents/src/harness/index.ts` and `session/index.ts`;
    `packages/workspaces/src/node/index.ts`; `packages/lib/src/digest.ts`),
    test helpers (`apps/marbles/test/helpers/*`,
    `apps/works/test/helpers/*`), and modules below their package's cutoff
    (`packages/workflows/src/step.ts`, 55 incoming and fan-in 10 against a
    cutoff of 11).
  - New: modules many source files of their own package import, whatever
    other packages do: types and error modules (`packages/sandbox/src/types.ts`
    and `errors.ts`, `packages/agents/src/harness/types.ts`), and most of all
    `apps/marbles` (10 to 16) and `apps/works` (3 to 7). There the old count
    missed them: `apps/marbles/src/components/ui/theme.ts` has 4 incoming
    edges in the edge shards but a topology fan-in of 32, and
    `apps/works/src/app/lib/cn.ts` has 0 against 16. The two `lib` measures
    disagree on these modules, apparently on path-alias imports; that is
    left as it is.
  - `@foundry/core`, `release`, and `website` have a cutoff of 3 and no
    high fan-in module; `@foundry/docs` has a cutoff of 0.
  - A package saved without internals (`scan.workspace`, or a failed
    package) raises no summit. Selecting it says why: belonging fails with
    the reader's "saved without internals" message. Saying it at overview is
    left to phase 4.
- Cost, on the same Foundry scan (cold, 43.6 s): the `lenses` phase took
  66 ms for both lenses. In isolation (`writeLenses` over the saved
  dataset, three runs) it takes 57 ms and raises RSS by about 200 MB, from
  38 MB to 231 MB, of which about 30 MB is live heap afterwards: it parses
  all 15 internals files, 36 MB of JSON, and keeps them in the phase-long
  `parsed` cache. Releasing a file after its last reader is a later loader
  change. `lenses/file-roles.json` is 133 KB.
- Tests: `test/lib/lenses.test.ts` (`rootRelative`; role order on literal
  evidence: junction over mixed, mixed over commons, commons over unknown,
  `unknown` only with symbols; a module the topology does not list; the
  high fan-in role, fan-in, and cutoff copied, sorted, an empty-root join;
  a saved cutoff of 0; `missing` and a failed package through the phase);
  the registry; `test/lib/render-lens.test.ts` (with no high fan-in
  section when there is none); `test/lib/semantics.test.ts` (a scan
  without internals lists every package missing; the gravity parity);
  `test/atlas.test.ts` (the fixture's lens output by hand, the entry the
  map keeps from load, and the roles a dive binds from it);
  `test/web/internals.test.ts` (`bindInternals` and `withFileRoles`);
  `test/web/landmarks.test.ts` (high fan-in only where the topology says
  so, and a commons file that is also high fan-in); the codex, terrain,
  bindings, natural-feature, topography, and load tests. The reference
  internals helper binds the roles the lens derives for its package.

**2.2b `responsibility-groups`.** Done 2026-10-10.
- `lib/lenses/responsibility-groups.ts`: for every package whose internals
  the dataset holds, by manifest id, the viewer's greedy modularity merge
  over `responsibilities.relationships`, moved unchanged from
  `web/hierarchy.ts` `deriveHierarchy` as `groupResponsibilities`, with its
  weight `districtAffinity`, now `responsibilityAffinity`
  (`log1p(moduleEdges) + log1p(symbolFlow)`). Only names changed: the
  generated helpers are `mergeWhileGaining` and `bestJoin`, and `bestJoin`
  takes four parameters instead of six and returns only the pair, since
  the initial best and the `1e-12` floor it was always called with are now
  its own. Each group has
  the viewer's `label`, `anchor`, and `anchorWeight`, its members as
  `responsibilities`, and `anchorModule`: the anchor's module with the
  highest internal fan-in from the topology, ties by id, root-relative
  through the 2.2a helper. Its `id` is `responsibility-group:` and the first
  12 hex digits of the SHA-256 of the sorted member ids, one per line, as a
  responsibility's id is made. Both were renamed before the v1 schema was
  relied on: the viewer's `composite:${JSON.stringify(ids)}` id and its
  `regions` field. The viewer reads the new names; its selection state
  keeps the name `compositeId`, the viewer's word for a drawn district,
  and now holds a `responsibility-group:` id.
  `independent` and `missing` as in 2.2a. A "responsibility group" is the
  lens's word; "district" stays the viewer's word for drawing one.
- Tests never anchor: a responsibility's modules are primary (source)
  modules only, so a test file is never in one, and it was not under the
  viewer's rule either.
- The overview draws no districts, so the lens is read the way 2.2a reads
  `file-roles`: the codex keeps each package's entry from load
  (`Territory.responsibilityGroups`, `undefined` without internals), and
  `use-belonging.ts` draws it on entering the island under the same pin.
  `compositeRegions` keeps only presentation: contours, pigment, each
  anchor's mark (the member file at `anchorModule`), and the collections,
  of which "Unresolved belonging" stays the viewer's. `web/hierarchy.ts`,
  its test, and `districtAffinity` with its codex README rows are deleted.
- Equal to `deriveHierarchy`, checked before it was deleted, on every
  package of a Foundry scan (15 packages, 29 groups, 124 responsibilities
  in groups) and of the semantics fixture (3 packages, 1 group): 0
  differences in groups, labels, anchors, weights, or `independent`.
- Visible change: the groupings are identical. The anchor mark moves where
  the anchor responsibility's file with the most incoming import edges is
  not its file with the highest internal fan-in: 6 of Foundry's 29 groups.
  - `@foundry/agents` SessionMessage: `session/store.ts` (31 incoming,
    fan-in 10) to `session/types.ts` (24, 17).
  - `@foundry/atlas` src/lib: `serve.ts` (8, 5) to `dataset-files.ts`
    (7, 5), a fan-in tie broken by id.
  - `@foundry/marbles` src/components/ui: `ui/log.tsx` (1, 1) to
    `ui/panel.tsx` (0, 6).
  - `@foundry/sandbox` SandboxExecResult: `container/store.ts` (25, 2) to
    `types.ts` (18, 12).
  - `@foundry/works` src/app/components/input.tsx:
    `pages/settings/credential-field.tsx` (1, 1) to
    `components/input.tsx` (0, 3).
  - `@foundry/works` src/app/theme: `theme/theme-selector.tsx` (0, 1) to
    `theme/theme.tsx` (0, 3).
- Cost, on the 2.2a Foundry dataset: `lenses/responsibility-groups.json`
  is 15 KB. The lens phase, now three lenses over internals parsed once,
  takes 59 ms (57 ms before) and raises RSS by about 210 MB (200 MB before).
- Tests: `test/lib/lenses.test.ts` (`hierarchy.test.ts`'s cases moved
  unchanged: the weak bridge, empty input and independents, the anchor and
  its weight `4 · log1p(20)`, determinism and coverage; the affinity;
  `anchorModule` on the higher fan-in even when it sorts later by id, and
  a fan-in tie broken by id; packages keyed and sorted by manifest id, and
  the hashed group id; `missing` through the phase; the registry);
  `test/lib/render-lens.test.ts`; `test/lib/semantics.test.ts` (both
  internals lenses list every package missing in a scan without them);
  `test/atlas.test.ts` (the fixture's groups by hand, and the entry the map
  keeps from load); `test/web/belonging.test.ts` (lens groups; the anchor
  at `anchorModule`, the anchor responsibility's second file by id, and
  none without one); the codex tests.

**2.2e `frequent-change`.** Done 2026-10-10.
- Craters keep their meaning, "changes often", under `lib`'s definition of
  it. Hotspots also require complexity, a different concept; the term
  frequent change is already `lib`'s, the `frequent-change` signal that
  `hotspots.ts` gives every hotspot.
- `lib/lenses/frequent-change.ts` applies exactly the hotspots' commit gate
  from `ANALYSIS_CONFIG.hotspots`: a file of an `eligibleKinds` kind
  (`source`) with `rank.commitPercentile` at or above
  `gates.minCommitPercentile` (0.9), with no commit floor, over each
  complete package's report churn. Nothing is extracted from `hotspots.ts`,
  which stays as it is. Output: the `gate` it applied, so the viewer's copy
  reads it rather than keeping a copy; per package by manifest id, its
  `history` (`analyzedAt`, `historyComplete`, `since`), each package's own
  since a reused report can be older, and its files (workspace-relative
  path, commits, lines changed, commit percentile), sorted; and `missing`,
  the complete packages whose churn is unavailable (no Git, or not
  collected), so that no history never reads as no frequent change.
- Hotspots attach the `frequent-change` signal only to files that also pass
  the complexity gate (`signalsOf` runs for qualifying files only), so the
  signal names a subset of the lens's files. The lens is pinned to the gate
  itself (0.9 in, 0.897 out, other kinds out, no floor), and a hotspots
  test pins the subset: every hotspot carries the signal and is in the
  lens, and a frequently changed simple file is in the lens but is no
  hotspot. On Foundry all 31 hotspots are in the lens's 79 files.
- Churn paths are workspace-relative when the workspace sits inside a
  larger repository: `git log --relative` and `git ls-files` run in the
  workspace root (`lib/git-history.ts`), pinned in `test/lib/churn.test.ts`.
  The same test shows that the percentile's population is then the
  workspace's own tracked files, not the whole repository's, so the lens's
  docs and the viewer's copy say "workspace files of the same kind". The
  analysis types (`lib/types.ts` `FileChurn.rank`) still say "repository
  file", left as they are: analysis code.
- The viewer: craters and volcanoes mark the files the lens names, and the
  lens carries everything Place shows, so the viewer reads no package
  report: `load-internals.ts`'s report read, `AtlasInternals.churn`, and
  `NaturalEvidence.churn` are gone, and `NaturalEvidence.recordedChange`
  with them. Craters were only ever drawn on entering an island with
  Recorded change on, so the lens is read on that toggle path; it is not
  kept from load. The island binds one field, `frequentChange`: the
  package's files, gate, and history (`PackageFrequentChange`, in
  `web/internals.ts`, since only the viewer assembles it), or why there are
  none, `no-history` or `not-saved`. `Landmark.change` is the lens's file
  with the package's history and the gate. `changeCrater` and its codex
  README row are deleted. The change note (`natural-features.ts`) and the
  landmark text (`natural-feature-inspection.ts`) state the gate from the
  lens (`frequentChangeRule`, `percentileOrdinal`, which also fixes the
  former "92th"); the map key states no numbers and is unchanged; DESIGN.md
  describes the gate without its values. A package without history says
  recorded change is unavailable; a dataset saved before the lens says to
  run atlas scan again to include it.
- Visible change, Foundry at this commit: change-marked files on the map go
  from 289 to 79. The former rule (at least 3 commits, the 80th percentile,
  every kind) marked 129 test files, 2 config files, and 79 source files
  below the 90th percentile that no longer show. By package: marbles 114 to
  43, atlas 68 to 16, workflows 37 to 6, agents 25 to 4, models 19 to 4,
  workspaces 18 to 6, lib 4 to 0, docs 2 to 0, release and works 1 to 0.
- Cost: `lenses/frequent-change.json` is 12 KB. The lens reads every
  complete package's report, 79 MB of JSON on Foundry (`@foundry/atlas`'s
  alone is 38 MB). It reads them one at a time and keeps only the churn
  fields, and the lens reader serves package reports uncached (a second
  `datasetReader` over the uncached transport, for `packageReport` only),
  while every other file stays parsed once for the phase. Measured over the
  saved dataset, two or three runs each: the phase takes 191–212 ms (59 ms before
  the lens) and peaks at 470–530 MB RSS, against about 615 MB with the
  reports cached; the lens alone peaks at about 320 MB, set by parsing the
  atlas report. The heap still held after the phase, after a forced
  collection, is 18–165 MB, too noisy to compare. In full Foundry scans the
  phase takes 212–236 ms. The scan's peak memory footprint is where the
  lens costs most: warm scans peak at 2.10–2.28 GB with it and 1.48 GB
  without it (the same build with the lens left out of `LENSES`; 1.31 GB
  cold), so parsing the reports inside a scan that already holds the
  analysis adds about 0.6–0.8 GB. The earlier figure of 1.47 GB was a
  single cold scan and did not show it. A churn file of its own in the
  dataset, which the lens would read instead of the reports, would remove
  most of it; that is a dataset change, and 2.3, which also reads package
  reports, follows the same one-at-a-time rule meanwhile. Decided
  (orchestrator): accepted for 0.1, since the scan's overall high point is
  the derivation worker's (about 10 GB in 3.0's measurement), not this
  process's; the churn file waits until a measurement shows a need.
- Tests: `test/lib/lenses.test.ts` (the gate, no floor, kinds, `missing`,
  history and lines changed carried; reports read one at a time with only
  the churn fields kept and the gate read from `ANALYSIS_CONFIG`; a package
  report read afresh each time while other files stay shared; the phase
  with a package report each way; the registry);
  `test/lib/hotspots.test.ts` (the subset); `test/lib/churn.test.ts` (the
  nested repository); `test/lib/render-lens.test.ts`;
  `test/lib/semantics.test.ts` (a scan outside Git lists every package
  missing); `test/web/landmarks.test.ts` (change from the lens entry
  alone, both unavailable reasons), `natural-features.test.ts` (the note
  for each case, the ordinals), and `load-churn.test.ts` (the lens read
  only with Recorded change and never the package report; `no-history`;
  `not-saved`).

**2.2d Retire neighborhoods.** Done 2026-10-10. No lens: responsibilities
are the grouping, and the viewer's own neighborhoods are gone.
- Deleted: `web/neighborhoods.ts`, `web/relationships.ts`, and their test;
  `neighborhoodAffinity` with its test and codex README rows;
  `Territory.neighborhoods`; `AtlasSelection.neighborhoodId` and
  `MapLabel.neighborhoodId`; `paintLabelsPN`, the Georgia labels a
  selected island showed before it was entered; the scene's
  `selectedNeighborhood`, which dimmed the other files, filtered file
  labels, and framed the camera on a neighborhood (`scene.ts` `focus` and
  `focusEntries`, `paint-map.ts` `paintMapP`, `paintMapPF`, and
  `paintLabelsPF`); `selectionGroup` in `use-atlas-state.ts`, and with it
  `territoryLayoutRef`, which only `selectionGroup` read; the
  `neighborhoodId` fallback in `atlas-place.tsx`; and `districtLayout`'s
  override that copied responsibilities into `Territory.neighborhoods`. The
  panels' select filters' CSS class `atlas-neighborhood-filter`, which
  styled no neighborhood, is `atlas-select-filter`. `paintMap` loses its
  seventh positional parameter, and `focus` its third: it is now
  `focus(territory, file, fileIds)`.
- Selection by group is selection by responsibility: `regionId` and
  `compositeId`, which belonging already carried, and framing by a
  responsibility's files through `frameDistrict` and `frameSelection`. A
  selection made before an island is entered has no group: selecting a file
  there frames the file alone, without dimming or filtering by any group,
  until the island's responsibilities load. An island saved without
  internals has no grouping inside at all.
- The codex reads no module shard: `CodexSource.participation`, the codex's
  only read of the module shards, and `CodexModule.concepts`, its only use,
  are deleted, with `readCodexSource`'s `moduleShards()` call. That lands
  4.4's module-shard item here. A load test pins the files read at load:
  the manifest, the module index, the edge shards, the graph projection, the
  three lenses the codex reads, and history's manifest; no module shard.
- Visible change: a selected island shows no group labels until it is
  entered and its responsibilities load, and then only responsibility and
  district names; a file selected before then is framed alone; framing by
  group is framing by responsibility. In the Files map layer, which draws
  no Belonging regions, a selected island now shows no grouping at any
  zoom. With "Group files by responsibility" on, selecting a file no longer
  dims the files outside its responsibility or limits file labels to it;
  the Belonging layer's exact-member squares and its pinned-region label
  filter cover part of that, and nothing dims. This is documented, not
  ported: porting it would bring back the coupling between file selection
  and a grouping that this effort removed. Copy that described
  neighborhoods is rewritten (DESIGN.md, the chart settings' layer note,
  which also described the retired relief rule).
- Load, Foundry at this commit: the codex read 35 files and 4.16 MB at load
  and now reads 20 files and 1.65 MB; the 15 module shards were 2.50 MB.
  The edge shards (1.15 MB), the module index, the graph, and the lenses
  remain.
- Tests: `test/web/neighborhoods.test.ts` deleted; `paint-map.test.ts`
  (an unentered island shows only its own name; responsibility labels with
  a belonging layer); `codex/source.test.ts` (no module shard at load);
  `codex/resolve.test.ts`, `codex/bindings.test.ts`, and
  `internals.test.ts` lose the neighborhood cases; about 20 fixtures lose
  `neighborhoods: []`. `atlas-state.test.ts` had no neighborhood-selection
  case to move.

**2.2f Pair traffic.** Done 2026-10-10. No lens: the dependency graph
projection carries each pair's count.
- Characterized first, before any change: `scene/current-field.ts`
  counted each ordered pair's cross-package file edges, and those counts
  equal `routes[].weight`, the projection's `dependency.moduleEdges`, on
  every pair of the captured `test/fixtures/atlas.json` (65 pairs), of a
  Foundry scan at this commit (29 pairs), and of the scanned semantics
  fixture (2 pairs, one of them carrying a test file's import). No
  difference, so nothing is lost: type-only and test edges count the same
  on both sides, and no route has weight 0. The fixture's equality is
  pinned in `test/web/current-field.test.ts`; since 4.1a deleted the
  current, the same test, unchanged, is in `test/web/codex/resolve.test.ts`.
- `scene/current-field.ts` reads `data.routes`' weights instead of counting
  `fileEdges`.
- The codex joins each dependency to its endpoint files once:
  `pairEndpoints(imports, packageOf)` in `codex/resolve.ts`, one pass over
  the edges, gives each ordered pair its `consumerFiles` and
  `supplierFiles`, sorted; `CodexDependency` and `AtlasRoute` carry them.
  `trade-routes.ts`, `roads.ts`, and `ui/trade-partners.tsx` read them
  instead of filtering every file edge per pair. No `scope` was needed: an
  edge whose ends are in two packages is cross-package by definition.
  `fileEdges` stays for `scene/exploration.ts` `fileConnections` and the
  selection lines in `paint-map.ts`, which follow one file's imports.
- The captured reference atlas predates the endpoint lists; its test helper
  (`test/helpers/reference-atlas.ts`) attaches them through
  `pairEndpoints`, the codex's own join, so the capture stays unmodified.
- Visible change: none. The roads test pins that each road's endpoint
  files are those the old per-pair filter found on the reference atlas.
- Tests: `test/web/current-field.test.ts` (the characterization, in
  `test/web/codex/resolve.test.ts` since 4.1a; the current from route
  weights, deleted with the current in 4.1a); `test/lib/semantics.test.ts` (on a live
  scan, each pair's strength equals the import edges between its endpoint
  files, and both lists are non-empty); `codex/resolve.test.ts` (the join: deduped,
  sorted, both directions, intra-package and unknown files out; the
  codex's dependencies carry it); `roads.test.ts` (endpoints as before);
  `trade-routes.test.ts` (endpoints from the route, and the package-level
  fallback when a route has none); route fixtures in the landmass,
  selection-ink, atmosphere, paint-map, and trade-layer tests gain empty
  endpoint lists.

**2.3 Placement: where it lives against where it is used.** Done
2026-10-10. The motivating case, labelled before any domain exists.
- `lib/lenses/placement.ts` labels every exported symbol declared in a
  source file, every source file, folder, and package of each package with
  internals, from its consumer modules. A symbol its module does not export
  is neither a row nor a count, since nothing outside its module can use
  it. A consumer module is a source file (by the module index's kind)
  outside the place that uses it. At home it is a consumer in the topology's
  `consumedSurface`, so it imports the symbol on a primary edge, type-only
  imports included. Away it is a `consumerModuleUsage` entry with
  `references > 0`. On Foundry, every entry with no reference is a barrel
  that only re-exports, which matches the topology's rule that forwarding
  is not consuming (`internal-topology.ts:544`). A file's or folder's
  consumers are the union over the symbols declared in it, less the
  modules inside it. A package has no home, since its own modules are
  inside it, so a package is labelled from its away consumers alone and
  never fits. Two declarations sharing an id are one place.
- Labels, with `PLACEMENT_POLICY.dominantShare` 0.6, which the lens owns
  and saves in `policy`. The value is symbol locality's, also over
  consumer modules, but it is not read from `ANALYSIS_CONFIG`; `lib`'s
  concentrated consumption (0.8, over references and surface) stands
  beside it. A place departs when one other package holds at least 0.6
  (named in `toward`), fits when its own package does, and is spread when
  no package does; a place with no consumer is counted `unconsumed`. A
  third label, spread, is there because with two labels every
  shared-library symbol used by several packages would depart, and
  departures could not be the strongest signal 4.2 calls for.
- The plan's "sums over cross-package module edges" was not used: a module
  edge points at the module imported, often a barrel
  (`packages/artifacts/src/index.ts` receives 40 cross-package edges on
  Foundry), while a symbol's consumer modules are attributed to the file
  that declares it. `_domains.md` is corrected.
- Output (`Placements`):
  - `places`: every place a consumer module in another package uses,
    sorted by place, then level, then package. A folder and a nested
    package's root can be one place at two levels. Each is a `Placement`, a
    union discriminated on `label`, so `toward` is present exactly on a
    departure. It carries `place` in facet syntax, `level`, `package`,
    `home.modules`, `away` by package with module ids, and `unindexed`,
    consumers in no indexed package, which are never part of a label.
  - `packages`: each with its `counts` by level and label; its own
    `unindexed`, the distinct unindexed files that consume any of its
    places; and its report's `shapeSignals` and `primaryConsumer`, copied
    for cross-checking. Unindexed files are mostly a failed package's,
    since the module index holds only packages that produced a report, and
    scripts at the workspace root. They have no kind, so they cannot be
    told from tests, and are counted as possible consumers with no path
    heuristics.
  - `missing`. Folders are
  the topology's directories, apart from the root and a technical root such
  as `src`, which only restate the package. 2.6 consumes the lens and reads
  the module index and the reports' symbol ids itself to report facets
  that match no place, so placement keeps only the places used away.
- Reads: the module index, every package's internals through
  `readPackageInternals`, and each report of a package with internals, one
  at a time, projected to `symbols[].{id, declarationFile, exported,
  consumerModuleUsage[].{module, references}}` and
  `dependencies.{primaryConsumer, shapeSignals}`. The loader needed no
  change: since 2.2e it serves package reports uncached. A package without
  internals goes in `missing` and its report is not read; a failed package
  is in neither.
- Foundry at this commit: 377 places (symbols 101 depart, 81 spread, 62
  fit; files 30, 33, 43; folders 6, 7, 5; packages 4 depart, 5 spread), no
  unindexed consumers, `placement.json` 181 KB. Counted over every place:
  symbols 101 depart, 81 spread, 2,846 fit, and 965 unconsumed (5,006
  before non-exported symbols were left out; 4,041 of those were not
  exported); files 30, 33, 662, 114; folders 6, 7, 56, 216; packages 4
  depart, 5 spread, 6 unconsumed. The packages that depart
  are models, modules, and workflows, the three that `lib` signals
  `single-consumer`, and workspaces (toward marbles); the motivating case
  shows as `packages/artifacts/src/node` departing toward `@foundry/works`.
- Cost, measured on Foundry: over the saved dataset, two runs each, the
  lens phase takes 375–383 ms and peaks at 784–795 MB RSS, against
  197–199 ms and 527–540 MB with placement left out of `LENSES`; the lens
  alone takes 242–245 ms and peaks at 720–731 MB, since it holds every
  package's internals (35 MB of JSON) while it parses the reports (79 MB).
  Full scans with a fresh `--state` under `/tmp`: a cold scan takes 39 s
  and has a maximum RSS of 8.2 GB (the derivation worker), with a
  1.95 GB peak memory footprint. Two warm scans peak at 2.07–2.11 GB
  footprint and 2.62–2.63 GB RSS, against 2.10 GB and 2.52–2.54 GB for the
  same build without placement, so the scan's footprint does not move and
  its RSS rises by about 0.1 GB.
- Tests: `test/lib/placement-lens.test.ts`:
  - the fixture's shapes on literal values (a test consumer and a
    forwarding barrel earn no use; the technical root has no folder
    place);
  - exactly 3 of 5 departs, home 3 of 5 fits, and a 1:1 split is spread;
  - a single-consumer package departs toward its consumer, with its
    signals carried;
  - unindexed consumers are counted on the place and, distinct, on the
    package, and a place used only by them has no row;
  - a symbol its module does not export is neither a row nor a count;
  - a folder's home leaves out its own modules;
  - one place per shared id;
  - the same output for inputs in any order (symbols, the consumed
    surface and its consumers, directories, modules, the module index, and
    packages, shuffled), with a folder and a nested package's root ordered
    by level; without the level tiebreak the test fails;
  - `read` reads reports one at a time, only for packages with internals,
    keeping only the projected fields, with a type-only home import kept
    and failed and missing packages told apart.

  The other test files:
  - `test/atlas.test.ts`: the real fixture scan with internals, every row
    and count.
  - `test/lib/semantics.test.ts`: a scan without internals lists all three
    packages missing, and the manifest entry.
  - `test/lib/lenses.test.ts`: the registry and the phase.
  - `test/lib/render-lens.test.ts`: the view.

**2.4 Nesting.** Done 2026-10-10. How the workspace is nested, as one
tree across packages.
- `lib/lenses/nesting.ts` builds the tree from the module index, so every
  analyzed package is in it, a package saved without internals too. It
  holds every folder with a file of the index directly or below, and every
  folder above a package root up to the top of the workspace.
  - Each folder carries its `fileCounts` (`direct`, `descendant`, every
    kind), its `parent`, its owning `package` (the nearest package root at
    or above it; absent for a folder above every package), and
    `packageRoot`.
  - What it derives: the folders above the packages (on Foundry, `apps`,
    `packages`, and `tooling`), the one tree that joins the packages, and a
    nested package's root under the folder of the package around it.
  - The topology's `.` is the package root. A package at the workspace
    root (path `""` or `.`) has `.` as its folder and owns every folder no
    other package root holds. Discovery never produces one, since 1.7
    ignores a pattern that resolves to the root, so it is tested on literal
    values only.
- Internals are used only for what needs them: each folder's `pathRegion`
  (from `topology.directories`), the `pathRegions` (files and primary
  files), and the `seams` (module edges, import sites, and symbol flow),
  copied.
  - A folder takes its region only from the internals of the package that
    owns it, so an outer package's topology that also lists a nested
    package's folders never decides theirs, whatever the order.
  - A region that holds no files has no `pathRegions` entry, although a
    folder can still name it. The topology leaves out the root region `.`
    when no file sits directly in it, yet puts the root folder there. On
    Foundry this applies to `apps/atlas`, `apps/atlas/src`, `docs`,
    `packages/agents`, and `packages/agents/src`. A complete package without internals is in `missing` and keeps
  its folders. A failed package has no files in the index and is in
  nothing. `locality.scopes` is not copied: it is the same tree restricted
  to primary modules.
- Loader change: `LensReader.packages()` gains `path`, the manifest's
  package root, since a package without internals has no topology root.
  `lib/lenses/package-internals.ts`, the 2.2a helper, gains
  `rootRelativeFolder(root, directory)`, which maps `.` to the package
  root and otherwise calls `rootRelative`.
- What it retires: nothing in the viewer. The root-relative join in
  `web/internals.ts` `bindInternals` maps the topology's module ids to the
  module index's files. The lens carries folders, not modules, so it cannot
  replace that join without copying the module index. The join already
  goes through the 2.2a helper `rootRelative`, which the lens uses too, so
  a module and a folder are named one way across the lens and the map. The
  viewer does not draw directories yet (4.3), so no viewer code changed.
- Folder ids agree with placement's, which come from each package's
  `topology.directories`. Every topology directory is a nesting folder
  under the same id and in the same path region. The module index can hold
  more: on Foundry, `packages/models/src/catalog/data` holds only a JSON
  file (kind `other`), which the topology does not list, so it is a folder
  with no path region. The comparison over Foundry found no other
  difference, and all 27 of placement's folder and package places are
  nesting folders.
- Foundry at this commit: 318 folders (15 package roots, 3 above every
  package), 314 with a path region, 84 path regions, 105 seams,
  `nesting.json` 77 KB, nothing missing.
- Cost, measured on Foundry with a fresh `--state` under `/tmp`:
  - Lens phase, over the saved dataset, two runs each: 348–354 ms with
    nesting and 353–354 ms without, peaking at 681–817 MB and 690–708 MB.
    Within noise, since the internals it reads are already parsed for the
    phase. Nesting alone takes 56–58 ms and peaks at 254 MB.
  - Scans: a cold scan takes 39 s, with a maximum RSS of 8.7 GB (the
    derivation worker) and a 1.84 GB footprint. Warm scans peak at
    2.11–2.25 GB footprint and 2.57–2.69 GB RSS with nesting, against
    2.15–2.20 GB and 2.59–2.75 GB for the same build without it. No
    measurable change.
- Tests:
  - `test/lib/nesting-lens.test.ts`:
    - the tree, path regions, seams, and a missing package on literal
      values;
    - a package at the workspace root, both spellings;
    - a nested package and a package root with no file;
    - a nested folder's region from its own package only, in either
      order, and none when that package has no internals;
    - the cross-lens folder ids, a data-only folder included, from one
      literal topology through both lenses;
    - the same output for inputs in any order;
    - `read` keeps only the fields it needs, and a failed package is
      neither a package nor missing.
  - `test/atlas.test.ts`: the real fixture scan with internals; every
    topology directory is a folder with the same id and region.
  - `test/lib/semantics.test.ts`: without internals, the tree is complete
    and every package is missing.
  - `test/lib/lenses.test.ts`: the registry, the phase, and `packages()`
    with `path`.
  - `test/lib/render-lens.test.ts`: the view.

**2.5 Proximity.** Done 2026-10-10. What sits close without being
related, and what is related without sitting close.
- Definitions:
  - Close means files directly in one folder, the file system's own
    grouping, named as `nesting` names it.
  - Related means one responsibility, a responsibility relationship (an
    import between two, either way), or a co-change between source files.
  - Co-changes are the workspace report's pairs as stored, already past
    `lib`'s coupling gates. Only `source-source` pairs count, as `lib`'s
    own uses of co-change read them (`conceptOwnership.evolutionCenter.couplingContexts`).
    `verified` is ignored: it says a pair was seen by more than one
    package.
- `lib/lenses/proximity.ts` reports three things:
  - `close`: each folder whose files directly in it fall into two or more
    groups. A group is a connected component of the folder's
    responsibilities, joined by a relationship or a co-change, so a row
    says "this folder holds k unrelated groups", not pairs.
    - Groups join only through responsibilities in the same folder. A
      responsibility both relate to that has no file there joins nothing.
    - Each group names in `apart` its files that are also in `apart.files`.
      A group can consist only of such files, and a reader counting
      signals counts each of them once.
  - `apart.files`: each file whose responsibility's dominant folder is
    another, the responsibilities' own `pathAgreesWithRegion`, copied,
    with the folder steps between them.
  - `apart.coChanges`: every source pair whose files sit in different
    folders, with the steps, `scope`, `staticPath`, commits, and Jaccard.
- `responsibilities.pathSeams`, the same comparison between path regions
  (how many of a seam's edges stay inside one responsibility), is not
  copied: it is per seam, already in the internals, and nothing in phase 4
  needs it in one file yet.
- Files no responsibility holds are left out of relatedness and counted:
  per close folder, and per package in `packages`. A complete package
  without internals is in `missing`, which `close` and `apart.files` do not
  cover; `apart.coChanges` needs no internals.
- Responsibilities are read from the internals, not through the
  `responsibility-groups` lens. Its groups carry neither the modules, the
  relationships, nor the dominant folders this needs. They also come from a
  modularity merge, which would make "related" depend on the lens's
  heuristic instead of the analysis's evidence. So there is no `consumes`.
- Boundary interactions are not read, contrary to the planned entry. The
  dependency graph projection's edges are built from them, and 2.2f routes
  package-pair traffic through the projection. Their destination modules
  are the declaring files of consumed symbols, which is placement's
  evidence (2.3). At package level "related without sitting close" would
  hold for every dependency, so it would say nothing.
- `lib/lenses/paths.ts` holds `folderOf` (moved from `nesting.ts`) and
  `directoryDistance`, a copy of the internal topology's private measure,
  which stays unexported. A parity test checks it against
  `InternalModuleEdge.distance` on an analyzed package, at distances 1, 2,
  and 3, package-relative and root-relative.
- Folder ids come from `rootRelativeFolder` and `folderOf`, the helpers
  nesting uses. On Foundry, all 780 folders that proximity names are
  nesting folders. `lib/render/reports/ranked-section.ts` is the ranked
  list the nesting and proximity views share.
- Foundry at this commit:
  - 30 folders hold unrelated groups (78 groups in all). The most is
    `packages/lib/src`, a folder of independent utilities, with 11 groups.
  - 143 files sit apart from their responsibility's folder.
  - 232 of the 378 source co-change pairs are in different folders, 125 of
    them with no import path and 29 across packages.
  - 115 files are in no responsibility; nothing is missing.
  - `proximity.json` is 117 KB.
- Cost, measured on Foundry with a fresh `--state` under `/tmp`:
  - Lens phase, over the saved dataset, two runs each: 417–427 ms and a
    701–720 MB peak with proximity, against 386–397 ms and 704–737 MB
    without. Proximity alone takes 94–101 ms and peaks at 365 MB, since the
    internals it reads are shared with the other lenses.
  - Scans: a cold scan takes 39 s, with a maximum RSS of 9.2 GB (the
    derivation worker) and a 1.41 GB footprint. Warm scans peak at
    2.10–2.13 GB footprint and 2.58–2.64 GB RSS, within the range measured
    for 2.3 and 2.4.
- Tests:
  - `test/lib/proximity-lens.test.ts`:
    - `directoryDistance`'s cases and its parity with the topology;
    - a folder's components from a relationship, a source co-change, and a
      chain through a third, with a test co-change ignored and an
      unresolved file counted;
    - no join through a responsibility outside the folder, and a group of
      apart files named in `apart`;
    - a file apart;
    - co-changes across folders, a same-folder pair and a source-test pair
      left out;
    - a package at the workspace root;
    - every named folder a nesting folder;
    - the same output for inputs in any order;
    - `read` keeps only the fields it needs, including an unverified pair.
  - `test/atlas.test.ts`: the real fixture scan. `@s/c`'s two
    responsibilities share a folder and import each other, so nothing sits
    close unrelated.
  - `test/lib/semantics.test.ts`: without internals or Git, nothing is
    observed and every package is missing.
  - `test/lib/lenses.test.ts`: the registry and the phase.
  - `test/lib/render-lens.test.ts`: the view.

**2.6 Domains.** Done 2026-10-10. The `domains` lens over 2.3: the
declared domains joined to the dataset's places, and a domain label for
every placed place inside a domain. The rules are in
[`_domains.md`](./_domains.md#built-as-a-lens).
- `lib/lenses/domains.ts` names the setting `domains` and consumes
  `placement`. Its stage, `lens:domains`, depends on `materialization` and
  `lens:placement`, and it runs last.
- Output (`lib/lenses/domains-types.ts`, schema 1):
  - `domains`: every declared domain flattened, with `parents`, its own
    facets that name a place by `kind` (`package`, `folder`, `file`,
    `symbol`), the ones that name none as `unmatched`, and `reason` and
    `weight` copied when declared. Sorted by name.
  - `placements`: every row of `placement` whose place is in a domain,
    with all of its `domains`, `placementLabel`, `domainLabel`, the
    `sharedDomains` it shares with its away consumer modules, and
    `away: { shared, total, unindexed }`, the module counts. Sorted by place, level, and package, as
    placement sorts, since a place can be both a folder of one package and
    the root of another.
- The label rule: `shares-domain` only when every away consumer module
  lies in a place that shares one of the place's domains and placement
  counts no unindexed consumer, whose domains cannot be told, so a
  departure stays the strongest signal; otherwise the placement label stands, and a
  `departs` there is a domain departure. A fit stays a fit. The two
  departs are kept apart by name: `placementLabel` and `domainLabel` in
  the output, "placement departure" and "domain departure" in prose and in
  the view ("Domain departures"), and the glossary's Domain label.
- Matching:
  - A facet names a package (a complete package's manifest path), a file
    (the module index), a folder (a directory above an index file), or a
    symbol (an id in a complete package's report, exported or not, since
    placement leaves an unexported one unlabelled but it is still a place).
  - Coverage runs downward only; consumer modules are covered by path
    facets alone.
  - Membership rolls up through parents, so billing and payments share
    finances.
  - A facet inside a failed package is unmatched.
  - Nothing reads `nesting`: folders come from the module index, which is
    where nesting builds its tree too.
- The lens contract changes: `read(reader, settings)` gets the lens's
  settings, the same `pickSettings` value `derive` gets, so a lens can
  leave unread what its settings do not need. The other lenses' `read`
  take the reader alone, as before. With no domains, the domains lens's
  `read` returns at once and reads nothing, and `derive` returns
  `{ domains: [], placements: [] }`. Otherwise it reads, one at a time and
  keeping only the symbol ids, the report of each complete package whose
  root (the deepest, when packages nest) holds a symbol facet's file;
  path facets need only the module index and the package roots. It
  flattens placement's away modules and copies `unindexed`.
- No per-setting digest: nothing loads the configuration to compare with
  (`atlas report` and the viewer read the saved dataset), and the lens is
  cheap to recompute.
- `lib/render/reports/domains.ts` is the view: counts, the declared
  domains, places that share a domain, domain departures, spread places
  (the rankings through `rankedSection`), then unmatched facets, and
  "No domains declared." for an empty output.
- Foundry at this commit, with no domains: `domains.json` is
  `{ domains: [], placements: [] }`. With a temporary declaration in a
  copy of the workspace (four domains: `modules` over `packages/modules`
  and the Works folders that use it; `persistence`, holding `atlas-state`
  and `sessions`, over `packages/lib` storage helpers and their users):
  - 10 facets matched and 2 unmatched.
  - Of 62 placed places in a domain, 30 share a domain (17 placement
    departures and 13 spread places), 4 are domain departures, 2 stay
    spread, and 26 fit.
  - `packages/modules`, which departs toward `@foundry/works`, shares
    `modules` with all 10 of its away consumer modules.
    `packages/lib/src/file-lock.ts` is a domain departure: 2 of its 6
    away consumer modules share `persistence`.
  - `domains.json` is 15 KB.
- Cost, on Foundry with a fresh `--state` under `/tmp`:
  - Lens phase over the saved dataset, three runs each: with no domains
    declared, 391–423 ms with the domains lens against 385–417 ms without
    it, the lens itself under 1 ms, since it reads nothing. With the
    temporary declaration, whose four symbol facets all lie in
    `packages/lib`, 400–427 ms, the lens 6 ms, reading one report. Peaks
    ranged 643–863 MB in every configuration, which is GC timing, not the
    lens. Before `read` took settings, the lens read all 75 MB of package
    reports on every scan: 561–574 ms for the phase and a peak of up to
    931 MB.
  - Scans: a cold scan of the copy took 44 s, its lenses phase 0.60 s. A
    warm CLI scan took 4.1 s, with a 2.62 GB maximum RSS and a 2.16 GB
    footprint, against 2.58–2.64 GB and 2.10–2.13 GB measured for 2.5.
- Tests:
  - `test/lib/domains-lens.test.ts`:
    - facets matched by kind, unmatched ones (a path and a symbol);
    - the label rule: a fit kept, a shared departure, a domain departure,
      a half-shared spread place kept spread, a place in no domain left
      out, and a package holding a facet left out;
    - an unindexed consumer withholding `shares-domain`;
    - two sibling domains sharing a domain through their parent;
    - a facet on an unexported symbol matched, with no row;
    - empty settings;
    - a package path before a folder, and one place at two levels;
    - the same output for inputs in any order;
    - `read`: nothing at all with no domains; with domains, only the
      report of the deepest complete package holding a symbol facet's
      file, one at a time, none for path facets or a failed package, an
      unexported symbol kept, and a root package's path left out; one
      symbol facet, one report.
  - `test/atlas.test.ts`: the real fixture scan with a `shapes` domain
    over `apps/a` and `packages/b`: `area` shares a domain, `perimeter`
    is a domain departure, the spread places stay spread, and a missing
    file is unmatched.
  - `test/lib/semantics-incremental.test.ts`: a domains-only edit still
    reuses every package and keeps `package-sizes.json`'s inode, while
    `domains.json` follows each edit: under the fixture's patterns the
    package facet matches, and under `*` it is unmatched; a symbol facet
    that `shape.ts` declares then goes from unmatched to matched under
    both.
  - `test/lib/semantics.test.ts`, `test/lib/lenses.test.ts`: the manifest
    entry, the registry, and the phase, which hands `read` and `derive`
    the same settings.
  - `test/lib/render-lens.test.ts`: the view and its empty state.

**2.7 In the terminal.** Done 2026-10-10. `atlas lens <id> [path...]`
prints one lens from the saved dataset through its report view, and with
`--json` its saved output.
- The planned entry had `atlas report` gain the lens sections; a command of
  its own is the least surface the 1.8 table allows.
  - `atlas report` with no package cannot be told from `atlas report
    <path>`, since its first word is the package.
  - Lens rows in `report <package>` would break 1.8's rule that `--json`
    prints the package report as saved, and would need each lens to slice
    itself by package.
  - `report --lens <id>` would make `read` see the flags and add a rule
    that it excludes the package.
- `cli/args.ts`: `lens` is one row of the command table, taking
  `--format` and `--density` as `report` does. `needed` reads the id, so
  `atlas lens` alone is a usage error (`atlas lens needs a lens: atlas lens
  <id> [path...]`); there is no overview. The id is read against
  `LENS_IDS`, so an unknown id is a usage error (exit 2) that lists them;
  the parsed line's `lens` is a `LensId`. `oneOf`'s check and message are
  now `chosen`, which `--format`, `--density`, and the id share. `--json`
  with `--format` or `--density` names the command's result: "--json
  prints the lens as saved". `report <package>` is unchanged.
- `lib/lenses/lens-types.ts` exports `LENS_IDS`, the keys of
  `LENS_SCHEMA_VERSIONS` sorted with an explicit code-unit comparator, so
  the browser-safe leaf imports nothing.
- `cli/atlas.ts`: `RUN.lens` opens the saved dataset through
  `savedDataset`, reads `reader.lens(id)`, and prints it through
  `renderLens` or as JSON; the reader stays the only path to the dataset.
  A dataset saved without the lens, or with another version of it, fails
  with the reader's message and exit 1. `renderContext` takes only the
  format and density.
- The library is unchanged: `lens` is a command, not an export. The
  reader's `lens(id)` is already reachable from `scan`'s and `serve`'s
  results.
- Docs: the help in `reference/cli.md` and the README, the flags, `--json`
  and exit-code tables, and a `## Lens` section listing the ids.
- Tests:
  - `test/cli/args.test.ts`: the parsed line, flags, `./lens` as a path,
    a second path, a refused flag, no id, an unknown id, `--json` with
    `--density`, and the generated help.
  - `test/lib/lenses.test.ts`: `LENS_IDS` holds every lens once, in
    code-unit order.
  - `test/atlas.test.ts`: the built CLI prints `package-sizes` as text and
    Markdown, `domains` empty, `placement --json` as saved on one line, an
    unknown id with exit 2, a dataset without the lens with exit 1, and a
    workspace never scanned with exit 1.

**2.8 Naming.** Done 2026-10-10. The viewer's Belonging / Files toggle was
typed as a lens; it is the map layer, the name the glossary (Lens, _Avoid_)
and the control's own label ("Map layer") already gave it, so "lens" now
means only the derivations in `lib/lenses`.
- `web/ui/atlas-state.ts` exports `MapLayer = "belonging" | "files"`, the
  one spelling of the union, which three files had spelled on their own;
  `AtlasState.mapLayer` starts on `"belonging"`.
- `web/ui/use-atlas-state.ts`: `[mapLayer, setMapLayer]`,
  `changeMapLayer`, the action `mapLayer`, and `resolveValue`'s
  `mapLayer` parameter. `web/ui/atlas-header.tsx`: the `mapLayer` and
  `onMapLayer` props, `handleMapLayer`, and the class `atlas-map-layer`
  (`atlas.css`); its `Lens` type is gone. `web/ui/atlas-shell.tsx` passes
  them on.
- No visible change: the label, "Map layer", and the options, Belonging
  and Files, are as they were.
- `belongingLayer` and `chartSettings.layers` sit beside `mapLayer` in the
  map state. That is right as it is: `belongingLayer` is what the belonging
  map layer draws, and the chart layers are the chart's.
- Docs: `web/DESIGN.md` names the selector the map layer selector;
  `_review.md`'s finding is marked resolved; `CONTEXT.md` and the guide
  already said "map layer".
- Tests: `test/web/atlas-shell.test.ts` finds the control in the header by
  its class and label, with its two options, starting on belonging, and
  switches it to files.

Shape has no effort of its own: the graph projection, layers, gravity, and
file counts already answer it. The 2.1 `package-sizes` lens joins two of
these for the codex and is not that effort.

**Phase 2 is done** (2026-10-10). Eight lenses run at every scan and are
saved in the dataset, each with its own schema version; the viewer reads
four of them (`package-sizes`, `file-roles`, `responsibility-groups`, and
`frequent-change`) and computes nothing the analysis defines (2.2) apart
from the per-module import counts, which are pinned to gravity, and
`atlas lens <id>` prints any of them (2.7). Resolved in 4.4b: the module
index carries each file's gravity fan-in and fan-out, and the viewer reads
them there instead of recounting the edge shards.
- 2.1: the lens layer, with `package-sizes`; 2.2: `file-roles`,
  `responsibility-groups`, and `frequent-change`, with neighborhoods and
  the pair re-aggregations retired.
- 2.3–2.5: `placement` (fits, spread, departs, from consumer modules),
  `nesting` (one folder tree, path regions, seams), and `proximity`
  (close and unrelated, related and apart).
- 2.6: `domains`, the first lens to read the configuration: what each
  facet names, unmatched facets, and the domain label beside placement's.
  `read` now gets the lens's settings, so a lens reads only what they need.
- 2.8: "lens" means one thing; the viewer's toggle is the map layer.
- Cost on Foundry: the lens phase takes 0.4–0.7 s of a 44 s cold scan;
  with no domains declared, the domains lens costs under 1 ms. Peak
  memory rises 0.6–0.8 GB from `frequent-change` reading package reports,
  accepted in 2.2, and about 0.1 GB of RSS from `placement`.
- Left for later phases, by design rather than open in this one:
  - The viewer draws none of `placement`, `nesting`, `proximity`, or
    `domains` yet: 4.2 (departures as the strongest signal) and 4.3
    (directories and domains drawn).
  - A per-setting digest waits for a consumer, a rule written in terms of
    domains (3.1) at the earliest.
  - How nested and overlapping domains combine into one label, and how
    weights combine, stay in [`_domains.md`](./_domains.md#later-when-needed).

## Phase 3: rules and codemods

Detail in [`_codemods.md`](./_codemods.md#decisions-needed).

**3.0 Measure the refresh.** Done 2026-10-10; the numbers and what they
mean for 3.6 are in [`_codemods.md`](./_codemods.md#refresh-measured-2026-10-10).
- Derivation is about 90% of any refresh: 30–33 s on Foundry whatever the
  edit, against 3 s warm. A commit that touches a file, and the first scan
  of each UTC day, re-derive too.
- `apply` spends 85% of its 33 s in its two analyses; the edit takes
  milliseconds.
- Internals are cheap (under 0.4 s) and already reused, so 3.6's internals
  item is done. Passing the `apply` project through saves about 3 s; the
  larger savings are splitting the derivation key and reusing the saved
  report for `apply`'s before and after.

**3.1 Rules.** Done 2026-10-10. Declaration and validation only; nothing
reads the rules yet.
- `lib/rule-declaration.ts` holds `Rule` (`{ effect, operator, subject }`,
  written out) and `rulesSchema`, a strict zod schema. `AtlasConfig` gains
  `rules?`; the resolved `SemanticsConfig` carries `rules`, `[]` by default,
  and `configFingerprint`, an allow-list, leaves it out. `rules` follows
  1.7's one-file rule, and `foundry.config.json#semantics` rejects it as an
  unknown key (`legacySchema` omits it with `domains`). `Rule` is not
  exported; it is `NonNullable<AtlasConfig["rules"]>[number]`.
- `operator` accepts `internalize` only, the one executable catalog kind;
  the list widens kind by kind as each becomes executable (3.8). `effect`
  is `permit` or `require`. `subject` is a facet: the facet checks moved
  unchanged from `domain-declaration.ts` to `lib/facet.ts`, which both
  declarations import.
- A rule is named by its index, `rules[0]`, as errors name it, so
  reordering the list renames every rule (and, from 3.2, invalidates an
  authorization). One operator and subject take one rule: the same rule
  twice is `rules[1] repeats rules[0]`, and a permit beside a require of
  the same subject is refused too, since a require permits. Neither issue
  shows a `got`.
- `lib/facet.ts` also holds `covers(facet, place)`, the domains lens's
  private matcher moved out unchanged, so that 3.2's permits and 3.3's
  rules lens match as the domains lens does: whole segments, `#` as a
  boundary, downward only. Lens code, so no analysis change.
- The rules lens is 3.3's, not 3.1's: its output is the violations, which
  nothing could read before `check`, and `LensSettings` gains `rules` with
  the lens that names it.
- Rules are not written in terms of domains, so no per-setting digest is
  needed yet.
- Tests: `test/lib/rule-declaration.test.ts` through `parseConfigFile`
  (every message and path, an unknown key, both repeats);
  `test/lib/facet.test.ts` (`packages/co` does not cover `packages/core`,
  `#` as a boundary, downward only); `test/lib/atlas-config.test.ts` (rules
  through the loader, declared in two files, an invalid one by file and
  setting, the fallback rejecting them); `test/lib/semantics-incremental.test.ts`
  (a rules-only edit reuses every package and derives nothing); and the
  installed package's configuration and TypeScript consumer declare a rule.

**3.2 Wire the two stacks** at `authorizeMutationPlan`. Done 2026-10-10.
No third stack: the rules gate and the bridge to the mutator live in the
handoff, and `OperatorReadinessContext` and the assessment are unchanged.
- `authorizeMutationPlan(plan, context, rules)` checks cheapest first and
  answers with one of four kinds. `refused-by-rule` comes from
  `lib/rules.ts` `permits`: an operator whose kind a rule can name, and
  whose place no rule of that kind covers (a `require` permits too).
  `not-executable` comes from the bridge: exactly one operator; the
  catalog's `legacyOperatorId`; a kind a rule can name (`ruleCanName`, so a
  kind added to the catalog later cannot reach a write unpermitted; a
  catalog test ties the two lists); built from a saved plan
  (`intent.planId`); that plan `ready`; every edit one the mutator performs
  (`remove-export` or `rewrite-reexport` for `internalize-export`); and the
  saved plan's route files equal to the files the plan transforms,
  ignoring `verify-only`. Neither of these runs a baseline command.
  `readiness` is the assessment's verdict when it does not authorize, such
  as a baseline that fails now, which is `blocked` and never a hash
  mismatch. `authorized` carries the readiness and the record.
- An operator of a kind no rule can name yet is left to the bridge, which
  says that no mutator executes it: a rule cannot be written for it, so
  "refused by rule" would name the wrong fix.
- The record (`AuthorizedMutationPlan`, schema 2, its own
  `AUTHORIZED_MUTATION_PLAN_SCHEMA_VERSION`; readiness keeps 1) holds
  `execution: { mutator: "internalize-export", planId, planFingerprint }`,
  the saved plan's id and fingerprint (no plan copy); `executionPlanId`,
  the execution plan's; `permittedBy`, the indexes of the permitting rules;
  `authorizationFingerprint` with readiness's five parts (its
  `planFingerprint` is the execution plan's) plus `ruleFingerprint`, and an
  `auth:` hash over all six, so 3.5 can name the part that moved;
  `sourceFiles`, every file and manifest with the hash `sourceFingerprint`
  covers (`"missing"` for a file the plan would create), so it can name the
  file; and `readinessFingerprint`, the assessment's own hash.
- `ruleFingerprint` is over every rule in one canonical form,
  `canonicalRules` (`{ effect, operator, subject }` by index, fixed key
  order), so rules from the configuration and rules read back from the
  rules lens hash alike; a rule edited, added, removed, or moved
  invalidates the record.
- One short-hash helper, `lib/short-hash.ts` `hash16`, moved out of
  `operator-readiness.ts` unchanged, serves readiness and the rules.
- `lib/execution-plan.ts` `executionPlanFor(facts, planning, planId)`,
  returning a `PlannedExecution`, is
  the chain 3.4's `atlas plan` calls: the saved plan as an operator
  (`createInternalizeOperator`), decomposed, composed, and planned, in the
  shape of `planned()` in `test/lib/operator-readiness.test.ts`.
- `DEFAULT_MUTATION_CAPABILITIES` still claims kinds `apply.ts` never
  performs; the bridge's file check keeps them from reaching a write, and
  3.5 narrows the registry.
- Tests: `test/lib/rules.test.ts` (permits by whole segments, require
  permits, kinds no rule names left out, one canonical form, a moved rule
  moves the fingerprint); `test/lib/operator-readiness.test.ts` (a manual
  operator: refused with no rule, not executable with one, and no
  baseline runs; a composed plan of two operators is not executable); and
  `test/lib/workspace-e2e.test.ts` over real reports, on a copy of the
  locality fixture whose subject package gains a test script: a ready
  saved plan is authorized under a permit, the record is ids and
  fingerprints only, a moved rule changes only `ruleFingerprint` and the
  hash, and `internalize-export` previews exactly the planned files; no
  permitting rule makes no record; a failing baseline answers `readiness`
  with `blocked`; a rehome operator is not executable.

**3.3 `atlas check`.** Done 2026-10-10. Rules against the dataset; exit
3 on a violation, as 1.8 reserved, so it differs from a failed run (1) and
bad arguments (2).
- The `rules` lens (`lib/lenses/rules.ts`, `settings: ["rules"]`, schema 1)
  runs at every scan, last; `LensSettings` gains `rules`, which
  `generateSemantics` passes from the resolved configuration. Its output,
  `lenses/rules.json`, is `{ rules, unmatched, violations, missing }`:
  - `rules`: `canonicalRules` of the configuration's, in declaration
    order, neither sorted nor de-duplicated, so that the lens's rules and
    the configuration's hash alike (3.4 reads the one, 3.5 the other);
  - `unmatched`: indexes of rules whose subject names no place, matched
    by `lib/lenses/places.ts` (`placesOf`, `kindOf`, moved out of the
    domains lens with `packageRoots`, `packagesNamedBySymbols`, and
    `readSymbols`, which both lenses now use), so a misspelled path or
    symbol is reported and a package at the workspace root names no place;
    `meets` (a subject covers a package's root or lies inside it) only
    chooses the reports to read and the failed packages for `missing`;
  - `violations`: a `require` of `internalize` is a state, "under S no
    package-public symbol is unused outside its package", so every
    `internalize-symbol` opportunity under the subject is one, with its
    saved plan's `id`, `status`, and sorted blocker reasons; sorted by
    rule, place, package; a permit breaks nothing;
  - `missing`: each `require` rule and failed package it meets, where it
    could not be checked.
- `read(reader, { rules })` reads nothing with no rules; otherwise the
  module index, the reports of complete packages a `require` meets, and
  the symbols of the packages a symbol subject names, one report at a
  time, keeping only the fields it needs.
- The view (`render/reports/rules.ts`) prints counts, one section per
  broken rule, a note on what each blocker reason means, from the package
  report's own `blockerDefinitions` (`publishable`: the package is marked
  `"private": false`, so consumers outside this repository are invisible),
  the unmatched rules, and what was not checked. `atlas lens rules`
  prints it too.
- `atlas check [path...]` (`lib/check.ts`, CLI only) reads the saved
  manifest and the rules lens; no configuration runs, so the configuration
  invariant holds, and a rules-only edit takes a warm scan (about 3 s on
  Foundry) to show. Outcome `clean` (exit 0, also when no rule is
  declared, with a note), `violations` (3), or `incomplete` (1, when
  `missing` is not empty, which outranks violations, and one stderr line
  names the rule and the failed package); a dataset saved
  before the lens exists fails (1). `--format`, `--density`, and `--json`
  (`{ generatedAt, outcome, lens }`) work as for `lens`. 3.5's apply
  journal is read in `check` before the outcome (a comment marks the
  place); nothing reads it yet.
- Measured on Foundry (15 packages, read-only, fresh state under `/tmp`):
  with no rules, the rules lens reads nothing and takes under 0.2 ms; the
  whole lens phase took 412–425 ms over three scans (cold 412 ms; 422–478
  ms in a first run before the review's changes), against 391–423 ms in
  2.6 with one lens fewer. A `require` of `internalize` on
  every top-level folder reads all 15 reports and takes 149–157 ms; Foundry
  then has 3,957 violations.
- Tests: `test/lib/rules-lens.test.ts` (derive: violations with plans,
  narrowing by whole segments, a permit breaking nothing, declaration
  order, unmatched, missing, a root package; read: nothing with no rules,
  only the reports a require meets, one at a time); `test/lib/render-lens.test.ts`
  (the view, exactly); `test/lib/lenses.test.ts` and `test/lib/semantics.test.ts`
  (registry, manifest entry, output with no rules); `test/cli/args.test.ts`;
  and `test/atlas.test.ts` on the built CLI over a temp copy of the
  semantics fixture: no rules exits 0 with the note; a require exits 3,
  with one JSON line equal to `atlas lens rules --json`; a permit, and the
  export removed, exit 0; `missing` exits 1 over a violation; a dataset
  without the lens exits 1; a never-scanned workspace exits 1.

**3.4 `atlas plan`.** Done 2026-10-10. One plan for one site; it writes
nothing in the workspace.
- `atlas plan <opportunity> [path...]` (`lib/codemod.ts` `planSite`, with
  `lib/codemod-types.ts`; CLI only, not in the exports map). `resolveSite`
  reads the opportunity id `internalize-symbol:<path#name>`, the saved
  plan's id `plan:internalize-symbol:<path#name>`, or the bare `path#name`;
  any other shape, another operation's id or a second `#` included, is a
  usage error (2); `savedPlanOf` splits the place with the same helper.
  The site's package comes from the module index; a file, opportunity, or
  saved plan the dataset does not hold fails (1). `rule:<n>` is deferred
  (decision 2).
- The rules come from `reader.lens("rules").rules`, so no configuration
  runs and the configuration invariant still holds; a dataset without the
  lens fails (1). The chain is the decisions': the saved workspace report
  and only the subject's package report into `createOperatorContext`, a
  planning context over the subject package only, `executionPlanFor`, then
  `authorizeMutationPlan`. The probe showed the saved `workspace.json`
  carries the intelligence the projection needs, and that the narrowed
  context still authorizes.
- **Deviation from "read-only"** (decision 1 ruling): readiness runs the
  baseline commands, the package's `test` script and its `typecheck`
  script where it has one, with `CI=1`. Help, `cli.md`, `_api.md`, and the
  README say "writes nothing in the workspace" and that the scripts run;
  `_api.md`'s principle 3 notes it.
- Only an authorized verdict writes: the record, as `authorizeMutationPlan`
  returned it, to `<state directory>/plans/<hash16(plan id)>.json`, with
  `writeFileAtomicSync` and without the state lock (A11). Any other verdict
  deletes the site's earlier record, so a record exists only while the
  last plan authorized it. **For 3.5:** apply never trusts a record without
  authorizing again, fresh, and comparing the `auth:` hash. `cli.md` warns that plan's
  scripts may run beside another command's. `output.md` lists `plans/`.
- `plan` refuses (1) while `<state directory>/apply/journal.json` exists.
  It reads only whether the file exists; `refuseUnfinishedApply` and the
  path live in `codemod.ts`, where 3.5's `applyRecord` reuses them and
  reads the phase (A1). `check` does not read the journal yet; its comment
  still marks the place.
- **A9 currentness: left to 3.6.** `collectWorkspaceInputs` takes the
  resolved configuration, so `plan` cannot recompute the inputs fingerprint
  without loading it, and the manifest records no fingerprint yet. 3.6 adds
  the hash to `manifest.generation`; `plan` should compare against that
  recorded hash, not recompute it, or solve the configuration input some
  other way. Until then a stale dataset can yield a record, which apply's
  fresh revalidation refuses; `cli.md` says to scan after an edit.
- `--json` is `{ site, opportunity, plan, verdict, record? }`: `site` the
  `path#name`, `plan` the saved plan as the package report holds it,
  `verdict` the `MutationAuthorizationResult` unchanged, and `record` the
  saved path. Exit 0 for every verdict; 1 for no dataset, an unknown site,
  a journal, or no rules lens; 2 for bad arguments.
- **Reading of the tests' "publishable is blocked":** the bridge answers
  `not-executable` for any saved plan that is not `ready`, before
  readiness, so a publishable plan's verdict is `not-executable` ("the
  saved plan … is blocked: publishable"). The view and JSON show
  `plan.status` `blocked`, its blockers, and `blockerDefinitions`' note on
  `publishable`. No fifth verdict word was added. "Not ready, not
  executable" is tested on an `unsupported` plan
  (`internal-entrypoint-import`).
- The view (`render/reports/codemod.ts`, `renderPlan`) is built on
  `views.ts` primitives: the opportunity, package, and saved plan status;
  the verdict as a signal, titled by the saved plan's status ("Blocked",
  "Unsupported") when a plan that is not ready is why it is not
  executable, and "Not executable" for the bridge's other reasons (a refusal gives the `permit` rule to declare,
  an authorization the permitting rules by index and the record's path);
  planned changes from the saved plan; the saved plan's blockers with
  `blockerDefinitions`; readiness's blockers, cautions, and verification
  steps with their commands; and, when authorized, "Run atlas apply <id>
  to preview; add --write to write." That line, and the journal
  refusal's "Run atlas apply to restore", name a command 3.5 adds; 3.5
  revisits both strings.
  `listSection` moved from `reports/rules.ts` to `reports/ranked-section.ts`,
  beside `rankedSection`, and both views use it, instead of a second copy.
  The help's command column is now the longest usage plus two.
- No analysis code changed, so no Changes row: the existing files touched
  are the CLI and the renderers (`reports/rules.ts`, `ranked-section.ts`,
  `render/index.ts`).
- Measured on Foundry (read-only, fresh state under `/tmp`, cold scan
  43.9 s at 8.5 GB peak RSS). Foundry declares no rules, so `atlas plan`
  there is refused before any baseline: 3.3–4.6 s wall, 2.6 GB peak, no
  record. A probe driving the same chain with a permit on `packages` and a
  stub runner, for `@foundry/workspaces` `AnyWorkspaceExtension`, three
  runs: dataset read 44–53 ms, operator context 5–12 ms, planning context
  0.71–0.76 s, execution plan 2.1–2.2 s, authorization 34–35 ms (readiness
  `sourceMs` 28.5–29.1, `structuralMs` 3.8–4.2), 3.1–3.2 s wall, 2.4–2.5 GB
  peak. The record is 1,489 bytes, with 5 source files. The planning
  context and execution plan run for every verdict, refusals included; the
  gate was not split to avoid that. `baselineMs` was **not** measured on
  Foundry, since a real run would spawn `@foundry/workspaces`' test and
  typecheck scripts. On the deps fixture (`test` is `true`), `baselineMs`
  is 14.8–15.4 ms, plan takes 0.54–0.56 s wall at 0.37 GB, and the record
  is 1,013 bytes.
- Tests: `test/lib/codemod.test.ts` (`resolveSite`'s three spellings and
  refused shapes; on a committed copy of the deps fixture, every package
  private unless the fixture publishes it, each with a `test` script, an
  injected runner: authorized writes the record and leaves `git status`
  clean, the view exactly; no permitting rule refuses with no baseline and
  no record; publishable shows why it is blocked; unsupported is not
  executable; a failing baseline answers `readiness` `blocked` with no
  record; a journal refuses; unknown sites fail); `test/cli/args.test.ts`
  (the three spellings, missing and bad sites, `--write` refused, `--json`
  with `--format`); and `test/atlas.test.ts` on the built CLI (authorized
  exits 0 with one JSON line and the record on disk; the text view; a
  clean tree; a refusal exits 0; an unknown site 1; a bad shape 2).

**3.5 `atlas apply` for `internalize-export`.** Fresh analysis,
revalidation, a dirty tree blocks, preview by default, write with
`--write`, verify, restore on failure. Done 2026-10-10 in two units: (a),
the mutator's hardening and a library preview; (b), the write with its
journal, verification, the scan after it, and the CLI.

Unit (a), done 2026-10-10. Nothing is exposed in the CLI yet, and nothing
writes through `applyRecord`.
- `apply.ts` (Changes row): the snapshot is each planned file's raw bytes
  and mode, not a UTF-8 read; a symbolic link is refused. Each edited file
  is written with `writeFileAtomicSync` and its original mode (the sync
  writer in `@foundry/lib` gains `mode`, set exactly whatever the umask),
  instead of `saveSync`; ts-morph's `getFullText()` drops a byte order
  mark, so the original's is put back. One `try` covers the first write
  through the last check, so a throw anywhere in it restores as a failed
  check does; the restore is atomic, with the mode, and guarded per file:
  a file still holding its original bytes is left alone, one holding the
  written bytes is restored, and one holding neither changed after the
  write, is not overwritten, and is named in the error. The after-analysis
  is a seam (`analyzeAfter`), which the tests throw through. Before, a
  throw after `saveSync` left a half-applied tree, and the restore was a
  plain `writeFileSync` of a lossy UTF-8 read.
- Before any edit, each planned file's text as the project read it must
  write back to its snapshot's bytes exactly; otherwise the plan is
  refused (`apply-unsupported`). That refuses a file that is not UTF-8,
  which the rewrite would re-encode, and a file that changed between the
  snapshot and the project's read.
- The restore tries every file, collects what it left untouched and what
  failed, and throws once, naming them all, with the error that called for
  it as the cause.
- A write or restore is a rename over the file: it keeps the bytes and the
  mode, but not another user's ownership, extended attributes, ACLs, or
  other hard links to the file, which keep the old bytes. A crash can leave
  a `<file>.<uuid>.tmp` beside a file; it is safe to delete.
- `editRoute` says how each statement reads before and after
  (`MutationResult.edits`, `{ file, before, after | null }`; a declaration
  by its first line after any decorators), for the preview.
- The working tree comes from one helper, `lib/working-tree.ts`
  `workingTree`, which reads `git status --porcelain -z`, so a path with
  spaces, quotes, or non-ASCII characters is matched as written (before, Git
  quoted such a path and a dirty planned file slipped past both readers),
  and tells Git missing, a workspace outside a repository, and a repository
  Git cannot read (dubious ownership, a held `index.lock`, with Git's
  message) apart; readiness's `gitDirty` and the mutator both use it, and
  `dirtyPlannedFiles` is gone (A5). Only a dirty file the mutator writes
  blocks. A write without Git, or outside a repository, is refused and
  says which (decision 5); before, `dirtyPlannedFiles` returned `[]`
  without Git, so a write had no dirty check. The shared helper also fixes
  a bug both copies had: the porcelain output was trimmed whole, so the
  first dirty file lost the first character of its path.
- `DEFAULT_MUTATION_CAPABILITIES` holds what `editRoute` performs,
  `remove-export`, `rewrite-reexport`, and `verify-only`, and
  `MUTATION_CAPABILITY_VERSION` is 2 (decision 6, A12; Changes row). Every
  record 3.4 saved now reports `capability` as moved, and a readiness
  assessment of a plan that rewrites imports is `unsupported` under the
  default; `test/lib/operator-readiness.test.ts`, which judges the gate,
  runs those plans under a test-local copy of the old registry.
- `codemod.ts` `applyRecord(root, site, { state, runner })`, preview only:
  the state lock, taken before the saved dataset is read and held to the
  end; an apply's journal
  refused, as `plan` refuses it; the record `atlas plan` saved, read as
  untrusted (missing: "run atlas plan"); the rules from
  `loadConfiguration`, the second load site (decision 3; `scan.ts`
  `prepare` says so); the chain authorized again, fresh, through the same
  helper `planSite` now calls (`authorizeSite`), which runs the baseline
  commands again (re-authorization is mandatory, so a preview runs the
  workspace's scripts too); then the refusals, in order:
  `refused-by-rule`, `not-executable`, or `readiness` from that answer;
  `authorization-changed` with the parts that moved, in the order source
  (naming the files from `sourceFiles`), rule, capability, verification,
  plan (the saved plan's id and fingerprint count as the plan), rollback,
  and `atlas-version` when every part is the record's but the hash or the
  record's schema is not (A4); `rollback` when the plan creates or deletes
  a file or a written file is not restorable (A2); `dirty` for a written
  file readiness saw dirty (A5); and `revalidation` when the mutator's own
  fresh analysis (`applyReductionPlan`, preview) disagrees. The result is
  `{ site, planId, mode, status, refusal?, edits, changedFiles }`.
- The mutator's own `dirty-working-tree` and `no-git` blockers map to the
  `dirty` and `no-git` refusals, not `revalidation`. `no-git` is not reached
  in (a): the mutator refuses only a write without Git, and a preview does
  not write. The `git-missing` and `failed` branches of `workingTree` are
  untested (they need Git off the `PATH`, or a repository Git refuses);
  `not-a-repository` is tested.
- A record of another schema version is read on its version alone and
  reported as `atlas-version`. A missing dataset fails before the lock,
  which creates the state directory; the reader is made again under it.
- A10: the lock's messages name apply, and a live holder's no longer
  suggests removing the lock.
- Measured on a committed temp copy of the deps fixture (test scripts
  `true`): `plan` 84–200 ms, an apply preview 366–434 ms, three runs each.
  Nothing on Foundry, where a preview would run `@foundry/workspaces`'
  scripts.
- Tests: `test/lib/working-tree.test.ts` (a spaced, a quoted, and a
  non-ASCII path, an untracked file, a rename, a workspace below the
  repository's root, and no repository); `test/lib/operator.test.ts`
  (preview edits for a shared re-export, a declaration, a removed
  statement, and a decorated class; a file with a 0xE9 byte refused in both
  modes; one restore failing while the others are restored; no Git previews but refuses a
  write, saying why; the mode kept and an unrelated dirty file not
  blocking; a byte order mark kept; a throw mid-verification restores
  bytes and mode; the restore guard); `test/lib/codemod.test.ts` (a preview
  re-runs the baseline and writes nothing; no record; a planned file
  edited names `source` and the file; a rule moved names `rule`, and none
  permitting refuses by rule; a tampered part and a tampered hash; a dirty
  written file refuses, a dirty read-only or unrelated file does not; a
  journal and a held lock refuse); `test/lib/operator-readiness.test.ts`
  (the default registry judges an import rewrite unsupported);
  `packages/lib` (`mode` set exactly under a narrow umask).

Unit (b), done 2026-10-10.
- `atlas apply <opportunity> [path...] [--write]` (`lib/codemod-apply.ts`
  `applyRecord`, CLI only; `codemod.ts` keeps the site, `plan`, and the
  chain both share, `authorizeSite`). `--write` is apply's only; the help
  says "Preview a planned change; write and verify it with --write". Exit
  0 for a preview, or a write verified and published; 1 for no record, a
  refusal, a rollback, an interrupted write restored, or a verified write
  whose scan failed (decision 9); 2 for bad arguments. `--json` is
  `{ site, planId, mode, status, refusal?, edits, changedFiles,
  verification?, scan?, timings? }`, `status` one of `preview`, `refused`,
  `applied`, `rolled-back`.
- The journal is the one record of an unfinished apply (A1;
  `lib/apply-journal.ts`): `{ schemaVersion, site, planId, phase,
  startedAt, files }`, each file with its original bytes (base64), mode,
  and the SHA-256 of the original and of the written bytes; written with
  `writeFileAtomic({ fsync: true })` before the first source write, through
  the mutator's new `beforeWrite` hook, and rewritten `verified` once every
  check passed. No `WorkspaceRecord` marker; `recordSavedDataset` is
  unchanged. `writing`: the next apply, any site or mode, restores under
  the lock with the same guard (`restoreWritten`, now comparing the written
  hash), deletes the journal, says what it restored, and exits 1; `plan`,
  `check`, and `scan` refuse. `verified`: `scan` publishes, then deletes it;
  `plan`, `apply`, and `check` refuse. A restore that refuses a file keeps
  the journal. The 3.4 strings are revisited: the refusals now say which
  phase and what to run, and plan's "Run atlas apply … to preview; add
  --write to write." names a command that exists.
- Just before the first write the mutator reads each file again and checks
  it against its snapshot and the hash readiness's rollback recorded, passed
  in as `expectedHashes`, and again once the journal is flushed; a mismatch
  is `stale`, writes nothing, and the journal of the write that never began
  is deleted (A2). The mutator writes only with a `beforeWrite` journal.
- Durability: each source write and each restore is flushed, file and
  directory (`writeFileAtomicSync` gains `fsync`, and `@foundry/lib`
  exports `syncDirectorySync`), so the written files are on disk before the
  journal flips to `verified` or is deleted; the state directory is flushed
  when `apply/` is new. On macOS, Bun's `fsync` is a plain `fsync(2)`, not
  `F_FULLFSYNC`: 200 one-byte `fsyncSync` calls took 0.025 ms each under
  Bun 1.3.14, the same as `fsync(2)` from C (0.026 ms), against 4.1 ms
  under Node 26, which issues `F_FULLFSYNC` through libuv, as C's
  `fcntl(F_FULLFSYNC)` does (4.05 ms). So a power loss on macOS can still
  lose a flushed write; nothing is built around it.
- A restore refused for a changed file names the journal, and says that
  restoring the file from Git (its `HEAD` content) lets the next apply
  finish, and that deleting the journal keeps the files as they are. The
  journal's copy of each original is checked against its recorded hash
  before any restore. An earlier interrupted write reports the files it
  restored and, apart, those already as they were.
- Under the lock, a scan and the scan after a write remove the
  `output.tmp-<pid>`, `output.old-<pid>`, and `output.next.*-<pid>`
  directories of a pid that no longer runs (`processAlive`, the lock's own
  check). `atlas export` refuses while an apply is unfinished, in either
  phase, since the dataset may not describe the sources.
- SIGINT and SIGTERM are caught across the write and its checks (A3).
  Under Bun 1.3.14 a signal's listener runs only at the next macrotask,
  never when a blocking `execFileSync` returns, so every check first yields
  (`setImmediate`) and then throws `InterruptedError` for a caught signal,
  inside the mutator's `try`, which restores. The checks: before the
  journal is written (a signal during the analysis before the write writes
  nothing), around the after-analysis, after each script, and once more
  after the mutator returns `applied`, before the `verified` flip, so a
  signal dispatched late, as when a script traps SIGINT and exits 0, still
  undoes the write, from the journal. A child killed on its own, by its
  timeout (`ETIMEDOUT`) or a full buffer (`ENOBUFS`), is a failed step,
  which rolls back and exits 1; it is an interrupt only when Atlas caught a
  signal too. There is also a check right after the journal is written.
  The listener stays installed through the restore, so a second signal
  does not stop it. An interrupted write exits 130 for SIGINT and 143 for
  SIGTERM. The scan after the write is outside the window: by then the
  write is verified and journaled so. The window that remains, a few
  synchronous statements between the last check and `stop()`, is accepted:
  a signal there takes Bun's default action, ending the process with the
  journal still `writing`, and the next apply restores. History's own
  staging, `output/history.tmp-<pid>` and `.old-<pid>`, is swept with the
  rest. A first version checked synchronously and
  missed every signal during a script; the review reproduced it, and the
  e2e now sends SIGINT to the CLI's process group during a sleeping script,
  and one that traps it.
- After the write, each readiness command step runs again (A6, decision 4;
  Changes row): it must exit 0 or show only failures its baseline, run
  under the lock in this apply's re-authorization, showed. The TypeScript
  diff and `verifyInternalizeExport` run first. The checks are the mutator's
  new `afterChecks` hook. Since a failing baseline blocks readiness and
  apply passes no allowances, the subset rule bites only once allowances
  exist; today any failure after a passing baseline rolls back.
- The scan after the write (A7, A8): `scan.ts` `publishAfterWrite` stages
  the dataset, internals included, in `output.next` with
  `generateSemantics`' new `previous` option (the published dataset, for
  hardlink reuse), hardlinks `output/history` into it, swaps it in with
  `replaceDirectory`, and records the save; apply calls it under the lock
  it already holds. History is carried over because it covers past
  commits, HEAD included, and apply commits nothing; a plain scan without
  `--history` drops it, as before. Once 3.6 takes "after" from the staged
  scan, a failed scan means no after-report, so it rolls back; decision
  9's "applied, but the scan failed, files stay" then survives only for a
  failure in the swap or in recording the save. The staged scan is not
  yet compared with anything: "after" is still `analyzeSurface`'s.
- On a published scan apply deletes the record, only if its text is still
  the one it loaded (A11), and then the journal. A refusal or rollback
  keeps the record; a later apply re-authorizes anyway.
- The text view (`render/reports/apply.ts`, `renderApply`): the outcome,
  the refusal with what to run next, each edit as `before → after`, and the
  checks after a write.
- Measured on a fresh `git clone` of Foundry under `/tmp` (c97bb1b, its
  own `bun install`, a committed `permit` on `packages/workspaces`, never
  the user's checkout), one run each after a cold scan (49.7 s, 6.9 GB):
  `plan` 6.2–7.7 s at 2.5 GB, its baseline (`@foundry/workspaces`' test
  and typecheck scripts) 2.9–3.8 s; an apply preview 29.9 s at 5.9 GB
  (re-authorization with the scripts, then the mutator's fresh
  `analyzeSurface`); `apply --write` 82.4 s at 8.7 GB, of which the
  baseline under the lock took 3.1 s, the scripts after the write 4.0 s,
  and the scan after the write 34.4 s; the rest is the two analyses and
  the re-authorization. 3.0 measured `apply` (32.9 s) and the refresh
  (35.7 s) apart, 68.6 s together; the write now adds the re-authorization
  and both script runs, about 14 s. Only `packages/workspaces/src/index.ts`
  changed. On a committed copy of the deps fixture (test scripts `true`):
  `apply --write` 2.45–2.50 s at 0.62 GB, the scan after it 1.28–1.33 s,
  three sites. A preview of a multi-line export statement prints it whole;
  a shorter form is a candidate.
- Tests: `test/lib/codemod.test.ts` on committed copies of the deps
  fixture with injected runners (a write journals before it writes,
  verifies, re-runs the script once, scans, keeps history byte for byte,
  advances `generatedAt`, leaves only the planned file changed, and deletes
  the record and the journal, and a second apply has no record; a script
  failing after the write rolls back byte for byte and keeps the record; a
  baseline failing under the lock refuses; a throw and a SIGINT restore,
  and the listeners go; an interrupted journal is refused by plan, check,
  and scan, and restored by the next apply of another site; a file changed
  since the interrupted write is not overwritten and the journal stays; a
  failed scan keeps the verified write and the journal, apply then
  refuses, and a scan finishes it; no Git previews but refuses the write);
  `test/lib/operator.test.ts` (the pre-write hash check, absent and
  wrong, and a failing `beforeWrite` write nothing);
  `test/cli/args.test.ts` (apply's words and `--write`, refused elsewhere);
  and `test/atlas.test.ts` on the built CLI over a committed copy of the
  semantics fixture with a `require`: check exits 3; a dirty written file
  refuses (1) and writes nothing; rules edited after the plan refuse (1),
  naming the rule; a preview exits 0 with a clean tree; `--write --json`
  exits 0 with one line, the file changed, `generatedAt` advanced, and no
  journal; check then exits 0; apply again exits 1.

**3.6 The scan after every write.** Done 2026-10-10. 3.0's item 4: both of
`apply`'s analyses come from datasets instead of `analyzeSurface`.
- "After" is the staged scan. `scan.ts` splits 3.5's `publishAfterWrite`
  into `stageAfterWrite` (the dataset, internals included, generated into
  `output.next` with the published one as `previous`, history hardlinked
  in), `publishStaged` (swap, then `recordSavedDataset`), and
  `discardStaged`. The mutator's `analyzeAfter` returns the staged package
  report, so `verifyInternalizeExport` reads the dataset that will be
  published, and the second `analyzeSurface` is gone. On a failed check, an
  error, or a signal the files are restored and the staging discarded: the
  published dataset is untouched (tested file by file). A scan that fails
  leaves nothing to verify against, so the write rolls back ("The scan
  after the write failed, so Atlas restores every file it wrote: …"); a
  worker the signal stopped counts as the signal. Decision 9's "applied,
  but the scan failed, files stay" now holds only for a failure in the
  final swap or in recording it; cli.md's exit table says so. The staged
  scan now runs before the scripts are run again, since the structural
  checks precede them; the interrupt e2e waits for the script by a marker
  file, and a new case interrupts the staged scan.
- "Before" is the saved report, when the dataset is current (A9). The
  manifest's `generation` gains an optional `inputs: { hash, config }`
  (Changes row; output.md): `hash`, `workspaceInputsHash` over the five
  components `collectWorkspaceInputs` already computes at the scan's
  fingerprint phase (analysis version, the start-of-UTC-day clock, the
  exclusions and profile, Git's commits and tracked files, every input
  file's hash); `config`, the exclusions-and-profile component alone.
  `lib/dataset-current.ts` `datasetCurrency` recomputes it with the same
  units and clock. So a dataset is current exactly on the UTC day it was
  scanned, with no commit (and no tracked file added or removed) and no
  source edit since, under the same exclusions, profile, and analysis
  version; `.foundry/` and the rules are not inputs. Apply loads the
  configuration, recomputes every component, and refuses a dataset that is
  not current (`stale-dataset`, "The saved dataset is stale: …. Run atlas
  scan.") before any script runs; then the mutator validates against the
  saved report (`before`), and the preview needs no analysis either.
- Plan runs the same check and fails early (1), without loading the
  configuration: the hash can be recomputed without it except for its
  config component, so plan takes that component from the manifest. The
  alternatives were reading the `exclude` setting, which means running the
  configuration files and breaking the invariant, or skipping the check,
  which lets plan run minutes of scripts against a stale dataset. The cost:
  an exclusion edited since the scan is not caught by plan, only by apply,
  which loads the configuration. Units come from the manifest's packages;
  the cruise is workspace-wide, so only their presence matters.
- The saved report agrees with a fresh analysis on every field validation,
  verification, and the mutator read (the symbols' identity, exposure, and
  outside use; each internalize plan whole; the summary's counts): a test
  compares the deps fixture's saved reports with `analyzeSurface` for three
  packages, and another that the dataset apply publishes equals, file for
  file, what a later `atlas scan --history` saves, apart from the two
  manifests' timings, with the same `inputs`.
- Cache churn after a rollback: the staged scan caches the written
  sources' local analysis and assembled reports, and records the written
  inputs, so the next scan after a rollback analyzes the package again and
  derives the workspace again (on the deps fixture 1 package analyzed, 20
  reused, `derived: true`, 1.4 s, then 0.17 s); on Foundry that is a
  one-file edit's scan, about 30 s by 3.0's table.
- Not done: passing the project `apply` builds through (about 3 s by 3.0;
  the planning context forbids AST changes), and splitting the derivation
  key; both stay candidates. The mutator still builds one ts-morph project
  for its edits and the TypeScript diff.
- Measured on a fresh `git clone` of Foundry at c97bb1b under `/tmp`
  (its own `bun install`, a committed `permit` on `packages/workspaces`;
  never the user's checkout), one run each:

  | Step | 3.0 | 3.5 | 3.6 |
  | --- | --- | --- | --- |
  | Cold scan | 40.4 s | 49.7 s | 44.7 s (8.6 GB) |
  | Warm scan | 3.0 s | | 4.3 s |
  | `plan` | | 6.2–7.7 s | 9.9–10.0 s (2.9 GB), its scripts 3.5–3.9 s |
  | Preview | | 29.9 s | 12.9 s (4.4 GB) |
  | `apply --write` with its scan | 32.9 + 35.7 s | 82.4 s | 53.1–55.2 s (8.2 GB): the staged scan 36.4–36.7 s, scripts 3.4–4.0 s before and 3.5 s after |
  | Scan after that | | | 4.3–4.4 s (warm) |
  | `plan` after a commit | | | 2.4 s, refused stale |
  | Scan after a commit | 30.3 s | | 37.8 s |

  Same day, the cycle plan, preview, write is about 76 s against 3.5's
  119 s; the write itself takes about 28 s less than 3.5's. After a commit
  the dataset is stale, plan refuses in 2.4 s, and a scan that re-derives
  (37.8 s) comes first. The next-day case was not measured, since the clock
  cannot be moved here: the UTC day is the hash's `clock` component, so it
  refuses as a commit does, and 3.0 measured the day's first scan
  re-deriving in full. On a committed copy of the deps fixture: cold scan
  9.4 s, warm 0.82 s; plan 0.92 s; preview 1.08 s; write 2.91 s; the scan
  after it 0.76 s; after a commit plan refuses in 0.57 s, the scan takes
  1.76 s, then plan 0.85 s and write 2.83 s.
- Tests: `test/lib/codemod.test.ts` (an edited file makes apply refuse
  `stale-dataset` before any script, and plan fail early; the edit, the
  dirty, and the moved-source tests now scan after editing; a failing
  script leaves the published dataset file for file as it was and no
  staging; the published dataset equals a later scan's; the field-level
  agreement); `test/atlas.test.ts` on the built CLI (plan fails stale after
  an edit, then succeeds after a scan; Ctrl-C during the staged scan exits
  130 and restores).

**3.7 Domains reaching the gates,** through anchors, if a codemod needs
them. Done 2026-10-10: not needed for 0.1, decided by the orchestrator.
- The one executable codemod, `internalize-export`, only narrows a
  symbol's exposure inside its package. It moves no facet, so every
  `path#symbol` a domain declares stays valid after it.
- Anchors gate `fold-package` only (`operator.test.ts`, "leaves
  internalization plans unaffected"), and `createInternalizeOperator`
  adds anchor preservation only for an anchored package; Foundry has
  declared none since 1.7.
- So the two "Only if domains feed anchors" rows below stay open, and
  come due with the first codemod that moves, rehomes, or folds, which is
  also when a Foundry scan gets an anchor back.

**3.8 A second codemod kind,** chosen by the maintainer. Done 2026-10-10:
deferred beyond 0.1, decided by the orchestrator acting for the
maintainer.
- A second kind must have a plan the dataset produces (so `check` and
  `plan` have a source), a planner, and a mutator that stays inside one
  package, creates and deletes nothing, and restores byte for byte. No
  catalog kind but `internalize` meets that: `fold-package` moves and
  deletes a package and edits manifests; `move`, `rehome-concept`, and
  `rehome-behavior` plan edits no mutator performs; `redirect-dependency`
  takes manual input only; the `preserve-*` kinds write nothing.
- The candidate, `rewrite-import` and `update-test-import` under
  `internalize`, would unblock plans that carry the
  `internal-entrypoint-import` blocker. It needs analysis changes the
  ground rules rule out for 0.1, written up in
  [`_codemods.md`](./_codemods.md#a-second-kind-deferred).

Taken up 2026-10-11 by the orchestrator acting for the maintainer: that
candidate, in two units committed back to back and never released apart,
(a) the analysis and (b) the mutator. The orchestrator's rulings: tests
keep a blocker of their own (D1), a moved name merges into an existing
import of the declaration's module (D2), the new import goes right after
the old one, unsorted (D3), the policy goes to 26 (D4), the permit need not
cover importer files (D5), and the preview keeps whole statements (D6).

**3.8 (a) The analysis.** Done 2026-10-11. Plans repoint the package's
own importers of an entrypoint; nothing writes them yet.
- One scope for both stacks: an import declaration in the package is
  repointed when its specifier resolves to a route file the plan edits and
  binds that route's exposed name, however the specifier is spelled
  (package name, subpath, relative, `.js`). `plan.ts`'s `EntrypointContext`
  gains `internalImporters` (exposed name → importing file, form `import`,
  `default`, or `reexport`, and whether it is a test) and
  `starReexporters`, scanned from every package module but the entrypoint;
  re-exports in other entrypoints are routes, not importers. The operator
  side adopts the scope: `operator-plan-source.ts`'s
  `internalEntrypointImporters` is a set of routes, and `operator-plan.ts`'s
  `internalImporters` takes the route and keeps sites resolving to its
  file that bind its name (R2b), each site rewritten once across the
  symbol's routes. Before, it rewrote only sites spelled with the package's
  name, and all 55 rewritable Foundry plans import relatively.
- A `named-reexport` or `type-export` route whose exposed name has internal
  importers is planned with one `rewrite-import` change per importer file,
  then its removal, when the route is a re-export (`export … from`), every
  importer is a named import (`import { X }`, `import type`, an inline
  `type`, an alias), none is the declaration file, none is a test, and the
  declaration file exports the symbol under its own name and keeps that
  export. The last condition is new beyond the plan: when the declaration
  sits in another entrypoint whose export modifier the plan removes, the
  importers would follow it to an export that goes (3 plans on Foundry).
  Otherwise the route is blocked by `internal-entrypoint-import`, with a
  detail per case (default import, internal re-export, the declaration
  file, the name, the declaration's entrypoint, a local export list), or,
  when tests are the only obstacle, by `internal-entrypoint-test-import`
  (D1). Direct declarations keep today's gate. `preservedBehavior` names
  the repointed files. A side-effect import beside them is not an importer.
- A module that `export *`s or `export * as`s the entrypoint now blocks
  every route through it, a direct one included (R2): before, such a plan
  was `ready` while removing the name broke that module's importers. None
  on Foundry.
- `lib/import-specifier.ts` `importSpecifierFor(importer, target, hint?)`,
  which the operator side uses and the mutator will: the importer's own
  specifier for the module when it has one (D2's case: 27 of the 133
  Foundry sites the plan's probe counted); else a relative path in the importer's majority style
  (extensionless, `.js` with `.ts`/`.tsx` → `.js`, `.mts` → `.mjs`,
  `.cts` → `.cjs`, or `.ts` keeping the source's extension; a tie goes
  extensionless, then `.js`); else in the route statement's style; else
  extensionless. `/index` is never dropped.
- `intelligence.ts`'s scale counts the repointed files (R6): route files as
  source, importers by kind, `imports.sites` one per importer and route,
  `imports.moduleEdges` their files. `explanations.ts` rewords
  `internal-entrypoint-import` and adds `internal-entrypoint-test-import`
  with what lifts it.
- `ANALYSIS_POLICY_VERSION` is 26; the Changes row lists what moves
  (R7). Plan fingerprints cover blocker reasons and change files and kinds,
  not the policy, so only plans whose changes or blockers moved changed
  fingerprint: on the deps fixture none (a test pins all twelve at
  461822b), on Foundry 58.
- The stop-gap (R7b): `applyReductionPlan` refuses a plan carrying a
  `rewrite-import` change with `apply-unsupported` and writes nothing. It
  reports `blocked`, beside the dirty-file check after validation, rather
  than `unsupported` before the analysis: the function sits at Biome's
  complexity limit, and one more branch fails `check`. (b) removes it. The
  bridge refuses such a plan first in any case: `internalize-export does
  not perform rewrite-import` (tested on a temporary fixture), since
  `MUTATOR_TRANSFORMATIONS` lacks the kind until (b).
- The planning fixture's `helperOnly` flips from `unsupported`
  (`internal-entrypoint-import`) to `ready`, repointing
  `packages/core/src/internal-user.ts`. The operator side always planned
  that rewrite (its specifier `@p/core` becomes `./helper`, the route
  statement's style, as before); `operator-plan.test` and
  `operator-readiness.test` plan it from synthetic facts, not the saved
  plan, so none of their assertions moves. A test pins the flip.
- Known gaps of the scope, recorded: `import X = require(...)`, dynamic
  `import()`, and `.js` source importers are not seen (the program loads
  `.ts` and `.tsx`); a direct declaration's internal named re-exports and
  default imports stay unblocked, as before. `importSitesOf` leaves out
  the declaring file, so only `plan.ts` sees the declaration file
  importing its own symbol through the entrypoint; the bridge still
  refuses, since the saved plan is not ready.
- Measured on Foundry at 461822b, read-only (the user's checkout, scans
  with `--state` under `/tmp`, nothing written into it), one cold scan
  each, before with the 461822b build:

  | | Before | After |
  | --- | --- | --- |
  | Internalize plans | 4,383 | 4,383 |
  | Ready | 141 | 142 |
  | `internal-entrypoint-import` (plans) | 128 | 72 |
  | `internal-entrypoint-test-import` (plans) | | 55 |
  | Plans with `rewrite-import` changes | | 2 (3 changes) |
  | Plan fingerprints moved | | 58 |
  | Cold scan | 48.4 s (8.2 GB) | 50.9 s (8.5 GB) |

  The 141 ready plans are the same by id and fingerprint. The new one is
  `@foundry/workflows`' `createExtensions`, repointing `orchestrator.ts`
  from `./store` to `./extensions`. Of the 72 plans' 74 import blockers, 70
  are direct declarations, 3 a declaration in an entrypoint whose export
  goes, and 1 an internal re-export. For 54 plans a test is the only
  blocker.
- The finding, for the maintainer: with D1, 3.8 makes one more Foundry plan
  ready. Most plans the importer scan would unblock are held by a test as
  the consumer the opportunity gate does not see; 48 of the 55 would edit
  `packages/workflows/src/test/public-surface.test.ts`, a pin test that
  repointing keeps passing while it asserts nothing. The real yield waits
  on a decision to allow tests, which is one predicate and a policy bump,
  since the mutator and registry keep `update-test-import`.
- Tests: `test/lib/plan-importers.test.ts` on temporary committed fixtures
  (`test/lib/helpers/importer-fixture.ts`): every named shape, the blocked
  ones, the star and namespace cases, fingerprints stable across two
  analyses, the deps fixture's plans pinned, the scale, the operator side's
  specifiers and blockers, one rewrite for a name exposed twice, the bridge
  verdict, and the stop-gap; `test/lib/import-specifier.test.ts`.

**3.8 (b) The mutator.** Implemented 2026-10-13; independent review pending.
- `apply-imports.ts` repoints internal named imports before `apply.ts` removes
  the public routes. Splits preserve other names, default bindings, aliases,
  declaration-level `import type`, and inline `type` specifiers. Renamed
  re-exports import the declaration's own name while retaining the local binding.
- A compatible existing import of the declaration's module receives the moved
  name; otherwise a split import goes immediately after the original, unsorted.
  A value import never merges into a type-only declaration. Specifiers use
  `importSpecifierFor`, shared with the planner.
- All importer files join the route files in dirty-file gates, byte and mode
  snapshots, stale-hash checks, the journal and rollback. Previews report whole
  import statements and leave disk untouched. The temporary refusal from (a)
  is removed.
- The default capability registry advances to 3 and supports named and type
  `rewrite-import` forms, both package and relative. The authorization bridge
  matches the saved plan's importer files as well as its routes. Test-import
  rewrites remain unsupported and tests of the entrypoint remain blocked.
- Proof includes actual writes with structural verification, exact-byte rollback,
  dirty and stale importers, aliases, split and merged imports, preserved type
  semantics, and the public scan/authorize/preview/apply/refresh lifecycle with
  a real Bun test command. Independent review has not been performed.

- Validation: `bun run validate` passes, including the Atlas build, workspace
  typechecks, dependency consistency and dead-code checks. The full Vitest
  suite passes 1,938 tests across 143 files with two workers. The initial
  concurrent run timed out in two repeated-analysis cases; the import-shape
  cases now share one fixture without increasing test timeouts. All 36 Bun
  integration tests pass with local-server permissions; the restricted run
  could not bind its temporary ports. No source changes were needed for that
  environment restriction.

**Phase 3 is done** (2026-10-10). Rules are declared, checked, and gate
the one codemod, which writes only under a rule that permits it.
- 3.1: `{ operator, subject, effect }` in `.foundry/atlas/`, subjects
  matched as domain facets are; not an analysis input.
- 3.2: `authorizeMutationPlan` answers refused by rule, not executable,
  the readiness verdict, or a record naming what it authorizes by id and
  fingerprint part.
- 3.3: the `rules` lens and `atlas check`, exit `3` on a broken rule.
- 3.4–3.5: `atlas plan` saves an authorization; `atlas apply` previews
  it and, with `--write`, journals, writes, verifies, restores on any
  failure or signal, and scans again.
- 3.6: the scan after a write is staged and read as "after"; "before"
  comes from the saved report while the dataset is current. A write on
  Foundry takes about 54 s, against 82 s in 3.5 and 69 s for 3.0's apply
  plus refresh.
- Left for later, by design: a second kind (3.8, taken up 2026-10-11 as
  3.8 (a) and (b)), domains at the gates
  (3.7), splitting the derivation key and passing the apply project
  through (3.6's candidates), `rule:<n>` as `plan`'s argument, and the
  per-setting digest, which still has no consumer: rules name facets, not
  domains.

## Phase 4: the viewer

Detail in [`_viewer.md`](./_viewer.md#questions).

**4.0 Decide the viewer's direction.** Done 2026-10-10, decided by the
orchestrator because the maintainer could not be asked; the answers are in
[`_viewer.md`](./_viewer.md#questions).
- Why the engraved survey was rejected is recorded nowhere. The work
  proceeds without reversing it, and takes three of its observations
  piecemeal, since none conflicts with the chart: relief is never darker
  than a file mark (4.2a), responsibilities lead inside an island, and
  packages carry no pigment. Its plan-view camera and its single typeface
  are not taken. That departures read without a toggle (4.2b) follows from
  [question 1](./_viewer.md#what-the-map-answers), not from the survey.
- The problem is legibility: the chart metaphor stays, and what changes is
  what is on by default and how strongly it is drawn. Decoration that
  carries no data is deleted, not hidden (4.1), and position carries no
  import pull (4.3a): north–south is the dependency layer, west–east the
  folder order, and inside an island the folder tree. Relationships are
  carried by marks that say so, departures and ties, not by distance.
- Two groupings, one meaning each: position and outline mean folder (and,
  north–south, layer); an outline is a folder, the package's own being its
  coast; pigment and labels mean responsibility, and only responsibility, so
  islands carry no package hue and a package, which is a folder, is told
  apart by its coast and outline; Place says which.
- The reader is someone exploring locally after `atlas scan`; a reader of a
  static `atlas export` comes second. Reviewing a PR is out of scope for
  0.1.
- The developer flag is `import.meta.env.DEV || ?dev`, read once in
  `web/ui/app.tsx`: the dev server and any page opened with `?dev` are a
  developer session. A URL parameter, unlike a build-time variable, reaches
  a static export too.
- Order: the measurement marks, 4.1, 4.2a, 4.3a, then 4.2b to 4.2d as their
  lenses' fields are read, 4.3b, 4.3c, and 4.4. 4.2b to 4.3c are planned
  against the real lens fields when they start.

**Measuring the viewer.** Done 2026-10-10, before any drawing changes, so
that every later effort has a before.
- `web/timings.ts` names five load marks, recorded through the Performance
  API once per page, so a scene built again after a layout change adds no
  second mark: `atlas:data-requested` and `atlas:data-loaded` around the
  codex's read, `atlas:layout-settled` when `loadAtlas` returns,
  `atlas:terrain-built` once the scene has built its relief, and
  `atlas:first-frame` after the first frame is submitted. A reader's
  session records these marks and nothing else.
- In a developer session, each repaint's stages are measures too:
  `atlas:paint:ink`, `boundaries`, `sea-ink`, `relief`, and `lettering`.
  They are the scene's stages, not each painter's: `paintMap` is one stage,
  `ink`, until 4.2a times each layer painter. Separately,
  `atlas:render-submit` is the CPU time to encode and submit a frame; it is
  not a repaint stage, since it fires on every frame the atmosphere loop
  draws until 4.1 removes that loop. GPU time is not measured.
- Each timed stage keeps at most its latest 240 measures: at the cap its
  measures are cleared and counting starts again, so a long session's
  entries stay bounded.
- `createAtlasScene(host, data, options)` takes one options object, which
  carries `developer`, instead of ten positional parameters.
- `scripts/capture.ts` gains a `marks` step: the marks in milliseconds
  since navigation, the requests under `data/` and their decoded bytes, and
  each timed stage's count, median, and maximum over the measures the page
  still holds. It also gains `--angle` (ANGLE's backend: `metal` for the
  GPU on macOS, SwiftShader otherwise) and `--webgl`, which hides
  `navigator.gpu` before the page loads so the renderer takes its WebGL 2
  backend; neither applies with `--webgpu`. The script drives Chrome over
  the DevTools Protocol, outside the default test command, in place of the
  planned Playwright capture, because Playwright is no dependency of the
  repository and the script already drove the same browser.
- Tests: `test/web/timings.test.ts` (once per page, developer only, the
  cap); `test/web/app.test.ts` (a reader's session, `?dev`, and the dev
  server); `test/atlas.test.ts` checks that `loadAtlas` over a served scan
  records its three marks in order; `test/web/atlas-map.test.ts` checks
  that `developer` reaches the scene.
- Baseline, measured before the cap and the once-per-page rule, which do
  not change these numbers: a scan of this repository (15 packages, 1,552
  files), served by `atlas serve`, in headless Chrome 155 on an Apple M4
  Max at 1500×1000 and a pixel ratio of 1, three runs each:

  | Backend | data loaded | layout settled | terrain built | first frame |
  | --- | --- | --- | --- | --- |
  | WebGPU (Metal) | 73–88 ms | 412–429 ms | 3.81–3.87 s | 4.21–4.28 s |
  | WebGL 2 (ANGLE on Metal) | 77–115 ms | 414–453 ms | 3.79–3.85 s | 4.27–5.34 s |
  | WebGL 2 (SwiftShader) | 73–77 ms | 399–418 ms | 5.86–6.44 s | 18.3–19.2 s |

  The load reads 20 files, 1.71 MB decoded. About 3.4 s of the first frame
  falls between the settled layout and the built terrain; how it splits is
  not measured. It holds the fonts, the renderer's start, the 4096-pixel
  sea, the water's current and wave fields, and the relief.
- At island zoom, in a developer session on WebGL 2 on Metal, panning and
  zooming kept pace with 60 Hz, with no long task. Over all 295 repaints of
  that run, the ink stage took 1.3 ms at the median and 3 ms at most, and
  every other stage under 1 ms.
- Entering islands raises the data read to 36 files, 9.24 MB decoded, the
  difference being their internals. These numbers hold for this workspace
  and this machine only; nothing here validates a budget for a larger
  workspace. Nor is the layout validated beyond it: a flat workspace with
  many layer-0 packages gives one wide row (4.3a).

**4.1 Reader settings and renderer settings.** Reader settings are only
layers that carry data; the rest is a developer session's or is deleted.
- The developer flag from the measurement work reaches `createAtlasScene`.
  No scene builds a wave or current field any more. A reader never ran the
  30 fps loop, since the atmosphere that drove it started off; the loop is
  gone for everyone.
- `ChartSettings` splits into `ReaderSettings` and `DeveloperSettings`, and
  the Chart panel into a reader's section and a developer's.
- Deleted: forests; houses (`settlementTier`); `scene/ecosystem-layer.ts`;
  the ports' warehouses and beacons; the props' shadow map; wind and waves
  (`scene/wave-field.ts`, the wind strokes); the current (the pigment
  advection); the chart filters; and the water pigment picker.
- Behind the developer flag: roads and connecting land, a third and fourth
  drawing of package dependency; the rendering controls and the stage
  inspector.
- Kept: wrecks.
- The atmosphere's deletion is paired with hover ink, so a hovered island
  is still marked.
- The panel's stale copy is fixed.
- `atlas:first-frame` and `atlas:render-submit` move out of the
  atmosphere's callback, with the loop they sat in, into the repaint.
- Split in two units, so each is reviewable: 4.1a, the still chart (the
  animation and the loop it ran in), and 4.1b, the reader's settings (the
  settings split and the remaining deletions).

**4.1a The still chart.** Done 2026-10-10. Nothing on the chart moves on its
own, and a frame is drawn only when a repaint asks for one.
- Deleted: the atmosphere layer (`scene/atmosphere-layer.ts`: coastlight
  and the wind strokes, and the loop that drew them and the sea);
  `web/atmosphere.ts`, apart from `insidePolygons` and `islandAt`, which
  are `web/polygons.ts` now; wind and waves (`scene/wave-field.ts`); the
  current (`scene/current-field.ts`, `scene/coastal-current.ts`, the
  pigment advection in `scene/water-material.ts`, and `currentStrength` in
  `codex/bindings.ts`); playback (`scene/playback.ts`, the scene's
  `getPlayback`, `play`, `seek`, `restorePlayback`, `setPlaybackSpeed`,
  `setTrackPlaying`, and `setCurrentTime`, and the `atlas:current-time`
  event); the water pigment picker and water contrast; the header's
  Decorative atmosphere button with `AtlasState.atmosphereEnabled`; the
  pipeline's `overlay` input, which only the atmosphere used; and the
  chart settings' Playback, Wind, Current, and Waves sections. Their tests
  go with them (`atmosphere`, `ocean-atmosphere`, `wave-field`,
  `current-field`, `coastal-current`, `playback`), except the 2.2f
  characterization in `current-field.test.ts`, which pins the route
  weights against the captured fixture's 65 pairs and moves, unchanged,
  into `test/web/codex/resolve.test.ts`.
- `scene/water-material.ts` is the painted sea sheet under the paper
  surface, thinned over wrecks: one texture sample and the wreck mask, no
  current or wave field. Wrecks are kept.
- `drawMap` submits each frame itself (`submitFrame`): the wreck reveal,
  then `atlas:render-submit`, then `atlas:first-frame`, which `markLoad`
  records once.
- Hover ink (`scene/hover-ink.ts`) is new for readers, who never saw the
  coastlight, since it drew only with the atmosphere on: the hovered
  island's coast in amber, a 1.6-pixel line over a 6-pixel band, drawn on
  the ink canvas after `paintMap`; a selected island keeps its gilt ring.
  The island is asked for again at every repaint (`scene/hover-target.ts`):
  the resting pointer is kept, and cleared when it leaves the map, and the
  repaint's own hit test names the island under it, looked up by id in the
  territories being drawn. A wheel zoom toward the cursor keeps the ink;
  Escape or a header zoom, which move the camera under a still pointer,
  move it to the island now under the pointer or drop it.
- Measured as before, against this branch at `72e1c7f` built in a temporary
  copy, three runs each:

  | Backend | Build | terrain built | first frame |
  | --- | --- | --- | --- |
  | WebGPU (Metal) | before | 3.61–3.62 s | 3.98–3.99 s |
  | WebGPU (Metal) | after | 2.93–3.20 s | 3.31–3.60 s |
  | WebGL 2 (ANGLE on Metal) | before | 3.58–3.66 s | 4.03–4.10 s |
  | WebGL 2 (ANGLE on Metal) | after | 2.85–2.90 s | 3.25–3.51 s |

  The data read is unchanged: 20 files, 1.71 MB decoded. At rest, over
  5 s at the overview and in a developer session (`?dev`), since only it
  counts frames, neither build submits a frame in its default state, because the atmosphere started off; the main thread is 0.4–1.4%
  busy in both. With Decorative atmosphere on, the build before submitted
  113 frames in those 5 s, with the main thread 2.7% busy; that state no
  longer exists. Panning at island zoom still kept pace with 60 Hz, with
  no long task. `scripts/capture.ts` gains an `idle=<ms>` step for these:
  main-thread task and script time over the window, and the frames
  submitted in it, counted by one observer that is disconnected at the
  window's end, and `null` outside a developer session.
- Tests: `test/web/polygons.test.ts` (the containment case kept from the
  atmosphere tests); `test/web/hover-ink.test.ts`;
  `test/web/hover-target.test.ts` (a wheel zoom keeps the island; a camera
  moved under a still pointer moves or drops it; leaving drops it; the
  island is the repaint's, and never the selection);
  `codex/resolve.test.ts` (the 2.2f characterization, moved); `atlas-shell.test.ts`
  (no Decorative atmosphere in the header; no Playback, Wind, Current,
  Waves, water pigment, or timeline in chart settings); `atlas-map.test.ts`
  without playback or atmosphere.

**4.1b Reader settings.** Done 2026-10-10. A reader's Chart section holds
only layers that carry data; the rest is a developer session's or deleted.
- `web/chart-settings.ts`: `ReaderSettings` (`trade`, `streams`,
  `volcanic`, `contours`, all off) and `DeveloperSettings` (the layout's
  `coastalBuffer` and `islandClearance`, `boundaries`, `layers: { land,
  roads }`, `rendering`); `ChartSettings` is their intersection, and the
  test pins that their keys are disjoint and cover it.
- The panel: `ui/reader-settings.tsx` (Layers: sea trade routes, district
  streams, recorded change, topographic lines) and `ui/developer-settings.tsx`
  (Dependency, drawn again: connecting land and roads; Display boundaries;
  Rendering, with the render-status readout polled only while it is
  mounted), composed by `ui/chart-settings-panel.tsx`, which renders the
  developer's section only in a developer session. The stale copy
  ("Experimental layers", "Roads and forests require connecting land") is
  gone.
- Sea trade routes are a reader's setting: the scene reads `settings.trade`
  at each repaint, so turning them on goes through `configure` and builds
  no new scene. Connecting land and roads stay scene options, behind the
  developer flag, and still rebuild it; the map's scene effect depends on
  `layers.land` and `layers.roads` as values, so a Reset or any reader
  setting, which makes a new settings object, builds no new scene either.
- The boundary overlays and the layout's tuning (coastal buffer, island
  clearance) move behind the flag because they draw the layout's own
  geometry, not data the scan measured.
- Deleted: forests and houses (`continent.ts` `forestSites` and
  `settlementBuildings`, `codex/bindings.ts` `settlementTier` with its
  test and README rows); `scene/ecosystem-layer.ts`, whose connecting-land
  mesh is `scene/continent-ground.ts`; the ports' warehouses and beacons
  and their picking (`trade-layer.ts` draws only lanes, and `resolveHit`
  no longer hit-tests ports); the chart's shadow map and every shadow flag
  in the chart scene, so the chart's wreck no longer casts a shadow; the
  wreck layer keeps its shadow flags, since the wreck dive shares it and
  keeps its own shadow map; and the chart filters
  (`chartFilters`, the pipeline's `filter` option, its grades and Sepia
  stage, and the map element's CSS filter with the `atlas:render`
  listener that only served it).
- Measured as before, against `bd4fd6f` built in a temporary copy, three
  runs each, interleaved, on a machine under other load:

  | Backend | Build | terrain built | first frame |
  | --- | --- | --- | --- |
  | WebGPU (Metal) | before | 2.93–3.77 s | 3.33–4.15 s |
  | WebGPU (Metal) | after | 2.92–2.93 s | 3.28–3.31 s |
  | WebGL 2 (ANGLE on Metal) | before | 2.92–2.96 s | 3.40–4.13 s |
  | WebGL 2 (ANGLE on Metal) | after | 2.89–3.01 s | 3.30–3.68 s |

  No change beyond the noise, as expected: everything deleted was off by
  default, and the shadow map was drawn once. The data read is unchanged,
  20 files, 1.71 MB decoded; at rest under `?dev`, neither build submits a
  frame in 5 s, with the main thread 0.3% busy.
- Tests: `chart-settings.test.ts` (the split); `atlas-shell.test.ts` (a
  reader sees only Layers and its four layers; a developer also sees
  Developer, its three sections, connecting land and roads, and no houses,
  forests, or map filter); `atlas-map.test.ts` (trade goes through
  `configure` without a new scene); `atlas-shell.test.ts` again (Reset in
  a reader's session builds no new scene); `trade-layer.test.ts` (one lane per
  route and nothing else); `continent.test.ts`, `codex/bindings.test.ts`,
  and `pipeline.test.ts` lose the forest, settlement, and filter cases.

**4.2 The four questions by default,** from the phase 2 lenses, with
departures as the strongest signal.
- **4.2a** First, `paintMap`'s positional parameters (sixteen, after 2.2d
  removed one) become one options object, before any drawing changes: 2.2d
  had to drop an argument at every call site by position, and a shifted
  argument still type-checks wherever two neighbors share a type.
  `paintMap` becomes an ordered list of layer painters, and each painter
  is timed as its own stage, in place of the one `ink` stage. Done in
  4.2a(i). Required in 4.2a(ii), not optional: each layer runs inside its
  own `ctx.save()` and `restore()` in `paintInk`, so no layer inherits
  another's drawing state, with the pixel compare run again afterwards to
  show what that alone changes.
  Then the ink ladder: one ink module ranks every mark's contrast against
  its ground, and with it islands lose their package hue, since pigment
  means responsibility only (4.0). Its table of hue × dash × weight →
  meaning has a row for hover ink (4.1a), which must stay distinct from
  the selection's gilt: today hover is amber `rgb(190, 132, 48)`, solid,
  1.6 px over a 6 px band, and the selection ring is gilt `#b38a32`
  (`rgb(179, 138, 50)`), nearly the same hue, told apart only by weight.
  The ink pass also rewords DESIGN.md's "ports" and "settlements" (files
  drawn as settlements, lanes' harbors), left as they are by 4.1b.

**4.2a(i) The ink canvas as layers.** Done 2026-10-10, with no visual
change; 4.2a is split in two, and the ladder, relief, and legend are
4.2a(ii).
- `scene/paint-map.ts` (1,257 lines, sixteen positional parameters and a
  mode string) is three functions and 130 lines: `paintSea(canvas, data,
  continents)` and `paintCoast(canvas, data, continents)` for the two
  sheets painted once, and `paintInk(canvas, options)` for the ink canvas
  at the view, which takes one `InkOptions` object and returns the labels
  placed.
- `scene/ink/state.ts` resolves the options once into an `InkState` (the
  unpinned focus, the composition dropped off screen, the matched region,
  the evidence files, the zoom's detail and region strength), and
  `scene/ink/layers.ts` holds `inkLayers`, the ordered list every repaint
  runs: chart grid, sea ripples, coast, relief, belonging, connections,
  files, responsibility, file focus, labels, topography, selection, grid
  references, compass, sea caption, boundaries, hover. That list is the
  map's z-order. The boundary overlays and the hover ink, which the scene
  painted after `paintMap`, are its last two layers; the hover layer asks
  the scene for the island under the pointer once the labels are placed,
  through `hit(pointer, placed)`, so a label is still hit before the land
  beneath it.
- Each layer's code is in its own file under `scene/ink/` (belonging,
  coast ink, compass, connections, file focus, files, labels,
  responsibility, sea caption), renamed, bodies unchanged; the
  layers that already had a painter (grid, ripples, relief, topography,
  selection, grid references, boundaries, hover) are entries that call it.
  Layers share one context and inherit each other's drawing state, as the
  painter they came from did; 4.2a(ii) gives each its own (see 4.2a).
- The focus path no longer repaints the coast sheet: that paint never
  depended on the selection, and a rebuild repaints it. Deleted with its
  texture upload.
- Each layer is timed in a developer session as `atlas:paint:ink:<layer>`,
  inside the whole canvas's `atlas:paint:ink`; the scene's `boundaries`
  stage is now the `ink:boundaries` layer, and the hover hit-test, which
  ran outside the ink stage, now counts under `ink` and `ink:hover`. On
  this repository at island
  zoom (WebGL 2 on Metal, 150 repaints), every layer's median is 0.5 ms or
  less, files 0.5 ms and labels 0.3 ms the largest, for 1.5 ms of ink.
- No visual change, shown by pixels: the same five views captured from the
  build at `441a4c8` and from this one, with the pipeline Off so the frame
  is deterministic (the default tier's occlusion noise differs between two
  runs of one build), and compared in the page by the capture script's new
  `compare=<a.png>,<b.png>` step. The overview, a hovered island, the
  selected `@foundry/atlas` island, its close zoom, and the overview with
  every reader layer and all six boundary overlays on: 0 of 1,500,000
  pixels differ in each. Two runs of the build before agree exactly on the
  first four and on all but 749 pixels (at most 4 of 255) of the fifth.
- Tests: `paint-map.test.ts` and `paint-features.test.ts` call
  `paintInk(canvas, { … })`; `paint-map.test.ts` adds that every layer is
  painted once in `inkLayers` order and timed only in a developer session,
  and that the hovered island is asked for once, after the labels, and
  that every layer reading the placed labels runs after the labels layer.

**4.2a(ii) The ink ladder.** Done 2026-10-10. 4.2a(ii) is split once more:
this unit is the ladder, the relief, and the package hue; the latitude
scale, the always-visible legend, the map key read from the ink table, and
DESIGN.md's "ports" and "settlements" are 4.2a(iii).
- First, each ink layer runs inside its own `save()` and `restore()` in
  `paintInk`, on the ink canvas and the lettering canvas. The pixel compare
  against `441a4c8` stayed at 0 differing pixels in all five views, so the
  isolation alone changes nothing; everything below is the ladder.
- `scene/ink-ladder.ts` holds every colour the chart scene uses; a grep of
  `scene/` and `scene/ink/` for colour literals finds them only there. It
  has the sheets (`grounds`: land `#f1ead9` and sea `#d5dbca`, which the
  ladder measures against, and the shallows, the sea's depths, and
  connecting land), the named zooms (overview 1, island 2.2, close 10
  pixels per unit), the rungs strongest first (selection, departure, file,
  label, coast, relief, sea) with each rung's floor as a WCAG contrast ratio
  against its ground, every ink and its opacity, `ladderMarks` (each mark
  the ladder rules, its opacity a function of zoom), `inkTable` (hue, dash,
  and weight to meaning, by kind: line, fill, text), the lit materials and
  lights of the chart and the wreck dive (`materials`), and a developer
  session's boundary and road inks (`developerInks`). A mark meets its
  rung's floor and stays under the floor of the rung above.
- Contrast is measured in linear light, as the renderer blends: the ink and
  lettering canvases are sRGB textures composited over the scene in linear,
  and the paper's relief term multiplies its linear colour. Translucent
  inks read lighter than an sRGB blend would put them, so the numbers below
  replace the first draft's. Contrast with the ground, the same at the
  three named zooms unless shown:

  | Rung (floor) | Marks |
  | --- | --- |
  | selection (10) | file ring and name 12.74 on land; island ring at overview, and lines, 10.78 on sea |
  | departure (8) | 9.96 on land, 8.42 on sea; defined, drawn in 4.2b |
  | file (5.5) | story 6.40, entered ring 6.56 on sea (island zoom and closer), test 7.15, config 7.64, other 7.75, source 7.88 |
  | label (4.5) | caption 5.02, label 5.34 |
  | coast (1.8) | frame 1.90, rule 1.97, pen 2.90 |
  | relief (1.25) | steepest shade 1.26, land contour 1.35 |
  | sea (none) | ripple 1.01 to 1.10, minor grid 1.03 to 1.12 as it fades in, sea contour 1.14, grid 1.15 on sea and land |

- Measured on screen, with the capture script's new `probe=<shot>:<segment>`
  step (the darkest pixel along a segment against its median, in linear
  light), at default quality on this repository: a grid line on open sea
  1.06 to 1.07 (the 0.7-pixel line never reaches full ink); relief 1.13 on
  the beach slopes of the small islands, the steepest ground without file
  marks over it (the 1.26 of the steepest slope is reached only on summit
  flanks, under marks); coast ink, the pen over the frame, 3.36 and 3.55;
  a test file mark 7.01; and the entered ring 2.80 to 2.95 (one pixel, so
  antialiasing halves it). The ladder's numbers are each ink's own: a
  single thin line renders lighter than its ink, and stacked inks render
  darker (the coast pen over its frame, 3.36 and 3.55 against the pen's
  own 2.90).
- The selection is one deep amber-brown, `#3b1e06`: the island's ring at
  overview and its dependency lines (dashed to what it imports, dotted from
  what imports it, both opaque), the file's ring and name, and a focused
  natural feature's outline (which was the `#875222` amber). Once an island
  is entered (from `enteredAt`, 1.8 pixels per unit, where district pigment
  is fully in) its ring steps down to the file rung, `#4f4634` at 1 pixel:
  the breadcrumb carries the selection there, and a strong ring around
  every islet read as a second coast.
- Hover is `#9a5512`, a mid amber, opaque: 2.41:1 over the coast rule it is
  drawn on, 2.68:1 against the selection ink, 4.76:1 on land. Three to one
  from both is not possible, the rule being light and the selection near
  black, so the test holds 2.3 from each. Departures are magenta,
  `#681049`, with a notched ring and a dash-dot line as their second cue
  (`drawn: false` until 4.2b); story files move from plum to green,
  `#3f5a3a`, and a test keeps every file ink more than 60 degrees of hue
  from the departure's magenta.
- The table holds every reader-visible ink: the compass, the sea caption,
  the selected file's halo, a selected group's member mark and its paper
  edge, the stream's banks and glint, label halos, grid references, paper,
  and the architecture overlays (responsibility evidence, hints, links,
  notches, unresolved diamonds, composition declarations and blockers, the
  proposed positions, and both scenario routes). No two rows of one kind
  share hue, dash, and weight, and rows of one kind, hue, and dash differ
  by a pixel of weight or more. The `#875222` collision is resolved: a
  focused feature takes the selection ink; an overlay's members and the
  declarations a trace moves are one meaning, evidence in focus; and trade
  lanes (`[8, 6]` in map units), hints (`[1, 2]`), proposed positions
  (`[2, 2]`), and proposed scenario routes (`[3, 3]` at 1.2) share the
  evidence amber only by distinct dashes. The path-disagreement notch is
  2 pixels, a pixel heavier than a composition blocker in the same red.
- Optional layers and on-demand inks are outside the rung order: sea trade
  routes (a reader layer), streams, marsh drains, traced imports, the
  architecture overlays, and hover. The table still keeps each apart.
- Relief is one capped term: the island paper is unlit
  (`MeshBasicNodeMaterial`), and the slope turned from a north-west light,
  or the vertex's concavity where it is larger, multiplies its linear
  colour by 1 minus at most `inkAlpha.reliefCap`, 0.22, so the steepest
  shade clears the relief floor. The hachures are deleted
  (`scene/relief-ink.ts`, `reliefHachure` and its README row, the relief
  layer of `inkLayers`), and so is the material's separate occlusion
  strength (`setOcclusion`).
- Quality: the chart defaults to Light (`low`), which runs no screen-space
  occlusion on the chart. The wreck dive is floored at Balanced
  (`diveRenderSettings`): its perspective camera runs screen-space
  occlusion at every enabled tier, and at Light it did so at half
  resolution without denoising, which showed as noise.
- File marks no longer recede: overview specks kept 85% of their strength
  once districts faded in, which put them under the label rung; they keep
  full strength until file marks replace them. Labels are lighter
  (`#665e50`) and the coast pen is lighter (`#7a6a50`), as the rungs order
  them.
- The package hue is gone: `Territory.color`, the pigments in `loadAtlas`,
  the package swatch in Find, and the coast sheet's pigment wash. The land
  is the land ground, every coast wall one colour, and pigment marks
  responsibilities only.
- `codex/README.md`'s contradiction is fixed: it said `bindings.ts` held
  "every constant that tunes how a value looks" and that palettes stay with
  the painters; inks are the ladder's now, and the README says so.
- Screenshots for review, a reader's session at default quality, from the
  build at `441a4c8` (which draws as `a6a54b0` does) and from this one:
  `/tmp/review-shots/{before,after}-{overview,hover,island,close}.png`.
- Tests: `test/web/ink-ladder.test.ts` (every mark within its rung at every
  named zoom; the rungs in order, each rung's weakest mark above every mark
  below it; relief lighter than any file mark; the table's styles unique by
  kind; hover against the coast rule and the selection; departure's second
  cue; file inks away from magenta and distinct); `chart-settings.test.ts`
  (the chart Light, the dive never below Balanced); `paint-map.test.ts`
  (the layers draw with the ladder's inks and none of the replaced gilt or
  amber; specks at full strength); `hover-ink.test.ts`,
  `paper-material.test.ts` (unlit paper), `detail-level.test.ts`, and
  `pipeline.test.ts`; `terrain.test.ts` loses the settlement colours, now
  the ladder's; about fifteen fixtures lose `color`.

**4.2a(iii) The latitude scale and the legend.** Done 2026-10-10.
- The latitude scale (`scene/ink/latitude-scale.ts`, the
  `latitude-scale` layer of `inkLayers`, after the grid references) runs
  down the right margin: a rule, a tick for each dependency layer at the
  mean latitude of its islands as they settled (dependencies pull islands
  off their layer's nominal latitude, so the scale marks where a layer's
  islands are), and its number, "FOUNDATION · 0" at the south. It is a
  margin note on the lettering canvas, takes no part in label collision,
  and stops short of the legend. `AtlasData.packageLayers` maps each
  package to its layer: the codex now keeps an unplaced package's layer as
  `null` instead of 0, `loadAtlas` still seats it at the foundation, and it
  stays off the scale while its caption adds "NO LAYER". The reference
  capture has no layers, so its scale is empty and none is drawn.
- Drawing the scale showed that the record had north backwards:
  `_viewer.md`, the explore-the-map guide, and the overview page all said
  the foundations sit north. Layer 0, the packages that depend on no
  other, is at latitude 0, and each layer above it is 220 units further
  north; the foundation is south. All three are corrected.
- The legend (`ui/map-key.tsx`) is always open at the lower right (moved
  from the lower left, where at overview it covered an island; it moves
  aside for the open panel on wide screens), in two rows: where north points and the five file kinds in their inks; then
  the selection, its imports, its importers, and a package coast, each
  drawn from its `inkTable` row. Beneath it the collapsed Map key lists
  each optional layer by its table row and meaning, marked off when its
  setting is off, and says that relief is a cap most slopes stay well
  under: readers rarely see the relief rung at its floor, which only the
  steepest summit flanks reach.
- The ladder gains the scale's ink, `#57523f`, with a line row and a text
  row, and the district pigments, which were in `web/belonging.ts`; the
  key draws a district's rows in a sample pigment. The source and other
  file inks were 4.4 ΔE76 apart; a test keeps every two file inks at least
  12 ΔE76 apart (see colour vision below). A second test lists every
  ink shared across kinds (a line and a fill, or a line and a text) and
  holds the list to the five that are meant: the selection's rows, paper,
  district pigment, the grid and its references, and the scale.
- Left from 4.2a(ii): the overlays' hint arcs and their related and member
  rings were drawn at the 1.2-pixel width the links set before them and
  are now the table's 1 pixel; `diveRenderSettings` says that Off is
  raised to Balanced too.
- After review: the legend's first row reads "Packages built on others
  north, the foundation south"; its swatches are drawn 1:1 (each SVG's
  viewBox is its size in pixels, so weight and dash are the map's), and
  the file kinds in the shapes the map uses close in (a block, an open box
  with a foot for test, a half-disc for story), in the map's own
  `fileInk`. The scale stops above the legend's measured height (a
  `ResizeObserver` on the legend, through the map state to the scene)
  rather than a fixed 150 pixels. Place and the hover readout, and with it
  the polite live region, say "Layer n" or "No layer" for an island.
- Colour vision: at overview every file is the same dot, so the inks alone
  tell the kinds apart. The first ladder's file inks fell to 5.3 ΔE76
  (source and story, deutan) and 3.5 (config and source, tritan) under
  Machado's matrices at full severity. The file inks are now source
  `#624427` (7.37:1), test `#2f5e75` (5.88), story `#4c4485` (7.08),
  config `#894215` (6.14), and other `#575447` (6.33), found by a search
  over inks in the file rung, away from magenta; the closest pairs are
  18.4 ΔE76 in normal vision, 15.6 deutan, 14.4 protan, and 14.6 tritan,
  and a test holds every pair to at least 10 under all three.
- DESIGN.md: ports are harbors, where a lane meets a coast, and files are
  marks, not settlements; the legend and the scale are described, and the
  relief paragraph says the cap is rarely reached.
- Screenshots for review, a reader's session at default quality, from the
  build at `fb95563` and from this one:
  `/tmp/review-shots/{before,after}-{overview,island,close}.png`.
- Tests: `paint-map.test.ts` (the scale numbers the placed layers, marks
  an unplaced island's caption, and draws nothing without layers);
  `atlas-shell.test.ts` (the two-row legend open, the key collapsed, its
  rows and dashes from the table, an off layer marked); `ink-ladder.test.ts`
  (file inks 12 ΔE76 apart; inks shared across kinds only as intended);
  `codex/resolve.test.ts` (an unplaced layer stays `null`).

**4.2b Departures, the strongest signal,** from the `placement` lens
(schema 1). Planned 2026-10-10 against the lens as saved on this
worktree's scan: 377 places, of which 30 files, 6 folders, 4 packages and
101 symbols depart; `away` lists consumer modules by package, `home` those
in the place's own package, and a departing place names `toward`. Two
units: the data seam, then the drawing.
- **Data seam.** The codex reads the lens (a dataset without it is refused
  by the reader, as for any lens) and resolves each place to its label,
  `toward`, consumer counts at home and in each other package, and its
  dominance share: the `toward` package's consumer modules over all of
  them, unindexed ones left out as the lens leaves them out of the label.
  `AtlasData.placement` keys them by `level:place`.
  - `departures.ts` derives what is drawn, deterministically. Marks: every
    departing file at its position and every departing folder at its
    files' centroid, except that a package whose only consumer is one other
    package (fold-package territory) gets one package-level mark and no
    file or folder marks. Lines: departing files and folders grouped by
    (folder → consumer package), a single-consumer package as one group,
    ranked by the strongest member's dominance share, then the group's
    departing places, then folder and target by code unit; at most 3 lines
    per target package. Totals, marks and lines drawn against all, are
    returned for disclosure. (Ranking revised at review; see the ruling
    below.)
  - Place gives a place's placement label and, when it departs, where to
    and with what share ("placement: departs toward marbles · 7 of 7
    consumer modules"),
    for a selected file, its symbol, and its package; a place no other
    package uses says so. Symbol departures are told in Place only.
- **Drawing.** In the ladder's departure rung (magenta `#681049`, rung
  floor 8), defined in 4.2a(ii) and drawn from here: a notched ring on
  each mark, and a dash-dot line (8, 3, 1, 3) routed as selection lines
  are, a bowed curve from the group to the target's nearest coast, sea ink
  only, cut around names. Default on, with no toggle. While anything is
  selected, selection wins: departure lines are not drawn, so the gilt
  imports and importers never meet them; marks stay, being on land. The
  legend gains a departure row with the totals, the line threshold, and
  that unindexed consumers are left out. The ink is checked against
  every file ink, story's included, under the colour-vision matrices, and
  its contrast probed on screen.

**4.2b, the data seam.** Done 2026-10-10; nothing is drawn yet, and
only Place's text and the bytes read at load change.
- The codex reads the `placement` lens (`CodexSource.placement`: its
  places as saved and the ids of the packages it labelled) and resolves
  each place to counts: consumer modules at home and per other package,
  never the module lists, and `share`, the most any one package holds
  (its own package counted as one of the packages) over all of them,
  unindexed consumers left out.
  On this worktree's scan every departing place's share is at least the
  lens's 0.6, so the share agrees with the label. `AtlasData.placement`
  keys the places by `placementKey`, `level:place`, so that no two places
  can share a key. A dataset without the lens is refused with
  "The dataset has no placement lens. Run atlas scan again.", tested.
- `departures.ts` gives what the drawing will draw, once per atlas:
  - Marks on every departing file, at its position, and folder, at its
    files' centroid. A package whose only consumer is one other package
    (`away` of one package at package level) is folded: one mark for the
    package and none for its files or folders. No file of the three folded
    packages here departs elsewhere, so nothing is lost by the fold. A
    departing package with several consumers keeps a package mark and its
    places' marks too.
  - Lines by (folder → consumer package): a file's directory, a folder's
    own path, a folded package's root. Ruling at review, evidence before
    breadth: ranked by the strongest member's dominance share; on a tie by
    the evidence, the line's consumer modules in the target (its members'
    most, a floor on the distinct ones, since two places can share a
    consumer); then the broadest place (package, folder, file); then the
    most departing places; then folder and target by code unit. A line is
    drawn only when it rests on at least 2 consumer modules; a thinner one
    still counts in the totals and its places still read in Place. At most
    three lines into one package.
  - Totals for the legend: departing files, folders and packages, folded
    packages, lines before the threshold and the cap, lines left thin, and
    departing symbols, which Place tells and the map does not draw. The
    legend says the threshold, and that unindexed consumers are left out.
  - On this scan: 40 departing places (30 files, 6 folders, 4 packages)
    and 101 symbols; 3 packages folded (models and workflows toward
    marbles, modules toward works); 30 marks; 19 candidate lines, 6 of them
    thin, 9 drawn after the cap.
- Place gives a place's use after its folder and district, named so that
  4.2d can set a domain's reading beside it: "placement: departs toward
  marbles · 7 of 7 consumer modules", "placement: fits · 4 of 5 consumer
  modules at home", "placement: spread over 7 packages", or "placement:
  used by no other package" for a
  labelled package's place the lens does not list; nothing where the
  package has no internals. A file reads its own place, or its symbol's
  when one is chosen; an island reads its package's.
- `selection-ink.ts` gives the drawing its routing without a copy:
  `seaCurve` (the bowed curve, each end held back by its own clearance),
  `nearestCoast`, and the sea clip cut around names, which
  `paintSelectionInk` now calls. Selection lines are unchanged.
- Load: the lens adds one request and 181,378 bytes, from 1,757,262 to
  1,938,640 read at load in Chrome; `atlas:data-requested` to
  `atlas:data-loaded` stays within its run-to-run spread (6–14 ms against
  7–23 ms before). Under the 4.4 gate's 500 KB for one lens; the module
  lists are most of it, and the viewer keeps only counts.

**4.2b, the drawing.** Done 2026-10-10.
- `scene/ink/departures.ts` paints, as its own ink layer just under the
  selection's: a notched ring (`departureRing`: 4, 5.5 and 9 pixels for a
  file, a folder and a folded package, the notch a sixth of the turn at
  the top) on every mark, and the ranked lines in the dash-dot departure
  pen, routed through `seaCurve`, `nearestCoast` and the sea clip from the
  selection ink: from each group's centroid, so a line leaves its folder
  and the land part is cut away, to 7 units off the target's nearest coast.
  A package mark sits at its files' centroid, the middle of its island,
  clear of its name, which is set above the coast.
- Selection wins: while anything is selected no departure line is drawn,
  so the gilt imports and importers never meet one; the rings stay, being
  on land. Tested: unselected, the curves are drawn in the departure ink;
  selected, only in the selection's.
- The ink table's `drawn` field is retired with the last undrawn row.
- Colour vision, ΔE76 between the departure magenta and each ink, normal
  / deutan / protan / tritan: config 54.7 / 49.8 / 57.8 / 16.1, other 49.7
  / 18.6 / 33.1 / 42.3, source 48.4 / 31.5 / 43.2 / 24.3, story (indigo
  `#4c4485`) 33.8 / 29.7 / 21.8 / 52.3, test 53.6 / 16.6 / 21.3 / 70.2, and
  the selection 44.5 / 29.7 / 38.3 / 23.8. A test holds each at least 10.
- Probed on screen first, at overview: a line in `#681049` measured
  7.61:1 on the sea between the rows (200–201, 209, 195), under the
  departure floor of 8, while the ladder had computed 8.42 on its sea
  ground `#d5dbca`. Ruled at review: the ground was wrong, so it is
  corrected rather than the floor lowered.
  - The ladder's sea ground is now `#c8d1c3`, the darkest sea a line
    crosses at the named zooms: a sweep of 880 short probes over each of an
    overview, a zoomed and a close shot found it at (200, 209, 195) at
    overview and island zoom alike, and lighter close in.
  - What moved, sea marks on the corrected ground: the selection's ring and
    lines 10.78 → 9.72, under the selection floor, so the selection ink
    darkens from `#3b1e06` to `#361b05` (10.16 on sea, 13.31 on land, from
    12.74); the departure line 8.42 → 7.60, so the line takes its own ink
    (below); the entered ring 6.56 → 5.92, still over the file floor of
    5.5; the grid 1.15 → 1.14, minor grid 1.12 → 1.11, ripples 1.10 →
    1.09, sea contours 1.14 → 1.13, all within the sea rung. Outside the
    rung order: trade lanes 4.54 → 4.10, sea contours at full ink 3.23 →
    2.92, hover 4.02 → 3.63.
  - The departure line takes `#5e0d42`, the ring's magenta darker (hue
    320.7° against 321.1°): 8.29 on the corrected sea. The ring keeps
    `#681049` on land. They are two rows of the ink table, `departure` (the
    ring, solid) and `departure-line` (dash-dot), so no two rows share hue,
    dash, and weight, and the legend shows both.
  - Colour vision, ΔE76 normal / deutan / protan / tritan, the line ink
    against config 54.3 / 50.5 / 57.4 / 19.0, other 47.9 / 20.2 / 33.5 /
    40.4, source 46.8 / 32.1 / 42.8 / 22.8, story 33.4 / 30.7 / 24.2 /
    50.0, test 51.9 / 18.8 / 23.4 / 68.0, the selection 41.2 / 27.3 / 35.2
    / 21.8; the ring's against the new selection 44.0 / 28.5 / 36.7 /
    25.5. The test holds both inks at least 10 from every file ink and the
    selection.
  - Probed again with the same sweep: the line's pixels are exactly
    `#5e0d42`, 8.29:1 at the darkest sea it crosses at overview and island
    zoom (200, 209, 195), up to 9.71 at overview and 8.76–9.32 close in.
    At island zoom a line's end, held 7 units off the target's coast,
    reaches the light near-shore sea (237, 230, 213) at 10.47. Rings
    measure 8.6–9.96 on land.
  - The ladder's rule, ruled at review: a floor is met on the darkest ground
    a mark is drawn on, and "under the rung above" is an order between
    inks, not a ceiling: on every ground, each mark reads lighter than every
    mark of every rung above it, at every named zoom. On the light shore the
    line's 10.47 is under the selection's 13 there, so it is in order, not
    an exception. The ladder test checks both.
  - The sweep found the line on land at close zoom before: the sea clip cut
    names out of the same even-odd path as the land, so a name over land
    opened it again, and the line showed through file names. Each name is
    now its own clip; the line no longer reaches land, and the selection's
    lines, which share the clip, gain the same fix. Tested.
- Each line ends in a bead of its own ink at the target, as selection
  lines do, so it reads with a direction; the bead is a row of the ink
  table, `departure-bead`, and the legend's line swatch ends in it.
- The legend gains a third row: the ring, "Used mostly from another
  package", the line, "Toward the package that uses it most", and short
  totals, "40 departing · 101 symbols in Place · 9 of 19 lines". The map
  key says why: the lens's dominant share, now read from its `policy`;
  the 2-module threshold and the 3-line cap; that the totals count every
  departure; and that consumers in no package are not counted. The row
  and the explanation are left out when nothing departs.
- On a screen 760 pixels wide or narrower the legend shows only the map
  key's summary until it is opened, and each number of the latitude scale
  sits on a paper plate of its own (0.85), since islands reach the right
  margin there; a plate under the whole scale hid a third of a 390-pixel
  map.
- A focused wreck needs no rule of its own: focusing one opens its dive,
  which covers the whole map, so no departure line can meet it; closing the
  dive clears the focus.
- Screenshots, a reader's session at default quality on this worktree's
  rescan: `/tmp/review-shots/4.2b/before-{overview,island,close}.png` from
  `d2e1f4d`, which draws as `e23a006` does, and
  `after-{overview,zoomed,closeline,island,close}.png`, and at 390 × 800
  `after-narrow{,-key}.png`; the island and close shots have lib selected,
  so they show the selection's lines in place of the departures.
- Docs: DESIGN.md "Departures"; the guide's "What you are looking at"
  (its "Dependency is placement" bullet, stale since 4.3a, is rewritten);
  `_viewer.md`'s table.

**4.2c Proximity,** from the `proximity` lens (schema 1). Planned
2026-10-10 against the lens as saved on this worktree's scan: 30 folders
whose files fall into unrelated groups (`close`: 23 with two groups, the
most eleven), 156 files apart from their responsibility's dominant folder
(`apart.files`: 59 one folder step away, 77 two, 20 three), and 252
co-changing pairs in different folders (`apart.coChanges`: 223 within a
package, 29 across; 132 with no import path between them).
- **Data.** The codex reads the lens (a dataset without it is refused, as
  for any lens) and keeps it as it is, with the packages it covers.
  `proximity.ts` works out, once per atlas, what is drawn on each island:
  - "Related but apart" as ties on land: a file apart from its
    responsibility's folder is tied to that folder's centroid; two files of
    one package that change together from different folders are tied to
    each other. Ranked: co-changes by commits, then Jaccard, then pair id;
    apart files by folder steps, then path. At most 5 ties per island, the
    co-changes first, since a change in one file foretells one in the
    other; a selected file shows all of its own.
  - "Close but unrelated" as one mark per folder at its files' centroid.
  - Co-changes across packages are told in Place only: drawn, they would
    cross the sea, which departures hold.
- **Drawing,** at island zoom only (from `enteredAt`), so the overview
  stays the departures': ties in a new proximity ink, green, a hue no file
  ink or departure takes, on the label rung (4.5 on land, under every file
  mark), dotted for an apart file and dashed for a co-change; the close mark
  a ring broken in two, of the same ink, a ring meaning a place as the
  departure's does, its two gaps the groups it holds. No toggle; the ties
  and marks are on land, so they never meet the departure or selection
  lines, which are sea ink. The map key explains them, so that the
  always-open legend stays the overview's.
- **Place** gives a file's proximity: "proximity: apart from its
  responsibility's folder src/lib · 2 steps", "changes with …/b.ts · 6
  commits, no import path", and "its folder holds 3 unrelated groups of
  responsibilities"; an
  island its counts. Cross-package co-changes are listed there.

**4.2c, done.** 2026-10-10, as planned, in one unit, with the review's
changes.
- The codex reads the `proximity` lens and keeps it as saved
  (`AtlasData.proximity`), with the ids of the packages it covered; a
  dataset without it is refused, tested. Load: one request and 126,755
  bytes more, 1,938,640 to 2,065,395.
- `proximity.ts`: each island's ties, co-changes ranked by commits, then
  Jaccard, then id, and apart files by folder steps, then path; and the
  close folders' marks at the centroid of the files directly in them (or
  below, where none is). Ruled at review, a budget by kind: an island draws
  its 3 strongest co-change ties and 2 apart ties, one kind making up for
  the other when it runs short, or every tie of a selected file; Place
  gives "· N of M ties drawn" for each island. On this scan: 379 ties on 11
  islands, 45 drawn at once; 30 close marks; 29 co-changes across packages
  told in Place only.
- Drawn by `scene/ink/proximity.ts` from `enteredAt` only, clipped to land
  with `traceLand`, so a tie stays on land even if a coast curves in
  between its ends. Ruled at review, the ties take a rung of their own,
  `tie`, between label and coast (floor 3.5): the ink `proximity`
  `#6b70b8`, a slate found by a search over hues away from the departure
  magenta for 3.6–4.0:1 on land, at least 15.2 ΔE76 from every ink it can
  lie beside in every vision (the closest, the sea contours). The ladder's
  order between inks holds on every ground. Ties are 1.5 pixels, since at
  1 pixel a diagonal tie never reached its full ink on screen; probed, its
  pixels are exactly `#6b70b8`, 3.78:1 on land.
- The close mark, ruled at review, says "two sides apart": two arcs, "( )",
  each pushed 2 pixels from the centre and sweeping 55° either side of the
  horizontal, which no departure's ring, one arc with one notch at the top,
  shares; a test checks both shapes, and `after-key.png` shows the two
  swatches together. Rows in the ink table: `proximity-apart` (dotted),
  `proximity-co-change` (dashed), `proximity-close` (the arcs, 1.2 solid),
  and `proximity-bead`.
- The legend stays the overview's; the map key gains the three rows, with
  their own swatches, and the budget's rule. Place gives a file's proximity
  ("proximity: apart from its responsibility's folder src · 2 steps;
  changes with b.ts · 6 commits, no import path, and 1 more; its folder
  holds 2 unrelated groups of responsibilities") and a package's counts.
  CONTEXT.md gains **Proximity**, with close and apart.
- Tests: `proximity.test.ts` (ranking, cross-package left out, the apart
  tie's folder, the budget by kind and its refill, a selected file, the
  close mark), `paint-map.test.ts` (drawn at island zoom, not at overview;
  the arcs against the departure's ring), `atlas-shell.test.ts` (Place),
  `ink-ladder.test.ts` (the new rung, the slate's ΔE76), the codex's
  source and resolve tests.
- Screenshots: `/tmp/review-shots/4.2c/before-{overview,zoomed,closeline,
  narrow}.png` from `ef4c3e3`, and `after-{overview,zoomed,closeline,
  atlas-island,key,narrow}.png`; the overview and narrow shots are
  unchanged, as the plan meant.

**4.2d Nesting and domains, by default,** from the `nesting` (2.4) and
`domains` (2.6) lenses, both schema 1. Planned 2026-10-10 against the
lenses as saved on this worktree's scan: `nesting` has 319 folders in one
tree (each with its parent, owning package, whether it is a package root,
its file counts, and its path region where the internals list one), 84
path regions and 106 seams (the primary edges from one region into
another, with module edges, import sites, and the symbol names crossing);
`domains` is empty, since this workspace declares none.
- **What 4.2d builds: the data seam and the words.** The codex reads both
  lenses; a dataset missing either is refused, as for any lens.
  - `AtlasData.nesting`: the folder tree, path regions and seams as saved.
    `AtlasData.folderCells`: each island's cell tree from `settleFiles`,
    kept at load instead of thrown away, in island coordinates, so a
    relayout leaves it valid.
  - `AtlasData.domains`: each declared domain (name, parents, its facets'
    places, what matched nothing, reason and weight), and the domain label
    of every placed place in one, keyed as placements are, `level:place`.
    A file's domains are found from the facets, a file facet naming it or a
    folder or package facet above it.
  - Place: a file's path region ("in path region lib"); an island's path
    regions and its strongest seams ("4 path regions · seams web → lib 39
    module edges, …"); a place's domains ("domains: shapes"); and, for a
    placed place in a domain, its domain label beside the placement label:
    "placement departure: toward … · 4 of 4 consumer modules · domain
    departure: 2 of 5 consumer modules in other packages share its domains",
    with any consumers outside the module index said apart, or "… · shares
    shapes with every consumer".
  - Map key: a line on path regions and seams; with domains declared, how
    many and what a domain label means; with none, the one line "No
    domains are declared."
- **What 4.3b draws, from this seam:** the folder cells (faint lines from
  `folderCells`' cuts) and top-level folder names, named from the nesting
  tree; seams between path regions, if drawn at all, belong there too,
  since a path region is a folder.
- **What 4.3c draws, from this seam:** a chosen domain across islands, its
  places from `AtlasData.domains` and their positions from the files and
  `folderCells`. Departures are not redrawn here: a departure that shares
  its domain stays a departure on the map, as the placement label stays
  beside the domain label; whether it takes another mark is 4.3c's call.
- **Not here:** no drawing, and no island caption change; the island's
  folder is in Place since 4.3a.

**4.2d, done.** 2026-10-10, as planned, in one unit; nothing new is
drawn, and the overview is pixel-identical to 4.2c's.
- The codex reads the `nesting` and `domains` lenses; a dataset missing
  either is refused, tested for both. `AtlasData.nesting` holds the folder
  tree, path regions and seams as saved; `AtlasData.domains` the declared
  domains and each placed place's domain label by `level:place`; and
  `AtlasData.folderCells` each island's cell tree from `settleFiles`, kept
  at load in island coordinates. That is the seam 4.3b draws folders from
  and 4.3c draws a domain from. Load: two requests and 79,626 bytes more,
  2,145,021 in 24.
- Place: a file reads "in src/node, path region node"; an island "6 path
  regions · seams web → lib 39 module edges, cli → lib 10"; a place in a
  domain "domains: node-runtime", its domains from the facets that name it
  or a folder or package above it, with the domains those are nested in.
  A departure in a domain reads as two: "placement departure: toward
  marbles · 4 of 4 consumer modules · domain departure: 1 of 4 consumer
  modules in other packages share its domains", adding "; N consumers
  outside the module index can't be shown to share them" when the lens
  counts any; a place sharing its domains with every consumer, "… · shares
  shapes with every consumer". A symbol reads its own domains: a file facet
  covers its symbols, and a symbol facet names only its own, matched with
  `covers` from `lib/facet-cover.ts`, moved there from `lib/facet.ts` so
  that the viewer matches facets as the configuration does without
  bundling zod (a lens-code move; `rules.ts` and the `domains` and `rules`
  lenses import it from there).
- Map key: a line on path regions and seams, and on domains either "No
  domains are declared." or how many and what a domain label means. With
  none declared nothing more is shown.
- Kept for 4.3c: a departure that shares its domains stays a departure on
  the map, as the placement label stays beside the domain label; whether it
  takes another mark is decided when the domain is drawn.
- Tests: `nesting-domain-text.test.ts` (path region, seams, domains from
  facets and parents, the two domain labels), `atlas-shell.test.ts` (the
  departure told as two; the one-line note), the codex's source and
  resolve tests, and `atlas.test.ts` (the cell trees and nesting at load,
  over a real scan).
- Screenshots: `/tmp/review-shots/4.2d/after-overview.png`, unchanged; and
  `after-place.png` and `after-island-key.png` from a copy of this scan
  whose `domains` lens declares one domain, `node-runtime`, over
  `packages/workspaces/src/node`, since this workspace declares none.

**4.3 Directories drawn,** and a domain drawn across islands.
- **4.3a** (recorded at 4.2a(iii)): each island's y is fixed to its
  layer's latitude, `latitude(layer)`, with x free and overlaps resolved
  along x, or at the least the route term leaves y, so that dependency
  pulls no island off its layer's row. The latitude scale then switches to
  nominal ticks at `latitude(layer)` instead of the mean of each layer's
  settled islands.
- **4.3a, package placement.** Done 2026-10-10. North–south is the
  dependency layer, west–east the folder order, and the outline the
  package's folder, with no import pull.
  - `settlePackages` puts every island exactly on its layer's row,
    `latitude(layer)`; an unplaced package sits on the foundation's. A row
    runs west to east in the order of the packages' folders, the manifest's
    `path` threaded through the codex as `Territory.folder` and compared by
    code unit, and is packed with the island clearance (default 45) between
    coasts padded by 32 units, then centred. Islands of neighbouring rows
    that still overlap are moved apart along x only. Folder order is this
    effort's reading of "the folder tree" at package level; nothing else
    orders a row.
  - The atlas then moves by one offset, centred on the chart with 160 units
    more sea below the foundation row (`footSea`), so that at overview the
    foundation row and its tick sit above the legend rather than under it.
    The cleaner fix is to frame the overview above the legend, padding by
    its pixel height; it is not small, because the camera is clamped to the
    chart's bounds, so the chart needs room below the foundation anyway,
    and resize, the overview focus, and `constrainCamera` would all change.
  - Rows keep `latitude`'s spacing. The scale reads each tick from its
    row, the y every island of the layer shares, so ticks are nominal and
    no offset is stored. The scale fades out as an island's districts come
    in (`detailLevel().scale`), so it never prints over an island at island
    zoom.
  - Retired: the route term and `attraction` (with its test and codex
    rows); `settleLandmasses`, its separating-axis pass, the pocket
    placement for singletons, and `hullSeparation`, with their four tests
    in `landmasses.test.ts`; the east-west hash. `relayoutAtlas` moves to
    `geography.ts` and reruns the new placement, so Island clearance and
    Reset layout still work. `packageGroups` and the connecting-land
    footprint stay: groups no longer gather, so in a developer session a
    group's land runs across rows (`/tmp/review-shots/4.3a/a-land.png`).
  - The rule for the two groupings is recorded in DESIGN.md "Shapes":
    position and outline mean folder (and, north–south, layer); pigment and
    labels mean responsibility; Place says which. Place and the hover
    readout give an island's folder before its layer ("packages/core ·
    Layer 0"). The evidence panel's "Group files by responsibility" is the
    one arrangement by responsibility, on request.
  - Tests: an island on its row and a row in code-unit folder order; two
    rows parted along x only; a relayout moving x only; and, on the
    reference atlas given four rows and an unplaced package, at clearances
    8, 45 and 80, every pair of padded coasts at least the clearance apart
    (less 0.01) and every island on its row.
  - `scripts/measure-layout.ts` measures the acceptance numbers over a
    saved dataset, run through `loadAtlas` and each island's internals, or
    over the test fixture, against a shuffle: of each island's file
    positions, and of each row's order. Folder share counts only a file's
    exact directory. Row neighbours are the share of side-by-side islands
    in a row whose package folders have one parent (`apps/atlas`,
    `apps/marbles`).
  - Measured on the scan of the viewer worktree (15 packages, 1,552
    files), in `/tmp/review-shots/4.3a/`: row neighbours 0.444 before and
    after (0.39–0.40 shuffled), since Foundry's rows are short and the drift
    happened to give the same count; satellites per package 1.20 before and
    after (18 in all), and the fixture's 0.32 (9), since coasts are
    unchanged. The 3-NN shares and patches move only with the in-island
    layout, the next unit.
  - Layout time, from `atlas:data-loaded` to `atlas:layout-settled`, in
    Bun: 528–560 ms at `cd018ef` in the first runs (`before-measure.txt`);
    run back to back, 318–333 ms at `cd018ef` (`before-measure-paired.txt`)
    against 139–140 ms with this unit (`a-measure.txt`). In Chrome at
    overview: 600–610 ms before and 139–141 ms after, but the runs before
    were under heavier machine load (first frame 5.4 s against 3.1 s), so
    that difference overstates the gain.

- **4.3a, files by folder.** Done 2026-10-10.
  - `folder-sectors.ts` places an island's files by the folder tree below
    `Territory.folder`, with no import pull: a sunflower lattice fills a
    disc, spaced 1.5 contour spreads and at most 8 units, so one district's
    neighbouring files join in its footprint; recursive halving across the
    wider extent gives every folder a convex cell sized by its files,
    siblings side by side in code-unit name order, a folder's own files
    first. A gutter of one spacing parts the first split and halves at every
    split below, so no site crosses a cut. This is recursive bisection
    rather than the plan's angular sectors with distance by depth: it keeps
    every cell convex and the density even.
  - Within its cell, a folder's own files take their sites by district, one
    rank for the island (more files first, then id; then path), so a
    district is one compact patch per folder and takes the same side of
    every folder it reaches. Cells, and so coasts and satellites, do not
    depend on the districts. A district is a responsibility group; a file of
    an independent responsibility or of unresolved belonging has none, as
    the map draws them among its collections (`fileDistricts`).
  - The districts come at load from the `responsibility-groups` lens,
    which now records each group's member `modules`, workspace-relative,
    sorted, each once (schema version 2); `districtsOfGroups` reads them.
    That is a change to lens code, not analysis code, so it has no row under
    "Changes to existing code". A package without internals has no groups,
    and its files go in path order. A dataset saved before the change has
    no members, but it never reaches the layout: the dataset reader refuses
    a lens of another schema version and asks for a new scan, as for any
    lens, so the path-order fallback covers only packages without
    internals.
  - The lens on this worktree's scan (15 packages, 1,566 files), read and
    derived over the same dataset, alternating old and new: 12,164 bytes and
    71–88 ms before, 40,365 bytes and 77–106 ms after. The time is the
    internals' read; the members add 28 KB to the 1.71 MB the map reads at
    load.
  - Retired: `settleFiles`'s hashed directory anchors, its import pull and
    its collision pass; `loadAtlas` keeps the import edges for trade routes,
    roads and tracing only.
  - Place and the hover readout give a file's folder below its package's
    and, once the island's belonging is read, its district: "source · in
    src/web/scene · district Lens · …".
  - Acceptance changed, decided with the coordinator: patches per district
    are measured against folders per district, the number of folders each
    district's files sit in, a reference rather than a floor, and the bar is
    "at or below folders per district", not "no worse than the import-pulled
    layout". The original bar holds on Foundry too (2.414 patches against
    2.621), but the new one is the principled one, and it still means
    something where the original would not hold: under "position means
    folder", a district split across folders is the honest signal, the one
    the proximity lens reports, and the old layout joined such districts
    only by pulling files out of their folders.
  - Measured on a fresh scan of this worktree, against `3e93b64` on the
    same dataset (its lens relabelled version 1 for the old reader, which
    ignores `modules`), in `/tmp/review-shots/4.3a/before-3-measure.txt`
    and `c-measure.txt`: folder share 0.570 before, 0.771 after (0.137
    shuffled); district share 0.767 before, 0.860 after (0.53 shuffled; in
    path order it would be 0.825); responsibility share 0.476, 0.529
    (0.255); patches per district 2.621 before and 2.414 after, below the
    3.414 folders per district, since districts join across neighbouring cells
    (2.897 in path order); satellites 1.33 per package (20) before and none
    after; on the fixture, folder share 0.569 to 0.734 and satellites 0.32
    (9) to none. Layout in Bun 165–187 ms before and 31–42 ms after; in
    Chrome, `atlas:data-loaded` to `atlas:layout-settled`, 21–22 ms after
    (the old build cannot read the new lens, so it has no Chrome before on
    this dataset; 139–141 ms on the earlier one). The
    numbers on the earlier dataset, where a lone responsibility counted as a
    district, are in `b-measure.txt` and `before-2-measure-paired.txt`.
  - Coasts are round now: an island's outline no longer carries clusters;
    the gutter between its first two cells shows in its specks.
  - `settleFiles` returns the cell tree: each folder's cell with its sites,
    the cuts made between its own files and its subfolders (an axis, the
    line's coordinate mid-gutter, and its extent), and its subfolders'
    cells. Nothing draws it yet; 4.3b will. Tests prove, on the reference
    atlas, that within every cell the hulls of its own files and of each
    subfolder are pairwise apart, and cover one file, one folder of many
    files, deep nesting, and files outside the package's folder.
  - The `responsibility-groups` lens's schema version 2 means every saved
    dataset needs a new `atlas scan`: the reader refuses version 1 and says
    so. The atlas CHANGELOG is generated from commits at release, so this
    belongs in the commit message rather than an edited CHANGELOG.

- **4.3b** (recorded at 4.3a): draw faint cell lines and top-level folder
  names at island zoom, from `settleFiles`'s cell tree. Try a top gutter of
  2–3 spacings as a cue in the coast, and measure satellites again if it is
  tried. Check that district labels such as "lib" or "scripts" do not read
  as folder names once folder names are drawn. While "Group files by
  responsibility" rearranges an island, its cells are hidden there, since
  its files no longer sit in them (recorded at 4.2d).
- **4.3b plan.** Planned 2026-10-10 from the cell trees 4.2d keeps
  (`AtlasData.folderCells`) and the `nesting` tree.
  - Cell lines: each cut a cell made between its parts, a straight line at
    its coordinate across the sites it divided, clipped to land. They start
    at the island's first branching folder (a package whose files all sit
    in `src` branches inside `src`), its cuts from island zoom, the next
    level's from 4 pixels a unit, deeper ones close in. A new ink and a new
    rung, `cell`, between tie and coast, so cell lines read under every tie
    and over the coast; colour vision checked against every ink they lie
    beside.
  - Folder names: the branching folder's subfolders, named by their path
    below the package with a trailing slash ("src/web/"), at the centroid
    of their cells, in italics, in a darker ink of the cell lines' hue, on
    the label rung, as label candidates after the districts' and before the
    files', so a district's name wins a collision. The slash, the italics
    and the hue tell a folder name from a district's ("lib/" against
    "lib").
  - Hidden on an island while "Group files by responsibility" rearranges
    it, since its files no longer sit in their cells.
  - The gutter experiment: a top gutter of 2.5 spacings for a coast cue,
    with satellites and the folder share measured again; kept only if the
    coast reads better and no satellite appears.
  - Seams are not drawn: Place names an island's strongest, district
    streams already draw imports between responsibilities on land, and a
    third kind of line on an island would compete with the proximity ties.


- **4.3b, done.** 2026-10-10, as planned, with these choices.
  - `scene/ink/folders.ts` draws each cut from the island's first folder
    with more than one subfolder (descending through a lone `src`): its own
    from island zoom, its subfolders' from 8 pixels a unit, deeper from 14
    (4 and 8 at first, which crowded an entered island with lines).
    Clipped to land. The cell rung's ink, `#8975a3`, was found by a search
    for a hue at least 10 ΔE76 from every ink a cut lies beside, in every
    vision (the closest 11.8), that keeps the ladder's order on every
    ground: over the coast pen at 0.85, under the proximity ties. The rung,
    `cell`, has a floor of 3.
  - Probed: at 1 pixel a cut never reached its ink (1.6:1), the anti-alias
    and the tilted camera halving it; at 2 pixels a north–south cut's
    pixels are exactly `#8975a3`, 3.26–3.41:1 on land, and an east–west one
    reached 2.1 until widened by 1 / cos(tilt) for the camera's
    foreshortening (`chartTilt`, now exported), then 3.05–3.37.
  - Folder names: the branching folder's subfolders, below it with a
    trailing slash ("web/"), italic, in `#5f5980` on the label rung (5.43:1
    on land), at least 10.6 ΔE76 from the label and caption inks in every
    vision; label candidates after the districts' and before the island's
    and the files', so a district's name wins a collision. Tested.
  - Hidden on an island "Group files by responsibility" rearranges: the
    belonging layer then holds a territory with files of its own, which
    `cellsShown` checks. Tested.
  - The gutter experiment (`/tmp/review-shots/4.3b/gutter-*`): at 2.5
    spacings the first split parts most islands in two, 7 satellites (13 on
    the fixture), patches per district 2.414 → 2.759; at 2, 1 satellite; at
    1.75 and 1.5 none, folder share 0.771 → 0.794 and 0.786, patches 2.586
    and 2.483, but the bays the gutter cuts into the coast leave pinholes
    along it that read as coast features, while the cut lines already show
    the split from island zoom. Kept at 1.
  - Seams are not drawn, as planned; Place names an island's strongest.
  - At review: each cut spans its parent cell, the rectangle its split
    divided, starting from the island's box widened by the gutter, so cuts
    meet at T-junctions and the land clip trims them at the coast; a test
    on the reference atlas finds a cut between every two sites of
    different blocks. Levels below the subfolders' open 6 pixels a unit
    apart (8, 14, 20, …). A folder's name sits a line above its cell's
    centroid, so a proximity bead there stays seen. A district named as the
    folder it sits in ("lib" in `src/lib`) is not labelled; the folder's
    name carries the place, and Place and the panel name the district.
    Districts take their names from their anchor responsibility, whose
    label is mostly its folder; naming them by what they are responsible
    for would be lens work (`responsibility-groups`). Only the cells are
    compensated for the camera's tilt.
  - The map key gains the cell row and a line on folder names.
  - Screenshots: `/tmp/review-shots/4.3b/before-*.png` from `e60074b`;
    `after-overview.png` (pixel-identical: nothing changes at overview),
    `after-{zoomed,closeline,atlas-island,atlas-entered,agents-close,
    narrow}.png`, and `gutter2.5-*`, `gutter1.75-*` for the experiment.

- **4.3c plan.** Planned 2026-10-10 from `AtlasData.domains` and the cell
  trees. A chosen domain is drawn across islands. With none chosen, or none
  declared, the map is as before.
  - Choosing: Find lists the declared domains as well as its places, at
    every level, since a domain spans islands. Choosing one opens Place,
    which gives the domain's reading: its reason and weight, the domains it
    is nested in and holds, what it covers island by island, its symbols
    (told only there) and facets that match nothing, and how many of its
    departures it explains. Place also gets a Clear button. With no domain
    declared, Find and the key are as before.
  - What is drawn, from the domain and every domain nested in it: on each
    island, the folder cells its folder facets cover, joined into one
    outline, land ∩ the cells' rectangles, as a dashed band inside the
    edge. A file it covers alone gets a square round its mark. A package it
    covers whole (a package facet, or a folder facet above the package)
    gets the band along its whole coast and a filled diamond inside its
    south coast. Symbols are not drawn. A place under a covered folder is
    not drawn twice. `FolderCell` records its rectangle (`region`) for
    this.
  - The name is drawn once: "domain node-runtime", as the first label
    candidate, at the largest piece in view.
  - Ink: a new rung, `domain`, between label and tie (floor 4), with a
    cobalt line ink found by search: under every label mark and over every
    tie, cell and coast mark on every ground, and at least 10 ΔE76 from
    every ink it can lie beside in every vision, district pigments
    included. The name takes a darker ink of the same hue on the label rung.
    The band's dash is its second cue. East–west runs of the band are
    widened for the camera's tilt, as cuts are.
  - Departures stay as drawn. A departure the chosen domain explains
    (domain label `shares-domain`, with the domain among its shared
    domains) has its notch closed by a domain-ink plug while the domain is
    chosen. A domain departure takes no extra mark.
  - Precedence: the domain is not a selection. Choosing one keeps the
    selection, and selecting an island, district or file keeps the domain.
    Selection ink stays above the domain's. The domain goes with Clear,
    with another choice, or with Escape once nothing is selected. On an
    island "Group files by responsibility" has rearranged, its band and
    squares are hidden, as its cells are; the package mark stays. The
    camera does not move; Place names the islands.

- **4.3c, done.** 2026-10-10, as planned, with these choices.
  - `domain-extent.ts` works out, once per atlas and domain, where a
    domain lies, from its own facets and those of the domains nested in
    it:
    - islands covered whole, by a package facet or a folder facet above
      the package;
    - the topmost covered folder cells;
    - the files named alone, outside every covered cell;
    - its symbols and unmatched facets;
    - the placed places it explains (`shares-domain`, the domain among
      the shared) and its domain departures.

    A folder facet with no cell of its own falls back to its files. Each
    `FolderCell` now records its `region`, the rectangle its parent's cuts
    left it (web code, not `lib/`).
  - `scene/ink/domain.ts` draws it, in a layer after the folders and under
    the files, so files, ties, labels, departures and the selection draw
    over it. The band is the inner half of a 5-pixel dashed stroke, clipped
    to the island's land ∩ the covered cells' regions, so it reads 2.5
    pixels inside the edge.
    - Neighbouring cells meet exactly, so the edge between them drops out
      of the outline (`unionOutline`).
    - A cell edge on the island's box is pushed out past the coast
      (`toCoast`). The box falls short of the land on most islands, and
      without this the band stopped short of the coast as 4.3b's cuts do.
    - The whole band, and each file's square, are drawn under a transform
      that stretches y by 1 / cos(tilt), which widens every east–west run
      by the camera's foreshortening, whatever its direction.
  - A second layer after the departures closes the notch of each departure
    the domain explains with a cobalt plug. The plug is the decision the
    4.2d note left here: such a departure stays a departure and its ring
    is not redrawn. It gets a second mark because "every consumer
    elsewhere shares the domain" is the motivating case of `_domains.md`,
    the observation a domain marks as belonging without hiding it. The
    ring still reads in two tones without its hue: the plug is heavier
    than the ring and lighter, 4.3:1 against the magenta's 8 or more. A
    domain departure takes no extra mark; Place gives both labels.
  - Ink: cobalt `#1e6ccc` on a new rung, `domain`, between label and tie,
    with a floor of 4. It reads 4.30:1 on land.
    - It was found by searching sRGB with chroma kept at the ladder's
      strongest (C* ≤ 58). Below 45 no hue cleared 10 ΔE76 from every ink
      beside it.
    - It sits under every label mark and over every tie, cell, coast,
      relief and sea mark on every ground. It is at least 13.3 ΔE76 from
      every ink it can lie beside in every vision, all eight district
      pigments and an overlay's inks included; the nearest is the stream
      ink under tritan vision.
    - The name is `#125ecc` on the label rung, 5.01:1, at least 13.4 ΔE76
      from the label, caption, folder, selection and file inks.
    - Table rows: `domain-outline` (2.5, dashed 6 3), `domain-file` (2.5,
      solid), `domain-explained` (3.5, solid), `domain-package` (fill),
      `domain-name` (text). Their shared hue is listed among the intended
      shares.
  - Weights changed against the on-screen probe. The file square was 1.5
    pixels, then 2; its east–west sides read 1.74:1, then 2.1:1 once
    compensated, and 3.3–3.5:1 at 2. At 2.5 pixels, compensated, every
    side is the exact ink. The plug then moved from 2.6 to 3.5 pixels to
    stay 1 pixel from the square in the table. The square grew from 4.5 to
    6.5 pixels half-side, since at 4.5 it lay under a departing file's
    4-pixel ring.
  - Name: "domain node-runtime", the first label candidate after a
    selected file's name, at the largest piece in view. On an island
    covered whole it sits just above the diamond, since at the middle it
    covered the package's departure ring and its plug. For cells it sits
    just below the middle of their files, since a line above it took the
    folder name's place.
  - Selection precedence: the domain is its own state (`AtlasState.domain`,
    the scene's `setDomain`), not an `AtlasSelection`, which needs one
    island.
    - Choosing a domain keeps the selection, and selecting an island,
      district or file (Find, the map, Whole atlas) keeps the domain.
    - Selection ink stays above it, in the ladder and the layer order.
    - Place tells the domain above the selection, with Clear domain.
    - Escape leaves the selection level by level, then puts the domain
      away.
    - A relayout leaves it chosen, since it is not island-local.
    - The camera does not move.
  - Find lists the domains, by name with a diamond swatch, at every level,
    and opens Place on a choice. Place reads, for node-runtime on the
    fixture:
    - "Node-only adapters · holds storage";
    - "covers 18 files on 4 islands: artifacts src/node/; lib
      src/atomic-file.ts, src/file-lock.ts; modules src/node/; workspaces
      src/node/";
    - "1 symbol, told only here: atomic-file.ts#AtomicWriteOptions";
    - "1 place shares it with every consumer elsewhere · 2 domain
      departures";
    - and facets that match nothing, where there are any.

    The map key gains four rows (the band, the square, the diamond and the
    plugged ring) and a sentence on choosing, all only where domains are
    declared.
  - With none declared, nothing changes: no Find entries, the old
    placeholder, no key rows, the one-line note. Before against after on a
    copy of the scan with an empty `domains` lens: 0 differing pixels at
    overview and at island zoom. On the fixture, with domains declared and
    none chosen: 0 at overview and at island zoom. Both held until the
    review's halos and round rings, which change every map (below).
  - Load: no new request (the lens is read since 4.2d). The bundle is
    1,383.81 kB against 1,372.90 kB at `9967822`.
  - Probed on screen (WebGPU on Metal, 1500×1000, pixel ratio 1), against
    the paper beside each mark:
    - the band's east–west edge, the exact ink, 4.26:1;
    - a north–south cell edge, 4.09:1;
    - the band along a coast, the exact ink, 4.00–4.07:1 against the shore
      tint;
    - in the dash's gaps, the cell cut beneath, 3.35–3.41:1;
    - the file square, the exact ink on every side, 4.22–4.30:1;
    - the diamond, the exact ink, 4.10:1;
    - the plug, the exact ink, 4.30:1;
    - the name's stems, 4.37–4.68:1, as 13-pixel text anti-aliases.

    Not compensated, as before: departure rings. A 9-pixel package ring
    reads 9.4:1 at its sides and 1.8:1 at its foot. On models the `src/`
    folder name sits over the top of the ring and its plug, a collision
    that predates this unit.
  - Fixture: `/tmp/atlas-viewer-state-domains-43c`, a hand-edited copy of
    `/tmp/atlas-viewer-state-domains`, since Foundry declares no domains.
    It holds four domains: agent-runtime, with a package, two folders,
    weight 0.8 and an unmatched facet; marbles-host, which overlaps both
    others; node-runtime; and storage, nested in node-runtime, with three
    files and a symbol. Six placements were edited, three to
    `shares-domain`. The labels are made up for drawing; no scan produced
    them.
  - Tests:
    - `domain-extent.test.ts`: resolution, nesting, whole packages,
      dedup, the fallback, the union outline, the cell regions, the coast
      reach.
    - `paint-map.test.ts`: the band, square, plug and name drawn when
      chosen, none unchosen, none on a rearranged island.
    - `ink-ladder.test.ts`: the rung order, the ΔE76 floors, the shared
      hue.
    - `nesting-domain-text.test.ts`: the reading.
    - `atlas-shell.test.ts`: Find, Place, kept through a selection, Clear,
      Escape, nothing when none is declared.
    - `atlas-map.test.ts`: the domain reaches the scene and survives a
      rebuild.
  - At review (approved, with changes):
    - The domain's name is a caption: label hit-testing moved into
      `labelUnder` (`exploration.ts`), which passes a click through it.
      Tested.
    - Place's domain block has a real h3 and sits under the selection's
      heading and description, so the headings stay in order. Clear domain
      hands focus to Place's heading (`tabIndex` -1). The Find swatch is
      `aria-hidden`. Tested.
    - Names on the sea join the ladder as label marks on a new ground,
      `labelHalo`. On the bare sea, island names, captions and the domain
      name read 4.07, 3.83 and 3.82:1. They now take a 6-pixel halo (5 for
      captions) that fills their letters' gaps, and read 5.57, 5.25 and
      5.23:1 against it. Probed on screen against the halo pixels beside
      them: the domain name's exact ink 5.23:1, the island name's 5.57:1,
      the caption 4.93–5.09:1. Names on land keep a 3-pixel halo.
    - Departure rings, the close mark's arcs, the selected file's ring
      and the plug are drawn under the band's y-stretch (`tiltStretch`,
      now in `exploration.ts`), so they are round on screen. The foot of
      models' 9-pixel ring reads 3.63:1 (1.8 before) and its side 9.49:1.
    - A relayout keeps the chosen domain: a shell test moves Island
      clearance and checks the rebuilt scene gets it, and a unit test
      checks the extent is worked out again over the moved islands.
    - Because of the halos and the round rings, the map with no domain
      declared is no longer pixel-identical to `9967822`: 0.83% of pixels
      differ at overview and 0.20% at island zoom.
  - Follow-ups, known:
    - Folder names should avoid departure rings and proximity beads: on
      models, `src/` sits over the top of the package ring and its plug.
    - A ring's foot still falls short of the departure floor on screen
      (3.63:1 against 8): at 1.6 pixels a horizontal run straddles two
      rows of pixels. Reaching the floor needs a heavier ring, a change to
      the departure row.
  - Screenshots in `/tmp/review-shots/4.3c/`:
    - `before-{initial,zoomed,find,key}.png` from `9967822` on the
      fixture, and `after-{initial,unchosen-zoomed}.png` with no domain
      chosen;
    - `before-none-*`, `after-none-*` on the empty lens;
    - `after-{node-runtime,agent-runtime,marbles-host}{,-place}.png`;
    - `after-{find,key}.png`;
    - `after-workspaces-{place,island,close,closer}.png`;
    - `after-{workflows,models,lib}-close.png`;
    - `after-narrow-{initial,place,map}.png`.

**4.4 Loading.** Covered by the lazy reader in 1.5; the module shards stopped
being read at load in 2.2d. What remains is the viewer reading only what the
current zoom needs.
- The load after 4.2c, on this worktree's scan: about 2.07 MB in 22
  requests (2,065,395 bytes), the `placement` and `proximity` lenses each
  adding over 120 KB (181,378 and 126,755) since 4.3a.
- After 4.2d: 2,145,021 bytes in 24 requests. The lenses read since 4.2b,
  `placement`, `proximity`, `nesting` and `domains`, add about 388 KB, some
  22% over the 1,757,262 read before them. `nesting` could be read as a
  projection instead, the folder tree with its regions and seams, since
  the map reads it whole and derives nothing from it at load.
- Recorded at 4.2b: the viewer downloads the `placement` lens's consumer
  module lists, most of its 181 KB, only to count them. Either a
  count-only projection of the lens, or a lazy read of the lists for the
  place in Place, would leave the counts at load.
- **4.4 plan.** Planned 2026-10-10 at `7d61ed7`, against this worktree's
  scan with no domain declared. The load is 2,145,022 bytes in 24
  requests.
  - The largest part is not a lens. The 14 module edge shards are
    1,212,593 bytes and 14 of the 24 requests. The viewer reads all 4,668
    edges for three things:
    - recounting each file's imports, which equals the module records'
      `gravity.fanIn` and `fanOut`;
    - joining each package pair's endpoint files for trade harbors, roads
      and Trading partners;
    - keeping the edges for Trace imports.

    Then come the module index (334,194), `placement` (181,378),
    `file-roles` (137,688), `proximity` (126,755) and `nesting` (79,596).
  - Viewer only (this unit's first part):
    - Read `proximity` and `nesting` off the critical path: 206,351 bytes
      and 2 requests, which nothing at overview draws. They are read beside
      the terrain build, on a reader pinned to the manifest, and merged into
      the atlas after the relayout, keeping the islands, so the scene is not
      rebuilt; a scene `setData` repaints with them. The one visible
      deferral: Place and the hover readout give an island's proximity and
      path regions once they arrive. A refused late lens is shown as the
      load error is, not swallowed.
    - The capture's `marks` step splits the bytes into those read before
      `atlas:data-loaded` and after it.
    - A `--throttle` option emulates a slow network, so the bytes show in
      the timings.
  - lib/, to ask before any change:
    - A new lens, `import-traffic` (schema 1): each indexed module's
      `gravity.fanIn` and `fanOut`, copied from the module records rather
      than recounted, and each package pair's consumer and supplier files
      from the edge shards. About 94 KB on this scan, against 1.21 MB. The
      viewer's recount then retires, and the edge shards are read only on
      Trace imports, all 14 at once, since a file's importers can sit in
      any package's shard. It is a new lens rather than a `file-roles`
      bump, because `file-roles` lists 1,559 of the 1,566 indexed modules
      (packages without internals are missing).
    - Count-only placement cannot be a schema bump of `placement`: the
      `domains` lens reads its consumer-module lists. It needs a second
      artifact, so the ask is also how a lens publishes a projection and
      how `DatasetReader` exposes one. Counts for files, folders and
      packages are 29 KB; with symbols 85 KB. Symbol places (244 of 377)
      matter only when Place shows a symbol and could be read lazily.
    - `nesting` as a projection: folders with a path region (`id`,
      `pathRegion`), path regions per package, and seams as `{ package,
      from, to, moduleEdges }`. 31 KB against 80 KB.
    - Not asked: `file-roles` and the module index feed relief and layout
      at overview, and `responsibility-groups` orders the cells.
  - Acceptance: pixel-identical at overview and at island zoom once the
    late lenses are in. Load marks over three runs each, at full speed and
    throttled. Requests and bytes before and after `atlas:data-loaded`.
- **4.4a, done.** 2026-10-10: the viewer-only part of the plan. The
  `lib/` asks above are open.
  - `readCodexSource` no longer reads `nesting` or `proximity`.
    `readLateCodexSource` reads them, and `loadLateReadings` (in
    `load-atlas.ts`) resolves them on a reader pinned to the load's
    `generatedAt`, so a dataset a later scan replaced is refused. It marks
    `atlas:readings-loaded`.
    - Until they arrive, the atlas holds empty readings: no folder, path
      region or seam, and no package the proximity lens covered. Place
      says nothing of either rather than "none".
    - `App` starts the read as soon as the layout is done, beside the
      scene's build. It hands the readings to the map once the first frame
      is submitted (`afterFirstFrame` in `timings.ts`; the map releases it
      too if it cannot open), so the re-render they cause never lands in
      the build.
    - A refused read fails the page with its message, as a refusal at load
      does.
  - `useAtlasState` merges the readings after the relayout (`geometry` →
    `data`), so the islands keep their identity. `AtlasMap` builds and
    rebuilds the scene from `state.geometry` alone. A new scene method,
    `setData`, hands it the merged atlas, re-resolved through the kept
    territory layout, and repaints.
  - The capture's `marks` step reports the data read before
    `atlas:data-loaded` and after it. `--throttle <kbit/s>` (with
    `--latency`, default 40 ms) emulates a slow network.
  - Measured on this worktree's scan with an empty `domains` lens,
    `7d61ed7` against this unit, three runs each (`/tmp/review-shots/4.4/`):

    | | Requests before data-loaded | Bytes before data-loaded | Read after it |
    | --- | --- | --- | --- |
    | Before | 24 | 2,145,022 | none |
    | After | 22 | 1,938,671 | 3 requests, 219,892 bytes |

    The read after it includes `manifest.json` again (13,541 bytes): the
    pinned reader reads it to check the dataset is the same.

    | Timing | Before | After |
    | --- | --- | --- |
    | data-loaded, full speed | 74.7–85.4 ms | 81.2–85.3 ms |
    | data-loaded, 10 Mbit/s, 40 ms | 3,134–3,152 ms | 2,974–2,983 ms |
    | first frame, full speed, alternating runs | 2,651–2,682 ms | 2,610–2,671 ms |
    | first frame, 10 Mbit/s | 5,713–5,757 ms | 5,636–5,666 ms |

    Readings arrive at 114–118 ms at full speed, and are merged after the
    first frame. Throttled, the read finishes during the terrain build, so
    they are merged 6 ms after it. Locally the bytes cost about 7 ms. The
    throttled run is where they show: 150–170 ms off data-loaded and
    50–90 ms off the first frame. The first unalternated full-speed runs
    looked 80 ms slower after; the alternating runs show that was drift.
  - Unchanged on screen: before against after, 0 differing pixels at
    overview, at island zoom, on an entered island (workspaces) and close
    in, once the readings are in. Place's text for the island is identical
    too, proximity and path regions included. Text arriving after the
    first frame is the one deferral.
  - Tests:
    - `codex/source.test.ts`: the load reads neither lens; the late read
      reads only them; a pinned late read refuses a replaced dataset; the
      nesting refusal moves to the late read.
    - `codex/resolve.test.ts`: `resolveLateCodex`.
    - `timings.test.ts`: `afterFirstFrame`, by mark or release.
    - `atlas-map.test.ts`: one scene, built from `geometry`, with
      `setData` on arrival.
    - `atlas-shell.test.ts`: Place gains proximity and path regions when
      the readings arrive, and the scene is not rebuilt.
    - `atlas.test.ts`: over the real server, the load holds no nesting,
      then `loadLateReadings` brings it and marks it.
  - Next, with the `lib/` asks approved: the `import-traffic` lens would
    take the 14 edge shards (1,212,593 bytes) off the load for about
    94 KB, and the edges would be read on Trace imports. Count-only
    `placement` and the `nesting` projection would follow, once it is
    settled how a lens publishes a projection.
- **4.4b, done.** 2026-10-11. The coordinator's rulings on the `lib/`
  asks: the pairs as a new lens, the counts in the module index, the edge
  shards read on Trace imports only, a second manifest check after every
  late read, and the projections deferred.
  - `lib/`, self-contained:
    - The new `import-traffic` lens (schema 1) lists every ordered package
      pair the module edges cross, `{ from, to, consumerFiles,
      supplierFiles }`, sorted by code unit, joined once at scan time by
      `importPairs`. That is the join the codex did (`pairEndpoints`), which
      retires. It is registered in `LENSES`, its stage, the lens views
      (`atlas lens import-traffic`), and the docs.
    - Each module index entry carries `fanIn` and `fanOut`, counted from
      the edge shards written in the same step. Every indexed module has
      them, a failed package's included, so an unknown count never reads
      as 0. They equal the record's gravity wherever gravity was observed.
      (The first cut copied gravity, which leaves a failed package's files
      without counts; review caught it.) `DATASET_SCHEMA_VERSION` is 5, so a
      schema 4 dataset is refused with the message to scan again, and the
      reader's fallback for a manifest without `lenses` is gone. It is
      logged under Changes to existing code.
    - A collection names the workspace whose dataset cannot be read when
      it starts ("Workspace <root>: …"), as reading its manifest later
      does (`savedCollection`).
  - The viewer reads each file's import counts from the index and each
    pair's endpoint files from the lens; no edge shard is read at load.
    Trace imports reads every edge shard the first time it is asked
    (`loadImports`), with "Reading imports…" on the button (`aria-busy`)
    and a status line until they arrive. A failed read says why beside a
    Retry button, which reads again in one click, the trace still on. Both
    late reads check the manifest again once done (`stillTheSameDataset`),
    so a scan that published while they read is refused. A replaced dataset
    reads "A later scan replaced this dataset. Reload to see it." for the
    late readings, a trace, and an island's internals alike (`pinnedRead`
    in `web/dataset.ts`; the internals said "Reload Atlas" before).
  - Measured on fresh scans of this tree, `d237d24` (schema 4) against
    this unit (schema 5), alternating, three runs each
    (`/tmp/review-shots/4.4b/marks.txt`):

    | | Read before data-loaded | Read after it |
    | --- | --- | --- |
    | Before | 22 requests, 2,037,258 bytes | 3 requests, 239,323 bytes |
    | After | 9 requests, 809,003 bytes | 4 requests, 253,148 bytes |

    The after-load read gains the second manifest check (13,752 bytes).
    The module index grows by 34,099 bytes (378,223) for the counts. The
    lens is 21,089 bytes, against 1,283,516 in the 14 edge shards.

    | Timing | Before | After |
    | --- | --- | --- |
    | data-loaded, full speed | 64.4–84.9 ms | 72.9–78.7 ms |
    | first frame, full speed | 2,635–2,658 ms | 2,642–2,665 ms |
    | data-loaded, 10 Mbit/s, 40 ms | 3,049–3,067 ms | 2,018–2,019 ms |
    | first frame, 10 Mbit/s | 5,751–5,780 ms | 4,739–4,760 ms |

    Locally the bytes cost little. Throttled, the critical read is a
    second shorter, and the first frame a second sooner.
  - The first trace reads the manifest, the module index again for the
    shard list (378,223 bytes), the 14 shards (1,283,516), and the
    manifest for the check.
  - Unchanged on screen: 0 differing pixels at overview, at island zoom,
    on the entered workspaces island, close in, and with
    `workspace-system.ts` traced. Place's text is identical before and
    after, for the island and for the file ("7 import edges ending here
    … imports 8 modules"), and with the trace on.
  - Tests:
    - `import-traffic-lens.test.ts`: the join, code-unit order, no
      crossing, what the lens reads.
    - `render-lens.test.ts`: the view.
    - `semantics.test.ts`: the index's counts equal the edges in and out
      for every module, and gravity wherever it was observed. A fixture
      with `@s/b` failed, imported by `@s/a` and `@s/c`, carries edge
      counts on files without gravity. The saved lens equals the join of
      the scan's edges, and, checked independently of the join, the
      fixture's literal pairs (`@s/a` and `@s/c` into `@s/b`'s barrel).
    - `collection-scan.test.ts`: a schema 4 workspace in a collection is
      named at startup.
    - `codex/source.test.ts`: no shard, module or edge, is read at load;
      a dataset without the lens is refused.
    - `codex/resolve.test.ts`: counts from the index, 0 without gravity;
      endpoints from the lens.
    - `atlas-shell.test.ts`: the first trace reads once, says so, and
      hands the edges to the scene; a failure says why, and one click on
      Retry reads again. `web/dataset.test.ts`: a replaced dataset tells
      the reader to reload.
    - `atlas.test.ts`: over the real server, no edges at load, then
      `loadImports` matching every file's counts.
    - The registry, CLI and package tests for the new lens and schema 5.
  - Follow-up, deferred (recorded here, not started): count-only
    `placement` (29 KB without symbol places, against 194 KB on this scan)
    and the `nesting` projection (31 KB against 80 KB). Both need a
    lens-projection mechanism: how a lens publishes a second artifact, and
    how `DatasetReader` exposes it. `placement` cannot change in place,
    because the `domains` lens reads its consumer-module lists.

**Phase 4 is done** (2026-10-11). The chart stays, and what changed is
what is on by default and how strongly it is drawn. Position means folder
and layer, pigment means responsibility, and departures read without a
toggle.
- 4.0: the direction (legibility, not a new metaphor), the two groupings
  with one meaning each, and the developer flag (`?dev`).
- 4.1: the still chart (no animation loop; a frame only when a repaint
  asks) and a reader's settings, only layers that carry data. Wind, waves,
  the current, forests, houses, the chart filters and the props' shadow
  map are deleted. Roads, connecting land, the boundary overlays and the
  rendering controls are a developer session's.
- 4.2: the ink canvas as ordered layers, each in its own `save` and
  `restore`; the ink ladder in `scene/ink-ladder.ts`, with every colour,
  a contrast floor per rung, and one hue × dash × weight table the map key
  reads; islands without package hue; the latitude scale and the
  always-visible legend. The `placement`, `proximity`, `nesting` and
  `domains` lenses are read. Departures are drawn as the strongest signal
  after a selection, proximity at island zoom, and nesting and domains in
  Place.
- 4.3: islands on their layer's row in folder order, with no import pull;
  files placed by the folder tree; folder cuts and names at island zoom;
  a chosen domain drawn across islands.
- 4.4: `nesting` and `proximity` are read after the first frame. The
  module index carries each file's import counts, the new
  `import-traffic` lens each package pair's endpoint files, and the edge
  shards are read only on Trace imports. Dataset schema 5.
- Load on Foundry, WebGPU on Metal, 1500×1000, before Phase 4 against now.
  The datasets differ: the scan grew, and four lenses were added.
  - Before: 20 files and 1.71 MB at load; layout settled 412–429 ms,
    first frame 4.21–4.28 s.
  - Now: 9 requests and 809,003 bytes before `atlas:data-loaded`, and 4
    requests and 253,148 bytes after it; layout settled 93–98 ms, first
    frame 2.64–2.67 s.
  - At 10 Mbit/s, 4.4b alone took data-loaded from 3.05–3.07 s to
    2.02 s, and the first frame from 5.75–5.78 s to 4.74–4.76 s.
  - Most of the first frame is still the terrain build, about 2.1–2.2 s
    after the layout, which no unit of this phase measured apart.
- Left for later, by design:
  - Folder names should avoid departure rings and proximity beads (4.3c:
    `src/` over models' ring).
  - A ring's foot reads 3.63:1 against the departure floor of 8. The
    1.6-pixel line straddles two rows of pixels even under the tilt
    stretch (4.3c); reaching the floor means a heavier departure row.
  - Count-only `placement` and a `nesting` projection, which wait for a
    lens-projection mechanism (4.4b).
  - Every number here holds for Foundry, 15 packages, on one machine. No
    budget is validated for a larger workspace, nor the layout for a flat
    one: many layer-0 packages make one wide row (measurement, 4.3a).

## Phase 5: many workspaces

Detail in [`_workspaces.md`](./_workspaces.md#questions).

**5.0 Decide the use case.** Done 2026-10-10; see
[`_workspaces.md`](./_workspaces.md#decisions). A product split across
repositories that depend on each other, built against two fixture
workspaces (no local repository depends on a `@foundry/*` package across
repositories; Foundry with the Agents checkout is the manual check of
same-named packages). A package of the same name in two workspaces is two
packages, qualified `<workspace id>:<package>`. Crossings are package level,
from declared dependencies. No collection is persisted: the collection
manifest is derived from the saved workspace manifests by `serve` and
`export`. The viewer draws one archipelago per workspace, side by side.

**5.1 Resolve a collection.** Done 2026-10-10. No collection is persisted
(5.0), so this is the whole of what a collection is before its manifest:
its workspaces.
- `lib/state.ts` `resolveCollection(roots, state?)` resolves every path
  through `workspaceState`, so through symbolic links, with `resolveRoot`'s
  messages; when several fail, the first in the order given is named. A
  workspace given twice is kept once, and the workspaces come back as one
  `WorkspaceState` each, ordered by resolved root compared by code unit, so
  that the same paths in any order, in any locale, give the same
  collection. It creates nothing.
- It refuses no paths at all (`A collection needs at least one
  workspace.`) and accepts one workspace: the library's collection of one
  is well defined. The CLI is stricter, by the ruling in
  [`_workspaces.md`](./_workspaces.md#decisions) (decision 8): paths that
  name one workspace twice are refused there, in 5.3, so the output's
  layout never changes silently.
- It refuses two workspaces of which one holds the other (`Workspace
  <outer> holds workspace <inner>; the workspaces of a collection cannot
  overlap.`), including through a link that resolves inside another, with
  `@foundry/lib/paths` `isFilesystemPathWithin`, which export's place check
  uses too. A root sorts before every root inside it, so each is checked
  against the roots after it only; a sibling whose name extends another's
  (`repo` and `repo-b`) is not inside it.
- `resolveRoot` must stay the native `fs/promises` `realpath`, which a
  comment now says: it returns a case-insensitive file system's own
  spelling, so `Mixed` typed as `mixed` and `MIXED` is one workspace with
  one id; a test checks this where the temporary directory ignores case.
  Known limit, not fixed: `realpath` does not see through firmlinks or bind
  mounts, so one directory reached through two of them is two workspaces,
  with two ids and two state directories.
- `lockStates(states, lock?)` takes every workspace's lock in the order of
  the state directories' paths, which it sorts itself, or none: when one is
  held, the locks already taken are released in reverse and the held lock's
  error is thrown, with any failure to release attached as its `cause`.
  The release it returns runs once and tries every lock before it throws
  the one failure, or an `AggregateError` of them all. `lock` defaults to
  `lockState`, so a test can stand in a lock whose release throws. Only
  `atlas export` of several paths will take it (5.3), so that no
  workspace's dataset is replaced mid-copy; `scan.collection` scans one
  workspace at a time, each under its own lock.
- Tests: `test/lib/state.test.ts` (the order whatever the order of the
  paths, nothing created, a workspace given twice or through a link kept
  once, a collection of one accepted and of none refused, two spellings of
  one directory kept once, overlap refused directly and through a link, a
  prefix-named sibling allowed, the first missing path named in the order
  given, every lock taken and released once, none taken when one is held,
  every release tried when one throws, an `AggregateError` when several do,
  and the lock's error kept with a release's failure as its cause).

**5.2 The collection manifest.** Done 2026-10-10. Pure, and not yet read by
anything but its tests: `serve` and `atlas export` derive it in 5.3.
- `lib/collection-types.ts`, browser-safe under the `lib/*-types.ts`
  override, holds `COLLECTION_SCHEMA_VERSION` (1, independent of the
  dataset's), `QualifiedId` (`` `${string}:${string}` ``),
  `CollectionWorkspace`, `Crossing`, `AmbiguousDependency`, and
  `CollectionManifest` (`{ schemaVersion, workspaces, crossings,
  ambiguous }`). It has no time and no collection id of its own, since it
  is never saved (5.0, decision 5); each workspace's `generatedAt` is the
  pin its frame reads with.
- `lib/collection-manifest.ts` `collectionManifest(workspaces)` takes each
  workspace's id, resolved root, and saved manifest (`generatedAt`,
  `packages`, `workspace`, and `discovery.unitsSkipped`), orders them by
  root itself (by code unit, as `resolveCollection` does), and returns the
  same manifest for the same manifests in any order.
  `qualifiedId(workspace, id)` is `<workspace id>:<package>`.
- Each workspace lists its `dataset` (`<id>/`, relative to the collection
  manifest), its `generatedAt`, its `label`, and every package its manifest
  lists, failed ones included, qualified and sorted. The label is the
  manifest's `workspace.name` (the root `package.json` name), else the
  root's directory name; where two workspaces would share one, each is
  `parent/name` from its root (decision 3), and where two share that too,
  each adds its id's first six digits in parentheses. Two roots whose ids
  also share six digits could still share a label; ids never repeat.
- A declared dependency, of any of the four kinds, by the name it resolves
  to: stays inside its workspace when its range starts `workspace:` or its
  own workspace holds the name, analyzed or skipped; is a crossing when
  exactly one other workspace holds the name, as an analyzed package; is
  external when none does, or when the one other workspace holds it only as
  a skipped unit, since a crossing ends at a listed package; and is
  `ambiguous`, with no crossing, when two or more other workspaces hold it,
  analyzed or skipped. An ambiguous entry's `candidates` are the analyzed
  packages of that name, in the collection's order, and its optional
  `skippedIn` the workspaces that hold it only as a skipped unit, so every
  crossing's ends and every candidate are listed in some workspace's
  `packages`, which a test checks (decision 4). An `npm:` alias resolves to the package
  it names (`npm:@k/db@^1.0.0` and `npm:@k/db` are `@k/db`, `npm:lodash` is
  `lodash`, and a bare `npm:` names none), and the key it is written under
  is not read. The range is recorded as written and not checked against
  the version found (decision 10); other protocols are matched by the name
  they are written under (decision 4). Crossings are sorted by `from`,
  `to`, `kind`, and `range`; ambiguous entries by `from`, `name`, `kind`,
  and `range`; each field by code unit, through `@foundry/lib/ordering`
  `byCodeUnit`, chained, which `lib/state.ts` now uses too. Follow-up, not
  changed here: discovery itself sorts units and skipped entries with
  `localeCompare` (`semantics-discover.ts`, where it builds the
  discovery), and that order reaches the manifest, so it can differ by
  locale.
- A workspace holds the packages its scan skipped as well as those it
  analyzed, so that a dependency on its own JavaScript-only `@x/cfg` does
  not cross to another workspace's TypeScript `@x/cfg`. Discovery now
  records the name each skipped unit's `package.json` gives, as the
  manifest's optional `discovery.unitsSkipped[].name`: from the parsed
  manifest for a unit skipped as `analysis unsupported`, and, for one
  skipped as generated, gitignored, or excluded, read on purpose and
  tolerantly, so a missing or unparsable `package.json` there gives no name
  rather than failing discovery. Additive, so dataset
  schema 4 keeps its number; it is discovery code, not analysis, and
  nothing fingerprints the skipped list; logged below all the same, as
  1.7 and 3.6 logged their additive manifest fields. Names are recorded
  for all four reasons, since the path is recorded anyway;
  `reference/output.md` documents the field. A dataset saved before this
  change has no skipped names, so its workspace's skipped packages do not
  keep a dependency inside it, and it can make a false crossing, until the
  workspace is scanned again.
- The fixtures `test/lib/fixtures/collection/platform` (`@k/db`, which
  depends on `@k/shared` with `workspace:*`, and `@k/shared`) and
  `product` (`@k/shared` of its own, `@p/app`, which declares `@k/db:
  ^1.0.0`, `@k/shared: workspace:*`, and `left-pad`, and `@p/web`, which
  declares `@k/db: workspace:*`, `@p/app: workspace:*`, and `database:
  npm:@k/db@^1.0.0`). `@p/web`'s `@k/db: workspace:*` is deliberately
  invalid, since product holds no `@k/db`: it is there to show that a
  `workspace:` range never crosses. The two crossings are `@p/app` and
  `@p/web` to platform's `@k/db`; `@k/shared` is two packages.
- The glossary gains **Qualified id**, **Crossing**, **Ambiguous
  dependency**, **Label**, and **Collection manifest**, which is not a
  lens: a lens reads one dataset and is saved in it.
- Tests: `test/lib/collection-manifest.test.ts`, over literal manifests (a
  crossing per kind, a name the declaring workspace holds kept inside it,
  a package naming itself, `workspace:` ranges and a `workspace:` alias
  never crossing, `npm:` aliases scoped with and without a version,
  unscoped, bare, and under a key that is itself a package name, the range
  unchecked and last in the order, ambiguous across three workspaces with
  an alias, a skipped package held by its workspace, never crossed to when
  the one other workspace only skipped it, counted toward ambiguity but
  named only in `skippedIn`, every crossing's ends and every candidate
  listed (also over the fixtures), a failed package listed and crossed to, an
  external name, the workspaces by root, shared labels by parent and by
  id, and the same output with the workspaces, packages, and dependencies
  in reverse) and over the two fixtures, scanned with `scan.workspace` into
  a temporary state root; `test/lib/semantics.test.ts` (skipped units'
  names, including a generated unit whose `package.json` does not parse),
  and the skipped entries in `ignore.test.ts`, `scan.test.ts`, and
  `package.test.ts` gain their names.

**5.3 Many paths for real,** in two parts: (i) the library and the server,
(ii) the commands and `atlas export`. Deferred to it from 5.2, since nothing
reached the collection manifest before: the package exports, the exact
values in `test/package.test.ts` and its TypeScript consumer, and
`reference/output.md`, `reference/cli.md`, `reference/library.md`, and
`_api.md`; (i) does all but `cli.md`, which (ii) does with the commands.

**5.3 (i) The library and the server.** Done 2026-10-10.
- `scan.collection(roots, options?)` (`lib/scan.ts`) resolves the
  collection (`resolveCollection`), runs `scan` for each workspace in the
  collection's order, one at a time and each under its own lock, and
  returns a `CollectionScan`, `{ manifest, workspaces }`: the collection
  manifest derived from the manifests just saved, and each workspace's
  `Scan` with its accessors. Nothing is saved for the collection, so there
  is no `output`. One at a time because each scan already runs its packages
  in parallel and its progress stays in one piece. When a workspace fails,
  those before it keep their saved datasets and the call rejects with
  `Atlas could not scan <root>: <message>`, the workspace's own error as
  `cause` (the class of a `DatasetNotFoundError` and the like is then on
  the cause, not the error) and the scans that succeeded as `scanned`, so
  a caller keeps them.
- `CollectionScanOptions` is `ScanOptions` with `onProgress` receiving a
  `CollectionProgressEvent`, `{ kind: "workspace", id, root, event }`
  (5.0's decision 4): the exported `ScanProgressEvent` gains no member.
- `serve.collection(roots, options?)` (`lib/serve.ts`) makes `serve`'s
  checks (Bun, the port, the viewer; one `serving` helper now does them for
  both), then `dataset-files.ts` `savedCollection(roots, state?)`, which
  checks each workspace's saved dataset in the collection's order, as
  `savedDataset` checks one, so the first without one is named. It returns
  a `CollectionServer`, `{ roots, url, stop }`. `AtlasServer` keeps its
  singular `root`, deliberately: a collection's server is its own type, so
  no single-workspace caller sees a change. Both extend an internal
  `RunningServer`, `{ url, stop }`.
- `savedCollection` is the one mount table: `{ workspaces, datasets,
  manifest() }`, each workspace's output by exact workspace id, and the
  collection manifest derived from the manifests saved when it is called.
  `server/server.ts` `startServer` takes it as `collection`, or one
  workspace's `output` as before, never both (a union type), so the single
  call sites (`serve`, `scripts/dev.ts`, the tests) are unchanged.
  `/data/collection-manifest.json` is the manifest, built at each request,
  compact JSON as the dataset's files are; `/data/<id>/<path>` is that
  workspace's file, through the same `serveFile` and its guards; any other
  `/data/` path, an unknown id or a bare `/data/<id>` included, is 404.
  `Cache-Control: no-store` as for every `/data/` response. A workspace
  whose manifest cannot be read when the manifest is asked for (deleted,
  caught mid-swap, or of another schema) makes it `503` with
  `Retry-After: 1`, not a bare `500`: `savedCollection`'s `manifest()`
  rejects naming the workspace, with `savedDataset`'s message when nothing
  is saved and `Workspace <root>: <message>` otherwise. `scripts/dev.ts`
  takes the same mount table once the command line reads several paths,
  in (ii).
- `lib/dataset-layout.ts` names the collection's files:
  `COLLECTION_MANIFEST` (`collection-manifest.json`) and
  `collectionDataset(id)` (`<id>/`), which `collectionManifest` now uses
  for each workspace's `dataset`.
- Exports: `COLLECTION_SCHEMA_VERSION` (a value: the library now exports
  seven, the six of 1.10 and this one), `scan.collection` and
  `serve.collection` (properties of `scan` and `serve`, as
  `scan.workspace` is, so not values of their own), and the types
  `CollectionScan`, `CollectionScanOptions`, `CollectionProgressEvent`,
  `CollectionServer`, and `CollectionManifest`; a crossing is
  `CollectionManifest["crossings"][number]`. No browser-read collection
  file exists yet beyond `lib/collection-types.ts`, which the
  `lib/*-types.ts` override covers; the collection reader comes with 5.4a.
- The viewer does not read the collection manifest yet: it still reads
  `./data/manifest.json`, which a collection's server does not serve, so
  `serve.collection` shows the viewer's "No dataset found" until 5.4a.
- Tests: `test/lib/collection-scan.test.ts` (the two fixtures given out of
  order and scanned in the collection's, each workspace's output and full
  scan, the crossings, the result's JSON keys, `savedCollection`'s manifest
  equal to the scan's, progress wrapped and one workspace after the other,
  and a held lock on the second workspace: the first stays saved, the error
  names the root and carries the cause and the first workspace's scan as
  `scanned`, and `savedCollection` then names
  the workspace with no dataset); `test/lib/serve.test.ts`
  (`serve.collection` under Node names Bun); `test/atlas.test.ts`, under
  Bun (`serve.collection` refuses a workspace with no dataset, serves the
  roots in order, the manifest with its headers and crossing, a dataset
  file byte for byte, 404 for `manifest.json`, an unknown id, a bare id,
  and a missing file, a rewritten manifest seen at the next request, `HEAD`
  on the manifest, `%2F`-encoded `..` from one dataset into another and
  into the state directory and a link inside an output all 404, and a
  removed and an outdated manifest each a `503` naming the workspace);
  `test/package.test.ts` (seven values, `scan.collection` and
  `serve.collection` are functions, and the TypeScript consumer uses every
  new type, a crossing by indexed access, and is refused `root` on a
  `CollectionServer` and one path for `scan.collection`).

**5.3 (ii) The commands and `atlas export`.** Done 2026-10-10. Paths are
plural for real.
- `cli/args.ts`: `scan`, `serve`, the default command, and `export` read
  `[path, ...paths]` (`somePaths`); `report`, `lens`, `check`, `plan`, and
  `apply` keep one (`onePath`) and refuse a second with exit `2`, `atlas
  <command> reads one workspace's dataset; give one path.`: each reads or
  writes one workspace's dataset, rules, lens, or journal, and a package,
  rule, or site could name a place in either workspace. `SEVERAL_PENDING`
  is gone.
- `workspacesOf(paths)` (`cli/args.ts`) is the CLI's one reading of the
  paths. One path is one workspace, passed on as given, so the
  single-workspace code runs unchanged, its messages included. Two or more
  are resolved in the order given (a missing one fails as the library fails
  it, exit `1`); two that resolve to one workspace (the same path twice,
  `a` and `a/`, or a link) are a `UsageError`, exit `2`, `<path> names the
  same workspace as <earlier path>, <root>; give each workspace once.`
  (5.0, decision 8). Two of which one holds the other are a `UsageError`
  too, exit `2`, in the library's words: `lib/state.ts` `overlapRefusal`
  (pure, over resolved roots) gives the message to both `resolveCollection`,
  which throws it as an `Error`, and `workspacesOf`. Otherwise a collection,
  passed on as given, which the library orders.
- `cli/atlas.ts`: `scan` and the default command call `scan.collection`,
  `serve` and the default command `serve.collection`, and `export`
  `exportCollection`, for a collection. Progress prints `workspace: <root>`
  before each workspace's lines. `scan` prints one `Dataset saved to <dir>`
  per workspace and `Collection: <n> workspaces, <n> crossings`; a server
  prints `Atlas: <url>` and one `Workspace: <root>` per workspace.
  `whileServing` takes any server's `{ url, stop }`.
- `--json`, one line as before: `scan`, `{ manifest, workspaces }` (the
  collection manifest, and each workspace's `{ manifest, output, history? }`);
  `serve`, `{ roots, url }`; the default command, `{ manifest, workspaces,
  roots, url }`; `export`, `{ directory, manifest, workspaces }`, the
  collection manifest and each workspace's `{ id, root, dataset }`,
  `dataset` being the directory its dataset was copied to, so that the line
  is told from a single workspace's `{ directory, manifest }`.
- `lib/export.ts` `exportCollection(roots, directory, options?)`, internal
  as `exportViewer` is: `savedCollection` (every dataset checked), the place
  checks for every workspace (`checkPlace` now takes a list, so it refuses a
  directory that holds any workspace or overlaps any state directory),
  `lockStates` for the copy, `refuseUnfinishedApply` for each, then the
  viewer, each output whole under `data/<id>/`, one after another so that a
  failure stops the copy where it is, and
  `data/collection-manifest.json`, derived from the copied manifests, the
  same compact JSON the server answers, and the marker (`writeMarker`, now
  shared). No `data/manifest.json`.
- `scripts/dev.ts` reads its paths through `workspacesOf` too and, for a
  collection, gives `startServer` the `savedCollection` mount table that
  `serve.collection` uses.
- The help: the default command is "Scan, serve, and open the browser",
  the others' summaries say datasets, and "The path defaults to the
  current directory. atlas, scan, serve, and export read several paths as
  one collection; the other commands read one workspace." The README and
  `reference/cli.md` carry it verbatim; `cli.md` gains a "Several
  workspaces" section, the collection's `--json` rows, exit code `2`'s new
  cases, and the collection forms of the export and the server.
- What 5.4a needs to find a collection, served or exported, is the same: no
  `data/manifest.json`, `data/collection-manifest.json` instead, and each
  workspace's dataset at its entry's `dataset`, relative to it. The fetch
  transport knows a missing file by its `404` status, which a static host
  gives too; a host that answers a missing path with `200` and an HTML
  page (a single-page fallback) would make the probe fail to parse
  `manifest.json` instead, which 5.4a may want to name. So the probe is: read
  `./data/manifest.json`; on `DatasetNotFoundError`, read
  `./data/collection-manifest.json`; then a reader per workspace at
  `./data/<dataset>`. Three rules for it:
  - Fall back to the collection manifest only when `manifest.json` is not
    found (`404`, `DatasetNotFoundError`). A parse error or a `5xx` there is
    an error the viewer shows, never a reason to try the collection.
  - A `503` from the collection manifest means a workspace is being
    swapped: retry after `Retry-After`, never report "no dataset".
  - Pin each workspace's reader to its entry's `generatedAt`, so a scan of
    one workspace mid-load is caught as a replaced dataset.
  Until then, both forms show the viewer's "No dataset found".
- Tests: `test/cli/args.test.ts` (several paths for the four commands, the
  five refusals, and `workspacesOf`: one path as given, unresolved; several
  in the order given; a link to a given one refused as a `UsageError`
  naming both; a workspace inside another refused as one; the first
  missing path named); `test/atlas.test.ts`,
  "built CLI collections", over the platform and product fixtures and the
  built CLI: `scan` of two paths given out of order (text, progress
  headers, `--json` keys, outputs in order, the two crossings), duplicates
  for `scan`, `serve` through a link, `export`, and the default command
  (exit `2`, nothing on stdout), the refusals for `report`, `lens`, and
  `check`, `serve --json` (roots, the manifest's datasets, a dataset file
  byte for byte) and its text lines, the default command's one line, whose
  manifest equals the served one, and `export --json` (the written
  collection manifest equals the printed one, each dataset byte for byte,
  no `data/manifest.json`, a second export replacing the first, and a
  directory holding the workspaces refused, and `workspaces` in its
  `--json`), and two overlapping paths exiting `2`;
  `test/lib/export.test.ts` (`exportCollection`: each dataset under its id
  and the collection manifest, given out of order; a held lock on the
  second workspace refused, the first's released, and the previous viewer
  intact; an unfinished apply in one workspace refused with every lock
  released; a target that is or is inside the second workspace's state
  directory refused; and a copy that fails at the second workspace, which
  leaves the previous viewer intact and no staging directory beside it).

**5.4 The viewer.** Waits for Phase 4. 5.4a, the data seam: the data root
per workspace (1.5 reduced it to one place, `DATA_ROOT` in
`web/dataset.ts`), the probe for a collection, and a dataset reference per
island. 5.4b, the drawing: frames side by side, one rim per frame, and the
crossings' ink. The collection manifest keeps one crossing per kind and
range, so the drawing merges crossings by `from` and `to`: one line per
pair of packages.
- **5.4a plan.** Planned 2026-10-11 after Phase 4, ruled by the
  coordinator.
  - Option A: an island's lens readings stay bare and live in its frame,
    `AtlasFrame { id, label, dataset, territories, readings }`, as decision 5
    and the glossary keep ids bare inside a workspace's dataset. Readings
    are looked up through the island's frame.
  - `viewerDataset({ dataset })`. `DatasetRef` (data root and
    `generatedAt`) replaces `data.generatedAt` in the hooks.
  - The probe follows 5.3, with `loadInternals({ dataset, package, files,
    … })` binding to the island's own files.
  - `qualifyAtlasData` after each workspace's layout, beside `AtlasData`.
  - A plain x offset per frame until 5.4b, and the relayout per frame.
  - A chosen domain carries its frame, and Find shows frame labels in a
    collection.
  - Crossings: the field only; their listing and drawing are 5.4b.
  - Split, as allowed: (i) the frame restructure, a single workspace with
    no behaviour change; (ii) collections.
- **5.4a, done.** 2026-10-11, in the two parts planned.
  - (i) The frame restructure. `AtlasData` loses `placement`,
    `proximity`, `nesting`, `domains` and `generatedAt`, and gains
    `frames`.
    - `types.ts` holds `DatasetRef`, `FrameReadings` and `AtlasFrame`,
      with `frameOf`, `islandSource` (an island's dataset and bare package
      id) and `qualifiedIn`/`bareIn`.
    - Consumers read through the frame: `departures.ts` and
      `proximity.ts` frame by frame, `domain-extent.ts` within a domain's
      frame (`DomainRef { frame, name }`), and Place's text through a
      `PlaceView`. Ties now name file ids, not paths, which are the same
      strings in a single workspace.
    - Late readings come back by frame id (`LateReadings`) and merge into
      their frames.
    - `viewerDataset({ dataset })` reads under a frame's root and pins to
      its `generatedAt`. `useBelonging`, `useArchitecture` and the
      architecture panel take an `IslandSource`.
    - `loadInternals` takes one request, `{ dataset, files, island?,
      package, recordedChange?, roles, signal }`, the pin being the
      dataset's `generatedAt`. It binds the internals to the island's own
      files by path, so it reads no module index. `island`, the island's id
      on the map, is an addition to the ruled shape: overlays name their
      island by it, and in a collection the internals' own package id is
      bare.
    - Measured on this worktree's scan, HEAD (`b667ca5`'s code) against
      this unit, over the same session (select workspaces, as the capture
      steps do): the module index was read 6 times, 2,269,338 bytes, and
      now once, at load, 378,223 bytes. The session's data was 33
      requests and 9.03 MB, and is now 25 requests and 6.12 MB; the run
      before also read one island's internals twice.
  - (ii) Collections.
    - `loadAtlas` reads `./data/manifest.json` first. Only on
      `DatasetNotFoundError` does it read `collection-manifest.json`
      (`readCollectionManifest` in `web/dataset.ts`): a 404 there is "No
      dataset found"; a 503 is asked again after `Retry-After` (1 second
      if absent, at most 10, 30 attempts), and `App` shows the server's
      reason while it waits; a parse error, another failure, or another
      schema version is shown. A parse error or a 5xx at the data root is
      shown and never falls back.
    - Each workspace's source is read on a reader pinned to its entry's
      `generatedAt`, laid out with its bare ids (`layoutWorkspace`), then
      `qualifyAtlasData`. That qualifies, `<workspace id>:<package>` and
      `<workspace id>:<path>`, the islands and their files, cells, layers,
      routes and their endpoint files, import edges, declared dependencies
      and former packages. Paths, folders and readings stay bare.
    - `composeCollection` (`web/collection.ts`) sets the frames side by
      side (`besideEachOther`: each frame its own chart's width, the whole
      centred), joins their fields, and keeps the collection manifest's
      crossings in `AtlasData.crossings`. Not routes, not drawn, not
      listed: 5.4b.
    - `relayoutAtlas` places a collection's frames again one by one, so no
      row takes two workspaces' islands, and sets them side by side again;
      former packages move as far as their frame's middle does. A single
      workspace's relayout is unchanged.
    - Late readings and Trace imports run frame by frame. Each frame has its
      own pinned reader and second-manifest check, and the edges are
      qualified as the frame's files are. `atlas:readings-loaded` is
      marked once, after every frame.
  - Unchanged for a single workspace: 0 differing pixels, HEAD against
    this unit on the same scan, at overview, at island zoom, on the
    entered workspaces island, close in, and with `workspace-system.ts`
    traced; Place's text is identical; the load reads the same 9 requests
    and 809,004 bytes before data-loaded.
  - A collection, served from scans of the platform and product fixtures
    with `atlas serve` of two paths, loads with no console error. It reads
    19 requests and 18,822 bytes before data-loaded (the 404 at the data
    root, the collection manifest, and each workspace's files), and 8
    after; first frame at 1.22 s. The two frames sit side by side. Find
    and Place read a qualified island (`@p/app`), with its readings and
    internals, and its imports from product's own `@k/shared`
    (`/tmp/review-shots/5.4a/collection-*.png`).
  - Tests:
    - `test/web/collection.test.ts`:
      - the twin fixture (the reference atlas twice: twice the islands and
        files, every id unique, every route, file edge, declared
        dependency, crossing and former-package endpoint resolving);
      - the readings and paths bare, and each frame's layout the one its
        bare ids seeded;
      - the per-frame relayout;
      - the probe: neither manifest is "No dataset found"; an unparsable
        or failing `manifest.json` never tries the collection; a 503 waits
        and says why; another schema version or an unparsable collection
        manifest is refused.
    - `atlas.test.ts`, under Bun: `serve.collection` over the scanned
      platform and product fixtures, loaded with `loadAtlas()` (frames,
      datasets, unique qualified ids, `@k/shared` twice, the two crossings
      resolving, routes, late readings by frame, qualified imports).
    - `atlas-shell.test.ts`: a collection's Find shows "domain · product"
      and chooses the domain with its frame, covering only that frame's
      island.
    - `test/helpers/frames.ts` (`singleFrame`, `withReadings`) carries the
      existing tests' readings into frames. `load-churn.test.ts` now finds
      no module index read by `loadInternals`.
  - The glossary gains **Frame**. `_viewer.md` question 6 is recorded as
    answered.
  - At review:
    - A workspace's failure in a collection is named by its label. A
      dataset the collection manifest lists but the server no longer has
      reads "Workspace <label> is being saved; reload in a moment."; any
      other failure reads "Workspace <label>: …". Both are tested.
    - Find lists a collection's islands as "<name> · <frame label>". Tested.
    - The legend's dominant share is the `placement` lens's policy
      constant (`PLACEMENT_POLICY`), the same for every workspace, so the
      first frame's reading of it stands for all.
    - `frameOf` throws for an island in no frame of a collection rather
      than answering another frame's readings.
  - Known gaps, for 5.4b:
    - Island names, the breadcrumb and Place's title are bare labels, so
      two workspaces' `shared` look alike outside Find.
    - One latitude scale spans every frame, its ticks at the layer rows
      all frames share.
    - The interim spacing gives each frame its own chart margins.
    - Crossings are in `AtlasData.crossings` only: neither drawn nor
      listed.
- **5.4b plan.** Planned 2026-10-11, after 5.4a.
  - Layout: `besideEachOther` goes. Each frame is placed alone
    (`settlePackages`) and then moved whole, so its own layout is kept. Along
    x, the frames sit west to east in the collection's order, with a fixed
    stretch of open water between one frame's rim and the next. Along y,
    every frame's rows sit on one `latitude(layer)` axis. One offset then
    centres the whole, as `centre` does for a single workspace.
    `relayoutAtlas` uses the same composition, and a former package moves
    with its frame.
  - One rim per frame: `archipelagoHull` takes a frame's islands, and the
    sea, the topography's outer rings and the developer's Atlas hull
    take one rim per frame. A single workspace has one rim, built as
    before.
  - Latitude scale: one shared axis, since the rows now align layer by
    layer. A frame's layer *n* is its own workspace's layer *n*.
  - Labels: one `islandName` helper gives "name · frame label" in a
    collection. Find, the breadcrumb, Place's title and the pointer readout
    use it. On the map, each frame's label is set above the frame in spaced
    capitals. An island's caption adds its frame's label only where another
    frame has an island of the same name.
  - Crossings: merged by (`from`, `to`), one line per pair, between nearest
    coasts, routed and clipped as departure lines are, with a bead at the
    package depended on. A new `crossing` rung goes between `departure` and
    `file`, measured on its own ground, the open water between two rims
    that the lines cross. The new ink is kept 10 ΔE76 from every ink a sea
    line sits beside, in every vision.
  - Selection wins. With an island selected, only its own crossings stay
    drawn, under the selection's ink. With nothing selected, every crossing
    is drawn, under the departure lines.
  - Place lists the selected island's crossings, both directions, beside
    Trading partners. They are plain text: not routes, never in
    `data.routes`, and not selectable. The legend gains a crossing row only
    when the atlas has crossings.
  - A single workspace must stay pixel-identical, checked against `d8fda37`
    with the capture script's `compare` on one scan.
- **5.4b, done.** 2026-10-11, as planned, with the deviations named below.
  No `lib/` code changed.
  - Layout:
    - `geography.ts` `sideBySide(frames, layers)` replaces
      `besideEachOther`. It returns each frame's `{ dx, dy }`.
    - x: west to east in the collection's order, `frameSea` (120 units)
      between one frame's rim and the next, measured on the rims' extents
      along x. A frame with no islands takes no space.
    - y: each frame back onto `latitude(layer)`, which any one of its
      islands gives, since `settlePackages` moved its rows by one offset.
    - Then one offset for the whole, from `middleOf`, the function
      `centre` now calls too, so a single workspace's numbers are the same.
    - `composeCollection` and `relayoutAtlas` both use it. A former package
      moves with its frame, in x and y; in a relayout, by its frame's
      middle.
    - `islandsByFrame` moved to `types.ts`, beside `frameOf`, so that
      `geography.ts` can read the rim without an import cycle.
  - One rim per frame: `archipelagoHull` takes `{ territories }`, and
    `archipelagoRims(data)` gives one rim per frame, or the one rim of every
    island for a single workspace. `oceanField` fills each, so the open-water
    steps, the topography's outer rings and the developer's Atlas hull are
    per frame.
  - Latitude scale, decided: one shared axis. With the rows aligned, the
    5.4a scale code is right for every frame and is unchanged. A frame's
    layer *n* is its own workspace's: a crossing does not move a package up
    a row.
  - Labels:
    - `types.ts` `islandName` gives "shared · platform" in a collection and
      the bare name otherwise. Find (its inline form retired), the
      breadcrumb, Place's title and the pointer readout use it, so the
      polite live region does too. Find matches on it, so "platform" lists
      platform's islands.
    - On the map each frame's label sits above the frame in spaced
      capitals: 14 pixels, 3 pixels apart, centred over its islands, 18
      pixels above the tallest of its northernmost names. It is set in the
      label ink on the sea's halo, as a candidate right after the domain's
      name. `MapLabel.frame` is its frame's id, and it has no `territory`,
      so nothing can take it for an island's; a click passes through it.
      Where it would sit on the compass rose (`compassBox`, in map units),
      it moves west, clear of the rose by its gap. Only frame labels move,
      so a single workspace's labels are untouched.
    - Where two frames hold islands of one name, each caption adds its
      frame's label ("1 FILE · PLATFORM"). Other captions are unchanged.
  - Crossings:
    - `crossings.ts` `crossingPairs` merges the manifest's crossings by
      `from` and `to`, keeping every kind and range; `crossingsOf` gives an
      island's pairs both ways.
    - `scene/ink/crossings.ts` draws one curve per pair between the nearest
      coasts (`nearestCoasts`, now exported), 7 units off each, bowed by
      `seaCurve`, clipped by `clipToSea`, with a 2.6-pixel bead at the
      package depended on. The curves are cached per atlas in a WeakMap.
      The layer comes before `departures`.
    - Ink: rung `crossing` between `departure` and `file` (floor 6), a deep
      violet, `#580490`. Its table rows are `crossing` (2 pixels, long
      dashes 10, 4) and `crossing-bead`. Its nearest ink in any vision is
      the domain's name under deutan, at 19.1 ΔE76.
    - Selection wins, decided: with an island selected, only its own
      crossings stay, under the selection's lines; with nothing selected,
      all are drawn, under the departure lines. Departure lines still go on
      any selection, as before.
    - Place, `ui/crossings-place.tsx`: "Across workspaces" under Trading
      partners, for an island selection. One line per pair, "Depends on db
      · platform: dependencies ^1.0.0" or "Depended on by …", with a
      sentence saying these are declared dependencies, not routes. No
      buttons.
    - Legend: a crossing row, "2 lines between 2 workspaces", and a map key
      paragraph, both only when the atlas has crossings.
  - Deviations, with reasons:
    - The crossing is measured on `grounds.openWater` (`#b4c4c5`, the ocean
      blue at the chart's edge), not on a probed channel ground. A line
      between frames crosses the open water beyond the rims, which steps
      darker than `grounds.sea` and further where the rims curve away. The
      darkest water there is cannot be undershot. The ladder's type gains
      that ground.
    - The frame's label takes the `label` row, whose meaning now includes
      a workspace's name, rather than a text ink of its own. A second text
      row in the label hue would break the table's uniqueness, and a new
      text ink would have to sit inside the label rung on every ground and
      10 ΔE76 from every label ink. Its form, spaced capitals above the
      frame, tells it apart.
    - The breadcrumb names the island "shared · platform" rather than
      gaining a frame crumb. No frame is a selection to return to.
  - Ladder numbers, computed (contrast at full strength, crossing against
    departure ring): open water 6.34 against 6.62, sea 7.28 against 7.60,
    land 9.54 against 9.96, halo 9.97 against 10.40. The entered ring, the
    darkest file-rung mark, is 7.75 on land.
  - Probed on screen, platform and product, overview at 1500×1000 on
    Metal: the crossing renders exactly `#580490`, and reads 6.86, 7.01,
    7.08 and 7.30:1 against the water beside it, the darkest ground
    `rgb(194, 203, 192)`. A frame's label, in the label ink, reads
    4.68–5.52:1, the lowest on a row where the 6-pixel halo leaves a gap
    between spaced letters; still over the label floor of 4.5.
  - Unchanged for a single workspace, checked on this worktree's scan into
    a fresh state, `d8fda37` built in a temporary copy against this unit:
    - 0 differing pixels at overview, zoomed twice, on the selected
      `workspaces` island, close in on it, and with Topographic lines on,
      which draws the outer rings at the rim.
    - The breadcrumb, Place's text and the legend's text are identical.
    - The load reads the same 9 requests and 809,991 bytes before
      `atlas:data-loaded`, and 4 and 251,475 after; first frame 2.56 s
      against 2.55 s.
  - Collection load, the same fixtures, before against after: the same 19
    requests and 18,823 bytes before `atlas:data-loaded`, 8 and 15,715
    after, no console error. The chart is wider, 765 units against 615,
    since the rims now keep open water between the frames, and the first
    frame comes at 1.45–1.46 s against 1.21–1.24 s, as the terrain is
    built over the larger sheet.
  - Screenshots, `/tmp/review-shots/5.4b/`: `c-before-*` and `c-after-*`,
    the collection at overview, `app` and `db` selected, `shared ·
    platform` selected, and both with the developer's Atlas hull and
    Topographic lines on (`*-dev-rims.png`, one rim against two); `s-*`,
    the single workspace's compared views.
  - Tests:
    - `test/web/collection.test.ts`:
      - twins' layout kept up to a translation in x and y;
      - one rim per frame, `frameSea` between them, before and after a
        relayout;
      - two frames of three rows and two, each centred differently alone,
        on one latitude axis together;
      - `islandName`;
      - merging by pair, both directions, and none for a single workspace.
    - `test/web/crossings.test.ts`:
      - one curve per pair, in the crossing ink, none for a single
        workspace, never a route;
      - only the selected island's own crossings;
      - the frames' labels, naming their frame and no island, which a
        click passes through;
      - a long frame label moved off the compass rose at three zooms;
      - frame captions only on shared names;
      - none of either for a single workspace.
    - `test/web/atlas-shell.test.ts`: the breadcrumb, Place's title and the
      readout as "name · first"; the crossings listed both ways, without a
      button; the legend row; none of it for a single workspace; Find by a
      frame's label.
    - `test/web/ink-ladder.test.ts`: the rung order, the crossing ink's
      shared rows, and 10 ΔE76 from every ink a sea line sits beside, in
      every vision.
    - `atlas.test.ts`, under Bun, over the scanned platform and product:
      two pairs, no route among them, `frameSea` between the rims, one
      latitude axis.
    - The twin fixture moved to `test/helpers/twins.ts`.
  - Left for later:
    - A crossing is not selectable, by the 0.1 ruling.
    - The frames' order is the collection's, by root, not by their
      crossings.
    - Every number here is two one-file fixtures. No real collection of
      repositories that depend on each other exists locally (5.0).

**Phase 5 is done** (2026-10-11). Several workspaces are scanned, served
and exported as one collection, each keeping its own state and dataset,
and drawn as one archipelago per workspace with the crossings between
them.
- 5.0: the use case, a product split across repositories. A package of one
  name in two workspaces is two packages, qualified `<workspace
  id>:<package>`. Crossings are package level, from declared dependencies.
  Nothing is persisted for a collection.
- 5.1: `resolveCollection` resolves, dedupes and orders the roots by code
  unit, refusing one inside another; `lockStates` takes every lock or
  none, for export.
- 5.2: `collectionManifest`, pure. Labels, crossings, and ambiguous
  dependencies (a name two or more other workspaces hold, with no edge).
  `npm:` aliases are resolved and ranges recorded unchecked. Discovery
  records skipped units' names, so a workspace's own skipped package keeps
  a dependency inside it.
- 5.3: `scan.collection` scans one workspace after another, each under its
  own lock. `serve.collection` builds the manifest per request and mounts
  each dataset by exact id. `scan`, `serve`, the default command and
  `export` take several paths; the other commands refuse a second, and one
  workspace given twice exits `2`.
- 5.4a: the viewer reads a collection when the data root has no
  `manifest.json`. Each workspace is one frame with its own pinned reader
  and readings, its ids qualified after its own layout. A single
  workspace's load is unchanged, pixel for pixel.
- 5.4b: frames side by side, one rim each, on one latitude axis. Frame
  labels on the map and "name · frame" off it. Crossings are drawn, one
  line per pair on their own rung, and listed in Place.
- Where it lives: 5.0–5.3 landed on `feat/atlas`; 4.4b, 5.4a and 5.4b on
  `feat/atlas-viewer`, which has merged back into `feat/atlas`.
- Load: a collection of the two fixtures reads 19 requests and 18,823
  bytes before `atlas:data-loaded`. A single workspace is unchanged across
  the phase: 5.4a read the same requests and bytes as `b667ca5` on one scan
  (9 and 809,004), and 5.4b the same requests, bytes and pixels as 5.4a on
  another (9 and 809,991).
- Left for later, by design:
  - Crossings are not selectable as routes, and there are no module-level
    edges across workspaces (decision 4).
  - Ranges are recorded, not checked; `file:` and `link:` ranges are not
    followed; linking same-named packages is a later collection setting.
  - `realpath` does not see through firmlinks or bind mounts (5.1).
    Discovery's skipped-unit order uses `localeCompare` (5.2).
  - History stays per workspace (decision 7).
  - Every collection number is for two small fixtures, on one machine.

## Changes to existing code

Every change to analysis code, with its reason, before it is made.

| Change | Reason | Status |
| --- | --- | --- |
| Symbol ids carry no kind | `symbols.ts:133` forms `path#name`; an interface and a const of one name share an id, and five lookup maps keep the last one. | Confirmed. No change for now: a facet without a kind matches every symbol of that id. Revisit only if a codemod needs to tell them apart. |
| Anchors matched by name only in concept recentering | `concept-recentering.ts:1383`; an anchor declared by path is invisible there. | Only if domains feed anchors: not needed for 0.1 (3.7); due with the first codemod that moves, rehomes, or folds. |
| The worker passes no `AnalysisConfig`, and the fingerprint does not cover it | `semantics-worker.ts:39`; per-workspace anchors would be ignored, and a changed config would leave stale caches. | Only if domains feed anchors: not needed for 0.1 (3.7); due with the first codemod that moves, rehomes, or folds. |
| `analyzeInternals` and `packageInternals` extracted from `runInternalAnalysis` | The materializer derives each package's internals from the local report it already holds, instead of analyzing the package again; `runInternalAnalysis` is unchanged in signature and output. | Done in 1.4. |
| `PackageInternals` moves to `lib/internal-analysis-types.ts`, spelled out from the stage report types | The reader validates saved internals in the browser, which cannot import the analysis code that `packageInternals`' return type came from. No behavior change; `packageInternals` returns the same shape. | Done in 1.5. |
| The `@foundry/workspaces` anchor is built in | `lib/config.ts:816-819`; it blocks `fold-package` for any package of that name in any scanned repository. | Done in 1.7: `anchors` is empty and `ANALYSIS_POLICY_VERSION` is 25, so cached reports made under the anchor are not reused. A Foundry scan loses its one anchor until workspaces can declare their own (3.7). |
| `authorizeMutationPlan` takes the workspace's rules and returns one of `refused-by-rule`, `not-executable`, `readiness`, or `authorized`; the record (`AuthorizedMutationPlan`, schema 2) gains `execution`, `permittedBy`, `sourceFiles`, and `authorizationFingerprint.ruleFingerprint`, renames `planId` to `executionPlanId`, and its `auth:` hash covers the rules. `hash16` moves, unchanged, to `lib/short-hash.ts`. `OperatorReadinessContext` and `assessOperatorPlanReadiness` are unchanged. | The record had no consumer and named no mutator, and `apply.ts` runs saved plans only; nothing may write without a rule that permits it (`_codemods.md`, decision 1); and 3.5 must name the part, and the file, that moved since the plan was authorized. | Done in 3.2. |
| `workspacePatterns` (`lib/boundary.ts`) reads `pnpm-workspace.yaml#packages`, drops `!` negations, normalizes a leading `./` and trailing slashes, and ignores patterns that resolve to the workspace root (`.`) or escape it (`../*`); `findRepoRoot` finds a workspace by the same declaration | Discovery follows the workspace declaration from 1.7, and the analyses build their program, ownership, and module graph from the same patterns, so both must read the same list. A root pattern would make the whole workspace one package, and an escaping one reaches outside it, so neither names a package. `findRepoRoot` checked `package.json#workspaces` only, so its four callers without an explicit root (`apply.ts`, `package-local.ts`, `workspace-surface.ts`, and `workspace-derive.ts`) resolved a pnpm-only workspace to the current directory. A workspace without `pnpm-workspace.yaml` is unaffected, apart from `docs/` now matching `docs`, which also makes `fold-plan.ts`'s `workspace-entry` impact fire for Foundry's `docs`; that impact's `file: "package.json"` is not pnpm-aware and is left as is, being analysis code. `**` stays unsupported in both. | Done in 1.7. |
| `apply.ts`, the `internalize-export` mutator, which holds `verifyInternalizeExport`: raw-byte and mode snapshots, symlinks refused, atomic writes and restores with the mode, a byte order mark kept, one `try` from the first write through the last check, a guarded restore, the `analyzeAfter` seam, `editRoute`'s before and after text (`MutationResult.edits` in `types.ts`), and the dirty check through `workingTree`, refusing a write without Git. Verification's checks are unchanged. | A throw after the write left a half-applied tree, the restore was lossy and not atomic, and a write without Git had no dirty check (decisions 5 and 8, A2, A5). | Done in 3.5 (a). |
| `lib/working-tree.ts` `workingTree` holds readiness's `gitDirty` logic, moved, and tells Git missing from no repository; `gitDirty` delegates to it, and `apply.ts`'s `dirtyPlannedFiles` is gone. The porcelain output is read with `-z`, unquoted and untrimmed, and a repository Git cannot read is told from no repository. | Two copies of one job (ground rule 5); A5 needs the reason Git is unavailable; the trim cut the first character from the first dirty path, and Git quoted a path with spaces or non-ASCII characters, so readiness and the mutator missed such a dirty planned file. | Done in 3.5 (a). |
| `DEFAULT_MUTATION_CAPABILITIES` drops `rewrite-import`, `update-test-import`, and `preserve-compatibility-export`; `MUTATION_CAPABILITY_VERSION` is 2. | The registry claimed kinds no mutator performs (decision 6, A12). Every earlier authorization's capability part moves; readiness judges an import-rewriting plan `unsupported` under the default, as the bridge already refused it. | Done in 3.5 (a). |
| `operator-readiness.ts` exports `spawnRunner` and `commandResult` (one command run as readiness records it: its exit code and failures, normalized exactly as the baseline is, `exit <code>` when a failed run shows none), which `baselineStep` now calls instead of its inline extraction; a run (`ReadinessCommandRun`) carries the signal that killed it, if one did. | Apply runs the command steps again after its write and compares them with the baseline (decision 4, A6); one function makes both runs judge failures alike. `extractFailures` stays private behind `commandResult`. | Done in 3.5 (b). |
| `apply.ts` gains `beforeWrite` (required to write), `expectedHashes` (checked before and after it), and `afterChecks` options and `RestoreError`; writes and restores are flushed; the restore guard compares the written bytes by SHA-256 and reports what it restored and skipped. | The journal must be flushed before the first write (A1), each file checked against the rollback's hash just before it (A2), and the scripts run again inside the restoring `try` (A6). | Done in 3.5 (b). |
| `semantics-fingerprint.ts` gains `workspaceInputsHash`, one hash over the five workspace input components, and `collectWorkspaceInputs` takes only what it reads (`exclude`, and units by `path`); the manifest's `generation` gains an optional `inputs: { hash, config }` (`dataset-manifest.ts`, `semantics-types.ts`, written by `generateSemantics`). No fingerprint, cache key, or report changes. | Apply takes "before" from the saved report only when the dataset is proven current (A9), and plan checks the same without running the configuration, so it needs the config component apart. | Done in 3.6. |
| `apply.ts` gains a `before` option, the target's report before the write; `atlas apply` passes the saved one, and its `analyzeAfter` passes the staged scan's, so the mutator runs no `analyzeSurface` on that path. Validation and verification are unchanged. | 3.0's largest saving (item 4); the saved and the staged reports agree with a fresh analysis on every field validation and verification read, which a test checks. | Done in 3.6. |
| `semantics.ts`'s materialization gives each module index entry `fanIn` and `fanOut` (`SemanticsModuleIndexEntry`, required), its import edges in and out counted from the edge shards it writes in the same step, so every indexed module has them, a failed package's included, and they equal the record's `gravity.fanIn` and `fanOut` wherever gravity was observed; `DATASET_SCHEMA_VERSION` is 5, and the reader's fallback for a schema 4 manifest without `lenses` goes with it. Dataset and materialization code only: no analysis, report, or record changes. The `materialization` stage's fingerprint moves with the dataset version, but nothing uses it as a cache key, so every package's cached results are still reused; a dataset saved at schema 4 is refused with the usual message to scan again. | The viewer recounted every file's imports from all 14 edge shards at load (1.2 MB on Foundry) to get numbers the edges already give (4.4b); the index is read at load anyway. | Done in 4.4b. |
| `semantics-discover.ts` records the name each skipped unit's `package.json` gives, read tolerantly, as the manifest's optional `discovery.unitsSkipped[].name` (`semantics-types.ts`). Discovery only: no fingerprint, cache key, or report changes, and dataset schema 4 keeps its number. | A collection counts a workspace's skipped packages as its own, so a dependency on one never crosses to another workspace's package of that name. | Done in 5.2. |
| `plan.ts`: `EntrypointContext` gains `internalImporters` (exposed name → the package's own modules that bind it from the entrypoint, each with its file, its form, `import`, `default`, or `reexport`, and whether it is a test) and `starReexporters` (modules that `export *` or `export * as` the entrypoint), both from a scan of every non-declaration boundary file other than the entrypoint, entrypoints skipped for re-exports; `internallyImportedNames` and `namespaceImported` stay. A `named-reexport` or `type-export` route whose name has internal importers is planned with one `rewrite-import` change per importer file, before its removal, when the route is a re-export (`export … from`), every importer is a named import, none is the declaration file, none is a test, and the declaration file exports the symbol under its own name and keeps that export (not a direct declaration in another entrypoint); otherwise it is blocked by `internal-entrypoint-import`, with a detail per case, or, when tests are the only obstacle, by the new `internal-entrypoint-test-import`. A star re-export of the entrypoint inside the package blocks every route through it, a direct one included (`internal-entrypoint-import`). Direct routes keep today's gate otherwise. `preservedBehavior` says which imports are repointed. `ANALYSIS_POLICY_VERSION` is 26. | 3.8: the planner unblocks plans whose only obstacle is the package's own importers of the entrypoint, and both stacks must agree on which importers those are (`_codemods.md`, "A second kind, deferred"). A module that `export *`s the entrypoint made a plan `ready` while removing the name broke its importers through that module. Tests keep a blocker of their own (ruling D1): repointing a pin test keeps it passing while it asserts nothing. Known gaps of the scope: `import X = require(...)`, dynamic `import()`, and `.js` importers are not seen, and a direct route's internal named re-exports and default imports stay unblocked, as before. Consequences of the bump: the `packageLocalAnalysis`, `packageAnalysis`, and `workspaceDerivation` fingerprints move, so the first scan after the upgrade is cold, and the package-local cache misses although plans are built in derivation; every saved dataset stops being current for `plan` and `apply` until a scan; the `historySnapshot` fingerprint moves, so every cached checkpoint and the local history cache miss and the next `scan --history` analyzes history from cold, and until then A8's carry-over places policy-25 history inside policy-26 datasets. Plan fingerprints cover blocker reasons and change files and kinds, not the policy, so they move only for plans whose changes or blockers move. Until the mutator lands (3.8 (b)), `applyReductionPlan` (mutator code) refuses a plan carrying `rewrite-import` changes. | Done in 3.8 (a). |
| `operator-plan-source.ts`: `ExposureRoutes.internalEntrypointImporters` is the set of routes (`Set<ResolvedRoute>`) whose exposed name has internal importers or whose entrypoint is namespace-imported or star re-exported inside the package, instead of one boolean for the symbol. | A direct route was blocked because another route of the same symbol had importers; the operator side needs the route, as `plan.ts` does. | Done in 3.8 (a). |
| `operator-plan.ts`: a direct route is blocked only when that route has internal importers, and gets no import rewrites. `internalImporters` takes the route and rewrites the package's own import sites that resolve to the route's file and bind its exposed name, whatever the specifier's spelling, instead of only sites written with the package's name, each site once across the symbol's routes; the new specifier comes from `lib/import-specifier.ts` (`importSpecifierFor`). A re-export or star re-export site resolving to the route's file in a module that is not a route file blocks `unsupported-realization`, as does an import site when the symbol is declared in an entrypoint whose export the plan removes. | The two stacks disagreed on scope: `plan.ts` covers any import resolving to the entrypoint, relative ones included, and all 55 rewritable Foundry plans import relatively (`_codemods.md`); without the name filter, a symbol exposed under two names from one entrypoint would be rewritten twice. | Done in 3.8 (a). |
| `intelligence.ts` `internalizeScale` counts the importer files of `rewrite-import` changes among the plan's files, by kind (route files stay counted as source), and those changes as `imports.sites`, with their distinct files as `imports.moduleEdges`; `PlanScale.imports`' comment in `types.ts` says so. | A plan that repoints importers touches more than its route files; the scale said zero imports. | Done in 3.8 (a). |
