---
title: CLI reference
description: Commands, flags, and dashboard keys for running and inspecting Marbles.
---

`@foundry/marbles` is not published to npm yet. Inside the Foundry repository
the command is `bun run marbles -- …`; elsewhere run the built CLI directly.

```sh
# inside the Foundry repository
bun run marbles -- list

# elsewhere, with the built CLI
bun /path/to/foundry/apps/marbles/dist/cli.js list
```

The pages below write `marbles …` for the command. Substitute either form.

## Commands

| Command | Action |
| --- | --- |
| No command or `run` | Open the splash and live dashboard; Enter starts triggers. Piped, start at once. |
| `help`, `--help`, `-h` | Print usage without loading modules. |
| `init [developer \| design \| product]` | Create a starter module in `.foundry/marbles`, without running it or overwriting it. Defaults to Product. |
| `list` | Print every named step and workflow, then each schedule and monitor with its key and cadence. Loads the module; runs no step body. |
| `roll <name-or-key> [--input <json>]` | Dispatch one step, workflow, schedule, or monitor now, print its result as JSON, and exit. |
| `status` | Read every workspace under the state root: foreground process, schedules, recent runs, session count. Needs no running Marbles process. |
| `sessions` | List the current workspace's agent sessions: id, message count, last update, and whether a compaction summary exists. |
| `launchd install <key>` | Write and load a macOS LaunchAgent that runs `roll <key>` on the trigger's cadence. |
| `launchd uninstall <key>` | Unload and remove that LaunchAgent. |

`run` starts every trigger and takes no name. `marbles run <name>` prints a
pointer to `roll <name>` and exits 1.

Every command except `help` and `init` imports the discovered modules first. Keep module
scope to declarations: importing the file must not do work.

`roll` accepts three kinds of argument. A definition name runs that step or
workflow with `--input`, or with no input. A schedule key runs the schedule's
target with the schedule's recorded input, takes the schedule's lock, and
writes its history, exactly as a launchd tick would. A monitor key runs one
poll of that monitor: with no stored baseline every matching file counts as
added, or the first HTTP body counts as a change, so the handler runs and
anything it returns is started. Use the keys that `list` prints; a schedule's
key is derived from its target and input, a monitor's from its source.

`roll` has nobody to answer a question. A run that reaches `ask.approval` or
`ask.question` under `roll` is cancelled at the ask, the CLI prints that the
run needs an answer and was cancelled, and exits 1. Everything before the ask
ran. Launch such runs from the dashboard instead, or by a schedule or monitor
while the dashboard is open.

`launchd` needs macOS and a key `list` prints. It writes
`~/Library/LaunchAgents/com.foundry.marbles.<key>.plist`, which runs the
current Bun and CLI with `roll <key> --config <path> --state <dir>` from the
current directory, and sends output to `~/Library/Logs/marbles/<key>.log`. See
the [launchd guide](/marbles/guides/launchd).

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--source <path>` | `./.foundry/marbles` | Authoring folder or single module. Missing sources offer setup in the dashboard; other commands use an empty catalog. |
| `--config <path>` | Same as `--source` | Compatibility alias. A legacy `marbles.config.ts` is used when the default folder is absent. |
| `--state <dir>` | `~/.foundry/marbles` | Root directory for workspace state. |
| `--artifacts <dir>` | `artifacts/` beside the state root | Shared artifact store holding declared artifacts and feed entries from every workspace. |
| `--input <json>` | A schedule's input, or none | Input for `roll`. Overrides a schedule's recorded input. |
| `--harness <id>` | Every detected harness | Keep only `claude-code` or `codex`. Repeatable. |
| `--dry-run` | Off | Echo agent turns, git mutations, and sandbox commands instead of running them, and write no state. See [safety and limits](/marbles/safety-and-limits). |

The older spelling `--dry` is still read as `--dry-run`. A later occurrence of a value flag wins. Under `--dry-run` every allowed harness
is echoed, installed or not, so a module loads on a machine with neither CLI.

## The dashboard

With a terminal on both stdin and stdout, `marbles` opens the dashboard. Its
Dashboard tab shows Triggers, Marbles, and Runs, including live steps and
saved run history. The Feed tab lists reports and questions from every
workspace, newest first. Each tab shows its count, capped at 99+.

| Key | Action |
| --- | --- |
| Shift+D / Shift+F | Show the Dashboard or Feed tab |
| 1 / 2 / 3, Tab, `m` | Focus Triggers, Marbles, or Runs |
| ↑ / ↓, Enter, Esc | Select rows, open details, return |
| ← / →, Space | Collapse or expand run branches; change inspector tab |
| `l` in Marbles | Launch the selected step or workflow; a schema opens a form (Tab moves, Ctrl+Enter submits, Esc cancels) |
| `f` in Marbles | Filter runs to this schedule, monitor, workflow, or step; `x` clears |
| `s` / `p` / `k` on a run | Steer the running agent, pause or resume the step, cancel the run |
| `a` / `e`, `b` | Jump to the active step or failure; return from step details to the run |
| `/` | Search the focused marble or run list |
| `f` in logs | Toggle following new log lines |
| `w` / `x` in the Feed | Cycle the workspace filter; show every workspace |
| 1–9 / `a` in the Feed | Answer an open question by choice, or type a free-text answer. An approval takes an optional note after the choice |
| `h` | Return to the dashboard |
| `?` | Keyboard help |
| `q` / Ctrl+C | Confirm quit; Ctrl+C again quits |

Pause parks the selected step and everything under it. Resume, with or
without a prompt, replays the parked bodies from the top; a prompt leads the
first turn of the agent session each step had open. Steer hands a prompt to
the agent turn running in the step; the turn stops, the prompt becomes the
next message, and the step's `generate` resolves with the steered reply. The
run inspector's Stream tab shows `[steer]` and `[resume]` markers inline.

Quitting stops triggers and cancels queued and running runs. A run parked on
a question or a pause is kept, with its question open, and is adopted by the
next dashboard that starts with the same state root and still registers the
step. Under `--dry-run` nothing is written, so parked runs are cancelled too.
Custom code in a step body must honour the context's `signal` to stop
external work; cancellation cannot undo side effects.

When stdin or stdout is not a terminal, `marbles` and `marbles run` start at
once and print plain text. SIGINT and SIGTERM stop new triggers and let
active runs finish. `status` behaves the same way: a terminal opens a view
that `q` closes; piped output is plain text.
