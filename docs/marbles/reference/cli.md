---
title: CLI reference
description: Commands, flags, and dashboard keys for running and inspecting Marbles.
---

These commands use the standalone `marbles` executable. See
[Installation](/marbles/get-started/installation) to set it up in your environment.

A launch uses the bundled [Workflows runtime](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md)
and local persistent stores. `roll` creates a new run; it does not resume a
previous failed run. The worker hosting a workspace adopts parked work under
the [durability rules](/marbles/foundation/durability#recovery-after-a-restart).

One Marbles process per state root, which is one per machine by default,
hosts every attached workspace, each in a worker of its own, and keeps
their triggers running after the command that attached them exits.
`marbles`, `marbles run`, and `marbles roll` start it when none runs, and
replace one that runs another Marbles version; `marbles stop` ends it.
`--dry-run` is the exception: it hosts the workspace in the calling
process, persists nothing, and never touches the Marbles process.

## Commands

| Command | Action |
| --- | --- |
| No command or `run` | Attach this workspace to the Marbles process, which starts its triggers, and open the splash and live dashboard; Enter enters it. Piped, attach and follow the workspace's status lines until interrupted. |
| `help`, `--help`, `-h` | Print usage without loading modules. |
| `init [developer \| design \| product]` | Create a starter module in `.foundry/marbles`, without running it or overwriting it. Defaults to Product. |
| `list` | Load modules and list named work, schedules, and monitors with their keys and cadence. Runs no step body. |
| `roll <name-or-key> [--input <json>]` | Attach this workspace and dispatch one step, workflow, schedule, or monitor in its worker now; print the lines it logged and its result as JSON, and exit. The workspace stays hosted. |
| `status` | Read the state root: the Marbles process (pid, version, socket) and every workspace with whether it is hosted, its worker's pid, schedules, recent runs, and session count. Reads files only: needs no running process and loads no module. |
| `watch <runId>` | Replay saved output, follow new output, and exit when an agent or workflow run finishes. |
| `sessions` | List the current workspace's agent sessions: id, message count, last update, and whether a compaction summary exists. Loads no module. |
| `daemon` | Run the Marbles process in the foreground until interrupted, for launchd, systemd, or a terminal you keep open. Refused with the holder's pid when one already runs on this state root. |
| `stop` | Stop the Marbles process, whatever version it runs, and return once it has drained every worker and exited; prints `no Marbles process is running` otherwise. While it stops, it refuses new attaches, reloads, and workspace calls. |
| `attach` | Host this workspace in the Marbles process, starting one when none runs, and exit; it stays hosted and its triggers keep running. |
| `detach` | Stop hosting this workspace: its worker drains and the Marbles process does not start it again at boot. Its state stays; `attach` or `roll` hosts it again. Without a process, clears the record only. Refused when the running process is another Marbles version; `marbles stop` first. |

`run` starts every trigger and takes no name. `marbles run <name>` prints a
pointer to `roll <name>` and exits 1.

Invalid commands, arguments, starters, and harness IDs print a usage error
to stderr and exit 1 before importing modules or touching state.

`list` imports the discovered modules in the calling process; `run` and
`roll` have the workspace's worker import them, or import them here under
`--dry-run`; `help`, `init`, `status`, `sessions`, `watch`, `daemon`, and
`stop` import nothing. Keep module scope to declarations: importing the
file must not do work. Attaching (`run`, `roll`, the dashboard, and the
[MCP server](/marbles/reference/mcp)) records the workspace in
`workspace.json` with `hosted: true`; nothing is recorded under `--dry-run`.

### Watch a background run

The [MCP server](/marbles/reference/mcp) returns a `runId` from both
`dispatch_workflow` and `dispatch_agent`. Wait for either kind of run with:

```sh
marbles watch <runId>
```

`watch` replays earlier output, follows the live stream, prints the result
and terminal status, and exits. It reads across the workspaces under
`--state`; it needs neither the launching process's working directory nor
`--source`. It imports no authoring modules and starts no engine. Multiple
watchers can follow the same run.

Use the same `--state` as the owner when it is customized:

```sh
marbles watch <runId> --state /path/to/state
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

### Choose a roll target

| Target | Input and execution |
| --- | --- |
| Definition name | Run the step or workflow with `--input`, or no input. |
| Schedule key | Use its configured input unless overridden, take its lock, and record schedule history. |
| Monitor key | Poll once; run the handler if the observation changed. A returned locked node launches its target. |

Use the keys printed by `list`. Schedule keys derive from the target and
input; monitor keys derive from the source. The first monitor poll treats
existing files or the first HTTP response as a change.

`roll` runs in the workspace's worker: the lines the run printed come back
with the value and are printed before it. The first `roll` on a workspace
attaches it, so its schedules and monitors keep ticking in the Marbles
process after the command exits; `marbles stop` ends that. A tick takes
`locks/schedule:<key>`, so a `roll` of a key the worker's own tick holds at
that moment prints `skipped: held by <holder>`. Under `--dry-run` the roll
runs in this process, persists nothing, and stops when a `.env.schema`
value does not resolve; the worker warns and continues instead.

### Input errors and questions

Input the definition rejects is reported in one line on stderr, with exit
code 1: what failed, the fields the definition takes, an `--input` to start
from, and the schedule keys that carry input for it:

```text
marbles: "greet" input: name: Invalid input: expected string, received undefined. greet takes name (text). Pass --input '{"name":"…"}', or roll a schedule key that carries it: greet-88bab6d8.
```

`--input` that is not JSON is a usage error naming the flag.

`roll` itself cannot answer a question. Through the Marbles process a run
that reaches `ask.approval` or `ask.question` parks with its question open
on the Feed, and `roll` waits until a dashboard answers it; Ctrl+C leaves
the run parked. Under `--dry-run` nobody can answer: the run is cancelled at
the ask, the CLI prints
`marbles: run "<name>" was cancelled: "<title>" is waiting for an answer`
and exits 1, and everything before the ask ran. Launch such runs from the
dashboard, where the question can be answered as it comes.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--source <path>` | `./.foundry/marbles` | Authoring folder or single module. Missing sources offer setup in the dashboard; other commands use an empty catalog. A workspace root is hosted from one source: attaching another under a hosted root is refused until that workspace is detached. |
| `--config <path>` | Same as `--source` | Compatibility alias. A legacy `marbles.config.ts` is used when the default folder is absent. |
| `--state <dir>` | `~/.foundry/marbles` | Root directory for the Marbles process's files and every workspace's state. Each root has its own process. |
| `--artifacts <dir>` | `~/.foundry/artifacts`, or `artifacts/` beside a custom `--state` | Shared artifact store holding declared artifacts and feed entries from every workspace. Fixed when the Marbles process starts: a command naming another store than the running process's is refused with both paths; `marbles stop` first to change it. |
| `--input <json>` | A schedule's input, or none | Input for `roll`. Overrides a schedule's recorded input. |
| `--harness <id>` | Every detected harness | Keep only `claude-code`, `codex`, or `pi`. Repeat to keep more than one. Fixed when the Marbles process starts: applies to a process this command starts, to `list`, and under `--dry-run`. |
| `--dry-run` | Off | Host the workspace in this process, echo agent turns, git mutations, and sandbox commands instead of running them, and write no state. Never touches the Marbles process. See [safety and limits](/marbles/reference/safety). |

`FOUNDRY_HOME` moves the whole home (default `~/.foundry`): the state root,
the artifact store, and the process socket under it. `--state` and
`--artifacts` each move one location and win over it. Workers inherit the
environment of the Marbles process, not of the command that attached them.

Agents can select any retained harness through `provider`. Without one,
Claude Code takes precedence over Codex. Dry execution echoes allowed
harnesses even when neither CLI is installed.

`--dry` is an alias for `--dry-run`. A later occurrence of a value flag wins.

## The dashboard

With a terminal on both stdin and stdout, `marbles` attaches the workspace
to the Marbles process and opens the dashboard on it. The header shows the
workspace's state in the process (`ready`, `reloading`, or `failed` with the
error), as `<position>/<count> · <state>` when the process hosts more than
one workspace. The Dashboard tab shows Triggers, Marbles, and Runs,
including live steps and saved run history. The Feed tab lists reports and
questions from every workspace, newest first. Each tab shows its count,
capped at 99+.

