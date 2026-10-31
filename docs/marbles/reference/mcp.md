---
title: MCP server
description: Launch workflows and agents over STDIO, then watch their output by run ID.
---

The Marbles MCP server is a client of the Marbles process, the one daemon
per machine that hosts each attached workspace in a worker of its own. The
server attaches the `--source` workspace and answers for it, and for any
other workspace the process hosts, by id. External agents can list the
hosted workspaces, inspect a loaded configuration, dispatch work, read its
status, and cancel it. Both workflow and agent launches return a `runId`
without waiting for completion.

## Start from a source checkout

This first iteration runs directly from Bun source. It has no packaged MCP
executable or build step. Install the checkout's dependencies with
`bun install --frozen-lockfile`, then configure your MCP client to launch:

```json
{
  "mcpServers": {
    "marbles": {
      "command": "bun",
      "args": [
        "/absolute/path/to/foundry/apps/marbles/src/mcp/stdio.ts",
        "--source",
        "/absolute/path/to/project/.foundry/marbles"
      ]
    }
  }
}
```

The example uses the common `mcpServers` configuration shape. Adapt the
client configuration as needed, keeping the same command and arguments.
`--source` accepts a single module or a directory. Without it, the server
looks for `.foundry/marbles` under its working directory, with the CLI's
legacy `marbles.config.ts` fallback. See [project discovery](/marbles/reference/project).

Starting the server attaches the workspace to the Marbles process, starting
the process when none runs, and waits for its worker to load the source: the
workspace's `.env.schema` through Varlock first (a value that does not
resolve is a warning there), then the modules, whose top-level code runs and
registers their declarations. Keep module scope to declarations. A missing
source, or one that throws when imported, fails the start and names the
error. Source edits need no restart: the worker notices a change within a
second, drains, and reloads, and the next tool call sees the new modules.

