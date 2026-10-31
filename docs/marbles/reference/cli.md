---
title: CLI reference
description: Commands, flags, and dashboard keys for running and inspecting Marbles.
---

These commands use the standalone `marbles` executable. See
[Installation](/marbles/get-started/installation) to set it up in your environment.

A launch uses the bundled [Workflows runtime](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md)
and local persistent stores. `roll` creates a new run; it does not resume a
previous failed run. The dashboard can adopt parked work under the
[durability rules](/marbles/foundation/durability#recovery-after-a-restart).

## Commands

| Command | Action |
| --- | --- |
| No command or `run` | Open the splash and live dashboard; Enter starts triggers. Piped, start at once. |
| `help`, `--help`, `-h` | Print usage without loading modules. |
| `init [developer \| design \| product]` | Create a starter module in `.foundry/marbles`, without running it or overwriting it. Defaults to Product. |
| `list` | Load modules and list named work, schedules, and monitors with their keys and cadence. Runs no step body. |
| `roll <name-or-key> [--input <json>]` | Dispatch one step, workflow, schedule, or monitor now, print its result as JSON, and exit. |
| `status` | Read every workspace under the state root: foreground process, schedules, recent runs, session count. Needs no running Marbles process and loads no module. |
| `watch <runId>` | Replay saved output, follow new output, and exit when an agent or workflow run finishes. |
| `sessions` | List the current workspace's agent sessions: id, message count, last update, and whether a compaction summary exists. Loads no module. |

`run` starts every trigger and takes no name. `marbles run <name>` prints a
pointer to `roll <name>` and exits 1.

Invalid commands, arguments, starters, and harness IDs print a usage error
to stderr and exit 1 before importing modules or touching state.

`run`, `roll`, and `list` import the discovered modules first;
`help`, `init`, `status`, `sessions`, and `watch` do not. Keep module scope to
declarations: importing the file must not do work. Only commands that run
something under a state root (`run`, `roll`, and the dashboard after Enter)
record the workspace in `workspace.json`, and never under `--dry-run`.

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
watcher does not cancel the run. Use the MCP `cancel_run` tool to cancel
work owned by that server.

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

### Input errors and questions

Input the definition rejects is reported in one line on stderr, with exit
code 1: what failed, the fields the definition takes, an `--input` to start
from, and the schedule keys that carry input for it:

```text
marbles: "greet" input: name: Invalid input: expected string, received undefined. greet takes name (text). Pass --input '{"name":"…"}', or roll a schedule key that carries it: greet-88bab6d8.
```

`--input` that is not JSON is a usage error naming the flag.

`roll` has nobody to answer a question. A run that reaches `ask.approval` or
`ask.question` under `roll` is cancelled at the ask, the CLI prints
`marbles: run "<name>" was cancelled: "<title>" is waiting for an answer`
and exits 1. Everything before the ask
ran. Launch such runs from the dashboard instead, or by a schedule or monitor
while the dashboard is open.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--source <path>` | `./.foundry/marbles` | Authoring folder or single module. Missing sources offer setup in the dashboard; other commands use an empty catalog. |
| `--config <path>` | Same as `--source` | Compatibility alias. A legacy `marbles.config.ts` is used when the default folder is absent. |
| `--state <dir>` | `~/.foundry/marbles` | Root directory for workspace state. |
| `--artifacts <dir>` | `artifacts/` beside the state root | Shared artifact store holding declared artifacts and feed entries from every workspace. |
| `--input <json>` | A schedule's input, or none | Input for `roll`. Overrides a schedule's recorded input. |
| `--harness <id>` | Every detected harness | Keep only `claude-code`, `codex`, or `pi`. Repeat to keep more than one. |
| `--dry-run` | Off | Echo agent turns, git mutations, and sandbox commands instead of running them, and write no state. See [safety and limits](/marbles/reference/safety). |

Agents can select any retained harness through `provider`. Without one,
Claude Code takes precedence over Codex. Dry execution echoes allowed
harnesses even when neither CLI is installed.

`--dry` is an alias for `--dry-run`. A later occurrence of a value flag wins.

## The dashboard

With a terminal on both stdin and stdout, `marbles` opens the dashboard.

- **Overview** counts running, queued, waiting, failed, completed, and
  cancelled runs, with success rate and median run and wait times. It lists
  Runs with live steps and saved history, the latest run changes and feed
  entries, and agent usage by workflow and by agent.
- **Catalog** shows Triggers and the workflows and steps (Marbles) the
  workspace's source declares, with the file each was declared in. Every
  top-level definition is available throughout that workspace.
- **Logs** lists every run's log lines and Marbles' own status lines, oldest
  first, filtered by level, source, and search.
- **Feed** lists reports and questions from every workspace, newest first.
- **Settings** chooses the theme for every workspace.

Each tab except Settings shows its count, capped at 99+. Focusing Triggers or
Marbles shows Catalog; focusing Runs shows Overview.

Usage is recorded once per agent turn inside a run, from the token counts the
harness reports. A cost is estimated at the catalog's list price when the
model has one and keeps that price with the turn; `~` marks an estimate. A
turn without a price is counted as unpriced, never as zero, and a run with no
recorded turns shows "no usage recorded". A step's total includes its
descendants' turns once.

A committed turn whose usage was not saved is found again in its session
transcript: its tokens count, its cost is unknown, and the total says "not
recorded". It is attributed to a run only when a saved marker or the run's
file names that turn, and to the turns outside runs only when a saved marker
says so. Where a session was opened does not prove whose its later turns
are: another run or the host may continue it, and a run still running in
another process is not visible to this one. So such a turn is an
unattributed turn, counted in the workspace total and noted ("may be
incomplete") on outside runs, every workflow, and each run that was running
when it finished. A transcript that is missing or cannot be read is noted as
an unreadable usage record on every total, whoever named its session: any
run or the host may have taken the turns it lost. So is a sessions directory
that cannot be listed. A settled run's file that cannot be read is noted on
that run and its workflow.

| Key | Action |
| --- | --- |
| Shift+D / C / L / F / S | Show Overview, Catalog, Logs, Feed, or Settings |
| 1 / 2 / 3, Tab, `m` | Focus Triggers, Marbles, or Runs |
| ↑ / ↓, Enter, Esc | Select rows, open details, return |
| ← / →, Space | Collapse or expand run branches; change inspector tab |
| `l` in Marbles | Launch the selected step or workflow; a schema opens a form (Tab moves, Ctrl+Enter submits, Esc cancels) |
| `f` in Marbles | Filter runs to this schedule, monitor, workflow, or step; `x` clears |
| `s` / `p` / `k` on a run | Steer the running agent, pause or resume the step, cancel the run. Each shows only when the run's status allows it: steer and pause while running, resume while paused, cancel until the run settles |
| `a` / `e`, `b` | Jump to the active step or failure; return from step details to the run |
| `/` | Search the focused marble or run list |
| `f` in a run's logs | Toggle following new log lines |
| ↑ / ↓, Enter in Logs | Select a line (stops following); open the run and step it came from |
| `f` / `v` / `o` / `/` / `x` in Logs | Follow new lines; raise the minimum level; cycle all, run, or Marbles lines; search; clear the filters |
| ← / → in Settings | Change the theme |
| `w` / `x` in the Feed | Cycle the workspace filter (all workspaces, this workspace, then any other that has posted); show every workspace |
| 1 through 9 / `a` in the Feed | Answer an open question by choice, or type a free-text answer. An approval takes an optional note after the choice |
| `h` | Return to the Overview or Catalog list with focus |
| `?` | Keyboard help |
| `q` / Ctrl+C | Confirm quit; Ctrl+C again quits |

### Settings and local diagnostics

Settings are global: `settings.json` at the state root
(`~/.foundry/marbles/settings.json`, or beside a custom `--state`). A missing
file or key uses the default theme, `dark`. A value Marbles does not know, or
a file it cannot read, falls back to the default and is named on the Settings
tab; Marbles does not overwrite a file it cannot read. Saving keeps keys it
does not know. Under `--dry-run` the Settings tab is read-only.

Marbles measures its own work locally and sends nothing anywhere. Run records,
step logs, and each agent turn's tokens, duration, model, and cost are kept
under the workspace's state directory (`usage/<run-id>.json` for turns).
Marbles' own status lines are kept in memory for the session, up to 500.

### Pause, resume, and steer

Pause parks the selected step and everything under it. Resume, with or
without a prompt, replays the parked bodies from the top; a prompt leads the
first turn of the agent session each step had open. Steer hands a prompt to
the agent turn running in the step; the turn stops, the prompt becomes the
next message, and the step's `generate` resolves with the steered reply. The
run inspector's Stream tab shows `[steer]` and `[resume]` markers inline.

### Quit and restart

Quitting stops triggers and cancels queued and running runs. A run parked on
a question or a pause is kept, with its question open, and is adopted by the
next dashboard that starts with the same state root and still registers the
step. Under `--dry-run` nothing is written, so parked runs are cancelled too.
Custom code in a step body must honour the context's `signal` to stop
external work; cancellation cannot undo side effects.

### Headless operation

When stdin or stdout is not a terminal, `marbles` and `marbles run` start at
once and print plain text. SIGINT and SIGTERM stop new triggers and let
active runs finish. `status` behaves the same way: a terminal opens a view
that `q` closes; piped output is plain text.


`marbles --harness pi` selects Pi when its CLI is installed; setup also offers
Pi. Host model calls use `ai-sdk-provider-pi` 0.1.0, which embeds Pi 0.52.12,
with read-only tools by default. Configure its credentials through Pi's auth
storage or provider API-key environment variables.
Sandbox sessions install the pinned standalone Pi binary for the guest's
architecture, verify its SHA-256, and use Marbles' permission-controlled coding
tools. Supply a session API key or sign in with Pi on the host for the selected
`provider/model`; the host resolves the current key, and only that key enters
the guest environment. Refresh credentials remain on the host.
