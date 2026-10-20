# Marbles

Marbles is a standalone CLI for automations you write in TypeScript. Run
local commands, connect steps into workflows, react to changes, and add
coding agents where a task needs judgment.

Marbles is **alpha**. The first planned release is `0.0.1`; any `0.0.x`
release may introduce breaking changes. `0.1.0` will mark the first supported
API baseline. Alpha packages use npm's `alpha` channel when published.

[Workflows](../../packages/workflows/README.md) records step results and
provides optional retries and durable waiting points.
[Agents](../../packages/agents/README.md) keeps conversations,
[Workspaces](../../packages/workspaces/README.md) provides files and Git
checkouts, and [Artifacts](../../packages/artifacts/README.md) keeps
versioned outputs. Marbles bundles these libraries.

## Install

Requires Bun 1.3.14 or newer. The package is not yet on npm; install a
packaged archive supplied by a maintainer:

```sh
bun add --global /absolute/path/to/foundry.sh-marbles-0.0.1.tgz
marbles --help
```

The [installation guide](https://francois-esquire.github.io/foundry/marbles/get-started/installation/)
covers editor types and optional capabilities. Contributors can
[build an archive](https://francois-esquire.github.io/foundry/marbles/contributing/#build-a-distributable-package).

## Write one automation

Save this as `.foundry/marbles/inventory.ts` in your project:

```ts
import { step } from "@foundry.sh/marbles";

step("inventory").do(async ({ workspaces, log }) => {
  const files = await workspaces.current.files();
  log(`Found ${files.length} files`);
  return { files: files.length };
});
```

From that project's root:

```sh
marbles list
marbles roll inventory
```

The result contains the file count. This example needs no agent credentials
or sandbox runtime. The [quickstart](https://francois-esquire.github.io/foundry/marbles/get-started/quickstart/)
continues with an edit-and-rerun cycle and result inspection.

## Run locally

### MCP over STDIO

See the [MCP reference](../../docs/marbles/reference/mcp.md) for setup, tools,
arguments, and the launch-and-watch flow.

From this checkout, an MCP client can launch the Bun source directly. No
build is needed. Set `cwd` to the project whose Marbles modules you want
to load:

```json
{
  "mcpServers": {
    "marbles": {
      "command": "bun",
      "args": [
        "/absolute/path/to/foundry/apps/marbles/src/mcp.ts",
        "--source",
        "/absolute/path/to/project/.foundry/marbles"
      ],
      "cwd": "/absolute/path/to/project"
    }
  }
}
```

`--source` accepts a file or directory and defaults to `.foundry/marbles`
under `cwd`. Each process loads the source once and owns its engine.
Restart it to pick up source edits. Source modules execute when loaded,
after the workspace's Varlock environment is loaded and validated.

The server offers `list_config`, `dispatch_workflow`, `dispatch_agent`,
`get_run`, and `cancel_run`.
`list_config` returns workflow and step names with input schemas, agent
IDs and model routes, and declared schedules and monitors. `dispatch_workflow`
takes `name` and optional `input`, launches in the background, and returns
a real engine `runId` with `running` status.
Schedules and monitors are listed but are not polled by this server.

`dispatch_agent` starts an agent in the background and returns a `runId`,
`session`, and `running` status immediately after session setup. It accepts:

- `prompt`: the task to perform.
- `agent`: an optional declared agent ID. Omit it for an ad hoc agent.
- `instructions`: instructions for an ad hoc agent, or additional instructions
  appended to a declared agent's prompt.
- `model` and `provider`: overrides for the agent's route.
- `cwd`: working directory, resolved relative to the loaded workspace root.
- `maxTurns`: maximum model/tool steps for this task, rather than a target
  number of replies. The agent can finish earlier. Network models and local
  Claude Code support this limit. Claude Code accepts at most 100. Local
  Codex and Pi reject this option because their current adapters cannot
  enforce it; omit the option to dispatch them without a turn limit.
- `timeoutMs`: maximum execution time before cancellation is requested.
- `compaction`: optional automatic context compaction.
- `session`: the `{ id, model, provider }` returned by an earlier dispatch,
  to continue that conversation. Wait for that dispatch to finish first.

For example, call `dispatch_agent` with:

```json
{
  "agent": "reviewer",
  "prompt": "Review the changes and report any bugs.",
  "maxTurns": 10,
  "timeoutMs": 120000
}
```

Both launch commands return the same run convention. Poll `get_run` with
`{ "runId": "the-returned-run-id" }` for status, final `text`/`output`, or
an `error`. A run can be `running`, `cancelling`, `completed`, `failed`, or
`cancelled`. `cancel_run` takes the same run ID and requests cancellation.
The MCP server owns the running work and must stay connected. Closing its
connection cancels outstanding runs. `get_run` tracks this host's launches
in memory; it is not a persistent queue or a lookup into another instance.

### Watch a run

After either MCP launch command returns, wait for the result in one CLI call:

```sh
marbles watch <runId>
```

For this source checkout, without a build:

```sh
bun apps/marbles/src/cli.ts watch <runId>
```

`watch` replays earlier output, follows new output, prints the result and
terminal status, and exits. It reads saved output across workspaces under
`--state`, so it needs neither the original working directory nor
`--source`. Use the same `--state` value as the MCP server if you customized it.
It never imports configuration or starts an engine. Multiple watchers can
follow the same run independently.

Persisted engines append output to
`<state>/<workspace-id>/output/<runId>.jsonl`. This includes agent text,
workflow `stream.write`/`exec` output, and step lifecycle messages. Raw
`console.log` and process stdout still belong to the owning process's
stderr. Completed output remains watchable after that process exits.
Output from runs started before this feature, and in-memory `--dry-run`
runs, has no saved journal to watch. Output files have no retention policy yet.

The watcher exits with code 0 on completion, 1 on failure or cancellation,
and 130 when interrupted. Interrupting the watcher does not cancel the run.
If the owner disappears without recording an ending, the watcher reports
that interruption rather than waiting indefinitely.

Diagnostics and source output go to stderr; stdout carries MCP messages.
The process disposes its engine when stdin closes or it receives SIGINT
or SIGTERM. There is no shared-instance lookup or pooling. Existing
engine persistence and recovery still apply. Use `--state` to select a
separate state directory, or `--dry-run` for in-memory execution with echo
models and no provider calls. Dry runs still execute source and workflow
code, including any filesystem or network calls that code makes directly.

### Dashboard

`marbles` opens a dashboard; press Enter to start schedules and monitors.
`marbles run </dev/null` starts a headless loop immediately. Keep the process
running for automatic triggers. The dashboard can answer questions;
`roll` and headless execution cancel at a workflow ask.

State is stored under `~/.foundry/marbles/<workspace-id>/`, with artifacts
under `~/.foundry/artifacts/` by default. Restart to load edited modules.
`--dry-run` substitutes Marbles-owned operations and avoids state writes;
ordinary TypeScript and monitor I/O still execute.

## Documentation

| Need | Read |
| --- | --- |
| Explore what you can build | [Using Marbles](https://francois-esquire.github.io/foundry/marbles/get-started/using-marbles/) |
| Understand definitions, runs, resources, and durability | [Foundation](https://francois-esquire.github.io/foundry/marbles/foundation/api/) |
| Build an issue-driven development cycle | [Software Factory](https://francois-esquire.github.io/foundry/marbles/use-cases/software-factory/) |
| Look up commands or authoring options | [CLI](https://francois-esquire.github.io/foundry/marbles/reference/cli/) and [API](https://francois-esquire.github.io/foundry/marbles/reference/api/) |
| Operate or troubleshoot the runtime | [State](https://francois-esquire.github.io/foundry/marbles/reference/state/), [safety](https://francois-esquire.github.io/foundry/marbles/reference/safety/), and [remote execution](https://francois-esquire.github.io/foundry/marbles/reference/remote/) |
| Host or develop Marbles | [Embedding](https://francois-esquire.github.io/foundry/marbles/reference/engine/) and [Contributing](https://francois-esquire.github.io/foundry/marbles/contributing/) |

For terminal UI development, see the [preview guide](preview/README.md).
