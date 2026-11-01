# Marbles

Marbles is a standalone CLI for automations you write in TypeScript. Run
local commands, connect steps into workflows, react to changes, and add
coding agents where a task needs judgment.

Marbles is **alpha**. The first planned release is `0.0.1`; any `0.0.x`
release may introduce breaking changes. `0.1.0` will mark the first supported
API baseline. Every published version is npm's `latest`.

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

## Pick a model by what is left

`agent.extend({ model?, provider?, settings? })` gives the same agent another
route or settings and keeps its ID, so approvals and triggers carry over.
`usage` reports each signed-in account's limits; Marbles adds the Claude
Code (`anthropic`) and Codex (`openai`) logins when it starts. This step
reviews on Claude unless its weekly window is used up:

```ts
import { agent, step, usage } from "@foundry.sh/marbles";

const reviewer = agent({
  prompt: "Review the staged changes. Report findings without editing files.",
});

step("review").do(async ({ agents }) => {
  const claude = await usage.query("anthropic");
  const route = claude.weekly?.exhausted
    ? reviewer.extend({ provider: "codex" })
    : reviewer.extend({ provider: "claude-code" });
  const session = await agents.session(route);
  return (await session.generate("Review the staged changes.")).text;
});
```

[Usage](https://francois-esquire.github.io/foundry/marbles/foundation/usage/)
covers what a snapshot holds, and
[Agents and sessions](https://francois-esquire.github.io/foundry/marbles/foundation/agents-and-sessions/#choose-the-route-when-the-step-runs)
how `extend` merges settings.

An agent can also make the choice itself:
`agent(async ({ provider }) => ({ prompt, provider, skills, mcp }))` returns
its definition each time a session opens, so it can read `usage` and pick
the skills and MCP servers for its route. See
[defining the agent with a function](https://francois-esquire.github.io/foundry/marbles/foundation/agents-and-sessions/#define-the-agent-with-a-function).

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
        "/absolute/path/to/foundry/apps/marbles/src/mcp/stdio.ts",
        "--source",
        "/absolute/path/to/project/.foundry/marbles"
      ],
      "cwd": "/absolute/path/to/project"
    }
  }
}
```

`--source` accepts a file or directory and defaults to `.foundry/marbles`
under `cwd`. The server attaches that workspace to the Marbles process, one
per machine, which starts when none runs and hosts the workspace in a
worker of its own. The worker loads the workspace's Varlock environment,
then the source modules, which execute when loaded; it watches the
authoring folder and reloads itself on an edit, so no restart is needed.

The server offers `list_workspaces`, `list_config`, `dispatch_workflow`,
`dispatch_agent`, `get_run`, and `cancel_run`. Every tool but
`list_workspaces` takes an optional `workspace` id, from `list_workspaces`,
to address another workspace the process hosts instead of the attached one.
`list_config` returns workflow and step names with input schemas, agent
IDs and model routes, and declared schedules and monitors. `dispatch_workflow`
takes `name` and optional `input`, launches in the background, and returns
a real engine `runId` with its current engine status.
Schedules and monitors are listed but are not polled by this server.

`dispatch_agent` starts an agent in the background and returns a `runId`,
`session`, and current status immediately after session setup. It accepts:

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

Both dispatch commands return acknowledgements with run metadata only, even
when status is already `completed`. Read final results through `get_run`.
Poll `get_run` with
`{ "runId": "the-returned-run-id" }` for status, final `text`/`output`, or
an `error`. Status follows the engine: `queued`, `running`, `suspended`,
`completed`, `failed`, or `cancelled`. `cancel_run` takes the same run ID and requests cancellation.
Dispatched runs belong to the workspace's worker, so closing the MCP
connection detaches the server and leaves them running. `get_run` looks a
run up in that worker's memory: any server attached to the same workspace
sees it, and a source reload or `marbles stop` forgets it, though its saved
output stays watchable.

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

Diagnostics and the worker's status lines go to stderr; stdout carries MCP
messages. The server detaches when stdin closes or it receives SIGINT or
SIGTERM; the Marbles process keeps hosting the workspace, and several MCP
clients can attach to one process at once. Use `--state` to select a
separate state root (each root has its own process), or `--dry-run` to host
the workspace in the server's own process with in-memory state, echo
models, and no provider calls; closing a dry-run server cancels its runs.
Dry runs still execute source and workflow code, including any filesystem
or network calls that code makes directly.

### Dashboard

`marbles` attaches the workspace to the Marbles process, which starts its
schedules and monitors, and opens a dashboard on it; `marbles run </dev/null`
attaches it and follows its status lines instead. Either way the triggers
keep running after the command exits, until `marbles stop`. The dashboard
lists every workspace the process hosts (`w` moves between them) and can
answer questions; a run that asks waits on the Feed for one, and is
cancelled at the ask only under `--dry-run`. Source edits reload the
workspace's worker on their own.

State is stored under `~/.foundry/marbles/<workspace-id>/`, with artifacts
under `~/.foundry/artifacts/` by default; `FOUNDRY_HOME` moves both. The
Marbles process claims `locks/process` at the state root and listens on
`marbles.sock` beside it; each worker claims the same lock under its
workspace's directory, so a second process for the same root or workspace
is refused with the holder's pid. `marbles daemon` runs the process in the
foreground for a service manager, and `marbles status` shows it and which
workspaces it hosts. `--dry-run` hosts the workspace in the calling process
instead, substitutes Marbles-owned operations, and avoids state writes;
ordinary TypeScript and monitor I/O still execute.

## Embedding and execution

`@foundry.sh/marbles/engine` exports the engine, durable Execution Runs,
host tasks and their stores for bundling hosts such as Works. CLI harness SDKs
load only when those harnesses run. `@foundry.sh/marbles/statuses` exports only
Execution Run statuses and can load in a renderer.

Hosts register work with `engine.task` and launch it with `engine.launch` or
`engine.run`. Every launch joins a named FIFO queue with configurable concurrency
and no length limit. `engine.executions` reads and follows the runs and their
model-turn, tool-call and host observations. Task sessions and borrowed sandbox
handles stop with the task; closing a borrowed handle leaves its container with
its owner.

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
