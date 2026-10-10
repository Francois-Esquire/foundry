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
are kept so that the codex reads no module shard; and the `_review.md`
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
  pinned in `test/web/current-field.test.ts`.
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
- Tests: `test/web/current-field.test.ts` (the characterization; the
  current from route weights); `test/lib/semantics.test.ts` (on a live
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
`atlas lens <id>` prints any of them (2.7).
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
- Left for later, by design: a second kind (3.8), domains at the gates
  (3.7), splitting the derivation key and passing the apply project
  through (3.6's candidates), `rule:<n>` as `plan`'s argument, and the
  per-setting digest, which still has no consumer: rules name facets, not
  domains.

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
- **4.2a** First, `paintMap`'s positional parameters (sixteen, after 2.2d
  removed one) become one options object, before any drawing changes: 2.2d
  had to drop an argument at every call site by position, and a shifted
  argument still type-checks wherever two neighbors share a type.

**4.3 Directories drawn,** and a domain drawn across islands.

**4.4 Loading.** Covered by the lazy reader in 1.5; the module shards stopped
being read at load in 2.2d. What remains is the viewer reading only what the
current zoom needs.

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

**5.2 The collection manifest:** qualified ids and the crossings from
declared dependencies, as a pure function of the workspace manifests.

**5.3 Many paths for real** in the commands, the library, and `serve`,
which serves each dataset under its own prefix. `AtlasServer.root` is
singular until then.

**5.4 The viewer.** Waits for Phase 4. 5.4a, the data seam: the data root
per workspace (1.5 reduced it to one place, `DATA_ROOT` in
`web/dataset.ts`), the probe for a collection, and a dataset reference per
island. 5.4b, the drawing: frames side by side, one rim per frame, and the
crossings' ink.

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
