---
title: Embedding the engine
description: Host Marbles in a Bun application with explicit dependencies and lifecycle ownership.
---

Embed `Engine` from `@foundry.sh/marbles/lib` when a Bun application needs to
launch and inspect Marbles work. The host supplies configured package
instances, registers definitions, and owns startup and shutdown.

Marbles connects those instances to step contexts, the Feed, approvals,
and run execution. The [package map](/marbles/foundation/primitives) explains
what each library provides.

## Create and run an engine

This example counts files with in-memory stores and no agent provider or
sandbox runtime:

```ts
import { step } from "@foundry.sh/marbles";
import {
  ArtifactManager,
  Engine,
  InMemoryArtifactStore,
  InMemorySessionStore,
  ModelManager,
} from "@foundry.sh/marbles/lib";

const engine = new Engine({
  models: new ModelManager(),
  sessions: new InMemorySessionStore(),
  // Called at the first sandbox; `createContainers` over your runtime.
  containers: () => Promise.reject(new Error("no sandbox runtime here")),
  artifacts: new ArtifactManager({ store: new InMemoryArtifactStore() }),
  root: process.cwd(),
  workspaceId: "my-app",
  // Add a state directory to persist run records and tasks. Configure
  // persistent session and artifact stores separately; these two are in memory.
  askable: false, // true when something in this process can answer `ask`
});

engine.define(
  step("inventory").do(
    async ({ workspaces }) => (await workspaces.current.files()).length
  )
);

try {
  await engine.start();
  const count = await engine.run<number>("inventory", {});
  console.log({ count });
} finally {
  await engine.stop();
  await engine.dispose();
}
```

`models`, `sessions`, `containers`, and `artifacts` are required. `workspaces`
is optional: without it the engine builds a workspace system over the local
filesystem, watched, whose `git()` layer runs git as the `git` option says. A
host that brings its own `WorkspaceSystem` builds its `git()` layer with the
same options it passes as `git`. The engine hands the instances back
(`engine.models`, `engine.sessions`, `engine.workspaces.system`,
`engine.sandboxes.containers()`) and closes them in `dispose()`.
`engine.triggers` is the store it keeps trigger state in,
`engine.executions` its Execution Runs (`subscribe` is async: its snapshot
is read from the store), and `engine.scopes` is a read-only view of the
runs in flight: each run's `RunScope` by run id.

## Launch without waiting

For background work in a long-lived host, `launch` returns the run ID and a
result promise after dispatch, rather than waiting for execution to finish:

```ts
const launched = await engine.launch<number>("inventory", {});
console.log({ runId: launched.id });
const count = await launched.result;
```