A workspace without a source offers setup: choosing a starter writes it,
attaches the workspace, and the worker posts a setup milestone to the Feed.

| Key | Action |
| --- | --- |
| Shift+D / Shift+F | Show the Dashboard or Feed tab |
| 1 / 2 / 3, Tab, `m` | Focus Triggers, Marbles, or Runs |
| ↑ / ↓, Enter, Esc | Select rows, open details, return |
| ← / →, Space | Collapse or expand run branches; change inspector tab |
| `l` in Marbles | Launch the selected step or workflow; a schema opens a form (Tab moves, Ctrl+Enter submits, Esc cancels) |
| `f` in Marbles | Filter runs to this schedule, monitor, workflow, or step; `x` clears |
| `s` / `p` / `k` on a run | Steer the running agent, pause or resume the step, cancel the run. Each shows only when the run's status allows it: steer and pause while running, resume while paused, cancel until the run settles |
| `a` / `e`, `b` | Jump to the active step or failure; return from step details to the run |
| `/` | Search the focused marble or run list |
| `f` in logs | Toggle following new log lines |
| `w` on the Dashboard | Show the next workspace the Marbles process hosts; offered only when it hosts more than one |
| `w` / `x` in the Feed | Cycle the workspace filter (all workspaces, this workspace, then any other that has posted); show every workspace |
| 1 through 9 / `a` in the Feed | Answer an open question by choice, or type a free-text answer. An approval takes an optional note after the choice |
| `h` | Return to the dashboard |
| `?` | Keyboard help |
| `q` / Ctrl+C | Confirm quit; Ctrl+C again quits. Quitting detaches: triggers keep running in the Marbles process |

