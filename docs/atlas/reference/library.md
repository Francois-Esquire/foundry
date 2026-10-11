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

// Several workspaces, read together as a collection
const collection = await scan.collection(["./platform", "./product"]);
collection.manifest.crossings; // dependencies from one workspace on another
const both = await serve.collection(["./platform", "./product"], { port: 0 });
await both.stop();
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
| `scan.collection(roots, options?)` | function | Scans each workspace of a [collection](#several-workspaces) as `scan` does, in turn, and returns a `CollectionScan` |
| `serve(root, options?)` | function | Serves the saved dataset and the viewer on `127.0.0.1` and returns an `AtlasServer` |
| `serve.collection(roots, options?)` | function | Serves a collection's saved datasets, its collection manifest, and the viewer, and returns a `CollectionServer` |
| `DatasetNotFoundError` | class | No dataset is saved where one was expected |
| `DatasetReplacedError` | class | A later scan saved over the dataset an accessor reads |
| `DATASET_SCHEMA_VERSION` | constant | The dataset's schema version, `5` |
| `HISTORY_SCHEMA_VERSION` | constant | History's schema version, `1` |
| `COLLECTION_SCHEMA_VERSION` | constant | The collection manifest's schema version, `1` |

`root` is the workspace directory, resolved through symbolic links; `roots`
are a collection's.

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

## Several workspaces

A collection is one or more workspaces read together, such as a product
split across repositories that depend on each other. The CLI forms one only
from two or more distinct paths; the library also takes one. Each workspace keeps
its own state, dataset, cache, and lock; nothing is saved for the
collection itself. What ties them is the collection manifest, derived from
the workspaces' saved manifests whenever it is asked for: each workspace
with its id, label, and qualified package ids (`<workspace id>:<package>`),
and the crossings, the declared dependencies of a package in one workspace
on a package in another. See [output](/atlas/reference/output#a-collection).

The paths are resolved through symbolic links, and a workspace given twice
counts once. They are put in one order, by resolved root, whatever the
order given. A workspace inside another is refused, and so are no paths at
all; one workspace is a collection of one.

`scan.collection(roots, options?)` scans each workspace as `scan` does, one
after the other in that order, each under its own lock, and returns a
`CollectionScan`:

| Field | Type | Holds |
| --- | --- | --- |
| `manifest` | `CollectionManifest` | The collection manifest, derived from the manifests the scans just saved |
| `workspaces` | `Scan[]` | Each workspace's scan, in the collection's order, with its accessors |

Its options are `scan`'s (`state`, `history`), except that `onProgress`
receives a `CollectionProgressEvent`, `{ kind: "workspace", id, root,
event }`: the workspace's id and resolved root, and the `ScanProgressEvent`
its own scan emitted. When a workspace fails, the ones scanned before it
keep the datasets they saved, and the call rejects with `Atlas could not
scan <root>: <message>`, the workspace's own error as its `cause` and
their scans, each a `Scan` with its accessors, as `scanned`.

`serve.collection(roots, options?)` takes `serve`'s options and returns a
`CollectionServer`, with `url` and `stop()` as an `AtlasServer` has and
`roots`, the resolved roots in the collection's order, in place of `root`.
It serves `data/collection-manifest.json`, derived at each request, and
each workspace's dataset under `data/<workspace id>/`; any other path under
`data/`, an unknown id included, is not found. It checks every workspace's
saved dataset first, as `serve` checks one, and takes no lock: a scan of
one workspace while it serves is seen by later requests, the collection
manifest included. While a workspace's dataset cannot be read (deleted,
caught mid-swap by a scan, or saved with another schema version), the
collection manifest answers `503` with `Retry-After: 1` and a message
naming the workspace. The viewer does not read a collection yet.

## Errors

Every function rejects with an `Error` whose message says what to do; the
CLI prints the same message after `Atlas: `.

| When | Error |
| --- | --- |
| No dataset is saved for the workspace: `serve`, or an accessor once the dataset is gone | `DatasetNotFoundError`. From `serve`: `No dataset found for <root> in <output>. Run atlas scan to save one.` |
| A later scan saved over the dataset an accessor reads | `DatasetReplacedError`: `A later scan replaced this dataset. Scan again to read the new one.` |
| The dataset was saved with another schema version | `Atlas reads dataset schema version 5; this dataset has version <n>. Run atlas scan to save it again.` |
| An accessor names a package the dataset does not hold | `The dataset has no package named <name>. Its packages: <id>, <id>.` (or `It has no packages.`) |
| `packageReport` or `internals` names a package that failed analysis | `Atlas could not analyze <id>, so it has no package report.`, `… so it has no internals.` |
| `internals` on a dataset saved without them, such as by `scan.workspace` | `The dataset was saved without internals for <id>. Run atlas scan to include them.` |
| A file the manifest names is missing, or saved internals are incomplete | `The dataset is missing <path>. Run atlas scan again.`, `The dataset's internals for <name> are incomplete. Run atlas scan again.` |
| Another scan, export, or apply of the workspace is running | `Workspace <root> is being scanned, exported, or applied by process <pid>. Wait for it to finish, then retry.` |
| A package fails analysis; nothing is saved and the previous dataset stays | `Packages failed analysis: <id> (<error>)` |
| A history checkpoint fails analysis; the dataset is saved, and the scan still rejects | `Some history checkpoints failed analysis.` |
| `scan.package` names no package of the workspace | `Workspace <root> has no package named <name>.` |
| The path is missing or not a directory | `Workspace path does not exist: <path>`, `Workspace is not a directory: <root>` |
| The configuration is invalid | The message names the file and the setting; see [configuration](/atlas/reference/configuration) |
| `serve` without Bun, or with a bad port | `Atlas serve needs Bun (>=1.3.14).`, `Port must be an integer between 0 and 65535.` |
| A collection has no paths, or a workspace inside another | `A collection needs at least one workspace.`, `Workspace <outer> holds workspace <inner>; the workspaces of a collection cannot overlap.` |
| A workspace of `scan.collection` fails | `Atlas could not scan <root>: <message>`, with the workspace's own error as `cause` and the scans before it as `scanned`; those workspaces stay saved |
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
| `CollectionScan`, `CollectionScanOptions`, `CollectionProgressEvent` | What `scan.collection` returns and takes, and its progress events |
| `CollectionServer` | What `serve.collection` returns |
| `CollectionManifest` | The collection manifest, `data/collection-manifest.json` when served or exported |
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
the types. A domain is `NonNullable<AtlasConfig["domains"]>[number]`, and a
rule `NonNullable<AtlasConfig["rules"]>[number]`. See
[configuration](/atlas/reference/configuration).

## One scan at a time

`scan` and `scan.workspace` hold the workspace's lock in its state
directory from start to finish, history included. A second scan or export
of the same workspace fails at once rather than waiting; scans of
different workspaces, or of one workspace under different state roots, run
side by side. `scan.collection` holds each workspace's lock while it scans
that workspace. `scan.package`, `serve`, and `serve.collection` take no
lock.

## Not exported

The analyses themselves, the dataset reader, the report printer (`atlas
report` is CLI only), `atlas export`, and the codemods are not part of the
library. `atlas scan` and `atlas serve` are `scan` and `serve` plus
formatting; see the [CLI](/atlas/reference/cli).
