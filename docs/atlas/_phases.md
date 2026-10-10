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
| `generateSemantics` (`lib/semantics.ts:879`) | The dataset; `onProgress` with phase, plan, and unit events; `dryRun` | Library `scan`, the refresh after a codemod |
| `generateSemanticsHistory` | History checkpoints | Library `scan` with history |
| `runInternalAnalysis` | One package's internal structure, through a chosen stage | Library `scan`, nesting and locality lenses |
| `output/`, the dataset | Every analysis's result, versioned | The reader, lenses, the viewer, `report`, `check` |
| `web/codex/source.ts` | The one typed read of the dataset, in the browser | Becomes the library reader, shared with the viewer |
| `lib/render` `renderSurface` | Terminal, text, Markdown; three densities | `atlas report` |
| `lib/render/views.ts` | The renderer-neutral view model | Terminal output of lenses |
| `lib/semantics-stages.ts` | Stage versions, dependencies, fingerprints | Versioning lenses |
| Projection context (`lib/workspace-projection.ts:376`) | `workspace.json` plus intelligence, indexed once | Lens mechanics |
| `AnalysisConfig.anchors` | Declared package boundaries the analyses respect | Domains, when they need to reach the gates |
| `operators.ts`, `apply.ts` | Reduction plans: preview, write, verify, restore | `atlas apply` |
| `operator-readiness.ts` | Authorization of architectural plans | `atlas plan`, rules, domains |
| `server/server.ts` `startServer` | A dataset and a web root on a port | Library `serve`, collections |
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

**1.1 Build and install.** The groundwork every later effort ships through.
- Bundle `@foundry/*` into `dist`. `@foundry/lib` is private, and a public
  package may not depend on a private one, so this comes before anything
  imports it. `scripts/build.ts` uses `Bun.build` with
  `packages: "external"`; set `external` to the names in
  `package.json#dependencies` instead, which bundles workspace packages
  without adding tsup. Marbles reaches the same result with tsup's
  `noExternal`.
- Spawn the analysis workers with `process.execPath`, not `bun` from the
  PATH (`lib/semantics.ts:190,229`).
- The missing-assets message stops naming a repository build command.
- Leave `dist/cli/atlas.js.map` out of the tarball.
- Copy Marbles' `privateImports` check into `test/package.test.ts`.
- Done when the packed tarball installs, scans, and serves the fixture, as
  today, and the private-import check passes.

**1.2 `scan` into the library.** A move, not a rewrite.
- `cli/scan.ts` becomes `lib/scan.ts`, taking a root and options instead
  of the CLI's workspace object, and reporting through `onProgress` instead
  of writing to stderr. The progress event type is exported.
- The shape settled in [`_api.md`](./_api.md#library): `scan(root)` scans
  the workspace and every package's internals, `scan.workspace(root)` the
  workspace level only, and `scan.package(root, name)` one package in
  depth. Each returns its results; how they are read back is 1.5.
- `cli/workspace.ts` moves with it as the state resolver.
- The CLI calls the moved function; `test/atlas.test.ts` follows.
- Done when the CLI behaves as before and the fixture snapshots do not
  change.

**1.3 State and cache.** Loading code, which the ground rules allow to
change.
- The cache lock in `lib/semantics-cache.ts:354,367` uses
  `@foundry/lib/file-lock` `tryFileLock` and `processAlive`, as Marbles
  does. Two scans can no longer both take it.
- `writeJsonAtomic` delegates to `@foundry/lib/atomic-file`.
- Each state directory gets a `workspace.json` record (root, id, Atlas
  version, last scan), as Marbles keeps, so the state root can be listed.
- The state id is Marbles' 12-hex id, settled 2026-10-10. Existing state
  directories are orphaned, which costs one rescan before 0.1.
- Done when a test runs two scans of one workspace at once and one waits or
  fails cleanly. Waits for 1.1 and 1.2.

**1.4 The dataset, complete.** Fixed in the moved `lib/scan.ts`.
- `internals/` and `manifests/` are written before the atomic publish, are
  listed in `manifest.files`, and fall under a stage fingerprint. Today
  `cli/scan.ts:39-57` writes them after the swap.
- `manifests/` keeps only the declared dependencies, which are all the
  viewer reads, instead of raw `package.json` copies.
- A `--history` scan keeps the `history/couplings.json` that a plain scan
  wrote, or the manifest stops pointing at it.
- The schema version: these change the dataset's shape, so
  `SEMANTICS_DATASET_SCHEMA_VERSION` goes to 4 before 0.1 is published.
  The viewer's literal `3` goes in 1.5.
- `reference/output.md` follows.
- Done when every file under `output/` is in the manifest and the viewer
  loads the fixture unchanged. Waits for 1.2.

**1.5 One reader, internal.** Split `web/codex/source.ts` into its two
layers. Not exported; `scan` returns its results through it.
- The reader moves to `lib`: it knows the dataset's paths, checks the
  schema version against the constant, and reads through an injected
  transport (`fetch` in the browser, the file system in Node).
- It reads lazily: one package's results read the manifest and one report,
  not every shard. Today the viewer loads every edge shard, module shard,
  and package manifest at once.
- The codex keeps its own part, the `CodexSource` picks, and builds it on
  the reader. `web/load-internals.ts` uses the same reader and reads the
  manifest once, not twice.
- Done when the viewer and a Node test read the fixture through one reader,
  and no file outside it names a dataset path. Waits for 1.4.

**1.6 `serve`.**
- `startServer` plus the web root resolution from `cli/index.ts` become the
  library `serve`.
- Retire `lib/semantics-serve.ts` and its test.
- Done when the CLI's default command and `serve` call it.

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
- `test/package.test.ts` imports the library from the installed tarball and
  runs `scan`, `scan.workspace`, `scan.package`, and `serve` against the
  fixture.
- Public pages for the library, beside the CLI pages.

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

**3.6 Refresh after every write.** Internals cached per package, as
`test/helpers/reference-internals.ts` does; the project `apply` builds
passed through instead of building three. Sized by 3.0.

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
which serves each dataset under its own prefix.

**5.4 The viewer's data root per workspace,** which 1.5 reduces to one
place in the reader.

## Changes to existing code

Every change to analysis code, with its reason, before it is made.

| Change | Reason | Status |
| --- | --- | --- |
| Symbol ids carry no kind | `symbols.ts:133` forms `path#name`; an interface and a const of one name share an id, and five lookup maps keep the last one. | Confirmed. No change for now: a facet without a kind matches every symbol of that id. Revisit only if a codemod needs to tell them apart. |
| Anchors matched by name only in concept recentering | `concept-recentering.ts:1383`; an anchor declared by path is invisible there. | Only if domains feed anchors (phase 3). |
| The worker passes no `AnalysisConfig`, and the fingerprint does not cover it | `semantics-worker.ts:39`; per-workspace anchors would be ignored, and a changed config would leave stale caches. | Only if domains feed anchors (phase 3). |
| The `@foundry/workspaces` anchor is built in | `lib/config.ts:816-819`; it blocks `fold-package` for any package of that name in any scanned repository. | Remove in 1.7. A Foundry scan loses its one anchor until workspaces can declare their own (3.7). |
