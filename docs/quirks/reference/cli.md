---
title: CLI reference
description: Commands, flags, and dashboard keys for running and inspecting Quirks.
---

`@foundry/quirks` is not published to npm yet. Inside the Foundry repository
the command is `bun run quirks -- …`; elsewhere run the built CLI directly.

```sh
# inside the Foundry repository
bun run quirks -- --config ./quirks.config.ts list

# elsewhere, with the built CLI
bun /path/to/foundry/apps/quirks/dist/cli.js --config ./quirks.config.ts list
```

The pages below write `quirks …` for the command. Substitute either form.

## Commands

| Command | Behavior |
| --- | --- |
| No command or `run` | Open the splash and live dashboard; Enter starts triggers. Piped, start at once. |
| `help`, `--help`, `-h` | Print usage without loading the configuration. |
| `list` | Print every named step and workflow, then each schedule and monitor with its key and cadence. Loads the config; runs no step body. |
| `once <name-or-key> [--input <json>]` | Dispatch one step, workflow, schedule, or monitor now, print its result as JSON, and exit. |
| `status` | Read every workspace under the state root: foreground process, schedules, recent runs, session count. Needs no running Quirks process. |
| `sessions` | List the current workspace's agent sessions: id, message count, last update, and whether a compaction summary exists. |
| `launchd install <key>` | Write and load a macOS LaunchAgent that runs `once <key>` on the trigger's cadence. |
| `launchd uninstall <key>` | Unload and remove that LaunchAgent. |

Every command except `help` imports the configuration first. Keep module
scope to declarations: importing the file must not do work.

`once` accepts three kinds of argument. A definition name runs that step or
workflow with `--input`, or with no input. A schedule key runs the schedule's
target with the schedule's recorded input, takes the schedule's lock, and
writes its history, exactly as a launchd tick would. A monitor key runs one
poll of that monitor: with no stored baseline every matching file counts as
added, or the first HTTP body counts as a change, so the handler runs and
anything it returns is started. Use the keys that `list` prints; a schedule's
key is derived from its target and input, a monitor's from its source.

`once` has nobody to answer a question. A run that reaches `ask.approval` or
`ask.question` under `once` is cancelled at the ask, the CLI prints that the
run needs an answer and was cancelled, and exits 1. Everything before the ask
ran. Launch such runs from the dashboard instead, or by a schedule or monitor
while the dashboard is open.

`launchd` needs macOS and a key `list` prints. It writes
`~/Library/LaunchAgents/com.foundry.quirks.<key>.plist`, which runs the
current Bun and CLI with `once <key> --config <path> --state <dir>` from the
current directory, and sends output to `~/Library/Logs/quirks/<key>.log`. See
the [launchd guide](/quirks/guides/launchd).

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--config <path>` | `./quirks.config.ts` | Configuration module. If absent, interactive startup offers setup; other commands run with an empty registry. |
| `--state <dir>` | `~/.foundry/quirks` | Root directory for workspace state. |
| `--artifacts <dir>` | `artifacts/` beside the state root | Shared artifact store holding declared artifacts and feed entries from every workspace. |
| `--input <json>` | A schedule's input, or none | Input for `once`. Overrides a schedule's recorded input. |
| `--harness <id>` | Every detected harness | Keep only `claude-code` or `codex`. Repeatable. |
| `--dry` | Off | Echo agent turns, git mutations, and sandbox commands instead of running them, and write no state. See [safety and limits](/quirks/safety-and-limits). |

A later occurrence of a value flag wins. Under `--dry` every allowed harness
is echoed, installed or not, so a config loads on a machine with neither CLI.

## The dashboard

With a terminal on both stdin and stdout, `quirks` opens the dashboard. Its
Dashboard tab shows Triggers, Catalog, and Runs, including live steps and
saved run history. The Feed tab lists reports and questions from every
workspace, newest first. Each tab shows its count, capped at 99+.

| Key | Action |
| --- | --- |
| Shift+D / Shift+F | Show the Dashboard or Feed tab |
| 1 / 2 / 3, Tab, `c` | Focus Triggers, Catalog, or Runs |
| ↑ / ↓, Enter, Esc | Select rows, open details, return |
| ← / →, Space | Collapse or expand run branches; change inspector tab |
| `l` on the catalog | Launch the selected step or workflow; a schema opens a form (Tab moves, Ctrl+Enter submits, Esc cancels) |
| `f` on the catalog | Filter runs to this schedule, monitor, workflow, or step; `x` clears |
| `s` / `p` / `k` on a run | Steer the running agent, pause or resume the step, cancel the run |
| `a` / `e`, `b` | Jump to the active step or failure; return from step details to the run |
| `/` | Search the focused catalog or run list |
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
step. Under `--dry` nothing is written, so parked runs are cancelled too.
Custom code in a step body must honour the context's `signal` to stop
external work; cancellation cannot undo side effects.

When stdin or stdout is not a terminal, `quirks` and `quirks run` start at
once and print plain text. SIGINT and SIGTERM stop new triggers and let
active runs finish. `status` behaves the same way: a terminal opens a view
that `q` closes; piped output is plain text.