The server also accepts `--state`, `--artifacts`, repeatable `--harness`,
and `--dry-run`. Their defaults match the [CLI flags](/marbles/reference/cli#flags).
Diagnostics and the worker's status lines go to stderr; stdout carries MCP
messages. The workspace's schedules and monitors run in its worker whether
or not an MCP server is connected. Under `--dry-run` the server hosts the
workspace in its own process instead: nothing persists, the Marbles process
is not involved, only the attached workspace exists, a `.env.schema` that
does not resolve prevents startup, and no trigger loop runs.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_workspaces` | None | Every workspace the Marbles process hosts: `id`, `root`, `config`, and `state` (`starting`, `ready`, `reloading`, `failed` with an `error`, or `stopped`). |
| `list_config` | optional `workspace` | Source path, workspace root, named definitions with input schemas, agent IDs/model routes, and declared schedules and monitors. |
| `dispatch_workflow` | `name`, optional `input`, optional `workspace` | Starts a named workflow or step and returns its `runId`, `kind`, `name`, and `status`. |
| `dispatch_agent` | `prompt`, optional agent and execution options below, optional `workspace` | Starts agent work and returns the same run fields plus its `session` reference. |
| `get_run` | `runId`, optional `workspace` | Current status, final `output`, agent `text`/`session` when applicable, or an `error`. |
| `cancel_run` | `runId`, optional `workspace` | Requests cancellation and returns the current run status. |

Every tool but `list_workspaces` takes an optional `workspace`: an id from
`list_workspaces`, defaulting to the attached workspace. The server lists
the hosted workspaces before resolving an id, so an id that is not hosted is
a tool error, and a call to a workspace whose worker is not `ready` fails
with its state. Under `--dry-run` only the attached workspace exists.

Dispatch responses are acknowledgements, even if their status is already
`completed`. They contain no final `output`, `text`, or `error`; call `get_run`
for those fields. Dispatch never waits for result finalization.

Tool results contain JSON in an MCP text content block. Unknown targets and
rejected arguments return tool errors. An accepted run can still fail during
execution; inspect it with `get_run` or watch it to its end.

`dispatch_workflow` addresses definition names, not schedule or monitor
keys. Use `list_config` for the available names and input schemas. It does
not tick a schedule, poll a monitor, or start a trigger loop.

## Dispatch and watch a workflow

Call `dispatch_workflow` with the name and input matching your source:

```json
{
  "name": "count",
  "input": { "extension": ".ts" }
}
```

The response includes a `runId`. Both launch tools use the engine's run ID;
an agent's session ID identifies its conversation and is separate.

Wait for either kind of run in a single command:

```sh
marbles watch <runId>
```

From the source checkout, without a build:

```sh
bun apps/marbles/src/cli.ts watch <runId>
```

The watcher replays earlier output, follows new output, prints the result
and terminal status, then exits. It needs no source path and can run from
another working directory. If you set a custom `--state` on the MCP server,
pass the same value to the watcher. See [watching runs](/marbles/reference/cli#watch-a-background-run)
for exit codes and interruption behavior.

## Agent options

`dispatch_agent` accepts these fields:

| Field | Meaning |
| --- | --- |
| `prompt` | Required task text. |
| `agent` | Optional declared agent ID from `list_config`. Omit it for an ad hoc agent. |
| `instructions` | Instructions for an ad hoc agent, or instructions appended to a declared agent's prompt. Without either, an ad hoc agent uses a short task-completion prompt. |
| `model`, `provider` | Override the agent's configured model route. Otherwise use its route or the engine default. |
| `cwd` | Working directory, resolved relative to the loaded workspace root. |
| `maxTurns` | Positive integer limiting model/tool steps. The agent can finish earlier. Network models and local Claude Code support it; Claude Code accepts at most 100. Local Codex and Pi reject this option because their current adapters cannot enforce it. Omit it to use their own loop defaults. |
| `timeoutMs` | Positive integer execution timeout in milliseconds, at most 2,147,483,647. Expiry requests cancellation and reports a failed run. |
| `compaction` | Optional boolean forwarded to session context-compaction settings. Omit it to use the session defaults. |
| `session` | An earlier `{ id, model, provider }` session reference, to continue that conversation. Wait for its earlier run to finish first. |

For example:

```json
{
  "agent": "reviewer",
  "prompt": "Review the changes and report any bugs.",
  "provider": "claude-code",
  "maxTurns": 10,
  "timeoutMs": 120000
}
```

`maxTurns` limits SDK model/tool steps for network providers and the native
loop for Claude Code. Dry runs use an SDK step limit. It does not ask the
server to send repeated follow-up prompts or force that many replies.
Continue a conversation by making another dispatch with its `session`.
Concurrent dispatches cannot use the same active session in one worker.

## Status, cancellation, and lifetime

Pass the returned run ID to `get_run` or `cancel_run`:

```json
{ "runId": "the-returned-run-id" }
```

Statuses follow the engine: `queued`, `running`, `suspended`, `completed`,
`failed`, or `cancelled`. MCP spells the engine’s `complete` status `completed`.
Cancellation through the engine or MCP appears in the same run record.
Cancellation is a request; keep reading status until the run settles.
Code inside workflow bodies must honor the context's `signal` to stop its
external work. Cancellation cannot undo completed side effects.

A dispatched run belongs to the workspace's worker, not to the MCP
connection. Closing stdin, or SIGINT or SIGTERM, detaches the server: the
Marbles process keeps hosting the workspace, its triggers keep running, and
runs already dispatched run to completion. Several MCP clients can run at
once against one process, each attaching its own `--source` or the same
one. `get_run` and `cancel_run` look a run up in the worker that hosts its
workspace, so any server attached to that workspace can read or cancel a
run another one dispatched. That lookup is held in the worker's memory: a
source edit, `marbles stop`, or a crash replaces the worker and forgets it,
though the run's [output journal](/marbles/reference/state#run-output) on
disk stays watchable, and a run parked on a question or a pause is adopted
by the fresh worker. The journal is not a persistent job queue, and output
files have no automatic retention policy yet.

`--dry-run` keeps everything in the server's process: closing the connection
cancels outstanding work, runs save no journal, and nothing can watch them
from outside. Dry runs still execute arbitrary source and workflow code;
they do not isolate its own filesystem or network calls.

`marbles stop` ends the process and every workspace it hosts; `marbles
status` shows the process and which workspaces are hosted. Custom artifact
tools, sandbox tools, and remote transport are outside this iteration.
