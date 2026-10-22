---
title: MCP server
description: Launch workflows and agents over STDIO, then watch their output by run ID.
---

The Marbles MCP server loads one workspace's authoring modules and owns an
engine for that connection. External agents can inspect the loaded
configuration, dispatch work, read its status, and cancel it. Both workflow
and agent launches return a `runId` without waiting for completion.

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

The workspace environment is loaded and validated through Varlock before
source imports. Missing source or an invalid environment prevents startup.
Importing the modules executes their top-level code and registers their
declarations. Keep module scope to declarations. Restart the server to load
source edits.

The server also accepts `--state`, `--artifacts`, repeatable `--harness`,
and `--dry-run`. Their defaults match the [CLI flags](/marbles/reference/cli#flags).
Diagnostics and ordinary source stdout go to stderr; stdout carries MCP
messages. The server does not start the schedule/monitor polling loop.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_config` | None | Source path, workspace root, named definitions with input schemas, agent IDs/model routes, and declared schedules and monitors. |
| `dispatch_workflow` | `name`, optional `input` | Starts a named workflow or step and returns its `runId`, `kind`, `name`, and `status`. |
| `dispatch_agent` | `prompt`, optional agent and execution options below | Starts agent work and returns the same run fields plus its `session` reference. |
| `get_run` | `runId` | Current status, final `output`, agent `text`/`session` when applicable, or an `error`. |
| `cancel_run` | `runId` | Requests cancellation and returns the current run status. |

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
Concurrent dispatches cannot use the same active session in this host.

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

Keep the MCP connection open while runs execute. Closing stdin or sending
SIGINT/SIGTERM shuts down the owning engine and cancels outstanding work.
Each connection launches its own engine, and that engine is the workspace's
one Marbles process while it runs: the server claims `locks/process` under
the workspace's [state directory](/marbles/reference/state) before it
starts. If the dashboard, a headless `marbles run`, or another MCP server
already holds it, this one prints who has it to stderr and exits with
status 1; stop that process first, or give this one its own `--state`.
`--dry-run` persists nothing and claims nothing. There is no run sharing
between processes: `get_run`/`cancel_run` address only this host's launches.
While an MCP server holds the claim, no process polls the workspace's
schedules and monitors.

Run lookup is held in memory for the life of the server. Persisted engines
also write an [output journal](/marbles/reference/state#run-output), so
completed output remains watchable after the owner exits. The journal is
not a persistent job queue, and output files have no automatic retention
policy yet. `--dry-run` and other in-memory engines save no journal and
cannot be watched from another process. Dry runs still execute arbitrary
source and workflow code; they do not isolate its own filesystem or network
calls.

Custom artifact tools, sandbox tools, remote transport, and detached work
that outlives the MCP owner are outside this iteration.
