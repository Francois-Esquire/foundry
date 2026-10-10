---
title: Library
description: scan and serve from code, what they return, their errors, and the types @foundry/atlas exports.
---

The CLI's scans and server, called from code. A program scans a workspace,
reads what came back, and serves it, with the same results the CLI prints.

```ts
import { scan, serve } from "@foundry/atlas";

const everything = await scan("./my-workspace"); // workspace and every complete package's internals
const workspace = await scan.workspace("./my-workspace"); // workspace level only
const db = await scan.package("./my-workspace", "@acme/db"); // one package's internals
const past = await scan("./my-workspace", { history: true });

const server = await serve("./my-workspace", { port: 0 });
server.url;
await server.stop();
```

## Runtime

- Atlas runs on Bun 1.3.14 or newer. `bun add @foundry/atlas` installs the
  library and the `atlas` binary together.
- Under Node, the package loads and `scan` works, but it starts its
  analysis workers with `bun` from the `PATH`, so Bun must still be
  installed. Under Bun, the running Bun starts them.
- `serve` needs Bun itself. Under Node it rejects with
  `Atlas serve needs Bun (>=1.3.14).`
- The declarations use `URL`, which a TypeScript project gets from the DOM
  library, `@types/node`, or Bun's types.

## Exports

The package has one entry, `@foundry/atlas`. Nothing else in it can be
imported.

| Export | Kind | Does |
| --- | --- | --- |
| `scan(root, options?)` | function | Scans the workspace and every complete package's internals, saves the dataset, and returns a `Scan` |
| `scan.workspace(root, options?)` | function | Scans the workspace level only, saves the dataset without internals, and returns a `WorkspaceScan` |
| `scan.package(root, name)` | function | Analyzes one package's internals fresh and returns them as `PackageInternals`; saves nothing |
| `serve(root, options?)` | function | Serves the saved dataset and the viewer on `127.0.0.1` and returns an `AtlasServer` |
| `DatasetNotFoundError` | class | No dataset is saved where one was expected |
| `DatasetReplacedError` | class | A later scan saved over the dataset an accessor reads |
| `DATASET_SCHEMA_VERSION` | constant | The dataset's schema version, `4` |
| `HISTORY_SCHEMA_VERSION` | constant | History's schema version, `1` |

`root` is the workspace directory, resolved through symbolic links. One
workspace at a time.

## What a scan returns

`scan` and `scan.workspace` return what they saved: the dataset read back
from disk, not kept in memory.

| Field | Type | Holds |
| --- | --- | --- |
| `output` | `string` | The directory the dataset is saved in |
| `manifest` | `DatasetManifest` | The dataset's [manifest](/atlas/reference/output) |
| `history` | `{ manifest: HistoryManifest }` or absent | History's manifest, when the scan asked for `history` |
| `workspaceReport()` | `Promise<WorkspaceReport>` | The workspace report, read from the saved dataset |
| `packageReport(name)` | `Promise<PackageReport>` | One package's report, read from the saved dataset |
| `internals(name)` | `Promise<PackageInternals>` | `Scan` only: one package's internals, read from the saved dataset |

- The plain fields are JSON. The accessors are functions, so
  `JSON.stringify` leaves them out.
- Each accessor reads the manifest, one file, and the manifest again. Once
  another scan of the workspace has saved over the dataset, the accessor
  rejects with `DatasetReplacedError`; scan again to read the new one.
- A scan reuses the cache, so scanning an unchanged workspace again is
  fast. There is no separate function that reads a saved scan.
- `scan.package(root, name)` analyzes fresh what
  `scan(root).internals(name)` reads back, and returns the six stages:
  `topology`, `locality`, `responsibilities`, `primitives`, `rewiring`, and
  `review`.

## Options

`ScanOptions`, for `scan` and `scan.workspace`:

| Option | Default | Effect |
| --- | --- | --- |
| `state` | `~/.foundry/atlas` | The state root, as `--state`. Each workspace's dataset and cache go in a directory under it |
| `history` | `false` | Also analyze Git checkpoints into the dataset's `history/`; see [history](/atlas/guides/history) |
| `onProgress` | none | Called with each `ScanProgressEvent` |

`ServeOptions`, for `serve`:

| Option | Default | Effect |
| --- | --- | --- |
| `port` | `4173` | The port, an integer from `0` to `65535`; `0` picks a free one |
| `state` | `~/.foundry/atlas` | The state root to read the saved dataset from |

`scan.package` takes no options: it reads the workspace's configuration and
saves nothing.

## Progress

A `ScanProgressEvent` is one of these, told apart by `kind`:

| `kind` | When | Carries |
| --- | --- | --- |
| `phase` | A phase starts: `discover`, `fingerprint`, `analyze`, `derive`, `ingest`, `intelligence`, `project`, `write`, `lenses` | `phase`, and `detail` when there is one |
| `plan` | Once, before any analysis | `invalidations`: per package and stage, whether it is reused, recomputed, or removed, and why |
| `unit` | A package's own analysis finishes or is reused | `unit`, `status` (`complete`, `failed`, `reused`), `durationMs`, `done` of `total`, and `error` when it failed |
| `internals` | A package's internals are written | `package`, `index` (1-based) of `total` |
| `history` | History's own events, with `history: true` | `event`, whose `kind` is `phase`, `checkpoint`, or `unit` |

