---
title: The Marbles UI
description: Where runs, questions, tasks, triggers, and observers show up, in the dashboard and at the shell.
---

A loop you cannot see is a loop you cannot trust. Marbles shows its work in
three places: the dashboard, a handful of read-only shell commands, and an
MCP server for other agents. This page says where to look for each thing.

## Where things live

| You want to see | Look in |
| --- | --- |
| Runs that are active, failed, or waiting | Dashboard view, `marbles status`, `marbles runs` |
| One run's steps, output, and live agent turns | The run inspector, or `marbles watch <runId>` |
| Questions and approvals waiting for you | The Feed, or `i` on a waiting run |
| Reports and saved artifacts | The Feed, `marbles artifacts` |
| Steps, workflows, schedules, and monitors | The Catalog view, `marbles list` |
| Observers and where each one is | `marbles list`, `marbles status` |
| The task backlog | `marbles tasks list`, `marbles tasks ready`, the MCP task tools |
| Agent conversations | `marbles sessions` |
| Spend and token usage | `u` on the Dashboard |

The dashboard has no task view yet. Tasks live in workspace state, and the
`marbles tasks` command and the MCP task tools read and change them.

## The process behind it

One Marbles process per machine hosts every attached workspace. `marbles`
attaches the current workspace and opens the dashboard. `marbles run
<name>` attaches it, runs one target, prints the result, and exits.
`marbles enqueue <name>` attaches it, queues one step or workflow, prints
the run ID, and exits at once; `marbles watch <runId>` follows that run.
`marbles daemon attach` attaches it and exits. Each leaves the workspace hosted, so
its schedules, monitors, and observers keep running after the command ends.
`marbles daemon stop` ends the process.

For unattended use, `marbles </dev/null` attaches the workspace and
follows its status lines as plain text. It cannot answer questions. See
[CLI modes](/marbles/reference/cli).

## The dashboard

Run `marbles` and press Enter at the splash. Three views share the screen:

- **Dashboard** (`Shift+D`) shows active runs, runs that need attention,
  success rate, and tracked spend, above upcoming work and run history.
- **Catalog** (`Shift+C`) lists the workspace's triggers, workflows, and
  steps. Select a step or workflow and press `l` to launch it; a definition
  with an input schema opens a form.
- **Feed** (`Shift+F`) shows reports and open questions for this workspace
  and those shared with it.

Within a view, `1`, `2`, and `3` focus the Triggers, Marbles, and Runs
panels. Enter opens a run's inspector, where each step shows its status and
output. While a step runs an agent turn or a command, the inspector lists it
under "Live now". From there:

| Key | Action |
| --- | --- |
| `s` | Steer the running agent turn, or send a line to a running command |
| `p` | Pause the step, or resume it with an optional prompt |
| `k` | Cancel the run |
| `i` | Open the Feed on the question this step waits for |
| `d` | Open this run's logs |

Press `?` for every key. `q` opens the quit dialog. Quitting detaches the
dashboard and leaves the workspace hosted.

## Questions and approvals

A step that calls `ask.approval(...)` or `ask.question(...)` parks its run.
The question appears in the Feed. Press a number to pick a choice, or `a`
to type an answer; an approval takes an optional note. The run continues
from the step that asked.

A parked run survives a quit, a stop, and a crash. The next dashboard on
that workspace sees the question. `marbles run` and piped `marbles` cannot answer,
so launch work that asks questions from the dashboard, or leave it parked
until you open one. [Durability](/marbles/concepts/durability) explains how
the step continues.

## From the shell

These commands read state and start nothing:

```sh
marbles status            # the process, each workspace, recent runs, observers
marbles list              # steps, workflows, schedules, monitors, observers
marbles runs              # this workspace's runs with their steps
marbles watch <runId>     # replay a run's output, follow it, exit when it ends
marbles tasks ready --tag checks
```

`marbles list` prints one line per entry:

```text
[source] /path/to/project/.foundry/marbles
[step] check-task
[workflow] pre-push
[schedule] nightly-checks → nightly-checks daily at 02:00
[monitor] source files src/**/*.ts every 1m
[observer] dispatchChecks ← tasks
[observer] flagFailures ← runs run.failed
```

An observer line names the observer, its source, and the fact types it
asked for. `marbles status` adds each observer's position, whether it is
caught up, retrying, or stuck in a call, and its last error. `list` imports
your modules, so it is also a quick check that they load. It needs the
current source checkout to show observers.

`watch` exits 0 when the run completes and 1 when it fails or is
cancelled. Stopping the watcher does not cancel the run. See
[watching a background run](/marbles/reference/cli#enqueue-and-watch-a-background-run).

## From an MCP client

`marbles mcp` serves the workspace to an MCP client over stdio. Another
agent can read and change tasks, list the loaded configuration, start a
named workflow with `dispatch_workflow`, or start agent work with
`dispatch_agent`. Both dispatch tools return a `runId` without waiting.
Dispatching needs the workspace hosted first, with `marbles daemon attach`.

An MCP client that creates tasks feeds [the outer
loop](/marbles/get-started/outer-loop) like anyone else. The [MCP
reference](/marbles/reference/mcp) lists the tools.

## Next

[How the parts fit](/marbles/concepts) explains the model behind what you
have built, and the [use cases](/marbles/use-cases) show larger loops built
from the same pieces.
