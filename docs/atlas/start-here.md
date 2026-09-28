---
title: Start Here
description: Install Atlas, scan a workspace, and open the viewer.
---

Atlas runs on Bun 1.3.14 or newer. It is one package with one binary,
`atlas`. Until it is on npm, run it from a checkout of Foundry:

```sh
git clone https://github.com/Francois-Esquire/foundry.git
cd foundry && bun install
bun run --filter @foundry/atlas build
bun run atlas -- --help
```

Inside the repository the command is `bun run atlas -- …`. The rest of these
pages write `atlas …`; substitute that form. Once the package is published,
`bun add -g @foundry/atlas` puts `atlas` on your PATH and the pages read as
written.

## Scan and view

```sh
atlas scan /path/to/workspace
atlas serve /path/to/workspace
```

`scan` analyzes the workspace, prints its progress on stderr, and ends with
the line `Output saved to …`. `serve` starts a local server for that saved
output and prints `Atlas: http://127.0.0.1:4173/`. Running
`atlas /path/to/workspace` with no subcommand scans, serves, and opens the
browser. Paths default to the current directory.

A workspace is a directory whose `package.json` lists `workspaces`, with
packages under `apps`, `packages`, `plugins`, or `tooling`. A package counts
when it has a `package.json` with a name and at least one `.ts` or `.tsx`
file. Other layouts are configured in
[`foundry.config.json`](/atlas/reference/configuration).

## What you get

Output lives under `~/.foundry/atlas/`, in a directory named by a hash of the
workspace path, so two checkouts never share state. Nothing is written inside
the workspace. A second scan is incremental: packages whose sources have not
changed reuse their last analysis, and the whole dataset is replaced in one
move when the scan finishes.

The viewer binds to `127.0.0.1` and serves the saved output as static files.
Open it, and the map shows one island per package. Continue with
[explore the map](/atlas/guides/explore-the-map).

## Flags

| Flag | Effect |
| --- | --- |
| `--state <path>` | Save output under this directory instead of `~/.foundry/atlas` |
| `--port <number>` | Serve on this port; the default is 4173 and `0` picks a free one |
| `--no-open` | Do not open the browser |
| `--history` | Include Git history in the scan; requires a Git repository |

Everything else is in the [CLI reference](/atlas/reference/cli).
