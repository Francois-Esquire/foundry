# Atlas API

Maintainer note, excluded from the Blume site. Dated 2026-10-09. The public
surface of Atlas 0.1, as a CLI and as a library. Draft for discussion: each
section marks what exists today and what is proposed. Once agreed, this
document wins over the code, as `_api-alt.md` does for Marbles.

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
| `atlas report <package>` | proposed | Print a package report in the terminal, through `lib/render`. `--format markdown` for docs and PRs. Package only: `renderSurface` takes a package's `SurfaceReport`, and no file report exists. |
| `atlas export <dir> [path...]` | proposed | Write the viewer and the dataset as static files, for hosting or CI artifacts. What `build-example.ts` does today. |
| `atlas check [path...]` | proposed, depends on rules | Evaluate the workspace's rules against the dataset. Exit 1 on a violation. |
| `atlas plan <rule-or-opportunity>` | proposed, depends on rules | Print the plan that would satisfy a rule at one site. Read-only. |
| `atlas apply <plan> [--write]` | proposed, depends on rules | Preview a plan's edits; write and verify with `--write`. |

`check`, `plan`, and `apply` ship only once rules can be declared and the
readiness gate reads them, as [`_codemods.md`](./_codemods.md) says.

Flags shared by every command: `--state`, `--json`, `--quiet`, `--help`.
`--history` belongs to `scan` and the default command, not to `serve`.

## Library

The split mirrors Marbles: one small root for the common case, subpaths for
the rest. Every export wraps code that exists; the right column says which.

```ts
import { open, scan, serve } from "@foundry/atlas";

const result = await scan({ root: "./my-workspace", history: false });
const atlas = await open(result.output);          // a typed dataset reader
const report = await atlas.package("@acme/db");
const server = await serve({ output: result.output, port: 0 });
```

| Entry | Exports | Built from |
| --- | --- | --- |
| `@foundry/atlas` | `scan`, `open`, `serve` | `cli/scan.ts` over `generateSemantics`, `runInternalAnalysis`, `generateSemanticsHistory`; `web/codex/source.ts` moved into `lib`; `startServer` |
| `@foundry/atlas/dataset` | Types and schema versions | `semantics-types.ts`, `semantics-history-types.ts`, `workspace-projection-types.ts`, `types.ts` |
| `@foundry/atlas/render` | `renderSurface(report, { format, density })` | `lib/render`, as it is |
| `@foundry/atlas/rules` | Declaring rules and domains | Phase 2 and 3; see [`_domains.md`](./_domains.md) |
| `@foundry/atlas/apply` | `plan`, `apply` | `operators.ts`, `apply.ts`, `operator-readiness.ts`; phase 3 |

- **`scan`.** `cli/scan.ts` moved into the library, so the CLI and the
  docs build call the same function. `onProgress` passes through, with its
  event type exported (today it is not). There is no `AbortSignal` in
  `lib`; cancellation waits until it is needed.
- **`open`.** The one place that knows dataset paths. Today that is the
  browser's `codex/source.ts`; it moves to `lib` and the viewer imports it,
  so Node and the browser read the dataset one way. It uses the schema
  constant instead of the literal `3`.
- **`serve`.** `startServer`, plus the web root resolution that now lives
  in `cli/index.ts`. `lib/semantics-serve.ts`, a second server only its
  test uses, is retired.

## Forks

Decisions needed before writing code, in order of what they block. Each now
says what the code answered; evidence is in [`_review.md`](./_review.md).

1. **How large is the 0.1 library?** Recommendation: thin, as in the table
   above. The code agrees: the facades exist and are few, and the dataset
   already carries every analysis's result. The individual analyses stay
   internal.
2. **Is the dataset public in 0.1?** Recommendation: yes, with the dataset
   schema version as the promise and `open` as the recommended path. What
   the code adds: nine version constants exist and a stage graph versions
   them (`lib/semantics-stages.ts`), so the promise has a mechanism. Two
   gaps to close first: `internals/` and `manifests/` sit outside the
   manifest and outside the atomic publish, and `manifests/` copies raw
   `package.json` files.
3. **Where does configuration live?** No shared loader exists in the
   repository; only Atlas reads `foundry.config.json`, and only for
   discovery settings. Analysis policy has no loader on purpose. Marbles'
   `.foundry/marbles/` resolution is the pattern to mirror; it is not
   importable. Recommendation unchanged: `.foundry/atlas/`, with
   `foundry.config.json#semantics` read as a fallback during 0.x, validated.
   Domains and rules are declared there; `AnalysisConfig` stays built in
   until phase 3 needs otherwise.
4. **Is the viewer a library export?** `docs/scripts/build-example.ts` is
   already a working static export. Recommendation: `atlas export` is that
   script moved into the CLI, without raw `package.json` copies. No
   component in 0.1.
5. **Is `report` in 0.1?** Yes. `renderSurface` already renders a package
   report in terminal, text, and Markdown at three densities. The command
   reads `packages/<name>.json` and calls it. The older `report.ts`
   renderer over the same input is not used.

## Packaging

From the release tooling and Marbles, not a fork:

- An `exports` map with the entries above.
- `@foundry/*` bundled into `dist`, as Marbles does with tsup's
  `noExternal`; Atlas's build marks every package external today.
- The analysis worker is found beside the entry file, so it ships beside
  every entry.
- The package test checks the built output for private imports, as
  Marbles' does.
- A `workspace.json` record in each state directory, as Marbles keeps, so
  state can be listed.
