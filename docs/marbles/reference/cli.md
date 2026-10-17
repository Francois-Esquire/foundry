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
| `sessions` | List the current workspace's agent sessions: id, message count, last update, and whether a compaction summary exists. Loads no module. |

`run` starts every trigger and takes no name. `marbles run <name>` prints a
pointer to `roll <name>` and exits 1.

Invalid commands, arguments, starters, and harness IDs print a usage error
to stderr and exit 1 before importing modules or touching state.

`run`, `roll`, and `list` import the discovered modules first;
`help`, `init`, `status`, and `sessions` do not. Keep module scope to
declarations: importing the file must not do work. Only commands that run
something under a state root (`run`, `roll`, and the dashboard after Enter)
record the workspace in `workspace.json`, and never under `--dry-run`.

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
| `s` / `p` / `k` on a run | Steer the running agent, pause or resume the step, cancel the run. Each shows only when the run's status allows it: steer and pause while running, resume while paused, cancel until the run settles |
| `a` / `e`, `b` | Jump to the active step or failure; return from step details to the run |
| `/` | Search the focused marble or run list |
| `f` in logs | Toggle following new log lines |
| `w` / `x` in the Feed | Cycle the workspace filter (all workspaces, this workspace, then any other that has posted); show every workspace |
| 1 through 9 / `a` in the Feed | Answer an open question by choice, or type a free-text answer. An approval takes an optional note after the choice |
| `h` | Return to the dashboard |
| `?` | Keyboard help |
| `q` / Ctrl+C | Confirm quit; Ctrl+C again quits |

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
