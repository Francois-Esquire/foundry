# Atlas API

Maintainer note, excluded from the Blume site. Dated 2026-10-09. The public
surface of Atlas 0.1, as a CLI and as a library. The library
and the forks were settled on 2026-10-10; the rules-dependent commands are
still proposals. Where it is settled, this document wins over the code, as `_api-alt.md` does for Marbles.

This is the outermost API: what a user types and what a program imports.
How `src/lib` implements it is free to change.

## Where it stands

- **One binary, no library.** `package.json` declares `bin` and nothing
  else. There is no `exports` map, so nothing under `src/lib` is importable
  by a consumer. Marbles, by comparison, exports `.`, `./lib`, and
  `./prebuilt`.
- **Three commands.** `atlas [path]`, `atlas scan [path]`, and
  `atlas serve [path]`, with `--state`, `--port`, `--no-open`, `--history`.
  One path at most. See `reference/cli.md`.
- **The dataset is already a contract.** `output/` is versioned
  (`SEMANTICS_DATASET_SCHEMA_VERSION = 3` in the manifest), documented file
  by file in `reference/output.md`, published atomically, and read by the
  viewer unchanged. The docs site already builds a static viewer plus
  dataset from it (`docs/scripts/build-example.ts`).
- **The library is written; only tests reach it.** Scan, history,
  internals, terminal reports, both codemod stacks, progress events, and
  dry runs all exist in `src/lib`. The CLI that used them is gone.
  `test/lib/workspace-e2e.test.ts` drives the whole pipeline and is the de
  facto shape of the library. The table is in
  [`_review.md`](./_review.md#the-library-already-exists-behind-tests).
- **Config.** One optional `foundry.config.json` with a `semantics` key,
  cast and shallow-merged, not validated. `semantics.output` is read and
  ignored. Analysis policy is built in, with "intentionally no user-facing
  config loader yet" (`lib/config.ts:9-10`).

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
   `apply`, which previews by default and writes only with `--write` or
   `write: true`. This is the existing `apply.ts` contract, made public.
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
| `atlas [path...]` | exists, one path | Scan, serve, open the browser. |
| `atlas scan [path...]` | exists, one path | Scan and save the dataset. |
| `atlas serve [path...]` | exists, one path | Serve the saved dataset. |
| `atlas report <package>` | 0.1 | Print a package report in the terminal, through `lib/render`. `--format markdown` for docs and PRs. Package only: `renderSurface` takes a package's `SurfaceReport`, and no file report exists. |
| `atlas export <dir> [path...]` | 0.1 | Write the viewer and the dataset as static files, for hosting or CI artifacts. What `build-example.ts` does today. |
| `atlas check [path...]` | proposed, depends on rules | Evaluate the workspace's rules against the dataset. Exit 1 on a violation. |
| `atlas plan <rule-or-opportunity>` | proposed, depends on rules | Print the plan that would satisfy a rule at one site. Read-only. |
| `atlas apply <plan> [--write]` | proposed, depends on rules | Preview a plan's edits; write and verify with `--write`. |

`check`, `plan`, and `apply` ship only once rules can be declared and the
readiness gate reads them, as [`_codemods.md`](./_codemods.md) says.

Flags shared by every command: `--state`, `--json`, `--quiet`, `--help`.
`--history` belongs to `scan` and the default command, not to `serve`.

## Library

Decided 2026-10-10. The library is for getting results programmatically:
scan a workspace and use what comes back. Two functions, plus the types of
what they return. The individual analyses are not exported.

```ts
import { scan, serve } from "@foundry/atlas";

const everything = await scan("./my-workspace"); // workspace and every package's internals
const workspace = await scan.workspace("./my-workspace"); // workspace level only
const db = await scan.package("./my-workspace", "@acme/db"); // one package, in depth
const past = await scan("./my-workspace", { history: true });

const server = await serve("./my-workspace", { port: 0 });
server.url;
await server.stop();
```

| Export | Does | Built from |
| --- | --- | --- |
| `scan(root, options?)` | Scans the workspace and every package's internals; returns the results and saves the dataset | `cli/scan.ts` over `generateSemantics`, `runInternalAnalysis`, `generateSemanticsHistory` |
| `scan.workspace(root, options?)` | The workspace-level results only, without internals | `generateSemantics` |
| `scan.package(root, name, options?)` | One package's internal structure | `runInternalAnalysis` |
| `serve(root, options?)` | Serves the saved dataset and the viewer; returns the URL and `stop` | `startServer` plus the web root resolution in `cli/index.ts` |
| Types | What `scan` returns, and the dataset schema version | `semantics-types.ts`, `semantics-history-types.ts`, `workspace-projection-types.ts`, `types.ts` |

- **`scan` returns the results**, typed, read back from the dataset it just
  published, along with the path it was saved to. Scans reuse the cache,
  so scanning an unchanged workspace again is fast; there is no separate
  function to read a saved scan.
- **`onProgress`** passes through in the options, with its event type
  exported (today it is not). There is no `AbortSignal` in `lib`;
  cancellation waits until it is needed.
- **One reader, internal.** The code that knows dataset paths moves out of
  the browser's `codex/source.ts` into `lib`. `scan` and the viewer both
  use it; it is not exported.
- **`lib/semantics-serve.ts`**, a second server only its test uses, is
  retired.
- **Not exported:** the report printer (`report` is CLI only), the
  codemods (phase 3), and rules and domains (phases 2 and 3).

## Forks

Settled with the maintainer on 2026-10-10.

1. **Library size.** Smaller than proposed: `scan`, with `scan.workspace`
   and `scan.package`, and `serve`. No `open`; `scan` returns the results.
   No `./render` subpath.
2. **The dataset is public**, with the schema version as the promise. Before
   0.1, `internals/` and `manifests/` join the manifest and the atomic
   publish, `manifests/` stops copying raw `package.json` files, and the
   schema version goes to 4.
3. **Configuration lives in `.foundry/atlas/`**, resolved as Marbles
   resolves `.foundry/marbles/`, with `foundry.config.json#semantics` read
   as a validated fallback during 0.x. Domains and rules are declared there
   later. `AnalysisConfig` stays built in until phase 3 needs otherwise.
4. **`atlas export`** is `docs/scripts/build-example.ts` moved into the
   CLI, without raw `package.json` copies. No viewer component.
5. **`atlas report <package>`** is in 0.1, CLI only, through
   `renderSurface`. The older `report.ts` renderer is not used.

Also settled: state directories adopt Marbles' 12-hex id and
`workspace.json` record, which costs every existing workspace one rescan.

## Packaging

From the release tooling and Marbles, not a fork:

- An `exports` map with one entry, `.`.
- `@foundry/*` bundled into `dist`, as Marbles does with tsup's
  `noExternal`; Atlas's build marks every package external today.
- The analysis worker is found beside the entry file, so it ships beside
  the library entry as well as the CLI.
- The package test checks the built output for private imports, as
  Marbles' does.
- A `workspace.json` record in each state directory, as Marbles keeps, so
  state can be listed.
