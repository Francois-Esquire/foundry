---
title: Embedding the engine
description: Host Marbles in a Bun application with explicit dependencies and lifecycle ownership.
---


The CLI is one host of an engine any Bun program can run. `@foundry/marbles` is
unchanged: the words a module writes definitions with. `@foundry/marbles/lib`
holds the `Engine` that runs them. A program builds one from explicit
instances, then drives and inspects it without the CLI, the dashboard, or the
authoring words.

The engine is handed an instance from each Foundry package, each already
configured for the machine it runs on. It builds everything that
connects them: the managers a step body sees, the feed, agent approvals and
activity, the triggers agents create, and the run queue.

```ts
import { step } from "@foundry/marbles";
import {
  ArtifactManager,
  Engine,
  InMemoryArtifactStore,
  InMemorySessionStore,
  ModelManager,
} from "@foundry/marbles/lib";

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
  step("inventory").do(async ({ workspaces }) => (await workspaces.current.files()).length)
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

The following excerpt assumes the `engine` above and configured model and
container providers. The managers a step body gets as `agents`, `workspaces`, `sandboxes`, and
`artifacts` are on the engine too, with the same methods, and work without a
run and before `start()`:

```ts
import { agent, artifact } from "@foundry/marbles";

const reviewer = agent({ prompt: "Review the diff." });
const report = artifact({ name: "review", type: "text/markdown" });

const repo = await engine.workspaces.load({ path: "/path/to/repo" });
const session = await engine.agents.session(reviewer, { cwd: repo.root });
const reply = await session.generate("Review this.");
const box = await engine.sandboxes.start({ image: "oven/bun:1-slim" });
const version = await engine.artifacts.write(report, { "report.md": reply.text });
```

Inside a step these calls are tied to the step: they replay to the same
session, sandbox, or version, stop when the step is cancelled, and close when
the run settles. On the engine there is no step, so each call is new, a
sandbox is yours to close, and whatever is still open closes on `dispose()`.
`engine.sandboxes.containerOf(box)` returns the container behind a sandbox
the engine opened.

The engine keeps its own registry and is told what can run:

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

A few optional settings cover what the instances cannot say: `print`
receives engine status and body `log(...)` lines, `home` is where shared
skills are read from, `git` is how git runs (for example a runner that echoes
instead), `worktrees` is where worktrees are cut when a step names no `home`
(`Engine.worktreesFor(state)` by default), and `dry` makes agents asked for a
sandbox run in-process instead. `store` is the `StateStore` that keeps
schedule history, monitor observations, and the triggers agents create, with
the locks that keep two ticks apart. It defaults to a `JsonStateStore` over
`state`, or an `InMemoryStateStore` without one; both are exported.

The package bundles its Foundry packages, so take the classes the
instances are built from out of `@foundry/marbles/lib` as well. An instance
built from another copy of the same class is a different type. Besides
`Engine`, its types, and three constants (`CLI_HARNESS_IDS`, `CLI_HARNESSES`,
`TERMINAL_RUN_STATUSES`), the entry exports only those:

| Instance | Exports |
| --- | --- |
| `models` | `ModelManager`, `claudeCodeProvider`, `codexProvider` |
| `sessions` | `InMemorySessionStore`, `JsonSessionStore` |
| `workspaces` | `WorkspaceSystem`, `directory`, `git`, `nodeObserver` |
| `containers` | `createContainers`, `createMemoryContainerStore` |
| `artifacts` | `ArtifactManager`, `InMemoryArtifactStore`, `JsonArtifactStore`, `blobFiles` |
| `store` | `JsonStateStore`, `InMemoryStateStore` |

Two things a host cannot do through this entry yet: the MicroSandbox runtime
`createContainers` needs is not exported, and nothing fires the triggers the
engine holds (the CLI's schedule loop is not part of the engine).
