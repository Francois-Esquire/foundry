---
title: CLI
description: Commands, flags, output, and exit codes of the atlas binary.
---

The same scans and server are available from code: see the
[library](/atlas/reference/library).

## Usage

```text
Atlas — workspace analysis and a local viewer

  atlas [path...]                   Scan a workspace, serve its dataset, and open the browser
  atlas scan [path...]              Scan and save the dataset
  atlas serve [path...]             Serve the saved dataset without scanning
  atlas report <package> [path...]  Print a package report from the saved dataset
  atlas lens <id> [path...]         Print a lens from the saved dataset
  atlas check [path...]             Check the workspace's rules against the saved dataset
  atlas export <dir> [path...]      Write a static viewer of the saved dataset to <dir>

The path defaults to the current directory; one workspace at a time.
A directory named like a command is written as a path: ./scan, ./serve, ./report, ./lens, ./check, ./export.

  --state <path>        State root (default: ~/.foundry/atlas)
  --history             atlas, scan: analyze Git checkpoints as well
  --port <number>       atlas, serve: local port (default: 4173; 0 chooses a free port)
  --no-open             atlas, serve: do not open the browser
  --format <format>     report, lens, check: terminal, text, markdown (default: terminal; text when piped)
  --density <density>   report, lens, check: compact, normal, expanded (default: normal)
  --json                Print the result as one line of JSON
  --quiet               Print no progress
  --help, -h            Show this help

Exit codes: 0 done, 1 failed, 2 bad arguments, 3 a rule broken (check).
```

The first argument is a command only when it is exactly `scan`, `serve`,
`report`, `lens`, or `export`; anything else is the workspace path, for
the default command. A directory with a command's name is written as a path,
`atlas ./report`. The path defaults to the current directory and must be
an existing directory. The parser reads `path...`, but one workspace at a
time is supported for now: a second path is refused until several
workspaces can be read as one collection.

## Flags

| Flag | Commands | Default | Effect |
| --- | --- | --- | --- |
| `--state <path>` | all | `~/.foundry/atlas` | The state root. Each workspace's state directory, `<state>/<id>/`, holds its workspace record, output, and cache; see [output](/atlas/reference/output). |
| `--history` | `atlas`, `scan` | off | Analyze Git checkpoints as well; see [history](/atlas/guides/history). |
| `--port <number>` | `atlas`, `serve` | `4173` | The port to serve on, `0` to `65535`. `0` picks a free port. |
| `--no-open` | `atlas`, `serve` | open | Do not open the browser after serving. |
| `--format <format>` | `report`, `lens`, `check` | `terminal` on a terminal, `text` when piped | `terminal`, `text`, or `markdown`. |
| `--density <density>` | `report`, `lens`, `check` | `normal` | `compact`, `normal`, or `expanded`. |
| `--json` | all | off | Print the result as one line of JSON instead of text. |
| `--quiet` | all | off | Print no progress. |
| `--help`, `-h` | | | Print the help and exit. |

An unknown flag is an error, even next to `--help`. Otherwise `--help`
wins over the rest of the line. A flag the command does not take is an
error too: `atlas serve does not take --history.`

## What it prints

- stdout carries the command's result and nothing else. stderr carries
  progress, warnings, and errors.
- Progress goes to stderr, one line per phase, then `internals: <package>`
  per package. `--quiet` silences it, and nothing else.
- `scan` ends with `Dataset saved to <dir>` on stdout.
- `report` prints the package report, rendered for the format.
- `lens` prints the lens, rendered for the format.
- `check` prints the `rules` lens, rendered for the format, and exits `3`
  when a rule is broken.
- `export` prints `Static viewer saved to <dir>`.
- A server prints `Atlas: <url>` and `Workspace: <root>` on stdout, then
  runs until `SIGINT` or `SIGTERM`, such as Ctrl-C, which stop it and exit
  `0`. The default command prints the scan's line, then the server's.
- A failure prints `Atlas: <message>` on stderr and nothing more on
  stdout; the default command may already have printed `Dataset saved to
  <dir>` when serving then fails. A usage error adds `Run atlas --help for
  usage.`

### `--json`

With `--json`, stdout is one line: the [library](/atlas/reference/library)'s result as JSON.

| Command | The line |
| --- | --- |
| `scan` | `{ "manifest", "output", "history"? }`: the dataset's manifest, the directory it is saved in, and history's manifest when the scan includes it |
| `report` | The package report exactly as the dataset holds it, `output/packages/<name>.json` |
| `lens` | The lens's output exactly as the dataset holds it, `output/lenses/<id>.json` |
| `check` | `{ "generatedAt", "outcome", "lens" }`: the checked dataset's `generatedAt`, `clean`, `violations`, or `incomplete`, and the `rules` lens as saved |
| `export` | `{ "directory", "manifest" }`: where the static viewer is, and the manifest of the dataset it holds |
| `serve` | `{ "root", "url" }`, printed once the server listens |
| `atlas` | One line once the server listens: the scan's fields and the server's, `{ "manifest", "output", "history"?, "root", "url" }` |

`--json` does not change stderr: progress still goes there unless
`--quiet` is given. `report --json`, `lens --json`, and `check --json` take
no `--format` or `--density`. `check --json` exits as `check` does.

## Exit codes

