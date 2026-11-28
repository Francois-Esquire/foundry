---
title: CLI reference
description: Commands, flags, and dashboard keys for running and inspecting Marbles.
---

These commands use the standalone `marbles` executable. See
[Installation](/marbles/get-started/installation) to set it up in your environment.

A run uses the bundled [Workflows runtime](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md)
and local persistent stores. `run` creates a new run, and so does
`enqueue` unless its `--key` matches an earlier run; neither resumes a
previous failed run. The engine generation hosting a workspace resumes
suspended work under the
[durability rules](/marbles/concepts/durability#recovery-after-a-restart).

One Marbles process per state root, which is one per machine by default,
hosts every attached workspace in one engine subprocess, its current
generation, and keeps their triggers running after the command that
attached them exits.
`marbles`, `marbles run`, and `marbles enqueue` start it when none runs,
and replace one that runs another Marbles version; `marbles daemon stop`
ends it. `--dry-run` is the exception: it hosts the workspace in the calling
process, persists nothing, and never touches the Marbles process.
`marbles mcp --dry-run` hosts nothing.

## Commands

`marbles help` groups the commands as below. A command name Marbles does
not know is a usage error, and one that has moved names its new spelling,
as in `unknown command "stop"; stop is now marbles daemon stop`.

### Core

| Command | Action |
| --- | --- |
| `marbles` | Attach this workspace to the Marbles process, which starts its triggers, and open the splash and live dashboard; Enter enters it. Piped (`marbles </dev/null`), attach and follow the workspace's status lines until interrupted. |
| `init [developer \| design \| product]` | Create a starter module in `.foundry/marbles`, without running it or overwriting it. Defaults to Product. |
| `list` | Load modules and list named steps and workflows, schedules and monitors with their keys and cadence, and declared observers with their source and fact types. Runs no step body. |
| `run <name-or-key> [--input <json>]` | Attach this workspace and run one step, workflow, schedule, or monitor in the current engine generation now; wait for it, print the lines it logged and its result as JSON, and exit. The workspace stays hosted. `run` takes exactly one name; with none it is a usage error that points to `marbles` for the dashboard. |
| `enqueue <name> [--input <json>] [--key <key>]` | Attach this workspace, put one step or workflow on its queue in the Marbles process, and exit at once without waiting for the run. The run ID is the only line on stdout; stderr gets `[enqueue] <name> <status> <runId>; marbles watch <runId> follows it`. `--key` enqueues the definition once per key. A schedule or monitor key is not enqueued; `run` takes those. |
| `watch <runId>` | Replay saved output, follow new output, and exit when an agent or workflow run finishes. A run still waiting in its queue is waited for. |
| `tasks <action> [--json]` | Read or change this workspace's tasks: `list`, `ready`, `get`, `deps`, `create`, `update`, `start`, `complete`, `cancel`, `reopen`, `move`, `depend`, `undepend`, or `change --input <json>` for one atomic batch. `marbles help` lists each action's options. `create` and `update` take `--metadata <json>`; on update each key is set over the stored metadata and a `null` value removes its key. A `__proto__` key at any depth is refused. The Marbles process, when it already hosts the workspace, answers; otherwise the command opens the tasks itself. Loads no module and never starts the Marbles process. |
| `status` | Read the state root: the Marbles process (pid, version, socket) and every workspace with whether it is hosted, the pid of the engine generation hosting it, the live generations, schedules, recent runs with their top-level steps (a run shared from another workspace says so), and how many sessions and artifacts it shows. Reads files only: needs no running process and loads no module. |
| `help`, `--help`, `-h` | Print usage without loading modules. |

### Resources

Each kind of resource has its own command, and `list` is its default
action: `marbles runs` and `marbles runs list` are the same.

| Command | Action |
| --- | --- |
| `runs [list] [--all]` | List the workflow runs this workspace shows, its own and those shared with it, newest first, each with its steps indented under it. `--all` lists every workspace's. Loads no module. |
| `sessions [list] [--all]` | List the agent sessions this workspace shows: id, message count, last update, and whether a compaction summary exists. `--all` lists every workspace's. Loads no module. |
| `artifacts [list] [--all]`, `sandboxes [list] [--all]` | List the artifacts (id, name, type, status, last update) or sandbox containers (id, status, creation) this workspace shows; `--all` lists every workspace's. A resource another workspace owns ends with `from <id>`, and one shared beyond the workspace listing it with `shared with <ids>`. Loads no module. |
| `runs share <id> <dir>`, `sessions share <id> <dir>`, `artifacts share <id> <dir>` | Show one resource this workspace shows in the registered workspace at `<dir>` as well. Changes no resource; sharing an artifact relinks the other workspace. A sandbox container stays with the workspace that started it, so `sandboxes` only lists: `sandboxes share` is a usage error that says `sandboxes are not shared with other workspaces`. |
| `runs unshare <id> <dir>`, `sessions unshare <id> <dir>`, `artifacts unshare <id> <dir>` | Stop showing the resource in the workspace at `<dir>`. The resource stays with the workspace that owns it, which it always belongs to. |
| `artifacts relink [--all]` | Make this workspace's links under `<root>/.marbles/` match the Marbles database: each file of an artifact it shows whose bytes one blob file holds is a link at `.marbles/artifacts/<id>/<path>`, or `.marbles/artifacts/@<owner>/<id>/<path>` for another workspace's. Links Marbles made that should not be there are removed; anything else is left and reported, and a directory on the way that is a link or a file refuses what is under it. `--all` relinks every registered workspace. Once a workspace has links, artifact writes keep them current; `artifacts relink` repairs what a reported failure left. |

### System

| Command | Action |
| --- | --- |
| `mcp` | Serve this workspace to an MCP client over stdin and stdout; stdout carries only MCP messages. Never starts the Marbles process or attaches the workspace: task tools work without one, and dispatch tools need a process that hosts the workspace. Under `--dry-run` it hosts nothing, keeps its tasks in memory, and refuses the dispatch tools. See [the MCP server](/marbles/reference/mcp). |
| `daemon [start]` | Run the Marbles process in the foreground until interrupted, for launchd, systemd, or a terminal you keep open. `marbles daemon` alone is `daemon start`. Refused with the holder's pid when one already runs on this state root. |
| `daemon stop` | Stop the Marbles process, whatever version it runs, and return once it has drained every engine generation and exited; prints `no Marbles process is running` otherwise. While it stops, it refuses new attaches, reloads, and calls that would start work (`run`, `enqueue`, launches, dispatches, resumes); reads, answers, and cancels still go through, so a run holding up the drain can be cut short. Prints `stopping Marbles process pid N; waiting for its engine generations to drain` first, then `stopped Marbles process pid N`. |
| `daemon attach` | Host this workspace in the Marbles process, starting one when none runs, and exit; it stays hosted and its triggers keep running. |
| `daemon detach` | Stop hosting this workspace: its running work drains and the Marbles process does not start it again at boot. Its state stays; `daemon attach`, `run`, or `enqueue` hosts it again. Without a process, clears the record only. Refused when the running process is another Marbles version; `marbles daemon stop` first. |
| `theme` | Print the saved terminal theme. |
| `theme list` | List the terminal theme names. |
| `theme <name>` | Save a theme for every workspace. An unknown name is a usage error: `unknown theme "<name>"; marbles theme list shows them`. |

Invalid commands, arguments, starters, and harness IDs print a usage error
to stderr and exit 1 before importing modules or touching state.

`list` imports the discovered modules in the calling process; the
dashboard, `run`, `enqueue`, and `daemon attach` have the Marbles process's
engine generation import them, or import them here under `--dry-run`;
`help`, `init`, `status`, `theme`, the resource commands, `tasks`, `watch`,
`mcp`, and the other `daemon` actions import nothing here. Keep module scope to declarations: importing
the file must not do work. Attaching (the dashboard, `run`, `enqueue`, and
`daemon attach`) records the workspace in the Marbles database with
`hosted: true`; nothing is recorded under `--dry-run`. The
[MCP server](/marbles/reference/mcp) never attaches.

### Enqueue and watch a background run

`marbles enqueue`, and the [MCP server](/marbles/reference/mcp)'s
`enqueue_workflow` and `dispatch_agent`, return a run ID without waiting
for the run. Keep the ID from `enqueue`'s stdout and wait for the run with
`watch`:

```sh
id=$(marbles enqueue pre-push)
marbles watch "$id"
```

`--key` enqueues the definition at most once per key. It is the same key
a definition's own `enqueue(input, { key })` and
`step.enqueue(name, input, { key })` match, so a later enqueue with the same
name and key prints the first run's ID, whatever became of that run. A
blank key, or a flag where its value should be, is a usage error. A name
the workspace declares no step or workflow for fails with `no workflow or
step named "<name>"`. `enqueue` refuses `--dry-run`, since a dry run has no
queue to leave the run on; `marbles run <name> --dry-run` runs it here
instead.

`watch` replays earlier output, follows the live stream, prints the result
and terminal status, and exits. A run still waiting in its queue has no
output yet: `watch` prints `[run] <runId> waits in its queue` and waits for
it to start. If the process that queued it is gone and no other holds it,
`watch` fails with `run "<runId>" waits in its queue, but the process that
queued it is gone and no other holds it`. `watch` reads across the
workspaces under the Foundry home; it needs neither the enqueuing process's
working directory nor `--source`. It imports no authoring modules and
starts no engine. Multiple watchers can follow the same run.

Use the same `FOUNDRY_ROOT` as the owner when it is moved:

```sh
FOUNDRY_ROOT=/path/to/home marbles watch <runId>
```

Exit codes are 0 for completion, 1 for failure, cancellation, missing output,
or a lost owner, and 130 when the watcher is interrupted. Stopping the
watcher does not cancel the run. Use the MCP `cancel_run` tool, or `k` on
the run in the dashboard, to cancel it.

The [output journal](/marbles/reference/state#run-output) includes agent
text, workflow `stream.write` and `exec` output, and step lifecycle messages.
Raw `console.log` and process stdout remain with the owning process.
Completed journals can be replayed after the owner exits. Runs from before
this feature, and in-memory `--dry-run` runs, have no journal to watch.

### Choose a run target

| Target | Input and execution |
| --- | --- |
| Definition name | Run the step or workflow with `--input`, or no input. `enqueue` takes only this target. |
| Schedule key | Use its configured input unless overridden, take its lock, and record schedule history. |
| Monitor key | Poll once; run the handler if the observation changed. A returned locked node starts its target. |

Use the keys printed by `list`. Schedule keys derive from the target and
input; monitor keys derive from the source unless `.name(key)` sets one.

`list` prints one line per entry, in this order:

```text
[source] /path/to/project/.foundry/marbles
[step] check-task
[workflow] pre-push
[schedule] nightly-checks → nightly-checks daily at 02:00
[monitor] source files src/**/*.ts every 1m
[observer] dispatchChecks ← tasks
[observer] flagFailures ← runs run.failed
```

An observer line is `[observer] <name> ← <source>`, followed by the fact
types it asked for, if any. The `workflow` source reads `runs`. Observers
are listed, not run: `run` takes a definition name or a trigger key. The
first monitor poll treats existing files or the first HTTP response as a
change.

`run` runs in the current engine generation: the lines the run printed come
back with the value and are printed before it. The first `run` or `enqueue`
on a workspace attaches it, so its schedules and monitors keep running in
the Marbles process after the command exits; `marbles daemon stop` ends
that. A `run` launches the schedule's target at once, alongside any
occurrence of it under way, and records no occurrence. Under `--dry-run`
the run happens in this process and persists nothing.

### Input errors and questions

Input the definition rejects is reported in one line on stderr, with exit
code 1: what failed, the fields the definition takes, an `--input` to start
from, and the schedule keys that carry input for it:

```text
marbles: "greet" input: name: Invalid input: expected string, received undefined. greet takes name (text). Pass --input '{"name":"…"}', or run a schedule key that carries it: greet-88bab6d8.
```

`--input` that is not JSON is a usage error naming the flag.

`run` itself cannot answer a question. Through the Marbles process a run
that reaches `ask.approval` or `ask.question` suspends with its question open
on the Feed, and `run` waits until a dashboard answers it; Ctrl+C leaves
the run suspended. A run `enqueue` queued suspends the same way. Under
`--dry-run` nobody can answer: the run is cancelled at the ask, the CLI
prints `marbles: run "<name>" was cancelled: "<title>" is waiting for an
answer` and exits 1, and everything before the ask ran. Launch such runs
from the dashboard, where the question can be answered as it comes.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--source <path>` | `./.foundry/marbles` | Authoring folder or single module. Missing sources offer setup in the dashboard; other commands use an empty catalog. A workspace root is hosted from one source: attaching another under a hosted root is refused until that workspace is detached. |
| `--input <json>` | A schedule's input, or none | Input for `run` and `enqueue`, or the batch for `tasks change`. Overrides a schedule's recorded input. |
| `--key <key>` | None | For `enqueue` only: enqueue the definition at most once per key. |
| `--dry-run` | Off | Host the workspace in this process, echo agent turns, git mutations, and sandbox commands instead of running them, and write no state: reading the Marbles database may create or update its SQLite side files (`marbles.db-shm`, `marbles.db-wal`), and nothing else is written. Never touches the Marbles process. `mcp` hosts nothing under it. `enqueue`, `init`, every `daemon` action, `theme <name>`, `artifacts relink`, and `share` and `unshare` under any resource refuse it before anything is opened or written. See [safety and limits](/marbles/reference/safety). |
| `--recheck-providers` | Off | Show provider discovery again when opening the live dashboard in a terminal. Keeps any existing provider configuration. Only `marbles` with no command takes it, and not under `--dry-run`: anywhere else it fails with `--recheck-providers requires a live dashboard`. |

`FOUNDRY_ROOT` moves the whole home (default `~/.foundry`): the state root,
the Marbles database, the artifact store, the process socket, and the
process recovery records (`processes/`) under it.
Nothing moves on its own, and no flag moves it. Each home has its own
Marbles process. Workers inherit the environment of the Marbles process,
not of the command that attached them.

Agents can select any retained harness through `provider`. Without one,
Claude Code takes precedence over Codex. Dry execution echoes allowed
harnesses even when neither CLI is installed.

A later occurrence of a value flag wins. A flag Marbles does not know is
refused, naming it, and so is a value flag with no value. `--source`,
`--input`, and `--key` also refuse a value that is itself a flag, so
`marbles --source --dry-run` fails instead of opening a live dashboard. The value of
a task option is taken as written: `tasks create "Fix" --description "--help"`
creates a task whose description is `--help`. `--dry-run`, `--help`, `-h`, and
`--recheck-providers` are read only where a flag can stand, never as another
flag's value.

## The dashboard

With a terminal on both stdin and stdout, `marbles` attaches the workspace
to the Marbles process and opens the dashboard on it. The workspace name
opens the picker, where you can see other workspaces and their states. A
workspace that is starting, reloading, or failed shows that state in the
header.

- **Dashboard** puts active runs, runs that need attention, success rate, and
  tracked spend above upcoming work, run history, and recent activity.
  The workflow rankings use known USD costs for the current workspace and
  sum elapsed time for finished runs with recorded start and end times.
  Rankings cover workflows in the current catalog. When there is room for
  a comparison, the bars show each value relative to the highest ranked
  workflow, alongside the cost or duration. `u` opens the full usage
  breakdown, including agent usage and records with unknown prices.
- **Catalog** lists the current workspace's triggers, workflows, and steps.
  On a wide terminal, inspecting a schedule or definition keeps the list
  in view alongside its detail frame.
- **Feed** shows reports and questions for the current workspace and those
  shared with it. You can widen it to all workspaces.

Open **Diagnostics** from the left for workspace logs, or press `d` from a
run inspector to filter to that run. **Settings** opens from the right.
Each focused frame shows its own shortcuts along its border. The bottom
bar holds shortcuts for the whole terminal.

Usage is recorded once per agent turn inside a run, from the token counts the
harness reports. A cost is estimated at the list price the model's catalog
row states, when a server or the configuration gave one, else at the
models.dev list price for it, and keeps that price with the turn; `~` marks
an estimate. Marbles fetches models.dev when an engine starts, keeps it once
it loads, and never waits for it. A fetch that fails is tried again while the
engine runs: after 30 s, then twice as long each time, up to 10 minutes.

Claude Code reports `total_cost_usd`, a running total for its CLI session.
Marbles records it only for a turn that made one model call and resumed no
session: in practice the first turn each time Marbles opens a Claude Code
session on this machine, when the provider's settings name no `resume`,
`continue`, `sessionId` or `extraArgs`. Every later turn resumes the CLI
session, so its figure may include earlier turns; that turn is priced from
its tokens like any other, or its cost stays unknown. A turn in a sandbox never gets the figure. The
CLI computes it from its own price table, so it is stored as Claude Code's
own figure and shown as an estimate (`~`). On an API key it estimates what
the API bills. On a subscription nothing is billed per token, so it is what
the work would cost at API prices.

A turn without a price is counted as unpriced, never as zero, and a run
with no recorded turns shows "no usage recorded". A step's total includes
its descendants' turns once.

A committed turn whose usage was not saved is found again in its session
transcript: its tokens count, its cost is unknown, and the total says "not
recorded". It is attributed to a run only when a saved marker or the run's
file names that turn, and to the turns outside runs only when a saved marker
says so. Where a session was opened does not prove whose its later turns
are: another run or the host may continue it, and a run still running in
another process is not visible to this one. So such a turn is an
unattributed turn, counted in the workspace total and noted ("may be
incomplete") on outside runs, every workflow, and each run that was running
when it finished. A delegated child session's turn is found the same way:
its parent's turn reports only its own tokens. A transcript that is missing
or cannot be read is noted as an unreadable usage record on every total,
whoever named its session: any run or the host may have taken the turns it
lost. So is a workspace whose
sessions cannot be listed. A settled run's file that cannot be read is noted on
that run and its workflow.

On first setup, the live dashboard shows the workspace path and any detected
model providers. You can use the detected providers across workspaces or skip
this step. A machine with providers already configured goes straight to
workspace setup unless another installed adapter is detected.

In workspace setup, you can load existing Marbles source, create a starter, or
skip starter creation and open an empty dashboard. Creating a starter attaches
the workspace and posts a setup milestone to the Feed. Restart Marbles after
installing another adapter to review the newly detected provider.

| Key | Action |
| --- | --- |
| Shift+D / C / F | Show Dashboard, Catalog, or Feed |
| `d` / Shift+L, Shift+S | Open Diagnostics or Settings. From a run inspector, `d` opens that run's logs. Shift+L opens logs across runs. Esc closes the panel |
| `r` on a schedule | Run the selected schedule now |
| `v` in trigger details | Show or hide its configuration when available |
| 1 / 2 / 3, Tab, `m` | Focus Triggers, Marbles, or Runs |
| ↑ / ↓, Enter, Esc | Select rows, open details, return |
| ← / →, Space | Collapse or expand run branches; change inspector tab |
| `l` in Marbles | Launch the selected step or workflow; a schema opens a form (Tab moves, Ctrl+Enter submits, Esc cancels) |
| `f` in Marbles | Filter runs to this schedule, monitor, workflow, or step; `x` clears |
| `s` / `p` / `k` on a run | Steer the agent turn or type a line into the command live in the selected step (Tab picks among several), pause or resume the step, cancel the run. Each shows only when it applies: `s` while something in the step takes input, pause while running, resume while paused, cancel until the run settles |
| `i` on a run | Open the Feed on the question or approval the selected step waits for |
| `p` / `k` on a trigger an agent created | Pause or resume the trigger; delete it |
| `u` on Dashboard | Show every workflow's and agent's usage; Esc or `u` closes it |
| `a` / `e`, `b` | Jump to the active step or failure; return from step details to the run |
| `/` | Search the focused marble or run list. The selection stays on a row the search shows: the first match when the selected row is filtered out |
| `f` in a run's logs | Toggle following new log lines |
| ↑ / ↓, Enter in Logs | Select a line (stops following); open the run and step it came from |
| `f` / `v` / `o` / `/` / `x` in Logs | Follow new lines; raise the minimum level; cycle all, run, or Marbles lines; search; clear the filters |
| ↑ / ↓ or ← / → in Settings | Browse and apply themes |
| `w` | Open the workspace picker. ↑ and ↓ select a workspace, and Enter switches to it |
| `g` on Dashboard or Catalog | Show every workspace's runs and triggers, or this workspace's again (its own and those shared with it); offered once another workspace has any. Another workspace's runs and triggers are read only here: no control acts on them |
| Shift+W / `x` in the Feed | Cycle the workspace filter (all workspaces, this workspace and what is shared with it, then any other that has posted); show every workspace. Another workspace's questions are answered where they were posted |
| 1 through 9 / `a` in the Feed | Answer an open question by choice, or type a free-text answer. An approval takes an optional note after the choice. The answer stays with the question it was started for: newer entries do not move the selection, and choosing another entry drops the draft |
| `h` | Return to the Dashboard or Catalog list with focus |
| `?` | Keyboard help |
| `q` / Ctrl+C | Confirm quit; Ctrl+C again quits. Quitting detaches: triggers keep running in the Marbles process |

Letter keys act only with no Ctrl or Meta held; Shift+letter shortcuts are
unaffected. A click on a tab, the footer, the workspace rail, the workspace
name, or a launch or run-now button in details acts only when its key
would. While a prompt, an answer, a search, help, the workspace picker or the
quit dialog has the keys, those clicks do nothing and the keys stay where
they were; clicking marbles goes home whenever `h` does. A steer or resume
prompt closes once its message is sent; if it cannot be sent, the prompt stays
open with its text. When a refresh hides the selected row, as when a renamed
marble or a run's new status no longer matches the search, the selection
moves to the first row still shown.

### Settings and local diagnostics

Settings are global: `settings.json` at the state root
(`~/.foundry/marbles/settings.json`, under `FOUNDRY_ROOT` when set). A missing
file or key uses the default theme, `dark`. A value Marbles does not know, or
a file it cannot read, falls back to the default and is named in the Settings
panel; Marbles does not overwrite a file it cannot read. Saving keeps keys it
does not know. Under `--dry-run` the Settings panel is read-only, and
`marbles theme <name>` is refused with a usage error.

Settings includes a scrollable picker for the bundled
[termCN OpenTUI themes](https://www.termcn.dev/docs/theming/opentui) and
the original `dark` and `light` palettes. The bundled `default` theme is a termCN palette. Marbles starts with `dark` when no preference is saved. Use
`marbles theme list` to list the theme names, `marbles theme` to see the
saved theme, or `marbles theme opencode` to change it from the command line. Reopen an existing dashboard to pick up a CLI change.
On wide terminals, Shift+W in Settings toggles the workspace rail for the
current terminal.

Marbles measures its own work locally and sends nothing anywhere. Run records
and each agent turn's tokens, duration, model, and cost are kept in the
Marbles database at the state root, one usage fact per turn, filed under its
run or, for a turn taken outside a run, its session; step logs stay under the
workspace's state directory.
Marbles' own status lines are kept in memory for the session, up to 500.

Catalog cost and token totals cover runs started from the selected definition.
Child invocations inside another workflow count under that run's step details;
the Catalog does not aggregate every invocation of a reusable step definition.

### Pause, resume, and steer

Pause suspends the selected step and everything under it. Resume, with or
without a prompt, replays the suspended bodies from the top; a prompt leads the
first turn of the agent session each step had open. Steer hands a prompt to
the agent turn running in the step; the turn stops, the prompt becomes the
next message, and the step's `generate` resolves with the steered reply.

Each agent turn and each `exec` command a step starts shows in the run
inspector under "Live now", with the step that owns it, until it ends.
Nothing in the workflow names it. Each row starts with the `#` identifier it
got when it started, then the agent, its model and session, or the command
and its process id; the prompt `s` opens names the same identifier. `s`
addresses that one, so a prompt never reaches a later turn, a retried
attempt, or another step. A step holding more than one asks which with Tab.
After a reload the run stays on the engine generation that started it, and
its live work is still listed and takes input there. Steering an
agent stops its turn and sends the prompt as the next message. A command on
the host takes a line on its standard input: it is a pipe, not a terminal, so
a program that reads from the terminal itself, or waits for end of input,
cannot be answered this way. Marbles cannot tell whether a command is waiting
to read. Typed lines are not written to the run's output, only a
`[stdin] sent a line` marker. A command in a sandbox shows as output only.
Questions and approvals an agent asks show as waiting on its row, a
question from a child session it delegated to on the row of the turn that
delegated it; `i` opens them in the Feed. Leaving the Stream tab or the
dashboard does not stop anything. For a hosted workspace the Stream tab
follows the run's saved output, as `marbles watch <runId>` does, filtered to
the selected step; under `--dry-run` the run is in this process and the tab
shows its stream directly. Either way `[steer]` and `[resume]` markers show
inline.

### Quit, stop, and source edits

Quitting the dashboard detaches it, as the quit dialog says. The Marbles
process keeps hosting the workspace: triggers keep firing, running steps
continue, and a run suspended on a question waits on the Feed for the next
dashboard. `marbles daemon stop` ends the process and every workspace it hosts,
draining running work first (30 seconds for each engine generation to
answer and as long again to exit, then it and its process group are
killed, once its pid is proved to be the process the daemon spawned), and
returns once the process has exited. A run
suspended on a question or a pause survives a stop and resumes once it is
answered after its workspace is hosted again, as long as the step is still
registered. When
`daemon detach` removes the last workspace while a dashboard is open, the dashboard
shows that workspace stopped and follows none until one is attached again.

Source edits need no restart. The Marbles process polls a fingerprint of
what its current engine generation loaded every second, taken before that
generation loaded: every file under each workspace's root (but
`node_modules`, `.git`, `.marbles` and build output), whether a load read
it or not, every module and data file a load or a run read outside it, as
it was when read, and the Marbles installation itself. Contents are read
again only for a file whose size or modification time changed. A change starts the next
generation, and the header shows `reloading` meanwhile. It loads every
registered workspace first; one that does not load, a source that throws
when imported, is an error on that workspace (the header keeps `ready`
and shows it), and the running generation carries on as it was until a
later edit loads. Once the next generation has loaded, it takes over at
once: triggers carry on by their key, queued and suspended runs move to it,
and the previous generation starts nothing new, finishes its running runs,
whole, and exits. A run of it that suspends on a question meanwhile moves to
the current generation at once, which answers it. A generation that
crashes is replaced on its own, after a pause that doubles from 1 second
up to 30 while replacements keep failing, and its runs are put right by
the next one's start.

Under `--dry-run` the workspace runs in the dashboard's own process, so
quitting stops triggers and cancels queued and running runs; nothing is
written, so suspended runs are cancelled too. Custom code in a step body must
honour the context's `signal` to stop external work; cancellation cannot
undo side effects.

### Headless operation

When stdin or stdout is not a terminal, `marbles` with no command attaches
the workspace to the Marbles process, starting one when none runs, print
`[process] pid N hosts <root> (<id>); Ctrl+C detaches and leaves it running`,
and then print the workspace's status lines and state changes as they
happen. SIGINT and SIGTERM detach: the process keeps hosting the workspace
and its triggers keep running, so a script that only needs them started can
exit at once, and `marbles daemon stop` is what stops them. When the Marbles
process goes first, the command prints why and exits: `the Marbles process
stopped` with exit 0 after a `marbles daemon stop`, or exit 1 with `exited without
stopping; see <state>/daemon.log` when it died, `closed the connection`
when it is up and hung up on this command, or `the connection to the
Marbles process failed: <error>` for a socket failure. Under `--dry-run`
the same command ticks the triggers in this process instead, and SIGINT or
SIGTERM stops new triggers and lets active runs finish.

A Marbles process a client starts runs detached and logs to
`<state>/daemon.log`; `marbles daemon` (or `marbles daemon start`) runs it in the foreground, printing
the same lines, which is the form to give launchd, systemd, or a terminal
you keep open. Either way it claims `locks/process` at the
[state root](/marbles/reference/state), and a second one is refused with the
holder's pid. A client that finds a process of another Marbles version stops
it and starts one of its own. `status` reads files only: a terminal opens a
view in the saved theme that `q` closes; piped output is plain text. Both
start with `marbles process: pid N · vX · <socket>` or
`marbles process: not running`, then an
`engine generation N: pid P · current` line for each live generation
(`retiring` for one finishing its runs, `cannot tell` for one whose process
cannot be proved alive or gone), whether or not the Marbles process is
running, then each workspace with `hosted: yes|no` and
`process: pid N (generation)` or `not running`.

### Pi and gateway providers

Vercel AI Gateway and an OpenAI-compatible gateway are available only to
a workspace whose source defines them, with
[`defineProvider`](/marbles/reference/api#providers):

```ts
import { defineProvider } from "@foundry.sh/marbles/providers";
import { vercel } from "@foundry.sh/marbles/providers/vercel";

defineProvider(vercel);
```

Setup offers Claude Code, Codex and Pi when their adapters are installed
alongside Marbles and their CLIs are on `PATH`. Restart Marbles after adding
an adapter to review it. A saved entry for a provider the workspace does not define stays
saved; the engine prints a `[providers]` line naming the import and the
call that make it available. Provider configuration lives in the Marbles
database; there is no file to edit and no command for it yet, so an entry
setup does not offer is added through the library, `ProviderConfiguration.add` over
`DatabaseProviderStore.forState` (`@foundry.sh/marbles/lib`), for example
`{ "id": "pi", "plugin": "pi", "enabled": true }`. Pi reads the process
environment itself. Host model
calls use `ai-sdk-provider-pi` 0.1.0, which embeds Pi 0.52.12,
with read-only tools by default. Configure its credentials through Pi's auth
storage or provider API-key environment variables.
Sandbox sessions install the pinned standalone Pi binary for the guest's
architecture, verify its SHA-256, and use Marbles' permission-controlled coding
tools. Supply a session API key or sign in with Pi on the host for the selected
`provider/model`; the host resolves the current key, and only that key enters
the guest environment. Refresh credentials remain on the host.

An OpenAI-compatible gateway is configured with the `gateway` plugin, once
the workspace's source calls `defineProvider(gateway)` with `gateway` from
`@foundry.sh/marbles/providers/gateway`, added the same way:
`{ "id": "gw", "plugin": "gateway", "enabled": true, "settings": { "baseURL": "https://gateway.example/v1", "apiKey": "GATEWAY_API_KEY" } }`.
`apiKey` names the environment variable that holds the key, never the key
itself, and the instance is available once that variable is set. Any other
setting is an error. Its models are the ones its server lists at
`GET <baseURL>/models`. Marbles asks when it starts and when the provider
configuration changes. Each listed id is a text model. Name the model, or set the entry's
`defaults`; otherwise the first listed id is used. Its capabilities and limits are unknown,
and its price comes from models.dev when that knows the id. A model the
server does not list is refused. A server that gives no list within 5
seconds, or answers with an error, leaves the gateway with no models. Marbles
prints why in a `[providers]` line, and the other providers still start. When a later
list fails, the gateway keeps the list it had. A streamed turn asks the
gateway for usage, so it records its tokens.
