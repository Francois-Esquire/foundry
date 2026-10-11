# Atlas API

Maintainer note, excluded from the Blume site. Dated 2026-10-09. The public
surface of Atlas 0.1, as a CLI and as a library. The library
and the forks were settled on 2026-10-10; the rules-dependent commands are
still proposals. Where it is settled, this document wins over the code, as `_api-alt.md` does for Marbles.

This is the outermost API: what a user types and what a program imports.
How `src/lib` implements it is free to change.

## Where it stands

- **One binary and a library** since 1.10. `package.json` declares `bin`
  and an `exports` map with one entry, `.`, which names `scan`, `serve`,
  and the types below; nothing else under `src/lib` is importable. Marbles,
  by comparison, exports `.`, `./lib`, and `./prebuilt`.
- **Nine commands**: `atlas [path...]`, `scan`, `serve`, `report`, and
  `export` since 1.8, `lens` since 2.7, `check` since 3.3, `plan` since
  3.4, and `apply` since 3.5, from a typed command table; each takes only its
  own flags, plus `--state`, `--json`, and `--quiet`. `atlas`, `scan`,
  `serve`, and `export` read two or more paths as a collection since 5.3;
  the others read one workspace. See `reference/cli.md`.
- **The dataset is a contract.** `output/` is versioned
  (`DATASET_SCHEMA_VERSION = 5` in the manifest, exported), documented file
  by file in `reference/output.md`, published atomically, and read by the
  viewer unchanged. The docs site builds its static viewer with
  `atlas export` (`docs/scripts/build-example.ts`).
- **The rest of the library stays behind tests.** Terminal reports, both
  codemod stacks, and dry runs exist in `src/lib` and are not exported.
  `test/lib/workspace-e2e.test.ts` drives the whole pipeline. The table is
  in [`_review.md`](./_review.md#the-library-already-exists-behind-tests).
- **Config** since 1.7: `.foundry/atlas/` files, validated, with
  `foundry.config.json#semantics` as a validated fallback during 0.x.
  Analysis policy is built in.

The "Before the first publish" list in [`_roadmap.md`](./_roadmap.md) still
applies; this document does not repeat it.

## Principles

Proposed. These decide the shape of everything below.

1. **The dataset is the product.** A scan produces a dataset; everything else
   reads it. The CLI and the library produce it, read it, serve it, render
   it, and act on it. A third party should be able to build on the dataset
   without importing Atlas.
2. **The CLI is the library with formatting.** Every command is one library
   call plus output. No behavior exists only in the CLI.
3. **Read-only unless asked.** Nothing writes inside a workspace except
   `atlas apply --write`, which writes one authorized change to source
   files, verifies it, and restores them on any failure, and `atlas
   export`, which writes only where it is pointed. A preview writes no
   source file. `atlas plan` and `atlas apply` run the workspace's test and
   typecheck scripts, which write what they always write; Atlas itself
   writes nothing else there.
4. **Machine-readable by default for programs, readable by default for
   people.** Every command that prints a result takes `--json`. Exit codes
   mean something a CI job can use.
5. **No Foundry in the defaults.** Discovery follows the workspace's own
   package manager, and no Foundry package name or caption is special.
6. **Paths are plural from the start.** Commands take `path...` even if 0.1
   only supports one, so multi-workspace does not need a breaking change.
   See [`_workspaces.md`](./_workspaces.md).

## CLI

| Command | Status | Does |
| --- | --- | --- |
| `atlas [path...]` | 0.1; several paths a collection (5.3) | Scan, serve, open the browser. |
| `atlas scan [path...]` | 0.1; several paths a collection (5.3) | Scan and save the dataset. |
| `atlas serve [path...]` | 0.1; several paths a collection (5.3) | Serve the saved dataset. |
| `atlas report <package> [path...]` | 0.1, done in 1.8 | Print a package report in the terminal, through `lib/render`. `--format markdown` for docs and PRs. Package only: `renderSurface` takes a package's `SurfaceReport`, and no file report exists. |
| `atlas export <dir> [path...]` | 0.1, done in 1.8; several paths a collection (5.3) | Write a static viewer, the viewer and a copy of the saved dataset, for hosting or CI artifacts. `build-example.ts` now calls it. |
| `atlas lens <id> [path...]` | 0.1, done in 2.7 | Print one lens from the saved dataset, through `lib/render`, or as saved with `--json`. An unknown id exits `2`; a dataset without the lens exits `1`. |
| `atlas check [path...]` | 0.1, done in 3.3 | Print the saved `rules` lens: the workspace's rules against the dataset. Exit 3 on a violation, 1 when a `require` could not be checked. CLI only, `lib/check.ts`. |
| `atlas plan <opportunity> [path...]` | 0.1, done in 3.4 | Plan one internalize opportunity from the saved dataset, named by its id, its plan's id, or `path#name`, and authorize it under the saved `rules` lens's rules; save an authorized plan's record in the state directory. Runs the workspace's test and typecheck scripts as readiness's baseline, and writes nothing in the workspace. Exit 0 on any verdict. CLI only, `lib/codemod.ts`. A rule as the argument (`rule:<n>`) is deferred. |
| `atlas apply <opportunity> [path...] [--write]` | 0.1, done in 3.5 | Preview a plan's edits; with `--write`, journal, write, verify (TypeScript, the structural proof, the workspace's scripts again), restore on any failure, and scan again. Authorizes again under the configuration's rules first, and refuses what moved. Exit 0 for a preview or a published write, 1 otherwise. CLI only, `lib/codemod-apply.ts`. |

