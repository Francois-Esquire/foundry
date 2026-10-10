---
title: CLI
description: Commands, flags, output, and exit codes of the atlas binary.
---

```text
atlas [path]         Scan a workspace, serve it, and open the browser
atlas scan [path]    Scan and save the dataset without starting the web viewer
atlas serve [path]   Serve the saved dataset without running analysis
```

The first argument is a command only when it is exactly `scan` or `serve`;
anything else is the workspace path. One path at most; it defaults to the
current directory and must be an existing directory.

## Flags

| Flag | Default | Effect |
| --- | --- | --- |
| `--state <path>` | `~/.foundry/atlas` | The state root. Each workspace's record, output, and cache live under `<state>/<id>/`; see [output](/atlas/reference/output). |
| `--port <number>` | `4173` | The port to serve on, `0` to `65535`. `0` picks a free port. |
| `--no-open` | open | Do not open the browser after serving. |
| `--history` | off | Analyze Git checkpoints as well; see [history](/atlas/guides/history). |
| `--help`, `-h` | | Print the help and exit. |

An unknown flag is an error, even next to `--help`. Flags apply to every
command; `--history` only has an effect when a scan runs.

## Output

- Progress goes to stderr, one line per phase, then `internals: <package>`
  per package.
- A scan ends with `Output saved to <directory>` on stdout.
- A server prints `Atlas: <url>` and `Workspace: <root>` on stdout, then
  runs until `SIGINT` or `SIGTERM`.
- A failure prints `Atlas: <message>` on stderr.

## Exit codes

| Code | When |
| --- | --- |
| `0` | The command finished, or `--help` |
| `1` | Bad arguments, a path that is not a directory, a package that failed analysis, a workspace already being scanned, `--history` without Git, the viewer's files missing, a port in use, or, for `serve`, no saved dataset, or one with another schema version |

A browser that fails to open is not a failure: the URL is printed instead.

## The server

`serve` binds to `127.0.0.1` on the chosen port and answers `GET` and
`HEAD` only. `/data/<path>` serves `output/<path>` byte for byte with
`Cache-Control: no-store`. Every other path serves the bundled viewer, with
`/` as `index.html`. A path that resolves outside those two directories,
including through a symlink, is `404`. The cache is never served. There is
no API and no directory listing.

The default command checks for the viewer's files before it scans, so a
checkout without a build reports `The viewer's files are missing` at once.
A port in use is only found once the scan has saved the dataset; serve it
on another port with `atlas serve --port <number>`.

`serve` reads the saved dataset's manifest before it starts, and refuses a
workspace with no saved dataset or one saved with another schema version.
It takes no lock: a scan that runs while it serves replaces the dataset
atomically, and later requests see the new one.
