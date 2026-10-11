---
title: Scan a workspace
description: What a scan reads, what it writes, how it stays incremental, and what to do when it fails.
---

```sh
atlas scan /path/to/workspace
```

A scan turns a directory of packages into a dataset the viewer can read. It
never writes inside the workspace. When the workspace has a configuration
directory, `.foundry/atlas/`, the scan runs its files first; see
[Configuration](/atlas/reference/configuration).

## What counts as a workspace

Atlas reads the workspace declaration: the `packages` list in
`pnpm-workspace.yaml` when that file has one, or else the `workspaces`
patterns in the root `package.json`, as an array or as
`{ "packages": [...] }`. The same package patterns decide which directories
are units and define the TypeScript program and the entry points for import
analysis. A workspace that declares no packages is not scanned: the scan
fails with `Workspace <root> declares no packages. Atlas reads them from
pnpm-workspace.yaml or package.json#workspaces.` The root `package.json`'s
`name` becomes the workspace name.

A package pattern without `*` (`docs`) matches that directory. A pattern
with `*` is expanded at its first `*`, one level: `apps/*` matches every
child directory of `apps`, and so do `apps/**` and `apps/*/lib`. A leading
`./` and a trailing slash are dropped. Atlas ignores `!` negations, in
discovery and in analysis alike, so put negated directories under `exclude`
instead; it also ignores a pattern that resolves to the workspace root or
escapes it. A pattern that matches no directory is recorded in the manifest
as `packagePatternsUnmatched`, not as an error, and a directory that two
patterns match is a unit once. The manifest counts every matched directory
as `unitsDiscovered`, and the units that are packages as `packagesFound`.

Every directory a pattern matches is a unit. A unit with a `package.json`
that has a name and at least one `.ts` or `.tsx` file that is not a
declaration file is analyzed as a package. Everything else is skipped with a
reason that lands in the manifest:

| Reason | Meaning |
| --- | --- |
| `generated output` | A build directory such as `dist`, `build`, `out`, or `coverage` |
| `gitignored` | Matched by a `.gitignore` between the root and the directory |
| `excluded` | Listed under `exclude` in the workspace's [configuration](/atlas/reference/configuration) |
| `no package manifest` | No `package.json` |
| `analysis unsupported` | No TypeScript source |

Dot-directories, `node_modules`, and `.foundry` are never entered. Within a
unit, files under `test/fixtures/` and build configuration files such as
`*.config.ts` are left out of analysis. To leave a unit out, list it under
`exclude` in the workspace's [configuration](/atlas/reference/configuration);
an exclusion that matches no unit is recorded as `excludeUnmatched`.

## What a scan does

Progress lines go to stderr, one per phase, from `atlas scan` and from the
default `atlas <path>` alike:

```text
discover       find the units
fingerprint    hash every source, manifest, and the Git state
analyze        one worker per package, in parallel, for package-local facts
derive         one worker for the whole workspace: imports, references, evolution, concepts
ingest         merge the package reports into one workspace report
intelligence   graph metrics, concepts on the graph, recurring patterns
project        renderer-neutral views
write          the dataset with each package's internals, then the manifest, then one atomic swap
internals: …   per-package internal structure, derived during write, before the swap
```

Git is read when it is there: churn, hotspots, and change coupling come from
`git log`. A directory that is not a repository scans fine and those
sections are empty.

Workers run under the same Bun that runs Atlas, so none is needed on the
PATH. The scan ends with `Dataset saved to <dir>` on stdout; with
`--json`, its result is one line of JSON instead, and `--quiet` silences the
progress.

## Where it goes

```text
~/.foundry/atlas/<id>/
  workspace.json   the workspace record: which workspace this is
  lock             held while a scan runs
  output/          the dataset
  cache/           per-package results and the workspace fingerprint
```

`<id>` is derived from the resolved path, so a symlinked path and its target
share one state directory and two checkouts never do. `--state <path>`
replaces `~/.foundry/atlas`. The files are described in the
[output reference](/atlas/reference/output).

## Incremental scans

Each package's local analysis is keyed by its own sources and manifest; a
package that has not changed is not re-analyzed. The assembled reports are
keyed by the whole workspace, including the Git state and the day, so a
change anywhere re-derives every package from the cached local results, and
the first scan of a new day does the same. Dataset files that come out
identical are linked from the previous dataset rather than rewritten. The
manifest records how many units were analyzed and how many were reused.

There is no rebuild flag. To start over, delete the state directory for the
workspace.

## When a scan fails

Atlas prints `Atlas: <message>` on stderr and exits with code 1; bad
arguments exit with code 2 and add `Run atlas --help for usage.` The
messages you are most likely to meet:

- `Workspace path does not exist`, or `Workspace is not a directory`: the
  path names nothing, or a file.
- `Packages failed analysis: <id> (<error>)`, or the failing package's own
  error: the first failure stops the scan, nothing is published, and the
  previous dataset stays.
- `Workspace … is being scanned, exported, or applied by process …`:
  another scan of the same workspace is running, an export is copying its
  dataset, or an apply is checking a change; one at a time holds a state
  directory, and the second fails instead of waiting. A lock left by a process that has
  exited is taken over.
- `The viewer's files are missing from <path>`: the default command or
  `serve` finds no built viewer. The default command checks before it
  scans, so nothing is scanned. Reinstall the package or, from source,
  build it; or use `scan` alone.
- `No dataset found for <root> in <output>`: `serve`, `report`,
  `lens`, or `export` on a workspace that has never been scanned with this `--state`. Run `atlas scan` first.
- `Atlas reads dataset schema version 4; this dataset has version <n>`:
  `serve`, `report`, `lens`, or `export` on a dataset saved by another
  Atlas version. Scan again.
- `The dataset has no <id> lens. Run atlas scan again.`: `lens` on a
  dataset saved before that lens existed. Scan again.
- A port in use: found after the scan, which has already saved the
  dataset. Serve it on another port with `atlas serve --port <number>`.
- `Command failed: git rev-parse HEAD`: `--history` on a directory that is
  not a Git repository. The dataset without history was already saved.
