---
title: Scan a workspace
description: What a scan reads, what it writes, how it stays incremental, and what to do when it fails.
---

```sh
atlas scan /path/to/workspace
```

A scan turns a directory of packages into a dataset the viewer can read. It
never writes inside the workspace.

## What counts as a workspace

Atlas reads the root `package.json`. Its `workspaces` patterns, as an array
or as `{ "packages": [...] }`, define the TypeScript program and the entry
points for import analysis; without them the whole root is one program. Its
`name` becomes the workspace name.

Units are found under the roots `apps`, `packages`, `plugins`, and
`tooling`. Every immediate child directory with a `package.json` that has a
name and at least one `.ts` or `.tsx` file that is not a declaration file is
a unit. A root that does not exist is recorded, not an error. Everything
else is skipped with a reason that lands in the manifest:

| Reason | Meaning |
| --- | --- |
| `generated output` | A build directory such as `dist`, `build`, `out`, or `coverage` |
| `gitignored` | Matched by a `.gitignore` between the root and the directory |
| `excluded` | Listed under `semantics.exclude` in `foundry.config.json` |
| `no package manifest` | No `package.json` |
| `analysis unsupported` | No TypeScript source |

Dot-directories, `node_modules`, and `.foundry` are never entered. Within a
unit, files under `test/fixtures/` and build configuration files such as
`*.config.ts` are left out of analysis. Change the roots or exclude units in
[`foundry.config.json`](/atlas/reference/configuration).

## What a scan does

Progress lines go to stderr, one per phase:

```text
discover       find the units
fingerprint    hash every source, manifest, and the Git state
analyze        one worker per package, in parallel, for package-local facts
derive         one worker for the whole workspace: imports, references, history, concepts
ingest         merge the package reports into one workspace report
intelligence   graph metrics, concepts on the graph, recurring patterns
project        renderer-neutral views
write          the dataset, then the manifest, then one atomic swap
internals: …   per-package internal structure, after the dataset is published
```

Git is read when it is there: churn, hotspots, and change coupling come from
`git log`. A directory that is not a repository scans fine and those
sections are empty.

Workers are started as `bun` from your PATH. The scan ends with
`Output saved to <directory>` on stdout.

## Where it goes

```text
~/.foundry/atlas/<sha256 of the workspace path>/
  output/    the dataset
  cache/     per-package results and the workspace fingerprint
```

The hash is of the resolved path, so a symlinked path and its target share
one state directory and two checkouts never do. `--state <path>` replaces
`~/.foundry/atlas`. The files are described in the
[output reference](/atlas/reference/output).

## Incremental scans

Each package's local analysis is keyed by its own sources and manifest; a
package that has not changed is not re-analyzed. The assembled reports are
keyed by the whole workspace, including the Git state and the day, so a
change anywhere re-derives every package from the cached local results, and
the first scan of a new day does the same. Output files that come out
identical are linked from the previous dataset rather than rewritten. The
manifest records how many units were analyzed and how many were reused.

There is no rebuild flag. To start over, delete the state directory for the
workspace.

## When a scan fails

Atlas prints `Atlas: <message>` on stderr and exits with code 1. The
messages you are most likely to meet:

- `Workspace is not a directory`: the path does not exist.
- `N packages failed analysis.`: the first failure stops the scan; the
  manifest names the package and the error.
- `semantics cache … is locked by process …`: another scan of the same
  workspace is running. A lock left by a dead process is taken over.
- `Atlas web assets are missing`: the default command scans, then finds no
  built viewer. Build the package, or use `scan` alone.
- `Command failed: git rev-parse HEAD`: `--history` on a directory that is
  not a Git repository. The dataset without history was already saved.
