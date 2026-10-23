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
  // Add a state directory to persist run records. Configure persistent
  // session and artifact stores separately; these two stores are in memory.
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
`engine.store` is the state store it keeps trigger state in, and
`engine.scopes` is a read-only view of the runs in flight: each run's
`RunScope` by run id.

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
- `engine.definitions()`, `engine.schedules()`, and `engine.monitors()` read
  it back, including the triggers agents created.

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
| `store` | Provides trigger history, observations, agent-created triggers, and their locks. |

`store` defaults to `JsonStateStore` when `state` is set, or
`InMemoryStateStore` otherwise. Both adapters are exported.

## Persistence and durability

[Workflows](https://github.com/Francois-Esquire/foundry/blob/main/packages/workflows/README.md)
provides the orchestrator and step execution. Marbles adds run-owned
sessions, resources, and the saved ledger used when a parked run replays.
The [durability contract](/marbles/foundation/durability) still applies when
you embed the engine; the library's broader recovery APIs do not change
Marbles' adoption rules.

The example above deliberately keeps everything in memory. Supplying
`state` enables run persistence and the default persistent trigger store;
provide a persistent session store and artifact store with durable bytes
separately. Persisting run records alone cannot retain agent transcripts
or report files. Set `askable: true` only when the host can present and
answer questions. Define the same named work before `start()` so parked
runs can be adopted.

## Package instances

The package bundles its Foundry packages, so take the classes the
instances are built from out of `@foundry.sh/marbles/lib` as well. An instance
built from another copy of the same class is a different type. Besides
`Engine`, its types, and three constants (`CLI_HARNESS_IDS`, `CLI_HARNESSES`,
`TERMINAL_RUN_STATUSES`), the entry exports only those:

| Instance | Exports | Underlying library |
| --- | --- | --- |
| `models` | `ModelManager`, `claudeCodeProvider`, `codexProvider` | [Models](https://github.com/Francois-Esquire/foundry/blob/main/packages/models/README.md) |
| `sessions` | `InMemorySessionStore`, `JsonSessionStore` | [Agents](https://github.com/Francois-Esquire/foundry/blob/main/packages/agents/README.md); JSON adapter in Marbles. |
| `workspaces` | `WorkspaceSystem`, `directory`, `git`, `nodeObserver` | [Workspaces](https://github.com/Francois-Esquire/foundry/blob/main/packages/workspaces/README.md) |
| `containers` | `createContainers`, `createMemoryContainerStore` | [Sandbox](https://github.com/Francois-Esquire/foundry/blob/main/packages/sandbox/README.md) |
| `artifacts` | `ArtifactManager`, `InMemoryArtifactStore`, `JsonArtifactStore`, `blobFiles` | [Artifacts](https://github.com/Francois-Esquire/foundry/blob/main/packages/artifacts/README.md) |
| `store` | `JsonStateStore`, `InMemoryStateStore` | Marbles' trigger state and local locks. |

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
import { hostWorkspace, layout } from "@foundry.sh/marbles/workspace";

const marbles = layout();
const source = "/path/to/project/.foundry/marbles";
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());

let claim: ProcessInstance | undefined;
const host = await hostWorkspace({
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
try {
  const rolled = await host.roll("inventory");
  console.log(rolled.value);
  await host.run(controller.signal); // tick triggers until interrupted
} finally {
  await host.close();
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

The catalog, `process.env`, and the module cache are per process, so one
process hosts one workspace. Claim the workspace's state directory
(`engine.state`, which is `<state>/<workspace-id>`) inside `prepare`, so
the engine starts only once the claim holds: a worker of the Marbles
process hosting the same workspace claims the same `locks/process`, and the
claim is what keeps two engines from adopting the same parked runs. A live
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
hosts each attached workspace in a worker it spawns, and a client reaches
the workers through it.

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
throws `NoProcessError` instead of starting one. `attach` hosts the source's
workspace, records it as `hosted` in its `workspace.json`, and resolves once
its worker is ready, or rejects with the load error when its source throws.
`workspace(summary)` is the same `WorkspaceConnection` as above, each call a
request to the worker; `workspaces()` lists every hosted workspace with its
state (`starting`, `ready`, `reloading`, `failed` with `error`, `stopped`);
`reload(id)` drains a workspace's worker and starts a fresh one, which is
also what revives a `failed` one; `forget(id)` stops hosting it and clears
`hosted`; `shutdown()` stops the daemon. `close()` detaches, and the daemon
keeps hosting. A live run's stream does not cross the socket, so
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
answers. `close` drains every worker (30 seconds, then SIGKILL) and releases
the claim; `closed` resolves after that, including when a `shutdown`
request or a lost claim ended it. `readProcess(dir)` reads a claim back from
its files, which is what `marbles status` shows for the state root and for
each workspace directory.