## The server

`serve` returns an `AtlasServer`:

| Field | Holds |
| --- | --- |
| `url` | The viewer's address, a `URL` such as `http://127.0.0.1:4173/`; the dataset is under `data/` |
| `root` | The workspace root, resolved through symbolic links |
| `stop()` | Stops listening and closes open connections; resolves once the port is free. A second call does nothing |

`serve` takes no lock. A scan that runs while it serves replaces the
dataset atomically, and later requests see the new one.

## Errors

Every function rejects with an `Error` whose message says what to do; the
CLI prints the same message after `Atlas: `.

| When | Error |
| --- | --- |
| No dataset is saved for the workspace: `serve`, or an accessor once the dataset is gone | `DatasetNotFoundError`. From `serve`: `No dataset found for <root> in <output>. Run atlas scan to save one.` |
| A later scan saved over the dataset an accessor reads | `DatasetReplacedError`: `A later scan replaced this dataset. Scan again to read the new one.` |
| The dataset was saved with another schema version | `Atlas reads dataset schema version 4; this dataset has version <n>. Run atlas scan to save it again.` |
| An accessor names a package the dataset does not hold | `The dataset has no package named <name>. Its packages: <id>, <id>.` (or `It has no packages.`) |
| `packageReport` or `internals` names a package that failed analysis | `Atlas could not analyze <id>, so it has no package report.`, `… so it has no internals.` |
| `internals` on a dataset saved without them, such as by `scan.workspace` | `The dataset was saved without internals for <id>. Run atlas scan to include them.` |
| A file the manifest names is missing, or saved internals are incomplete | `The dataset is missing <path>. Run atlas scan again.`, `The dataset's internals for <name> are incomplete. Run atlas scan again.` |
| Another scan or export of the workspace is running | `Workspace <root> is being scanned or exported by process <pid>. If no scan or export is running, remove <lock>.` |
| A package fails analysis; nothing is saved and the previous dataset stays | `Packages failed analysis: <id> (<error>)` |
| A history checkpoint fails analysis; the dataset is saved, and the scan still rejects | `Some history checkpoints failed analysis.` |
| `scan.package` names no package of the workspace | `Workspace <root> has no package named <name>.` |
| The path is missing or not a directory | `Workspace path does not exist: <path>`, `Workspace is not a directory: <root>` |
| The configuration is invalid | The message names the file and the setting; see [configuration](/atlas/reference/configuration) |
| `serve` without Bun, or with a bad port | `Atlas serve needs Bun (>=1.3.14).`, `Port must be an integer between 0 and 65535.` |
| `serve` cannot find the viewer's files | `The viewer's files are missing from <dir>. Reinstall the package, or build it first when running from source.` |

Only the two dataset errors have their own classes in 0.1. Test for them
with `instanceof`; tell the others apart by message.

## Types

| Type | Describes |
| --- | --- |
| `Scan`, `WorkspaceScan` | What `scan` and `scan.workspace` return |
| `ScanOptions`, `ScanProgressEvent` | `scan`'s options and its progress events |
| `PackageInternals` | One package's internals, every stage through the review |
| `PackageReport` | One package's report |
| `WorkspaceReport` | The workspace report |
| `AtlasServer`, `ServeOptions` | What `serve` returns and takes |
| `DatasetManifest` | The dataset's manifest, `output/manifest.json` |
| `HistoryManifest` | History's manifest, `output/history/manifest.json` |
| `AtlasConfig` | What one configuration file default-exports |

The types nested inside these are not exported. Reach one by indexed
access, such as `DatasetManifest["packages"][number]` for a package's
entry in the manifest. Editors show nested types under Atlas's internal
names, many starting with `Semantics`, and show `PackageReport` as
`SurfaceReport`; the exported names are the ones to write.

`DATASET_SCHEMA_VERSION` is the dataset's promise: a dataset whose manifest
has this version holds the files [output](/atlas/reference/output)
describes, in that shape. A program that reads `output/` itself, rather
than through a scan's accessors, checks the manifest's `schemaVersion`
against it. History
has its own version, `HISTORY_SCHEMA_VERSION`, in its own manifest.

## Configuration files

A configuration file in `.foundry/atlas/` can check itself against
`AtlasConfig`:

```ts
// .foundry/atlas/index.ts
import type { AtlasConfig } from "@foundry/atlas";

export default {
  exclude: ["packages/fixtures"],
} satisfies AtlasConfig;
```

The import is type-only, so it is removed before the file runs; the
workspace needs `@foundry/atlas` installed only for its editor to check
the types. A domain is `NonNullable<AtlasConfig["domains"]>[number]`. See
[configuration](/atlas/reference/configuration).

## One scan at a time

`scan` and `scan.workspace` hold the workspace's lock in its state
directory from start to finish, history included. A second scan or export
of the same workspace fails at once rather than waiting; scans of
different workspaces, or of one workspace under different state roots, run
side by side. `scan.package` and `serve` take no lock.

## Not exported

The analyses themselves, the dataset reader, the report printer (`atlas
report` is CLI only), `atlas export`, and the codemods are not part of the
library. `atlas scan` and `atlas serve` are `scan` and `serve` plus
formatting; see the [CLI](/atlas/reference/cli).
