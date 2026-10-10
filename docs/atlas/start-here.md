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
the line `Dataset saved to …`. `serve` starts a local server for that saved
dataset and prints `Atlas: http://127.0.0.1:4173/`. Running
`atlas /path/to/workspace` with no subcommand scans, serves, and opens the
browser. Paths default to the current directory.

Two more commands read the saved dataset without scanning:

```sh
atlas report @acme/db /path/to/workspace        # one package's report in the terminal
atlas export ./atlas-viewer /path/to/workspace  # a static viewer: the viewer and the dataset as static files
```

A workspace is a directory whose workspace declaration lists package
patterns, in `pnpm-workspace.yaml` or `package.json#workspaces`. Atlas looks
in every directory they match. A package counts when it has a
`package.json` with a name and at least one `.ts` or `.tsx` file. Exclusions
and history settings go in the workspace's
[configuration](/atlas/reference/configuration), `.foundry/atlas/`.

## What you get

The dataset is saved under `~/.foundry/atlas/`, in a directory named by the
workspace id, so two checkouts never share state. Nothing is written inside
the workspace. A second scan is incremental: packages whose sources have not
changed reuse their last analysis, and the whole dataset is replaced in one
move when the scan finishes.

The viewer binds to `127.0.0.1` and serves the saved dataset as static files.
Open it, and the map shows one island per package. Continue with
[explore the map](/atlas/guides/explore-the-map).

## Flags

Each command takes only the flags that apply to it.

| Flag | Effect |
| --- | --- |
| `--state <path>` | Use this state root instead of `~/.foundry/atlas` |
| `--port <number>` | Serve on this port; the default is 4173 and `0` picks a free one |
| `--no-open` | Do not open the browser |
| `--history` | Analyze Git checkpoints as well; requires a Git repository |
| `--json` | Print the result as one line of JSON |
| `--quiet` | Print no progress |

Everything else is in the [CLI reference](/atlas/reference/cli).
