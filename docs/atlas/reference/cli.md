---
title: CLI
description: Commands, flags, output, and exit codes of the atlas binary.
---

The same scans and server are available from code: see the
[library](/atlas/reference/library).

## Usage

```text
Atlas — workspace analysis and a local viewer

  atlas [path...]                      Scan, serve, and open the browser
  atlas scan [path...]                 Scan and save each workspace's dataset
  atlas serve [path...]                Serve the saved datasets without scanning
  atlas report <package> [path...]     Print a package report from the saved dataset
  atlas lens <id> [path...]            Print a lens from the saved dataset
  atlas check [path...]                Check the workspace's rules against the saved dataset
  atlas plan <opportunity> [path...]   Plan one opportunity and authorize it; writes nothing in the workspace
  atlas apply <opportunity> [path...]  Preview a planned change; write and verify it with --write
  atlas export <dir> [path...]         Write a static viewer of the saved datasets to <dir>

The path defaults to the current directory. atlas, scan, serve, and export read
several paths as one collection; the other commands read one workspace.
A directory named like a command is written as a path: ./scan, ./serve, ./report, ./lens, ./check, ./plan, ./apply, ./export.

  --state <path>        State root (default: ~/.foundry/atlas)
  --history             atlas, scan: analyze Git checkpoints as well
  --port <number>       atlas, serve: local port (default: 4173; 0 chooses a free port)
  --no-open             atlas, serve: do not open the browser
  --write               apply: write the change, verify it, then scan again
  --format <format>     report, lens, check, plan, apply: terminal, text, markdown (default: terminal; text when piped)
  --density <density>   report, lens, check, plan, apply: compact, normal, expanded (default: normal)
  --json                Print the result as one line of JSON
  --quiet               Print no progress
  --help, -h            Show this help

Exit codes: 0 done, 1 failed, 2 bad arguments, 3 a rule broken (check).
```

The first argument is a command only when it is exactly `scan`, `serve`,
`report`, `lens`, `check`, `plan`, `apply`, or `export`; anything else is
the workspace path, for the default command. A directory with a command's name is written as a path,
`atlas ./report`. The path defaults to the current directory and must be
an existing directory.

## Several workspaces

`atlas`, `scan`, `serve`, and `export` read two or more paths as one
collection: workspaces read together, such as a product split across
repositories that depend on each other. One path runs exactly as it always
has.