### Pause, resume, and steer

Pause parks the selected step and everything under it. Resume, with or
without a prompt, replays the parked bodies from the top; a prompt leads the
first turn of the agent session each step had open. Steer hands a prompt to
the agent turn running in the step; the turn stops, the prompt becomes the
next message, and the step's `generate` resolves with the steered reply. A
live run's stream does not cross the process socket, so the run inspector's
Stream tab is empty for a hosted workspace; `marbles watch <runId>` follows
the run's output instead. Under `--dry-run` the run is in this process and
the tab shows its stream, with `[steer]` and `[resume]` markers inline.

### Quit, stop, and source edits

Quitting the dashboard detaches it, as the quit dialog says. The Marbles
process keeps hosting the workspace: triggers keep firing, running steps
continue, and a run parked on a question waits on the Feed for the next
dashboard. `marbles stop` ends the process and every workspace it hosts,
draining running work first (30 seconds, then the worker is killed), and
returns once the process has exited. A run
parked on a question or a pause survives a stop and is adopted when its
workspace is hosted again, as long as the step is still registered.

Source edits need no restart. The worker polls its authoring folder, helper
modules included, every second; a change drains the worker (running runs
finish, parked runs stay) and starts a fresh one, and the header shows
`reloading` meanwhile. A source that throws when imported fails only its
worker: the header shows `failed` with the error, and the Marbles process
goes on hosting everything else. Nothing restarts a failed worker on its
own, and no source watcher runs for it: after fixing the module, open
`marbles` (or run `roll`) again, which attaches the workspace and starts
a fresh worker. The same goes for a worker that crashes mid-run.

Under `--dry-run` the workspace runs in the dashboard's own process, so
quitting stops triggers and cancels queued and running runs; nothing is
written, so parked runs are cancelled too. Custom code in a step body must
honour the context's `signal` to stop external work; cancellation cannot
undo side effects.

### Headless operation

When stdin or stdout is not a terminal, `marbles` and `marbles run` attach
the workspace to the Marbles process, starting one when none runs, print
`[process] pid N hosts <root> (<id>); Ctrl+C detaches and leaves it running`,
and then print the workspace's status lines and state changes as they
happen. SIGINT and SIGTERM detach: the process keeps hosting the workspace
and its triggers keep running, so a script that only needs them started can
exit at once, and `marbles stop` is what stops them. Under `--dry-run` the
same command ticks the triggers in this process instead, and SIGINT or
SIGTERM stops new triggers and lets active runs finish.

A Marbles process a client starts runs detached and logs to
`<state>/daemon.log`; `marbles daemon` runs it in the foreground, printing
the same lines, which is the form to give launchd, systemd, or a terminal
you keep open. Either way it claims `locks/process` at the
[state root](/marbles/reference/state), and a second one is refused with the
holder's pid. A client that finds a process of another Marbles version stops
it and starts one of its own. `status` reads files only: a terminal opens a
view that `q` closes; piped output is plain text, starting with
`marbles process: pid N · vX · <socket>` or `marbles process: not running`,
then each workspace with `hosted: yes|no` and `process: pid N (worker)` or
`not running`.

`marbles --harness pi` selects Pi when its CLI is installed, for the Marbles
process it starts or under `--dry-run`; setup also offers Pi. Host model
calls use `ai-sdk-provider-pi` 0.1.0, which embeds Pi 0.52.12,
with read-only tools by default. Configure its credentials through Pi's auth
storage or provider API-key environment variables.
Sandbox sessions install the pinned standalone Pi binary for the guest's
architecture, verify its SHA-256, and use Marbles' permission-controlled coding
tools. Supply a session API key or sign in with Pi on the host for the selected
`provider/model`; the host resolves the current key, and only that key enters
the guest environment. Refresh credentials remain on the host.