`run(name, input)` and `execute(definition, input)` wait for the result
instead. Register a definition with `define` to launch it by name. The
[MCP tools](/marbles/reference/mcp#tools) use `launch` for workflows and one
registered agent-dispatch step, exposing the handle's `id` as `runId` for both.

The host must keep the engine alive while work executes, handle a rejected
result promise, and stop/dispose the engine on shutdown. A persisted engine
writes the [run output journal](/marbles/reference/state#run-output) while
work runs; that output is separate from the run's recovery snapshot.

## Use resources directly

This excerpt assumes the `engine` above and configured model and
container providers. The managers a step body gets as `agents`, `workspaces`, `sandboxes`, and
`artifacts` are on the engine too, with the same methods, and work without a
run and before `start()`:

```ts
import { agent, artifact } from "@foundry.sh/marbles";

const reviewer = agent({ prompt: "Review the diff." });
const report = artifact({ name: "review", type: "text/markdown" });

const repo = await engine.workspaces.load({ path: "/path/to/repo" });
const session = await engine.agents.session(reviewer, { cwd: repo.root });
const reply = await session.generate("Review this.");
const box = await engine.sandboxes.start({ image: "oven/bun:1-slim" });
const version = await engine.artifacts.write(report, {
  "report.md": reply.text,
});
```

Inside a step these calls are tied to the step: they replay to the same
session, sandbox, or version, stop when the step is cancelled, and close when
the run settles. On the engine there is no step, so each call is new, a
sandbox is yours to close, and whatever is still open closes on `dispose()`.
`engine.sandboxes.containerOf(box)` returns the container behind a sandbox
the engine opened.

## Register work

The engine owns its registry:

- `engine.define(definition)` adds a named step or workflow. The authoring
  words return exactly that, so `engine.define(step("x").do(...))` works.
- `engine.schedule(record)` registers a schedule; it does not start a clock.
- `engine.monitor({ key, source, trigger, handler })` registers a monitor
  for a host to drive.
- `engine.definitions()` and `engine.monitors()` read it back;
  `await engine.schedules()` reads the schedules with the triggers agents
  created, read afresh, so one another process created or removed is in or
  out.

Importing a `.foundry/marbles/inspect.ts` does not fill an engine you built. The module's
own collection is private to the CLI, which copies it into the engine it
builds. A host that wants a module's definitions exports them from the module
and defines them.

## Host settings

| Option | Responsibility |
| --- | --- |
| `print` | Receives engine status and body log lines. |
| `home` | Selects the directory for shared skills. |
| `git` | Chooses the Git runner, such as one that echoes commands. |
| `worktrees` | Sets the default checkout directory, otherwise `Engine.worktreesFor(state)`. |
| `dry` | Runs sandbox agent requests in the host process. |
| `runs` | Keeps workflow Runs, what each run's scope recorded, and which engine owns each. |
| `executionStore` | Keeps every run's Execution Run, its observations, and what pruning removed. |
| `triggers` | Keeps each schedule's and monitor's last tick and each monitor's state. |
| `automationStore` | Keeps the triggers agents create. |
| `usageStore` | Keeps each agent turn's usage fact. |

Each store is in memory when it is omitted (`MemoryRunStore`,
`MemoryExecutionStore`, `MemoryTriggerStore`, `MemoryAutomationStore`,
`MemoryUsageStore`, all exported). The `Engine` the package publishes keeps
each one it is not handed in the [Marbles database](/marbles/reference/state)
when `state` is set, over one handle it closes on `dispose`. `records`, the
workspace's tasks, is described [below](#tasks).

## Persistence and durability

[Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md)
provides the orchestrator and step execution. Marbles adds run-owned
sessions, resources, and the saved ledger used when a parked run replays.
The [durability contract](/marbles/foundation/durability) still applies when
you embed the engine; the library's broader recovery APIs do not change
Marbles' adoption rules.

The example above deliberately keeps everything in memory. Supplying
`state` enables run persistence, the default persistent trigger store, and
[persistent tasks](#tasks);
provide a persistent session store and artifact store with durable bytes
separately. Persisting run records alone cannot retain agent transcripts
or report files. Set `askable: true` only when the host can present and
answer questions. Define the same named work before `start()` so parked
runs can be adopted.

## Tasks

The engine's `taskStore` holds the workspace's tasks, which `observe`
handlers receive the changes of. With `state` set and no `records`, the
`Engine` from `@foundry.sh/marbles/engine` and `@foundry.sh/marbles/lib`
keeps them in a Marbles database, opened at the first task call and
closed by `dispose()`:

- When `state` is the directory Marbles itself keeps the workspace at
  `root` in (`<state root>/<workspace id>`, the id Marbles derives from
  `root`, and `workspaceId` that id), it is the database of that state
  root, `<state root>/marbles.db`: the tasks the CLI and the MCP server see
  for that workspace.
- Otherwise it is a database of the engine's own, `<state>/marbles.db`.

The database is made and migrated only by a process holding
`locks/process` beside it: the engine takes it for that moment alone, or
uses it when this process already holds it (a host that claimed its own
`state` with `claimProcess`). When another process holds it, the engine
waits up to five seconds for the database to be current, and its first
task call fails otherwise. Without `state` the
tasks are in memory. A `tasks.json` an earlier Marbles left in `state` is
ignored.

To choose yourself, pass `records`. `new MemoryWorkspaceRecords()` (from
either engine entry) keeps them in memory on purpose, even with `state`.
`openWorkspaceRecords` from `@foundry.sh/marbles/workspace` opens a
workspace's tasks in the database of any state root, under the same rule,
and is closed by the engine that is handed it:

```ts
import { Engine } from "@foundry.sh/marbles/lib";
import { layout, openWorkspaceRecords } from "@foundry.sh/marbles/workspace";

const marbles = layout();
const { id } = marbles.workspace(process.cwd());
const engine = new Engine({
  ...instances, // models, sessions, containers, artifacts, as above
  records: openWorkspaceRecords({ state: marbles.state, workspaceId: id }),
  root: process.cwd(),
  workspaceId: id,
});
```

Delivery to observers is claimed through the records. The database's
records claim it in a transaction on the workspace's row of
`marbles_delivery_claims`, so of the engines that share a workspace's
records only one delivers; the others wait, and take the claim once its
holder releases it or its process is gone. Records kept in memory grant
every claim.

`WorkspaceRecords` is the type a host implements to keep the tasks
elsewhere: `taskStore`, the change log its stores record into (`log`),
`watch`, `close`, and the delivery claim (`claimDelivery` and
`releaseDelivery`).

## Package instances

The package bundles its Foundry packages, so take the classes the
instances are built from out of `@foundry.sh/marbles/lib` as well. An instance
built from another copy of the same class is a different type. Besides
`Engine`, its types, and three constants (`CLI_HARNESS_IDS`, `CLI_HARNESSES`,
`TERMINAL_RUN_STATUSES`), the entry exports only those:

| Instance | Exports | Underlying library |
| --- | --- | --- |
| `models` | `ModelManager`, `claudeCodeProvider`, `codexProvider`, `piProvider` | [Models](https://github.com/Francois-Esquire/foundry/blob/main/packages/models/README.md) |
| `sessions` | `InMemorySessionStore` | [Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md); the published `Engine` given `state` keeps them in the [Marbles database](/marbles/reference/state#sessions). |
| `workspaces` | `WorkspaceSystem`, `directory`, `git`, `nodeObserver` | [Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md) |
| `containers` | `createContainers`, `MemoryContainerStore` | [Sandbox](https://github.com/Francois-Esquire/foundry/blob/main/packages/sandbox/README.md) |
| `artifacts` | `ArtifactManager`, `InMemoryArtifactStore`, `JsonArtifactStore`, `blobFiles` | [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md) |
| `runs`, `executionStore`, `triggers`, `automationStore`, `usageStore` | `MemoryRunStore`, `MemoryExecutionStore`, `MemoryTriggerStore`, `MemoryAutomationStore`, `MemoryUsageStore` | Marbles' own stores; the published `Engine` keeps them in the Marbles database when `state` is set. |

One thing a host cannot do through this entry yet: the MicroSandbox runtime
`createContainers` needs is not exported. Firing the engine's triggers is
the workspace entry's job, below.

## Host one workspace

`@foundry.sh/marbles/workspace` hosts a workspace the way the CLI does,
without the CLI: `hostWorkspace` finds the source, loads the environment,
imports the modules, builds and starts the engine, and returns a
`WorkspaceHost`: the `WorkspaceConnection` the dashboard, the CLI, and the
MCP server are written against, plus the engine itself. `layout` decides
where state and artifacts live (`FOUNDRY_HOME`, else `~/.foundry`).

```ts
import type { ProcessInstance } from "@foundry.sh/marbles/process";
import { claimProcess } from "@foundry.sh/marbles/process";
import {
  hostWorkspace,
  layout,
  type WorkspaceHost,
} from "@foundry.sh/marbles/workspace";

const marbles = layout();
const source = "/path/to/project/.foundry/marbles";
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());

let claim: ProcessInstance | undefined;
let host: WorkspaceHost | undefined;
try {
  // Inside the try, so the claim is released when the engine fails to start.
  host = await hostWorkspace({
    artifacts: marbles.artifacts,
    askable: false, // true when something in this process can answer `ask`
    prepare(engine) {
      // Before the engine starts, which is what adopts parked runs.
      if (engine.state !== undefined) {
        claim = claimProcess(engine.state, { config: source, host: "worker" });
      }
    },
    print: (line) => console.error(line),
    source,
    state: marbles.state,
  });
  const rolled = await host.roll("inventory");
  console.log(rolled.value);
  await host.run(controller.signal); // tick triggers until interrupted
} finally {
  await host?.close();
  claim?.release();
}
```

`roll` dispatches one definition or schedule and returns its value with the
status lines printed meanwhile, as `marbles roll` does. `run` ticks the
schedules and monitors, including triggers agents add later, until the
signal aborts; `runSchedulesUntilStopped(engine, options)` is the same loop
over a bare engine. `describe`, `snapshot`, `dispatchWorkflow`,
`dispatchAgent`, `getRun`, `cancelRun`, and `actions` are what the MCP
tools and the dashboard call. `close` stops the engine, cancelling live
runs, and disposes what it opened.

Each host loads its workspace's source into a catalog of its own, and its
`.env.schema` into the environment the workspace's runs carry, leaving
`process.env` as it was; two hosts in one process never see each other's
definitions, triggers, agents, tasks or values, and two workspaces may use
the same names. What a workspace's modules do later, from a timer, a
promise or a listener, still belongs to that workspace, and is refused once
its host has closed. Every module a workspace's source imports by path,
under its root or not, is loaded for that workspace alone; a package,
imported by name or from `node_modules`, is shared by every workspace in
the process, and what it declares while a workspace loads is refused: a
package that makes definitions exports a function taking the words it
uses (`export const make = ({ step }) => step("helper").do(…)`), which the
workspace's source calls with its own (`make({ step })`). Loading a
workspace again in the same process costs a whole load: every module and
data file its source reaches by path is read and evaluated again, and Bun
keeps each earlier load's copies for as long as anything refers to them. A relative `source`, or a
workspace with no source at all, needs `directory`: the directory the
source is relative to, which is the workspace's root without one. `cwd`
sets where the workspace's runs start and its commands run, the root when
omitted. Claim the workspace's state directory
(`engine.state`, which is `<state>/<workspace-id>`) inside `prepare`, so
the engine starts only once the claim holds, and two programs hosting the
same workspace themselves never adopt the same parked runs. The Marbles
process claims no workspace directory: its engine generations take each
parked run by a claim on its row in the Marbles database instead, and one
of them hosting the workspace while your program does is not refused by
the lock. A live
holder throws `ProcessHeldError`, naming who has it; a lock left by an
exited process is taken over. Pass `dry: true` to persist nothing, and
`env: "require"` to refuse a `.env.schema` that does not resolve (the
default warns). `watchSource(configPath, { onChange, signal })` polls the
authoring folder, helpers included, every second and reports a change; a
host restarts itself on one, since loaded modules cannot be unloaded.
`createStarter` writes a starter module for a workspace without one.

## Start or join the Marbles process

`@foundry.sh/marbles/process` is the one Marbles process for a machine, and
how to be its client. Neither side imports an authoring module: the daemon
hosts every attached workspace in one engine subprocess, its current
generation, and a client reaches them through the daemon, its
subscriptions kept there across every switch to the next generation.

```ts
import { connect, layout } from "@foundry.sh/marbles/process";

const client = await connect({ layout: layout() });
try {
  const summary = await client.attach("/path/to/project/.foundry/marbles");
  const workspace = client.workspace(summary);
  const unsubscribe = client.subscribe(summary.id, {
    line: (line) => console.error(line),
    workspace: (next) => console.error(`${next.id} is ${next.state}`),
  });
  const { definitions } = await workspace.describe();
  console.log(definitions.map((entry) => entry.name));
  const dispatched = await workspace.dispatchWorkflow("inventory", {});
  const run = await workspace.getRun(dispatched.runId);
  console.log(run.status);
  unsubscribe();
} finally {
  client.close();
}
```

`connect` joins the daemon listening on the layout's socket, or starts one
detached (logging to `<state>/daemon.log`) when none runs; a daemon of
another Marbles version is stopped and replaced first. `start: false`
throws `NoProcessError` instead of starting one, and refuses a daemon of
another version rather than stop it. Either way, a daemon that keeps its
artifacts somewhere other than `layout.artifacts` is refused, naming both
paths; both refusals are a `ProcessMismatchError`, and a daemon that holds
the claim but does not answer is a `ProcessTimeoutError`. `stopProcess({
layout })` is what `marbles stop` does: it stops the daemon whatever its
version, calls `onStopping` once the daemon has agreed, and resolves with
that daemon's `hello` once it has exited, or `undefined` when none ran.
`attach` hosts the source's workspace, records it as `hosted` in the
Marbles database, and resolves once the current engine generation hosts it,
or rejects with the load error when its source throws, leaving it
unregistered unless it was registered before; attaching another source
under a root that is already hosted rejects until that workspace is
detached. Attaches, detaches and switches take turns, so an attach during
a reload resolves once the reload's generation is current.
`workspace(summary)` is the same `WorkspaceConnection` as above, each call a
request the daemon routes: a call about a run to the generation that owns
it, an answer or an activity's stop to the one holding it, anything else
to the current generation. `workspaces()` lists every hosted workspace with
its state (`starting`, `ready`, `reloading`, `failed` with `error`,
`stopped`) and the pid of the generation hosting it; a `ready` workspace
with an `error` runs as it was because a change to it did not load.
`reload(id)` starts the next engine generation, which takes over once it
has loaded every registered workspace, and is also what revives a `failed`
one; `detach(id)` stops hosting it, its running work drained first, and
clears `hosted`; `shutdown()` asks the daemon to stop and resolves once it
has answered, while it drains its generations and exits. From
then on it refuses `attach`, `reload`, and the workspace calls that start
work, while reads, answers, and cancels go through. `close()` detaches,
and the daemon keeps hosting; `closed` resolves once the connection is
gone, with a `Disconnect` saying why: `closed` after `close()`, `stopped`
when the daemon stopped and released its claim, `died` when its claim
still names a pid that no longer runs (with the log to read), `hung-up`
when it is alive and dropped this connection, or `failed` with the socket
error. `describeDisconnect` turns one into a line; headless `marbles run`
prints it and exits 1 for anything but a stop. A live run's stream does not cross the socket, so
`actions.runs.stream` is absent on a remote connection; read the
[output journal](/marbles/reference/state#run-output) instead.

To be the process yourself, as `marbles daemon` is:

```ts
import {
  layout,
  ProcessHeldError,
  startDaemon,
} from "@foundry.sh/marbles/process";

const marbles = layout();
try {
  const daemon = await startDaemon({
    layout: marbles,
    print: (line) => console.error(line),
  });
  process.once("SIGINT", () => {
    daemon.close().catch(() => undefined);
  });
  await daemon.closed;
} catch (error) {
  if (error instanceof ProcessHeldError) {
    console.error(error.message); // names the pid that has it
    process.exit(1);
  }
  throw error;
}
```

`startDaemon` claims `locks/process` at the state root, writes
`process.json` beside it, listens on `layout.socket`, hosts every workspace
recorded as `hosted` whose source still exists, and returns once it
answers. `close` drains every engine generation (30 seconds to answer and
as long to exit, then SIGKILL to its process group once its pid is proved
to be the process it spawned) and releases the claim; `closed` resolves after that, including when a `shutdown`
request or a lost claim ended it. After a lost claim it leaves the socket
path alone, since a successor may listen there by then. `readProcess(dir)` reads a claim back from
its files, which is what `marbles status` shows for the state root; the
engine generations are in the Marbles database (`marbles_generations`).
