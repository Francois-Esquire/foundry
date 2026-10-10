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
until a per-setting digest has a consumer, 2.6 at the earliest. See
[`_lenses.md`](./_lenses.md#in-the-dataset).

**2.1 The lens layer.** Done 2026-10-10. The contract of
[`_lenses.md`](./_lenses.md), built, with one lens that is computed,
versioned, published, and renderable (printed under test; `atlas report`
sections in 2.7).
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
- **2.2e `frequent-change`**: change craters against hotspots. It will read
  the hotspot commit gate from `ANALYSIS_CONFIG`, which is the built-in
  analysis policy, not the workspace's Configuration; the rule is in
  [`_lenses.md`](./_lenses.md#rules).
- **2.2d Retire neighborhoods**: responsibility regions are the grouping;
  the viewer's neighborhoods (`web/neighborhoods.ts`, `relationships.ts`)
  go. They do not place files, so no layout helper stays.
- **2.2f Pair traffic**: no lens. The dependency graph projection carries
  each pair's count, so the viewer's re-aggregations go; the endpoint files
  are one join in the codex.

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
file counts already answer it. The 2.1 `package-sizes` lens joins two of
these for the codex and is not that effort.

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

**3.1 Rules.** The shape `{ operator, subject, effect }`, declared in the
configuration from 1.7, with subjects addressed by path and `path#symbol`.

**3.2 Wire the two stacks** at `authorizeMutationPlan`. No third.

**3.3 `atlas check`.** Rules against the dataset; exit 3 on a violation,
as 1.8 reserved, so it differs from a failed run (1) and bad arguments (2).

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
| The `@foundry/workspaces` anchor is built in | `lib/config.ts:816-819`; it blocks `fold-package` for any package of that name in any scanned repository. | Done in 1.7: `anchors` is empty and `ANALYSIS_POLICY_VERSION` is 25, so cached reports made under the anchor are not reused. A Foundry scan loses its one anchor until workspaces can declare their own (3.7). |
| `workspacePatterns` (`lib/boundary.ts`) reads `pnpm-workspace.yaml#packages`, drops `!` negations, normalizes a leading `./` and trailing slashes, and ignores patterns that resolve to the workspace root (`.`) or escape it (`../*`); `findRepoRoot` finds a workspace by the same declaration | Discovery follows the workspace declaration from 1.7, and the analyses build their program, ownership, and module graph from the same patterns, so both must read the same list. A root pattern would make the whole workspace one package, and an escaping one reaches outside it, so neither names a package. `findRepoRoot` checked `package.json#workspaces` only, so its four callers without an explicit root (`apply.ts`, `package-local.ts`, `workspace-surface.ts`, and `workspace-derive.ts`) resolved a pnpm-only workspace to the current directory. A workspace without `pnpm-workspace.yaml` is unaffected, apart from `docs/` now matching `docs`, which also makes `fold-plan.ts`'s `workspace-entry` impact fire for Foundry's `docs`; that impact's `file: "package.json"` is not pnpm-aware and is left as is, being analysis code. `**` stays unsupported in both. | Done in 1.7. |
