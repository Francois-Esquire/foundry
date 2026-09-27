---
title: Start Here
description: Build the Atlas CLI, scan a workspace, and open the viewer.
---

`@foundry/atlas` is not published to npm yet. It runs from the Foundry
repository with Bun 1.3.14 or newer.

```sh
git clone https://github.com/Francois-Esquire/foundry.git
cd foundry && bun install
bun run --filter @foundry/atlas build
bun run atlas -- --help
```

Inside the repository the command is `bun run atlas -- …`. The rest of these
pages write `atlas …`; substitute that form.

## Scan and view

```sh
atlas scan /path/to/workspace
atlas serve /path/to/workspace
```

`scan` analyzes the workspace and prints where the output was saved. `serve`
starts a local server for that saved output and prints its URL. Running
`atlas /path/to/workspace` with no subcommand does both and opens the browser.
Paths default to the current directory.

Output lives under `~/.foundry/atlas/`, in a directory named by a hash of the
workspace path. Nothing is written inside the workspace. The output is
replaced on the next scan.

## Flags

| Flag | Effect |
| --- | --- |
| `--state <path>` | Save output under this directory instead of `~/.foundry/atlas` |
| `--port <number>` | Serve on this port; the default is 4173 and `0` picks a free one |
| `--no-open` | Do not open the browser |
| `--history` | Include Git history in the scan; requires a Git repository |