- Each workspace is scanned on its own, one after the other, with its own
  state, dataset, cache, and lock; nothing is saved for the collection.
  What ties them is the collection manifest, derived from the saved
  datasets: each workspace, its packages qualified by its workspace id, and
  the crossings, a package's declared dependency on a package of another
  workspace. See [output](/atlas/reference/output#a-collection).
- The workspaces are ordered by resolved root, whatever the order given. A
  workspace inside another exits `2`: `Workspace <outer> holds workspace
  <inner>; the workspaces of a collection cannot overlap.`
- Two paths that name one workspace, the same path twice or a path and a
  link to it, exit `2`, naming the path given twice: `<path> names the same
  workspace as <earlier path>, <root>; give each workspace once.`
- `report`, `lens`, `check`, `plan`, and `apply` read one workspace's
  dataset and refuse a second path with exit `2`: `atlas report reads one
  workspace's dataset; give one path.`
- When a workspace's scan fails, the workspaces scanned before it keep
  their saved datasets, and the command fails with `Atlas could not scan
  <root>: <message>`.

## Flags

| Flag | Commands | Default | Effect |
| --- | --- | --- | --- |
| `--state <path>` | all | `~/.foundry/atlas` | The state root. Each workspace's state directory, `<state>/<id>/`, holds its workspace record, output, and cache; see [output](/atlas/reference/output). |
| `--history` | `atlas`, `scan` | off | Analyze Git checkpoints as well; see [history](/atlas/guides/history). |
| `--port <number>` | `atlas`, `serve` | `4173` | The port to serve on, `0` to `65535`. `0` picks a free port. |
| `--no-open` | `atlas`, `serve` | open | Do not open the browser after serving. |
| `--write` | `apply` | off | Write the change, verify it, then scan again; see [apply](#apply). |
| `--format <format>` | `report`, `lens`, `check`, `plan`, `apply` | `terminal` on a terminal, `text` when piped | `terminal`, `text`, or `markdown`. |
| `--density <density>` | `report`, `lens`, `check`, `plan`, `apply` | `normal` | `compact`, `normal`, or `expanded`. |
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
  per package; for a collection, `workspace: <root>` before each
  workspace's lines. `--quiet` silences it, and nothing else.
- `scan` ends with `Dataset saved to <dir>` on stdout; for a collection,
  one such line per workspace, then `Collection: <n> workspaces, <n>
  crossings`.
- `report` prints the package report, rendered for the format.
- `lens` prints the lens, rendered for the format.
- `check` prints the `rules` lens, rendered for the format, and exits `3`
  when a rule is broken.
- `apply` prints the outcome, each statement it edits or would edit, before
  and after, and after a write every check it ran; scan progress goes to
  stderr.
- `plan` prints the verdict for one opportunity, its planned changes, what
  stops it, and the verification an apply would run, rendered for the
  format.
- `export` prints `Static viewer saved to <dir>`.
- A server prints `Atlas: <url>` and `Workspace: <root>` on stdout, one
  `Workspace:` line per workspace of a collection, then
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
| `plan` | `{ "site", "opportunity", "plan", "verdict", "record"? }`: the symbol as `path#name`, the opportunity's id, the saved plan as its package report holds it, the verdict (its `kind`, with readiness's assessment once readiness judged the plan, and the record when authorized), and the path the record was saved to, only when authorized |
| `apply` | `{ "site", "planId", "mode", "status", "refusal"?, "edits", "changedFiles", "verification"?, "scan"?, "timings"? }`: `mode` is `preview` or `write`; `status` is `preview`, `refused`, `applied`, or `rolled-back`; `refusal` says why, by `kind`; `edits` are `{ file, before, after }`, `after` `null` for a removed statement; `verification` holds every check after a write; `scan` is the scan after it, `{ status, output, durationMs, error? }`; `timings` how long the workspace's scripts ran before and after the write |
| `export` | `{ "directory", "manifest" }`: where the static viewer is, and the manifest of the dataset it holds |
| `serve` | `{ "root", "url" }`, printed once the server listens |
| `atlas` | One line once the server listens: the scan's fields and the server's, `{ "manifest", "output", "history"?, "root", "url" }` |
| `scan` of a collection | `{ "manifest", "workspaces" }`: the collection manifest, and each workspace's `{ "manifest", "output", "history"? }` in the collection's order |
| `export` of a collection | `{ "directory", "manifest", "workspaces" }`: where the static viewer is, the collection manifest it holds, and each workspace's `{ "id", "root", "dataset" }`, `dataset` being the directory its dataset was copied to |
| `serve` of a collection | `{ "roots", "url" }`: each workspace root in the collection's order |
| `atlas` of a collection | `{ "manifest", "workspaces", "roots", "url" }`: the collection scan's fields and the server's |

`--json` does not change stderr: progress still goes there unless
`--quiet` is given. `report --json`, `lens --json`, `check --json`, and
`plan --json`, and `apply --json` take no `--format` or `--density`.
`check --json` and `apply --json` exit as the command does.

## Exit codes

| Code | When |
| --- | --- |
| `0` | The command finished, or `--help`; for `check`, no rule is broken, or none is declared; for `plan`, any verdict, refused and blocked included; for `apply`, a preview, or a write that verified and whose scan published |
| `1` | The command ran and failed: a path that does not exist or is not a directory, a package that failed analysis, a workspace being scanned, exported, or applied, `--history` without Git, the viewer's files missing, a port in use, no saved dataset or one with another schema version, an unknown package, a dataset saved without the lens asked for or with another version of it, a directory export refuses, `check` could not check a `require` rule in a package that failed analysis, which outranks any violation, `plan` or `apply` was given an opportunity the dataset does not hold, found the dataset stale, or found an unfinished apply, `apply` found no record or refused, rolled back, or wrote a verified change whose final swap then failed, or `check` found an unfinished apply |
| `2` | Bad arguments: an unknown flag, a flag the command does not take, a bad value, an unknown lens, a missing package, lens, opportunity, or directory, an opportunity of another shape, two paths that name one workspace, two paths of which one holds the other, or a second path for `report`, `lens`, `check`, `plan`, or `apply` |
| `130`, `143` | `apply --write` was stopped by Ctrl-C (`130`) or `SIGTERM` (`143`), and restored every file it wrote |
| `3` | `check` only: a rule is broken |

Codes above `2` are for commands' own results: `atlas check` exits `3` on
a violation, and `atlas apply` exits `130` or `143` once a write Ctrl-C or
`SIGTERM` interrupted is restored, so that a CI job can tell a broken rule from a failed run.
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

## Plan

`atlas plan <opportunity> [path...]` plans one internalize opportunity from
the saved dataset and asks whether Atlas may apply it. The opportunity is
written as `check` lists it, `internalize-symbol:<path#name>`, as its saved
plan's id, `plan:internalize-symbol:<path#name>`, or as the bare
`<path#name>`. Any other shape is a usage error; an opportunity the dataset
does not hold fails.

It takes the rules from the `rules` lens the last scan saved, as `check`
does, so it runs no configuration, and a rule edited since then takes a
scan to count. It answers with one verdict, checked cheapest first:

| Verdict | When |
| --- | --- |
| `refused-by-rule` | No `permit` or `require` rule of `internalize` covers the symbol. The output names a rule that would. Nothing runs. |
| `not-executable` | No mutator executes the plan: the saved plan is not `ready`, or it needs an edit `internalize-export` does not make. A `publishable` package's plan is `blocked`, and the output says why. Nothing runs. |
| `readiness` | Readiness judged the plan and did not authorize it: `stale`, `unsupported`, `blocked`, such as a test that fails before any change, or `not-authorized`, such as a package with no `test` script. |
| `authorized` | Every check passed. |

Before it authorizes, readiness runs the baseline of each verification
step: the package's `test` script, and its `typecheck` script where it has
one; without one, Atlas checks the types itself. So `plan` runs the
workspace's own scripts, with `CI=1`, which can take minutes. Atlas writes
nothing in the workspace, though the scripts may write what they always
write, such as coverage or build info.

An authorized plan's record, ids and fingerprints only, is saved to
`plans/<digest>.json` in the workspace's state directory; see
[output](/atlas/reference/output). Any other verdict deletes the
opportunity's earlier record, so a record exists only while the last plan
authorized it. A later apply authorizes again before it writes, so a record
is never a promise that the sources still match.
`plan` takes no lock: it can run while a scan does, and its scripts can run
beside another command's. It refuses while an apply's journal,
`apply/journal.json` in the state directory, exists.

The saved plan is the last scan's, so `plan` first checks that the saved
dataset is current, and fails at once when it is not; see
[current](#a-current-dataset).

## A current dataset

A scan records one hash of everything its analyses read: every source
file, Git's commits and tracked files, the UTC day it ran on, the
configuration's exclusions and profile, and the analysis version. `plan`
and `apply` recompute that hash, in about two seconds on a workspace of
1,500 files, and go on only when it is the recorded one. So a dataset is
current on the UTC day it was scanned, with no commit and no source edit
since. Otherwise they fail with "The saved dataset is stale", and
`atlas scan` makes it current again; after a commit or on a new UTC day
that scan derives the workspace again, which is most of a cold scan's time. A dataset saved before Atlas recorded the hash cannot be shown current
either.

`plan` runs no configuration, so it takes the exclusions-and-profile part
of the hash from the dataset rather than from the configuration: an edited
exclusion is caught by `apply`, which loads the configuration, and not by
`plan`. Rules are not part of the hash; `apply` compares them with the
record.

## Apply

`atlas apply <opportunity> [path...]` applies the plan `atlas plan`
authorized for an opportunity, written as `plan` takes it. Without
`--write` it is a preview: it prints each statement it would edit, before
and after, and Atlas writes no source file. With `--write` it writes the
change, verifies it, and scans again.

Apply never trusts the record on its own. Holding the state directory's
lock, in both modes, it:

1. finishes an earlier apply that did not: one interrupted while it wrote
   is restored from its journal, which it reports and exits `1`; one that
   wrote and verified its change waits for `atlas scan`;
2. loads the configuration as it is now, and refuses a dataset that is not
   [current](#a-current-dataset), before any script runs: the saved
   package report is what the write is checked against;
3. authorizes the plan again, which runs the workspace's test and
   typecheck scripts again, and refuses unless the result is the record's.
   A refusal names what moved, in this order: the sources, with the files,
   the rules, the mutator's capabilities, the verification, the plan, and
   the rollback; "the Atlas that made the record" when only the record's
   hash differs, as after an Atlas upgrade;
4. refuses a plan whose rollback cannot restore every file it writes, or
   that creates or deletes a file;
5. refuses when a file it writes has uncommitted changes; an unrelated
   dirty file, or one the plan only reads, does not stop it. `--write`
   needs Git: outside a repository, without Git, or with a repository Git
   cannot read, it refuses and says which;
6. checks the saved plan against the saved package report, which a current
   dataset holds as a fresh analysis would. "Before" is fixed there, when
   currency is checked: a file edited elsewhere while the scripts run is
   not caught by these checks, but by the verification after the write,
   which reads the staged scan of the sources as they then are, and rolls
   back.

Then, with `--write`:

1. it checks each file it writes against the hash the rollback recorded,
   just before writing;
2. it saves the journal, `apply/journal.json` in the state directory, with
   each file's original bytes, and flushes it to disk before the first
   write;
3. it writes each file atomically, keeping its mode and any byte order
   mark;
4. it checks that no new TypeScript error appeared in the package, that
   the symbol still exists and no public route exposes it, that its
   external use is still none, and that the package's surface changed as
   the plan predicted; then it runs the test and typecheck scripts again,
   each of which must pass, or show no failure it did not show before the
   write;
5. on any failed check or error it restores every file it wrote, byte for
   byte, with its mode, and exits `1`; a script killed on its own, as by its
   ten-minute timeout or too much output, is a failed check. On Ctrl-C or
   `SIGTERM`, during the write or any check, the scripts included, it
   restores them too, says it was interrupted, and exits `130` for Ctrl-C,
   `143` for `SIGTERM`; a second signal does not stop the restore. A script
   that traps the signal and exits `0` does not hide it.
   A file that changed after Atlas wrote it is not overwritten: the journal
   stays, and the error names the file and the journal, which keeps every
   original. Restore that file from Git (its `HEAD` content) and the next
   `atlas apply` finishes the restore; delete the journal to keep the files
   as they are;
6. the structural checks read the scan after the write: it scans again,
   internals included, staged beside the dataset, keeping the dataset's
   history, since history covers past commits and apply commits nothing.
   A scan that fails leaves nothing to check against, so it fails the
   write, which is restored. On any failure the staged dataset is
   discarded and the published one is untouched;
7. once every check passes, the staged dataset is swapped in and recorded,
   and the record, if it is still the one it loaded, and the journal are
   deleted.

If only that last swap, or recording it, fails, the change stays written
and verified, the journal stays, and `apply` exits `1`: run `atlas scan`,
which publishes the dataset and then deletes the journal. Until then
`plan`, `apply`, and `check` refuse, and a scan refuses while an apply's
write was interrupted, until `atlas apply` restores it.

A write that rolls back leaves the scan cache holding the written sources'
analysis, so the next scan analyzes the package again and derives the
workspace again, as after any one-file edit.

Each write and restore replaces the file by a rename, so it keeps the
bytes and the mode, but not another user's ownership, extended attributes,
ACLs, or other hard links to the file. A crash can leave a
`<file>.<uuid>.tmp` beside a file; it is safe to delete. The scripts run
again after the write may write what they always write, such as coverage.

| Exit | When |
| --- | --- |
| `0` | A preview printed, or a change written, verified, and scanned |
| `1` | No record, a refusal (a stale dataset included), a rollback (a scan after the write that failed included), an earlier interrupted write restored, or a verified write whose final swap failed |
| `2` | Bad arguments, such as `--write` on another command |
| `130`, `143` | Ctrl-C (`130`) or `SIGTERM` (`143`) stopped the write, and every file it wrote is restored |

A refusal's `kind` says why: `pending-write` (an earlier apply did not
finish), `refused-by-rule`, `not-executable`, or `readiness` (authorizing
again did not authorize it), `authorization-changed` (with the `parts` that
moved), `rollback` (the plan creates or deletes a file, or a file it writes
cannot be restored), `dirty` (with the `files`), `no-git` (with the
`reason`), or `revalidation` (the mutator's fresh analysis found the saved
plan `stale`, `blocked`, or `unsupported`, with its `blockers`). `stale-dataset` (the dataset is not [current](#a-current-dataset), with the
`reason`) refuses before anything runs. `timings`
is `{ baselineMs, afterMs }`: how long the workspace's scripts ran under the
lock before the write, and again after it.

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

With several paths, `atlas export <dir> <path> <path>...` writes the
collection as the server serves it: each workspace's saved dataset, whole,
under `<dir>/data/<workspace id>/`, and `<dir>/data/collection-manifest.json`,
derived from the copied datasets; there is no `<dir>/data/manifest.json`.
`<dir>` must not hold any of the workspaces or overlap any of their state
directories. It holds every workspace's lock while it copies, and refuses
while any of them has an unfinished apply. The viewer cannot show a
collection yet.

To publish from a Git checkout, such as a `gh-pages` branch, export into a
subdirectory of it, or export elsewhere and copy the files in. A static
viewer inside the workspace is allowed; a later scan analyzes its files only
if a package pattern of the workspace covers them.

An export holds the state directory's lock while it copies, as a scan
does, so it fails at once while a scan of the workspace runs, and a scan
fails while it copies. It refuses while an apply is unfinished, since the
dataset may then not describe the sources. An apply holds the lock too, for as long as it
authorizes the plan again, its test and typecheck scripts included, even
for a preview: a scan or export started meanwhile fails at once.

## The server

`serve` binds to `127.0.0.1` on the chosen port and answers `GET` and
`HEAD` only. `/data/<path>` serves `output/<path>` byte for byte with
`Cache-Control: no-store`. Every other path serves the bundled viewer, with
`/` as `index.html`. A path that resolves outside those two directories,
including through a symlink, is `404`. The cache is never served. There is
no API and no directory listing.

For a collection, `/data/collection-manifest.json` is the collection
manifest, derived from the saved datasets at each request, and
`/data/<workspace id>/<path>` serves that workspace's `output/<path>`. Any
other path under `/data/`, an unknown workspace id included, is `404`.
While a workspace's dataset cannot be read, such as while a scan swaps it,
the collection manifest is `503` with `Retry-After: 1` and a message
naming the workspace. The viewer does not read a collection yet: it shows
that no dataset was found.

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
