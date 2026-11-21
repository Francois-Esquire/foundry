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

In your project, install the same archive with TypeScript 6 for editor types
and for names taken from a definition's `const`:

```sh
bun add --dev /absolute/path/to/foundry.sh-marbles-0.0.1.tgz typescript@^6
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
never attaches the workspace, and runs none of its source, under
`--dry-run` too. The task tools
work without a process, and without a source, for this workspace and any
workspace recorded under the state root, even one whose checkout is gone:
the Marbles process that hosts the workspace
answers, or the server opens the stored tasks for the call. `list_config`, the dispatch
tools, `get_run`, and `cancel_run` need the Marbles process to host the workspace,
and return an error that names `marbles attach` without one. Its engine
generation loads the workspace's Varlock environment and source modules,
and an edit brings up the next generation.

The server offers `list_workspaces`, `list_config`, `dispatch_workflow`,
`dispatch_agent`, `get_run`, and `cancel_run`, plus the task tools
`list_tasks`, `ready_tasks`, `get_task`, `task_dependencies`, and
`change_tasks`. Every tool but
`list_workspaces` takes an optional `workspace` id, from `list_workspaces`,
to address another workspace the process hosts instead of the server's own.
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

Both dispatch commands return acknowledgements with run metadata only, even
when status is already `completed`. Read final results through `get_run`.
Poll `get_run` with
`{ "runId": "the-returned-run-id" }` for status, final `text`/`output`, or
an `error`. Status follows the engine: `queued`, `running`, `suspended`,
`completed`, `failed`, or `cancelled`. `cancel_run` takes the same run ID and requests cancellation.
Dispatched runs belong to the engine generation that started them, so
closing the MCP connection ends only the server and leaves them running.
`get_run` looks a run up in that generation's memory: any server for the
same workspace sees it, and once that generation has exited, after a
source reload or `marbles stop`, it is forgotten, though its saved output
stays watchable.

### Watch a run

After either MCP launch command returns, wait for the result in one CLI call:

```sh
marbles watch <runId>
```

For this source checkout, without a build:

```sh
bun --no-env-file apps/marbles/src/cli.ts watch <runId>
```

`watch` replays earlier output, follows new output, prints the result and
terminal status, and exits. It reads saved output across workspaces under
the Foundry home, so it needs neither the original working directory nor
`--source`. Give it the same `FOUNDRY_HOME` as the MCP server if you moved it.
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

Diagnostics and the workspace's status lines go to stderr; stdout carries MCP
messages only. The server runs in a child process whose stdout is stderr,
so whatever it and the processes it starts print to stdout goes to stderr
too. The server exits when stdin closes, when the
`marbles mcp` process that started it exits, when it receives SIGHUP, SIGINT
or SIGTERM, or when writing a response to that process fails. Shutdown takes a few seconds at most. A task call that does not
finish in time is cut off, and the server is killed if it still runs. A
Marbles process that hosts the workspace keeps hosting it, and several MCP
clients can use one process at once. Set `FOUNDRY_HOME` to use a separate
Foundry home (each home has its own process). Under `--dry-run` the server
joins no process, lists only its own workspace, keeps its tasks in memory
for the session, and writes nothing. `list_config`, the dispatch tools,
`get_run`, and `cancel_run` then return an error. A dry run of a workflow
goes through `marbles roll --dry-run`.

### Dashboard

`marbles` attaches the workspace to the Marbles process, which starts its
schedules and monitors, and opens a dashboard on it; `marbles run </dev/null`
attaches it and follows its status lines instead. Either way the triggers
keep running after the command exits, until `marbles stop`. The dashboard
lists every workspace the process hosts (`w` moves between them) and can
answer questions; a run that asks waits on the Feed for one, and is
cancelled at the ask only under `--dry-run`. Source edits bring up the next
engine generation on their own.

### Engine generations

The Marbles process hosts every registered workspace in one engine
subprocess, a generation, and keeps clients connected to itself, so a
dashboard or `marbles run` follows its workspace across generations. An
edit to any workspace's source, a change to the Marbles installation, or
a client's reload, starts the next generation. It must load every
registered workspace; when one does not load, the error is shown on that
workspace and the running generation carries on as it was. Once it has
loaded, it takes over at once: schedules and monitors carry on from where
they were, by their key, and the runs waiting in a queue or parked on a
question move to it. The previous generation starts nothing new; it
finishes the runs it has running, whole, then exits, and with none it
exits at once; a run of it that parks on a question meanwhile moves to the
current generation as it parks, which answers it. Each schedule tick and
each task change is handled by one generation only. A generation that dies
is replaced after a pause that doubles from 1 second up to 30 while
replacements keep failing, and the next one's start puts its runs right.
What counts as a change is any file under a workspace's root (but
`node_modules`, `.git`, `.marbles` and build output), whether a load read
it or not, and any file a load or a run read outside it, as it was before
the generation loaded or when it read it. An answer is applied only by the
generation that holds its run at that moment; one that reaches another is
passed on. `marbles status`
lists the live generations.

Everything Marbles keeps is under one Foundry home, `$FOUNDRY_HOME`, else
`~/.foundry`; moving the home moves all of it, and nothing moves on its own:

```text
<home>/
  marbles/                    the state root
    marbles.db                the Marbles database, readable by its owner only, with its
    marbles.db-wal, -shm      SQLite side files while a process has it open
    marbles.sock              the Marbles process's socket
    locks/process             the Marbles process's claim on the state root
    process.json              who holds that claim, for `marbles status`
    daemon.log                what a Marbles process started in the background prints
    settings.json             preferences, the one file meant to be edited by hand
    spawned/<pid>.json        what its workspaces started and is still running, with
                              the process that started it, so a start after a crash
                              stops what an engine that is gone left behind
    <workspace-id>/
      output/<runId>.jsonl    each run's output, for `marbles watch`
      worktrees/              git worktrees cut for its steps
  artifacts/
    workspaces/<workspace-id>/blobs/   each artifact's bytes
