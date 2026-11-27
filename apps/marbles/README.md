# Marbles

Marbles is a standalone CLI for automations you write in TypeScript. Run
local commands, connect steps into workflows, react to changes, and add
coding agents where a task needs judgment.

Marbles is **alpha**, starting at `0.0.1`; the current release is `0.0.4`.
Any `0.0.x` release may introduce breaking changes. `0.1.0` will mark the first supported
API baseline. Every published version is npm's `latest`.

[Workflows](../../packages/workflows/README.md) records step results and
provides optional retries and durable waiting points.
[Agents](../../packages/agents/README.md) keeps conversations,
[Workspaces](../../packages/workspaces/README.md) provides files and Git
checkouts, and [Artifacts](../../packages/artifacts/README.md) keeps
versioned outputs. Marbles bundles these libraries.

## Install

Requires Node.js 22.18+ or Bun 1.3.14+ (the interactive TUI dashboard currently requires Bun; headless commands work natively on Node and Bun — note that Node's built-in type stripping supports erasable TypeScript syntax only, while Bun also supports `enum`, namespaces, and `.tsx`). Install the published package:

```sh
bun add --global @foundry.sh/marbles@0.0.4
marbles --help
```

In your project, install the same package for editor types:

```sh
bun add --dev @foundry.sh/marbles@0.0.4
```

The [installation guide](https://francois-esquire.github.io/foundry/marbles/get-started/installation/)
covers editor types and optional capabilities. Features added after a
release may need an archive built from a checkout; contributors can
[build an archive](https://francois-esquire.github.io/foundry/marbles/contributing/#build-a-distributable-package).

## Write one automation

Save this as `.foundry/marbles/inventory.ts` in your project:

```ts
import { step } from "@foundry.sh/marbles";

export const inventory = step("inventory").do(async ({ workspaces, log }) => {
  const files = await workspaces.current.files();
  log(`Found ${files.length} files`);
  return { files: files.length };
});
```

From that project's root:

```sh
marbles list
marbles run inventory
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

export const reviewer = agent({
  prompt: "Review the staged changes. Report findings without editing files.",
});

export const review = step("review").do(async ({ agents }) => {
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

See the [MCP reference](../documentation/marbles/reference/mcp.md) for setup, tools,
arguments, and the launch-and-watch flow.

`marbles mcp` serves MCP over stdin and stdout. Set `cwd` to the project
whose Marbles modules you want to load:

```json
{
  "mcpServers": {
    "marbles": {
      "command": "marbles",
      "args": ["mcp", "--source", "/absolute/path/to/project/.foundry/marbles"],
      "cwd": "/absolute/path/to/project"
    }
  }
}
```

From this checkout, without a build, run `bun --no-env-file
/absolute/path/to/foundry/apps/marbles/src/cli.ts mcp` with the same flags.

`--source` accepts a file or directory and defaults to `.foundry/marbles`
under `cwd`. The server reads and writes that workspace's stored state and
drives the Marbles process when one runs. It never starts the process,
never attaches the workspace, and runs none of its source. Workspaces and tasks
work without a process, and without a source, for this workspace and any
workspace recorded under the state root, even one whose checkout is gone:
the Marbles process that hosts the workspace
answers, or the server opens the stored tasks for the call. Definitions,
runs, a workspace's configuration, `enqueue_workflow`, `dispatch_agent`, and
`cancel_run` need the Marbles process to host the workspace, and return an
error that names `marbles start` without one. Its engine
generation loads the workspace's source modules, and an edit brings up the next generation.

The server offers six tools: `list`, `get`, `enqueue_workflow`,
`dispatch_agent`, `cancel_run`, and `change_tasks`. Each takes an optional
`workspace` id, from `list` with `resource: "workspaces"`, to address another
workspace the process hosts instead of the server's own; `list` of
workspaces and `get` of a workspace refuse it.

`list` takes a `resource`, `workspaces`, `definitions`, `tasks`, or `runs`,
and returns `{ items, total, nextCursor? }`; pass `nextCursor` back as
`cursor` for the next page (runs cursors page the current newest-first list,
so offsets can shift if new runs arrive between pages). Its `filter` takes
only the keys its resource names: `kind` and `name` for definitions; `status`,
`parentId`, `tags`, and `ready: true` (open tasks nothing holds back) for
tasks; `status` (`queued`, `running`, `suspended`, `completed`, `failed`, or
`cancelled`), `name`, and `kind` (`agent` or `workflow`) for runs, newest
first. `depth` expands subtasks. `get` takes a `resource`, `workspace`,
`definition`, `task`, or `run`, and an `id`, and returns `{ item }`. A
workspace's summary is read without a process; its `definitions`, `agents`,
`schedules`, `monitors`, and `observers` come once it is hosted and ready. A
task's `dependsOn` and `dependents` are read only when `fields` asks for them.
Both tools take `fields`, the top-level fields to return; the identity field,
`id`, or `name` for a definition, is always kept. A task's `updatedAt` is the
`expectedUpdatedAt` token for `change_tasks`. Tool refusals return `isError:
true` with `{ "error": { "code", "message" } }` (such as `not_hosted`,
`not_ready`, `not_found`, `invalid_fields`, `invalid_filter`, or
`invalid_argument`); root-schema input validation failures are returned by the
MCP SDK as `isError: true` plain validation text before the handler runs.

`enqueue_workflow` takes `name`, optional `input`, and an optional nonblank
`key`, launches the step or workflow in the background, and returns its run
`id` with its current engine status. A second call with the same `name` and
`key` in the workspace returns the run already queued under it. Read a
definition's input schema with `get` (`resource: "definition"`) or `list`
(`resource: "definitions"`, `fields: ["inputSchema"]`). Schedules and monitors
are listed by `get` but are not addressable by `enqueue_workflow` or polled by
this server.

`dispatch_agent` starts an agent in the background and returns a run `id`,
`session`, and current status immediately after session setup. It accepts:

- `prompt`: the task to perform.
- `agent`: an optional declared agent ID. Omit it for an ad hoc agent.
- `instructions`: instructions for an ad hoc agent, or additional instructions
  appended to a declared agent's prompt.
- `model` and `provider`: overrides for the agent's route.
- `cwd`: working directory, resolved relative to the loaded workspace root.
  After following links it must be a directory inside the workspace root or
  inside one of the workspace's worktrees that Marbles created; any other
  path is refused.
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

Both launch tools return acknowledgements with run metadata only, even
when status is already `completed`. Read final results through `get` with
`{ "resource": "run", "id": "the-returned-run-id" }` for status, final
`text`/`output`, or an `error`, or follow a run live with `marbles watch
<id>`. Status follows the engine: `queued`, `running`, `suspended`,
`completed`, `failed`, or `cancelled`. `cancel_run` takes the same `id` and requests cancellation.
Dispatched runs belong to the engine generation that started them, so
closing the MCP connection ends only the server and leaves them running.
`get` reads the run's stored records, so any server for the same
workspace finds it, and a later generation still finds it after a source
reload or `marbles stop`, once a Marbles process hosts the workspace
again. Its saved output stays watchable.

### Trigger and watch a run

`marbles trigger <name> [--input <json>]` runs one step, workflow, schedule,
or monitor in the foreground, waits for it, and prints its output and result.
Add `--async [--key <key>]` to put one step or workflow on the workspace's
queue in the Marbles process, starting the process when none runs, and exit at
once. Its run ID is the only line on stdout, so a script can keep it
(`id=$(marbles trigger build --async)`); a line on stderr says what was
queued. `--key` enqueues the definition once per key, the key a definition's
own `enqueue(input, { key })` and `step.enqueue(name, input, { key })` match
too: a later trigger with the same key prints the first run's ID, whatever
became of it. Pass `--json` to any data command (such as `workspaces`, `list`,
`trigger`, `tasks`, `start`, `stop`, `settings`, or resource commands) for
structured JSON on stdout.

After `marbles trigger --async` or either MCP launch command returns, wait for the
result in one CLI call:

```sh
marbles watch <runId>
```

For this source checkout, without a build:

```sh
bun --no-env-file apps/marbles/src/cli.ts watch <runId>
```

`watch` replays earlier output, follows new output, prints the result and
terminal status, and exits. A run still waiting in its queue has no output
yet; `watch` says so and waits for it to start. It reads saved output across workspaces under
the Foundry home, so it needs neither the original working directory nor
`--source`. Give it the same `FOUNDRY_ROOT` as the MCP server if you moved it.
It never imports configuration or starts an engine. Multiple watchers can
follow the same run independently.

Persisted engines append output to
`<state>/<workspace-id>/output/<runId>.jsonl`. This includes agent text,
workflow `stream.write`/`exec` output, and step lifecycle messages. Raw
`console.log` and process stdout still belong to the owning process's
stderr. Completed output remains watchable after that process exits.
Output from runs started before this feature has no saved journal to watch.
Output files have no retention policy yet.

The watcher exits with code 0 on completion, 1 on failure or cancellation,
and 130 when interrupted. Interrupting the watcher does not cancel the run.
If the owner disappears without recording an ending, the watcher reads the
run's Execution Run from the Marbles database before it gives up. A run
that is suspended or queued, or running under a live owner, is still being
handed over, and the watcher keeps following it to its new owner's ending.
A run recorded as completed, failed or cancelled ends the watch with that
status. Otherwise, or without a database, the watcher reports that the run
lost its owner rather than waiting indefinitely. A journal with no
readable start record two seconds after the watcher opened it is reported
as such.

Diagnostics and the workspace's status lines go to stderr; stdout carries MCP
messages only. The server runs in a child process whose stdout is stderr,
so whatever it and the processes it starts print to stdout goes to stderr
too. The server exits when stdin closes, when the
`marbles mcp` process that started it exits, when it receives SIGHUP, SIGINT
or SIGTERM, or when writing a response to that process fails. Shutdown takes a few seconds at most. A task call that does not
finish in time is cut off, and the server is killed if it still runs. A
Marbles process that hosts the workspace keeps hosting it, and several MCP
clients can use one process at once. Set `FOUNDRY_ROOT` to use a separate
Foundry home (each home has its own process).

### Dashboard

`marbles`, with no command, attaches the workspace to the Marbles process,
which starts its schedules and monitors, and opens a dashboard on it;
`marbles </dev/null` attaches it and follows its status lines instead.
Either way the triggers keep running after the command exits, until
`marbles stop`. `marbles trigger <name>` runs one step, workflow,
schedule or monitor now, waits for it, prints its output and result, and
exits; `marbles trigger` with no name opens nothing. The dashboard
lists every workspace the process hosts (`w` moves between them) and can
answer questions; a run that asks waits on the Feed for one. Source edits bring up the next
engine generation on their own.

### Engine generations

The Marbles process hosts every registered workspace in one engine
subprocess, a generation, and keeps clients connected to itself, so a
dashboard, or `marbles` with its output piped, follows its workspace across generations. An
edit to any workspace's source, a change to the Marbles installation, or
a client's reload, starts the next generation. It must load every
registered workspace; when one does not load, the error is shown on that
workspace and the running generation carries on as it was. Once it has
loaded, it takes over at once: schedules and monitors carry on from where
they were, by their key, and the runs waiting in a queue or suspended on a
question move to it. The previous generation starts nothing new; it
finishes the runs it has running, whole, then exits, and with none it
exits at once; a run of it that suspends on a question meanwhile moves to the
current generation as it suspends, which answers it. Each schedule occurrence
and each task change is handled by one generation only. A generation that dies
is replaced after a pause that doubles from 1 second up to 30 while
replacements keep failing, and the next one's start puts its runs right.
What counts as a change is any file under a workspace's root (but
`node_modules`, `.git`, `.marbles` and build output), whether a load read
it or not, and any file a load or a run read outside it, as it was before
the generation loaded or when it read it. An answer is applied only by the
generation that holds its run at that moment; one that reaches another is
passed on. `marbles workspaces`
lists the live generations.

Everything Marbles keeps is under one Foundry home, `$FOUNDRY_ROOT`, else
`~/.foundry`; moving the home moves all of it, and nothing moves on its own:

```text
<home>/
  marbles/                    the state root, readable by its owner only
    marbles.db                the Marbles database, readable by its owner only, with its
    marbles.db-wal, -shm      SQLite side files while a process has it open
    marbles.sock              the Marbles process's socket, its owner's only
    locks/process             the Marbles process's claim on the state root
    process.json              who holds that claim, for `marbles workspaces`
    daemon.log                what a Marbles process started in the background prints
    settings.json             preferences, the one file meant to be edited by hand
    <workspace-id>/
      output/<runId>.jsonl    each run's output, for `marbles watch`
      worktrees/              git worktrees cut for its steps
  processes/<pid>.json        what Foundry processes started and is still running, with
                              the process that started it, so a start after a crash
                              stops what an engine that is gone left behind
  artifacts/
    workspaces/<workspace-id>/blobs/   each artifact's bytes
<workspace root>/
  .marbles/artifacts/<id>/<path>       links to its own artifacts' files
  .marbles/artifacts/@<owner>/<id>/<path>   links to those other workspaces share with it
```

The database holds the rest, for every workspace: its record, tasks and
their recorded changes, agent sessions, workflow runs and Execution Runs,
trigger state, automations, usage facts, artifact and sandbox records, the
workspace catalogue, agent grants, deferred approvals, harness activities,
who delivers its task changes, and the machine's and each workspace's
provider configuration with the identity key. Provider settings can hold
secrets, which is why the database is its owner's only. The Marbles process
creates the state root mode 0700 and tightens an existing one to that when
it starts, claims `locks/process` at the state root and listens on `marbles.sock`
beside it, so a second Marbles process for the same home is refused with
the holder's pid. `marbles start` ensures the background Marbles process is
running, hosts this workspace in it, and exits; `marbles stop` stops the
process and every workspace it hosts; and `marbles stop --workspace` stops
hosting only this workspace, so it is not started again at boot. `marbles workspaces`
shows the process and which workspaces it hosts (and `marbles workspaces get <id|dir>`
inspects one workspace). Pass `--json` to any data command for structured JSON output
on stdout (bypassing interactive TUI views such as `marbles workspaces`).

### Resources and workspaces

Workspaces, tasks, runs, sessions, artifacts and sandbox containers are kept in
the Marbles database, each belonging to the workspace it was created in.
Each kind of resource has its own command: `marbles workspaces`, `tasks`, `runs`,
`sessions`, `artifacts` and `sandboxes` support `list` (the default) and `get <id>`,
with `--workspace <id|dir>` to target another workspace or `--all` to list across
every workspace (`tasks` also supports `create` and `update`). The dashboard's
run and trigger lists show this workspace's own (live) and those shared with it,
and `g` shows every workspace's; another workspace's runs and triggers are read
only there, as are its Feed questions.

`<workspace root>/.marbles/` holds links into the database's files for the
resources a workspace shows: for now, one link per artifact file whose
bytes a blob file holds, its own artifacts' under `artifacts/<id>/` and
another workspace's under `artifacts/@<owner>/<id>/`, each name encoded so
no two collide, case-insensitively too. Nothing reads them back.
`marbles artifacts relink [--all]` makes them match the database: it removes the
links Marbles made that no longer should be there and makes the missing
ones, leaving anything else (a file, a link of your own) and reporting it.
Before each change, the directory it is made in or removed from is checked
to be a real directory inside the real `.marbles`; one that is a link, a
file or elsewhere refuses that link, reported, and what was just made
through a directory that moved meanwhile is removed again. A process that
can write in your workspace can still swap a directory in the moment
between a check and the change after it; nothing in the runtime closes
that window. Once a workspace has links, they follow each artifact write
after it lands, in the artifact's owner and every workspace it is shared
with; a link that cannot be made is reported, never failing the write,
and `marbles artifacts relink` repairs it. A closing engine takes no new link work and
waits for the updates its writes queued; after five seconds it gives up
those still waiting for a `.marbles/.lock` or their turn, reporting them
for `relink`, and lets the one under way reach its next step, so it
leaves links as they were or made, never half made. The five seconds are
no deadline: a read of the database under way is waited for however long
it takes, and only a generation's stop timeout bounds the close. A write
that lands once the close has begun has its links left for `relink`,
reported once. Every rebuild and update, in any process, holds
`.marbles/.lock` and reads what each link should be from the database
under it, so concurrent ones converge on what the database holds. A file
the database holds inline (or in chunks), or whose name is too long for
the file system, has no link. `.marbles/.gitignore` keeps the directory
out of git. An artifact store inside a transaction the host owns cannot
keep links (`HostBoundStoreError`).

## Embedding and execution

`@foundry.sh/marbles/engine` exports the engine, durable Execution Runs,
host tasks and their stores for bundling hosts such as Works. CLI harness SDKs
load only when those harnesses run. `@foundry.sh/marbles/statuses` exports only
Execution Run statuses and can load in a renderer.

Hosts register work with `engine.task` and launch it with `engine.launch` or
`engine.run`. Every launch is a job of the engine's `@foundry/queue` from the
moment it is launched, in a named FIFO concurrency pool with a configurable
limit and no length limit; a long-lived task belongs in a pool of its own whose
limit is `Infinity`, so it never holds a bounded one. Source files configure
pools with `export default defineConfig({ pools: { review: 2 }, pool: "review" })`.
Pool limits are positive integers or `Infinity`. Hosted and script engines use
limit 4 in `default`; raw engines use 1. Awaiting an enqueued run holds the
caller's place; use `.run()` inline or separate pools. `engine.executions` reads
and follows the runs and their model-turn, tool-call and host observations. Task
sessions and borrowed sandbox handles stop with the task; closing a borrowed
handle leaves its container with its owner.

The `spawned` option (`Engine`, `hostWorkspace`, `HostedWorkspaces.open`)
names the directory of those recovery records. The engine reads them from
there when it starts, and records each command a step runs on the host
(`exec`) only when it has one. Records are written to
`$FOUNDRY_ROOT/processes`, else `~/.foundry/processes`, by Marbles and by
the bundled models, agents and usage packages (the Claude Code and Codex
CLIs, MCP servers over stdio, usage probes), so a host that passes
`spawned` should pass that directory, or what it records is not stopped
after a crash. Under a test runner that sets `VITEST`, nothing is recorded
unless `FOUNDRY_ROOT` is set.

## Loading workspace source

Marbles loads workspace ES modules natively on Node.js 22.18+ (via
`module.registerHooks`) and Bun 1.3.14+ (via `Bun.plugin`), with no native
parser binding or TypeScript compiler required at runtime. Export steps,
workflows, agents, schedules, monitors, observers, and providers (`export const
...`) so Marbles collects them into the workspace catalog. CommonJS workspace
modules (`.cjs`) are refused; use ES modules (`.ts`, `.mts`, `.js`, `.mjs`).
The interactive TUI dashboard currently requires Bun, while headless commands
(`list`, `run`, `enqueue`, `watch`, `status`, `tasks`, `mcp`, `daemon`) run
natively on both Node.js 22.18+ and Bun.

Every load evaluates again each module and data file its source reaches
by path. Neither Node nor Bun unloads ESM modules from memory, so the Marbles
process starts a new engine generation on a source edit, and the old one's
exit reclaims them.

## Documentation

| Need | Read |
| --- | --- |
| Explore what you can build | [Using Marbles](https://francois-esquire.github.io/foundry/marbles/get-started/using-marbles/) |
| Understand definitions, runs, resources, and durability | [Foundation](https://francois-esquire.github.io/foundry/marbles/foundation/api/) |
| Build an issue-driven development cycle | [Software Factory](https://francois-esquire.github.io/foundry/marbles/use-cases/software-factory/) |
| Look up commands or authoring options | [CLI](https://francois-esquire.github.io/foundry/marbles/reference/cli/) and [API](https://francois-esquire.github.io/foundry/marbles/reference/api/) |
| Operate or troubleshoot the runtime | [State](https://francois-esquire.github.io/foundry/marbles/reference/state/), [safety](https://francois-esquire.github.io/foundry/marbles/reference/safety/), and [remote execution](https://francois-esquire.github.io/foundry/marbles/reference/remote/) |
| Host or develop Marbles | [Embedding](https://francois-esquire.github.io/foundry/marbles/reference/engine/) and [Contributing](https://francois-esquire.github.io/foundry/marbles/contributing/) |

For terminal UI development, see the [stories guide](stories/README.md).
