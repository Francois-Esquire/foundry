---
title: CLI
description: Commands, flags, output, and exit codes of the atlas binary.
---

```text
atlas [path]         Refresh a workspace, serve it, and open the browser
atlas scan [path]    Generate output without starting the web viewer
atlas serve [path]   Serve saved output without running analysis
```

The first argument is a command only when it is exactly `scan` or `serve`;
anything else is the workspace path. One path at most; it defaults to the
current directory and must be an existing directory.

## Flags

| Flag | Default | Effect |
| --- | --- | --- |
| `--state <path>` | `~/.foundry/atlas` | The state root. Output and cache live under `<state>/<sha256 of the workspace path>/`. |
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
| `1` | Bad arguments, a path that is not a directory, a package that failed analysis, a held cache lock, `--history` without Git, missing web assets, or a port in use |

A browser that fails to open is not a failure: the URL is printed instead.

## The server

`serve` binds to `127.0.0.1` on the chosen port and answers `GET` and
`HEAD` only. `/data/<path>` serves `output/<path>` byte for byte with
`Cache-Control: no-store`. Every other path serves the bundled viewer, with
`/` as `index.html`. A path that resolves outside those two directories,
including through a symlink, is `404`. The cache is never served. There is
no API and no directory listing.

The default command scans first and only then checks for the viewer's
assets, so a checkout without a build pays for the scan before it reports
`Atlas web assets are missing`.