`check`, `plan`, and `apply` ship only once rules can be declared and the
readiness gate reads them, as [`_codemods.md`](./_codemods.md) says; they
did, in 3.3, 3.4, and 3.5.

Flags shared by every command: `--state`, `--json`, `--quiet`, `--help`.
`--history` belongs to `scan` and the default command, not to `serve`.

Exit codes, settled in 1.8: `0` done, `1` the command ran and failed, `2`
bad arguments, and codes above `2` for commands' own results, starting with
`check`'s `3` for a violation, so a CI job can tell a broken rule from a
failed run. Marbles exits `1` on a usage error; ESLint uses `1` for lint
errors and `2` for a failed run.

## Library

Decided 2026-10-10. The library is for getting results programmatically:
scan a workspace and use what comes back. Two functions, plus the types of
what they return. The individual analyses are not exported.

```ts
import { scan, serve } from "@foundry/atlas";

const everything = await scan("./my-workspace"); // workspace and every package's internals
const workspace = await scan.workspace("./my-workspace"); // workspace level only
const db = await scan.package("./my-workspace", "@acme/db"); // one package's internals
const past = await scan("./my-workspace", { history: true });

const server = await serve("./my-workspace", { port: 0 });
server.url;
await server.stop();
```

| Export | Does | Built from |
| --- | --- | --- |
| `scan(root, options?)` | Scans the workspace and every package's internals; returns the results and saves the dataset | `lib/scan.ts` over `generateSemantics`, which derives the internals, and `generateSemanticsHistory` |
| `scan.workspace(root, options?)` | The workspace-level results only, without internals; a dataset the viewer loads | `generateSemantics` without internals; the manifest's declared dependencies are what the viewer reads for every package |
| `scan.package(root, name)` | One package's internals, analyzed fresh; saves nothing | `packageInternals` over `analyzePackageLocal` |
| `serve(root, options?)` | Serves the saved dataset and the viewer; returns the URL, the resolved root, and `stop` | `lib/serve.ts` over `startServer`, checking the dataset through the reader |
| `scan.collection(roots, options?)` | Scans each workspace of a collection as `scan` does, in turn; returns their scans and the collection manifest, and saves nothing for the collection (5.3) | `lib/scan.ts` over `resolveCollection` and `collectionManifest` |
| `serve.collection(roots, options?)` | Serves each workspace's saved dataset under its id and the collection manifest, derived per request; returns the URL, the resolved roots, and `stop` (5.3) | `lib/serve.ts` over `startServer`'s collection mount, from `dataset-files.ts` `savedCollection` |
| `DatasetNotFoundError` | What a missing dataset throws: `serve`, and an accessor once the dataset is gone | `lib/dataset.ts` |
| `DatasetReplacedError` | What an accessor throws once a later scan saved over its dataset | `lib/dataset.ts` |
| `DATASET_SCHEMA_VERSION`, `HISTORY_SCHEMA_VERSION`, `COLLECTION_SCHEMA_VERSION` | The dataset's, history's, and the collection manifest's schema versions, the promise a reader holds them to | `semantics-types.ts`, `semantics-history-types.ts`, `collection-types.ts` |
| Types | `Scan`, `WorkspaceScan`, `ScanOptions`, `ScanProgressEvent`, `CollectionScan`, `CollectionScanOptions`, `CollectionProgressEvent`, `PackageInternals`, `PackageReport`, `WorkspaceReport`, `AtlasServer`, `CollectionServer`, `ServeOptions`, `DatasetManifest`, `HistoryManifest`, `CollectionManifest`, `AtlasConfig` | `scan.ts`, `serve.ts`, `dataset.ts`, `internal-analysis-types.ts`, `workspace-types.ts`, `semantics-types.ts`, `semantics-history-types.ts`, `collection-types.ts`, `atlas-config.ts` |

