---
title: MCP server
description: Launch workflows and agents over STDIO, then watch their output by run ID.
---

The Marbles MCP server reads and writes a workspace's stored state and
drives a running Marbles process. It manages nothing: it never starts the
process, never attaches a workspace, and runs no source or trigger itself.
This holds under `--dry-run` too.
External agents can list workspaces, read or change the workspace's tasks,
and, while the Marbles process hosts the workspace, inspect its loaded
configuration, dispatch work, read its status, and cancel it. Both workflow
and agent launches return a `runId` without waiting for completion.

## Start the server

`marbles mcp` starts the server. Configure your MCP client to launch it:

```json
{
  "mcpServers": {
    "marbles": {
      "command": "marbles",
      "args": ["mcp", "--source", "/absolute/path/to/project/.foundry/marbles"]
    }
  }
}
```

From a Foundry checkout, without a build, use `bun` as the command and
`--no-env-file`, `/absolute/path/to/foundry/apps/marbles/src/cli.ts` and
`mcp` as the first arguments.

The example uses the common `mcpServers` configuration shape. Adapt the
client configuration as needed, keeping the same command and arguments.
`--source` accepts a single module or a directory. Without it, the server
looks for `.foundry/marbles` under its working directory, with the CLI's
legacy `marbles.config.ts` fallback. See [project discovery](/marbles/reference/project).

Starting the server finds the `--source` workspace without running its
source. It starts without a source too: the task tools still work, and the
tools that need a host name the missing source. What each tool needs:

- The task tools work with or without a running Marbles process, for the
  server's own workspace and any workspace recorded under the state root.
  A worker that hosts the workspace answers them; otherwise the server
  opens the stored tasks for that one call and gives them up, the same as
  `marbles tasks`. Calls sent together take turns.
- `list_workspaces` lists what the Marbles process hosts. Without one, it
  lists the workspaces kept under the state root, each `stopped`. The
  server's own workspace is always listed.
- `list_config`, `dispatch_workflow`, `dispatch_agent`, `get_run`, and
  `cancel_run` need a running Marbles process that hosts the workspace and
  has its worker `ready`. Without one they return a tool error that says
  `marbles attach` hosts it. Host the workspace with `marbles attach`,
  `marbles run`, or `marbles roll` first.

The server joins the Marbles process on each call and leaves it after, so
a process started or stopped while the server runs is seen by the next
call. The worker loads the source, watches it, and reloads on an edit. The
workspace's schedules and monitors run in that worker, never in the server.

The server also accepts `--state`, `--artifacts`, and `--dry-run`. Their defaults match the [CLI flags](/marbles/reference/cli#flags).
Diagnostics go to stderr; stdout carries MCP messages only. The server
runs in a child process whose stdout is stderr, so whatever it and the
processes it starts print to stdout goes to stderr too.

Under `--dry-run` the server still hosts nothing and loads no source. It
joins no Marbles process, even one that hosts the workspace, and writes
nothing. [Tools](#tools) says what each tool does then. A dry run of a
workflow goes through `marbles roll --dry-run`.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_workspaces` | None | Every workspace the Marbles process hosts, or without one the workspaces kept under the state root: `id`, `root`, `config`, and `state` (`starting`, `ready`, `reloading`, `failed` with an `error`, or `stopped`). |
| `list_config` | optional `workspace` | Source path, workspace root, named definitions with input schemas, agent IDs/model routes, and declared schedules and monitors. |
| `dispatch_workflow` | `name`, optional `input`, optional `workspace` | Starts a named workflow or step and returns its `runId`, `kind`, `name`, and `status`. |
| `dispatch_agent` | `prompt`, optional agent and execution options below, optional `workspace` | Starts agent work and returns the same run fields plus its `session` reference. |
| `get_run` | `runId`, optional `workspace` | Current status, final `output`, agent `text`/`session` when applicable, or an `error`. |
| `cancel_run` | `runId`, optional `workspace` | Requests cancellation and returns the current run status. |
| `list_tasks` | optional `status`, `parentId` (null for root tasks), `tags`, `depth`, `limit`, `cursor`, `workspace` | A page of the workspace's tasks, oldest first, with `nextCursor`. |
| `ready_tasks` | optional `tags`, `limit`, `cursor`, `workspace` | A page of open tasks nothing holds back. |
| `get_task` | `id`, optional `depth`, `workspace` | One task with `depth` levels of subtasks. |
| `task_dependencies` | `id`, optional `workspace` | The tasks it depends on and the tasks that depend on it. |
| `change_tasks` | `operations`, optional `workspace` | Applies one atomic batch of task operations, the same as `marbles tasks change`. |

Every tool but `list_workspaces` takes an optional `workspace`: an id from
`list_workspaces`, defaulting to the server's own workspace. The task
tools reach any workspace recorded under the state root, even one whose
checkout is gone; an id with no record is a tool error. A symlink under
the state root is not a record, and the server's own workspace is refused
when its state directory is a symlink. The other tools reach a workspace only through the
worker that hosts it: an id that is not hosted is a tool error, and a call
to a workspace whose worker is not `ready` fails with its state.

Under `--dry-run`, `list_workspaces` names only the server's own workspace,
as `stopped`. The task tools answer from memory for that workspace and
refuse any other id. `list_config`, `dispatch_workflow`, `dispatch_agent`,
`get_run`, and `cancel_run` return an error that names
`marbles roll --dry-run`.

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
| `session` | The `session` an earlier dispatch returned, passed back unchanged, to continue that conversation. Its `instance` field lets the session resume only on the provider instance it ran on. Wait for its earlier run to finish first. |

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
loop for Claude Code. It does not ask the
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
connection. Closing stdin, ending the `marbles mcp` process, or SIGINT or
SIGTERM ends the server and nothing else. Shutdown takes a few seconds at
most; a task call that does not finish in time is cut off. The Marbles process keeps hosting the workspace, its triggers
keep running, and runs already dispatched run to completion. Several MCP
clients can run at once against one process. `get_run` and `cancel_run`
look a run up in the worker that hosts its workspace, so any server for
that workspace can read or cancel a run another one dispatched. That lookup is held in the worker's memory: a
source edit, `marbles stop`, or a crash replaces the worker and forgets it,
though the run's [output journal](/marbles/reference/state#run-output) on
disk stays watchable, and a run parked on a question or a pause is adopted
by the fresh worker. The journal is not a persistent job queue, and output
files have no automatic retention policy yet.

Under `--dry-run` the server runs nothing. Its in-memory tasks end with
the connection.

`marbles stop` ends the process and every workspace it hosts; `marbles
status` shows the process and which workspaces are hosted. Custom artifact
tools, sandbox tools, and remote transport are outside this iteration.