| Code | When |
| --- | --- |
| `0` | The command finished, or `--help`; for `check`, no rule is broken, or none is declared |
| `1` | The command ran and failed: a path that does not exist or is not a directory, a package that failed analysis, a workspace being scanned or exported, `--history` without Git, the viewer's files missing, a port in use, no saved dataset or one with another schema version, an unknown package, a dataset saved without the lens asked for or with another version of it, a directory export refuses, or `check` could not check a `require` rule in a package that failed analysis, which outranks any violation |
| `2` | Bad arguments: an unknown flag, a flag the command does not take, a bad value, an unknown lens, a missing package, lens, or directory, or a second path |
| `3` | `check` only: a rule is broken |

Codes above `2` are for commands' own results: `atlas check` exits `3` on
a violation, so that a CI job can tell a broken rule from a failed run.
This differs from Marbles, whose usage errors exit `1`; from ESLint, where
`1` means lint errors and `2` a failed run; and from `tsc`, where `1` and
`2` both mean type errors.

A browser that fails to open is not a failure: the URL is printed on stderr
instead, with or without `--quiet`.

## Report

`atlas report <package> [path...]` prints one package's report from the
saved dataset; it scans nothing. The package is its `package.json` name.
An unknown name fails and lists the dataset's packages. `terminal` uses
colour unless `NO_COLOR` is set, and wraps to the terminal's width; piped
output is 80 columns wide. Every format draws with Unicode glyphs.
`markdown` suits documentation and pull requests.

## Lens

`atlas lens <id> [path...]` prints one lens from the saved dataset; it scans
nothing, and renders as `report` does. Every scan saves every lens; see
[output](/atlas/reference/output) for each one's fields.

| Lens | What it shows |
| --- | --- |
| `domains` | The declared domains: the places each one's facets name, the facets that name none, and a domain label for each placed place in a domain |
| `file-roles` | Each package's files by role, and its high fan-in files |
| `frequent-change` | The files at or above the hotspots' commit gate |
| `nesting` | The folder tree, path regions, and the seams between them |
| `package-sizes` | Each package's dependency layer and files by kind |
| `placement` | Where each place is used against where it lives: fits, spread, or departs |
| `proximity` | What sits close without being related, and what is related without sitting close |
| `responsibility-groups` | Each package's responsibilities joined into groups |
| `rules` | The declared rules against the dataset: each place that breaks a `require` rule, with its saved plan's status and blocker reasons, the rules whose subject names no place, and the packages a `require` could not be checked in |

An unknown id is a usage error that lists the ids. A dataset saved before a
lens existed, or with another version of it, fails and asks for a new scan.

## Check

`atlas check [path...]` checks the workspace's [rules](/atlas/reference/configuration#rules)
against the saved dataset; it scans nothing and runs no configuration. It
prints the `rules` lens that the last scan saved, rendered as `lens`
renders, so a rule edited since then takes a scan to show: a warm scan
takes a few seconds, since rules invalidate no package. In CI, run
`atlas scan --quiet` and then `atlas check`.

A `require` of `internalize` means that, under its subject, no
package-public symbol is unused outside its package. Each such symbol is a
violation, listed with its saved plan's status and blocker reasons: a
`publishable` package's exports are blocked, since consumers outside the
workspace may import them and Atlas cannot see them. A `permit` breaks
nothing.

| Exit | When |
| --- | --- |
| `0` | No rule is broken, or no rule is declared (the output says so) |
| `3` | At least one rule is broken |
| `1` | The check could not run, or a `require` rule meets a package that failed analysis, which outranks any violation |

A rule whose subject names no place in the dataset, matched as a domain's
facet is, is listed as unmatched and breaks nothing; check its spelling.

When a `require` meets a package that failed analysis, `check` exits `1`
and names the rule and the package on stderr. A package that keeps failing
under a wide `require`, such as one on `packages`, makes every `check` exit
`1`; narrowing the subject to the packages that analyze fixes it.

## Export

`atlas export <dir> [path...]` writes a static viewer: the viewer's files at
the root of `<dir>`, the workspace's saved dataset, whole, under
`<dir>/data/`, and `.atlas-static-viewer.json`, which lists the top-level
entries Atlas wrote. Any static file host serves it, under any path; the
viewer reads `./data/` relative to its page. It scans nothing.

`<dir>` must be absent, an empty directory (a `.DS_Store` is ignored), or a
previous static viewer that holds nothing but what its
`.atlas-static-viewer.json` lists. A previous static viewer is replaced only
once the new one is complete; a failed export leaves it as it was, though a
crash can leave `<dir>.export-<id>` or `<dir>.previous-<id>` beside it.
Anything else is refused. The check covers the top level only: a file you
add inside one of Atlas's own entries, such as `data/`, is replaced with it. The refusals:

- `<dir> holds files Atlas did not write, such as <entry>. Choose another
  directory.` for anything else in it, such as a `.git` directory or a
  `CNAME` file.
- `<dir> is not a directory. Choose another directory.` and `<dir> is a
  symbolic link; Atlas does not write through links. Choose another
  directory.`
- `<dir>` must not hold the workspace, and must not overlap the state
  directory or the viewer's files.

To publish from a Git checkout, such as a `gh-pages` branch, export into a
subdirectory of it, or export elsewhere and copy the files in. A static
viewer inside the workspace is allowed; a later scan analyzes its files only
if a package pattern of the workspace covers them.

An export holds the state directory's lock while it copies, as a scan
does, so it fails at once while a scan of the workspace runs, and a scan
fails while it copies.

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

`serve` and `export` first check for the viewer's files. Then `serve`,
`report`, `lens`, and `export` read the saved dataset's manifest, and refuse a
workspace with no saved dataset or one saved with another schema version. A workspace whose directory has been removed
fails at once, since its path no longer resolves, even though its dataset is
still in the state root. `serve` takes no lock: a scan that runs while it
serves replaces the dataset atomically, and later requests see the new one.