<workspace root>/
  .marbles/artifacts/<id>/<path>       links to its own artifacts' files (`marbles relink`)
  .marbles/artifacts/@<owner>/<id>/<path>   links to those other workspaces share with it
```

The database holds the rest, for every workspace: its record, tasks and
their recorded changes, agent sessions, workflow runs and Execution Runs,
trigger state, automations, usage facts, artifact and sandbox records, the
workspace catalogue, agent grants, deferred approvals, harness activities,
who delivers its task changes, and the machine's and each workspace's
provider configuration with the identity key. Provider settings can hold
secrets, which is why the database is its owner's only. The Marbles process
claims `locks/process` at the state root and listens on `marbles.sock`
beside it, so a second Marbles process for the same home is refused with
the holder's pid. `marbles daemon` runs the process in the
foreground for a service manager, and `marbles status` shows it and which
workspaces it hosts. `--dry-run` hosts the workspace in the calling process
instead, substitutes Marbles-owned operations, and avoids state writes;
ordinary TypeScript and monitor I/O still execute. Each command decides
what the flag means for it: `run`, `roll`, `list`, `tasks` and `mcp` have
a dry mode, the listings, `status`, `watch` and `help` only read, and
`attach`, `daemon`, `detach`, `init`, `relink`, `share`, `stop` and
`unshare` refuse it before anything is opened or written. Where there is
no source, a dry run offers no starter: `marbles init`, without the flag,
creates one. A dry run writes nothing under the Foundry home but SQLite's
shared-memory index of a database that is already there
(`marbles.db-shm`), which every reader of it maps and which holds no
data; a definition the source uses as it loads runs dry too, and an
echoed worktree is an empty directory under the system's temporary
directory.

### Resources and workspaces

Runs, sessions, artifacts, sandbox containers and modules are kept in the
Marbles database, each belonging to the workspace it was created in.
`marbles share <kind> <id> <dir>` shows one of this workspace's resources in
the workspace at `<dir>` as well (a sandbox container stays with the
workspace that started it), and `marbles unshare` stops it; neither changes
the resource. `marbles runs`, `sessions`, `artifacts`, `sandboxes` and
`modules` list what this workspace shows, its own and what is shared with
it, and `--all` lists every workspace's; a run's steps are listed under it.
`marbles status` reads the same way. The dashboard's run and trigger lists
show this workspace's own (live) and those shared with it, and `g` shows
every workspace's; another workspace's runs and triggers are read only
there, as are its Feed questions. Sharing or unsharing an artifact is an `artifact.shared` or
`artifact.unshared` fact for the owner's observers. Deleting a run or an artifact removes its
shares with it.

`<workspace root>/.marbles/` holds links into the database's files for the
resources a workspace shows: for now, one link per artifact file whose
bytes a blob file holds, its own artifacts' under `artifacts/<id>/` and
another workspace's under `artifacts/@<owner>/<id>/`, each name encoded so
no two collide, case-insensitively too. Nothing reads them back.
`marbles relink [--all]` makes them match the database: it removes the
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
and `relink` repairs it. A closing engine takes no new link work and
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
`engine.run`. Every launch joins a named FIFO queue with configurable concurrency
and no length limit. `engine.executions` reads and follows the runs and their
model-turn, tool-call and host observations. Task sessions and borrowed sandbox
handles stop with the task; closing a borrowed handle leaves its container with
its owner.

An engine built with `dry: true`, through any entry (`Engine`,
`hostWorkspace`, the CLI), keeps everything in memory: it writes nothing
under its `state` directory and does not act on its `spawned` recovery
records, whatever else it is given. Stores handed to it explicitly are
the caller's: a dry run does not wrap them.

The `spawned` option (`Engine`, `hostWorkspace`, `HostedWorkspaces.open`)
names the directory of those recovery records. The engine reads them from
there when it starts, and records there each command a step runs on the
host (`exec`). Processes the bundled models, agents and usage packages
start (the Claude Code and Codex CLIs, MCP servers over stdio, usage
probes) are recorded only
where `MARBLES_SPAWN_RECOVERY` in the process environment says. A host
that passes `spawned` should set that variable to the same directory too,
or those processes are not stopped after a crash.

## Loading workspace source

Marbles loads a workspace's source with `oxc-parser`, which finds the
imports it points at that load's own copies. `oxc-parser` ships a native
binding per platform as an optional dependency, installed with
`@foundry.sh/marbles` on macOS, Linux and Windows. Installing with optional
dependencies left out, or on a platform with no binding, leaves Marbles
unable to load any workspace: the load fails with an error naming the
platform and what to install. The WebAssembly binding,
`@oxc-parser/binding-wasm32-wasi`, is used only once it is installed and
`NAPI_RS_FORCE_WASI=1` is set. Commands that load no source, such as
`status`, `tasks` and `mcp`, work without it.

Every load evaluates again each module and data file its source reaches
by path. Bun cannot unload a module, so the copies an earlier load made
stay in the process for as long as anything refers to them; the Marbles
process starts a new engine generation on a source edit, and the old one's
exit gives them back.

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
