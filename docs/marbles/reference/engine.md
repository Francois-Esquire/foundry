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

`launchDefinition(definition, input)` does the same for a direct definition,
including an anonymous one. `run(name, input)` and `execute(definition, input)`
wait for the result instead. The [MCP tools](/marbles/reference/mcp#tools) use
the launch methods and expose the handle's `id` as `runId` for both workflows
and agents.

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

Two things a host cannot do through this entry yet: the MicroSandbox runtime
`createContainers` needs is not exported, and nothing fires the triggers the
engine holds (the CLI's schedule loop is not part of the engine).
