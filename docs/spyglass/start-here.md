---
title: Start Here
description: Install Spyglass, scan a workspace, and open the viewer.
---

Spyglass runs on Bun 1.3.14 or newer. It is one package with one binary,
`spyglass`. Until it is on npm, run it from a checkout of Foundry:

```sh
git clone https://github.com/Francois-Esquire/foundry.git
cd foundry && bun install
bun run --filter @foundry.sh/spyglass build
bun run spyglass -- --help
```

Inside the repository the command is `bun run spyglass -- …`. The rest of these
pages write `spyglass …`; substitute that form. To install the published alpha,
run `bun add -g @foundry.sh/spyglass@alpha`. This puts `spyglass` on your PATH.

## Scan and view

```sh
spyglass scan /path/to/workspace
spyglass serve /path/to/workspace
```

`scan` analyzes the workspace, prints its progress on stderr, and ends with
the line `Dataset saved to …`. `serve` starts a local server for that saved
dataset and prints `Spyglass: http://127.0.0.1:4173/`. Running
`spyglass /path/to/workspace` with no subcommand scans, serves, and opens the
browser. Paths default to the current directory.

Three more commands read the saved dataset without scanning:

```sh
spyglass report @acme/db /path/to/workspace        # one package's report in the terminal
spyglass lens placement /path/to/workspace         # one lens, such as where each place is used
spyglass export ./spyglass-viewer /path/to/workspace  # a static viewer: the viewer and the dataset as static files
```

A workspace is a directory whose workspace declaration lists package
patterns, in `pnpm-workspace.yaml` or `package.json#workspaces`. Spyglass looks
in every directory they match. A package counts when it has a
`package.json` with a name and at least one `.ts` or `.tsx` file. Exclusions
and history settings go in the workspace's
[configuration](/spyglass/reference/configuration), `.foundry/spyglass/`.

## What you get

The dataset is saved under `~/.foundry/spyglass/`, in a directory named by the
workspace id, so two checkouts never share state. Nothing is written inside
the workspace. A second scan is incremental: packages whose sources have not
changed reuse their last analysis, and the whole dataset is replaced in one
move when the scan finishes.

The viewer binds to `127.0.0.1` and serves the saved dataset as static files.
Open it, and the map shows one island per package. Continue with
[explore the map](/spyglass/guides/explore-the-map).

## Flags

Each command takes only the flags that apply to it.

| Flag | Effect |
| --- | --- |
| `--state <path>` | Use this state root instead of `~/.foundry/spyglass` |
| `--port <number>` | Serve on this port; the default is 4173 and `0` picks a free one |
| `--no-open` | Do not open the browser |
| `--history` | Analyze Git checkpoints as well; requires a Git repository |
| `--json` | Print the result as one line of JSON |
| `--quiet` | Print no progress |

Everything else is in the [CLI reference](/spyglass/reference/cli).


## Moving from Atlas

The product, package, and command are now Spyglass, `@foundry.sh/spyglass`, and
`spyglass`. Move workspace configuration from `.foundry/atlas/` to
`.foundry/spyglass/` and change type imports to `SpyglassConfig` from the new
package. The old configuration directory is still read when the new one is
absent; only the new directory is read when both exist.

New workspaces save state under `~/.foundry/spyglass/`. Existing workspaces
continue to use their saved state under `~/.foundry/atlas/` when no new state
is present. This leaves scans, history, locks, and interrupted-apply journals
in place. An explicit `--state` always wins. Existing static exports can be
safely refreshed by `spyglass export`; new exports use the Spyglass marker.
