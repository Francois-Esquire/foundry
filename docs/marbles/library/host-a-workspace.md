---
title: Host a workspace
description: Host one workspace in your own process, or start and join the Marbles process.
---

These entries are available in the `0.0.3` npm release. See
[release status](/marbles/library#release-status).

Use `@foundry.sh/marbles/workspace` when your program should load a
`.foundry/marbles` source and run its triggers itself, as the CLI's worker
does. Use `@foundry.sh/marbles/process` when your program should be a client
of the one Marbles process on the machine, as the dashboard, the CLI, and the
MCP server are. Use the [engine](/marbles/reference/engine) directly when you
want neither discovery nor a daemon.

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
  try {
    await host?.close();
  } finally {
    claim?.release();
  }
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
throws `NoProcessError` instead of starting one, and refuses a daemon of
another version rather than stop it. Either way, a daemon that keeps its
artifacts somewhere other than `layout.artifacts` is refused, naming both
paths; both refusals are a `ProcessMismatchError`, and a daemon that holds
the claim but does not answer is a `ProcessTimeoutError`. `stopProcess({
layout })` is what `marbles stop` does: it stops the daemon whatever its
version, calls `onStopping` once the daemon has agreed, and resolves with
that daemon's `hello` once it has exited, or `undefined` when none ran.
`attach` hosts the source's workspace, records it as `hosted` in its
`workspace.json`, and resolves once its worker is ready, or rejects with the
load error when its source throws; attaching another source under a root
that is already hosted rejects until that workspace is detached. During a
reload, `attach` and `reload` resolve with the fresh worker.
`workspace(summary)` is the same `WorkspaceConnection` as above, each call a
request to the worker; `workspaces()` lists every hosted workspace with its
state (`starting`, `ready`, `reloading`, `failed` with `error`, `stopped`);
`reload(id)` drains a workspace's worker and starts a fresh one, which is
also what revives a `failed` one; `detach(id)` stops hosting it and clears
`hosted`, and rejects when an attach landed while it drained, since that
attach hosts the workspace again; `shutdown()` asks the daemon to stop and
resolves once it has answered, while it drains its workers and exits. From
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
answers. `close` drains every worker (30 seconds, then SIGKILL) and releases
the claim; `closed` resolves after that, including when a `shutdown`
request or a lost claim ended it. After a lost claim it leaves the socket
path alone, since a successor may listen there by then. `readProcess(dir)` reads a claim back from
its files, which is what `marbles status` shows for the state root and for
each workspace directory.