**Public names.** The glossary's words (`apps/atlas/CONTEXT.md`): dataset,
history, package, workspace. A name takes an `Atlas` prefix only where the
bare word would collide with a platform name (`Server`) or say nothing in a
consumer's file (`Config`); hence `AtlasServer` and `AtlasConfig`, but
`Scan`. `DatasetManifest`, `HistoryManifest`, and the two schema versions
were renamed at the source in 1.10. Nested types are not exported and keep
their internal `Semantics*` names, which editors show on hover; they are
reached by indexed access. `PackageReport` is an alias of the analysis's
`SurfaceReport`, which hovers show. A schema mismatch is a plain `Error`
in 0.1; a typed one can be added without breaking anyone.

- **`scan` returns the results**, typed, read back from the dataset it just
  published, along with the path it was saved to. Scans reuse the cache,
  so scanning an unchanged workspace again is fast; there is no separate
  function to read a saved scan. The plain fields (`manifest`, `output`,
  `history`) are JSON; `workspaceReport()`, `packageReport(name)`, and, on
  `Scan`, `internals(name)` read the saved dataset when called.
- `scan.package(root, name)` analyzes fresh what `scan(root).internals(name)`
  reads back.
- **`onProgress`** passes through in the options, with its event type
  exported. There is no `AbortSignal` in `lib`;
  cancellation waits until it is needed.
- **One reader, internal.** The code that knows dataset paths moves out of
  the browser's `codex/source.ts` into `lib`. `scan` and the viewer both
  use it; it is not exported.
- **`lib/semantics-serve.ts`**, a second server only its test used, was
  retired in 1.6.
- **Not exported:** the report printer (`report` is CLI only), `export`
  (CLI only), the codemods (phase 3), and rules and domains (phases 2 and
  3); a domain declaration is reachable as
  `NonNullable<AtlasConfig["domains"]>[number]`.

## Forks

Settled with the maintainer on 2026-10-10.

1. **Library size.** Smaller than proposed: `scan`, with `scan.workspace`
   and `scan.package`, and `serve`. No `open`; `scan` returns the results.
   No `./render` subpath.
2. **The dataset is public**, with the schema version as the promise. Before
   0.1, `internals/` joins the manifest and the atomic publish, raw
   `package.json` copies stop, and the schema version goes to 4. Done in
   1.4: each package's declared dependencies are in the manifest, and
   `manifests/` is gone.
3. **Configuration lives in `.foundry/atlas/`**, resolved as Marbles
   resolves `.foundry/marbles/`, with `foundry.config.json#semantics` read
   as a validated fallback during 0.x. Domains and rules are declared there
   later. `AnalysisConfig` stays built in until phase 3 needs otherwise.
4. **`atlas export`** is `docs/scripts/build-example.ts` moved into the
   CLI. The dataset it copies holds no `package.json` copies since 1.4. No
   viewer component.
5. **`atlas report <package>`** is in 0.1, CLI only, through
   `renderSurface`. The older `report.ts` renderer is not used.

Also settled: state directories adopt Marbles' 12-hex id and
`workspace.json` record, which costs every existing workspace one rescan.

## Packaging

From the release tooling and Marbles, not a fork. Done by 1.10:

- An `exports` map with one entry, `.`, `types` first:
  `dist/lib/index.d.ts` and `dist/lib/index.js`.
- `@foundry/*` bundled into `dist`, as Marbles does with tsup's
  `noExternal`; Atlas's build kept only `package.json#dependencies`
  external, so workspace packages are inlined.
- One Bun build with shared chunks puts the CLI (`atlas.js`), the library
  (`index.js`), both workers, and the chunks in `dist/lib`, so the workers
  are found beside whichever file asks and the viewer at `../web`. tsup,
  declarations only, bundles `dist/lib/index.d.ts`, which imports nothing.
- The package test checks the built output and the declarations for
  private imports, as Marbles' does, and drives the bin, the library under
  Bun and Node, and a TypeScript consumer.
- A `workspace.json` record in each state directory, as Marbles keeps, so
  state can be listed.
