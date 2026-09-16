---
title: Factories
description: Exact factory shapes, lifecycle, graph combinators, and bounded loops.
---

Import the factories and helpers from the package:

```ts
import {
  agent,
  loopUntil,
  monitor,
  schedule,
  step,
  workflow,
} from "@foundry/quirks";
```

## step(name, body)

`step<I, O>(name: string, body: (primitives: Primitives, input: I) => Promise<O>): Step<I, O>`

Register one unit of work. `body(primitives, input)` must return a promise. Use an
`async` function or return an existing promise. Results must be JSON-serializable.

```ts
import { step } from "@foundry/quirks";

const hello = step("hello", async ({ log }, who: string) => {
  log(`Hello ${who}`);
  return { greeted: who };
});
```

The returned definition is a Foundry workflow `Step` and can be placed in a graph.

## workflow(name, define)

`workflow<I, O>(name: string, define: (graph: DefinitionGraphBuilder<I, O>) => void): Workflow<I, O>`

Register a graph that composes existing step or workflow definitions.

`define(graph)` describes the graph. Input mappers can use the workflow's input
and outputs from earlier named nodes. `graph.output` selects the final result.

```ts
import { step, workflow } from "@foundry/quirks";

const greet = step("greet-person", async (_resources, name: string) => ({
  message: `Hello ${name}`,
}));

const measure = step(
  "measure-message",
  async (_resources, message: string) => ({ length: message.length }),
);

workflow<string, { message: string; length: number }>(
  "greeting-report",
  (graph) => {
    graph
      .step("greeting", greet, ({ input }) => input)
      .step("measurement", measure, ({ greeting }) => greeting.message)
      .output(({ greeting, measurement }) => ({
        message: greeting.message,
        length: measurement.length,
      }));
  },
);
```

| Method | Shape |
| --- | --- |
| `step` | `step(key, definition, inputMapper?)`; an overload also accepts a definition without an explicit key. |
| `sequence` | `sequence(key, definitions, inputMapper?)` |
| `parallel` | `parallel(key, namedDefinitions, inputMapper?)` |
| `race` | `race(key, namedDefinitions, inputMapper?)` |
| `branch` | `branch(key, predicate, { ifTrue, ifFalse }, inputMapper?)` |
| `output` | `output(resultMapper)` |

Use `loopUntil` for bounded repetition.

## agent(name, spec)

`agent(name: string, spec: Omit<AgentSpec, "id">): AgentSpec`

Register an agent specification. Declaring an agent does not start a process or
create a conversation. `prompt` is required. `model` and `skills` are optional.
Skills are resolved from `<workspace.root>/skills/<name>/SKILL.md`.

```ts
import { agent } from "@foundry/quirks";

const reviewer = agent("reviewer", {
  prompt: "Review repository changes and report findings without editing.",
});
```

The accepted specification also includes fields inherited from Foundry's agent
type. Acceptance does not imply that Quirks provisions every field: the current
runtime does not supply an MCP resolver or mesh, and declared tool names are not
provisioned.

Open a session inside a step through `agents.session(spec, options)`. A stable
`sessionId` reuses the conversation within this Quirks workspace. Without an ID,
a new session is created. See [agents and sessions](/quirks/guides/agents-and-sessions).

### Session options

| Option | Behavior |
| --- | --- |
| `sessionId` | Reuse this conversation across invocations. Omit for a new session. |
| `executor` | Select a harness reference. Defaults to the first available executor. |
| `cwd` | Set the harness working directory. Does not establish a security boundary. |
| `compaction` | Enabled by default using the turn model to summarize history. Set `false` to disable it, or pass partial settings. |

Compaction means continuity may include summaries rather than the complete
original conversation.

## schedule(name, options)

`schedule<I>(name: string, options: ScheduleOptions<I>): void`

Bind an executable definition and input to a cadence. Options are
`{ workflow, input, at }`. `workflow` accepts a step or workflow handle, or a
registered name.

`at` accepts:

- an integer interval string such as `"30s"`, `"10m"`, `"6h"`, or `"1d"`;
- a calendar slot with `hour`, optional `minute`, and optional `weekday`.

Calendar slots use machine-local time:

```ts
import { schedule, step } from "@foundry/quirks";

const inspect = step("inspect", async ({ workspaces, workspace }) => {
  const directory = await workspaces.add({ path: workspace.root });
  return { files: (await directory.refresh()).files.length };
});

schedule("inspect-mornings", {
  workflow: inspect,
  input: null,
  at: { weekday: ["mon", "wed", "fri"], hour: 9, minute: 30 },
});
```

`minute` defaults to zero. Omitting `weekday` means every day. Weekday names are
`sun`, `mon`, `tue`, `wed`, `thu`, `fri`, and `sat`.

A schedule registers timing information; importing the configuration does not
start its clock. Run it with `run`, invoke it immediately with `once`, or install
it through launchd. See [scheduling and overlap](/quirks/reference/state#scheduling-and-overlap).

## monitor(name, handler, options)

`monitor(name: string, handler: (primitives: Primitives, change: Change) => Promise<unknown>, options: MonitorOptions): void`

Observe a source and invoke `handler(primitives, change)` when it produces a
relevant change. The handler must return a promise. A monitor registers an
executable detector and a schedule under the same name.

```ts
import { monitor } from "@foundry/quirks";

monitor("instructions", async ({ log }, change) => {
  if (change.kind === "files") log(JSON.stringify(change));
}, { glob: "**/{AGENTS,CLAUDE}.md", every: "1m" });
```

### Sources and options

| Source | String shorthand | Object options |
| --- | --- | --- |
| Files | A glob | `{ glob, root?, every? }` |
| HTTP | An `http://` or `https://` URL | `{ url, method?, headers?, body?, every?, select? }` |
| WebSocket | A `ws://` or `wss://` URL | `{ url, headers?, protocols?, send?, select? }` |

For file monitors, `root` defaults to the configuration directory. Globs match
relative paths and support `*`, `**`, `?`, and `{a,b}`.

For file and HTTP monitors, `every` defaults to `"60s"` and accepts the same
interval or calendar forms as a schedule.

HTTP bodies and WebSocket messages are parsed as JSON when possible, otherwise
treated as text. `select` receives that value as `unknown`; validate its shape
before accessing fields.

For HTTP, `select` chooses the value used for comparison. JSON object key order
does not itself count as a change. Without `select`, Quirks compares the parsed
response value or text, rather than arbitrary response bytes.

For WebSockets, `select` transforms each message. It does not deduplicate
messages. `send`, when supplied, is sent when the connection opens.

### Handler input

`change.kind` identifies the source:

| Kind | Fields |
| --- | --- |
| `"files"` | `added`, `modified`, and `removed`, each containing entries with `path` and `checksum`. Removed entries retain the last observed checksum. |
| `"http"` | `status`, `previous`, and `current`. The first observation has `previous: undefined`. |
| `"ws"` | `message` |

On the first file observation, existing matching files are reported as added.
An empty match set does not invoke the handler. The first successful HTTP
observation invokes its handler.

File and HTTP snapshots are saved only after the handler succeeds. If the
handler throws, the observation remains eligible for a later attempt. A failed
poll logs the failure and leaves the last snapshot intact.

Under `run`, file monitors combine periodic polling with native filesystem
notifications. Notifications are an implementation detail of monitors, not a
separate configuration API.

WebSocket monitors operate only under `run` and reconnect after five seconds
when disconnected. `once` reports that they are live-only; launchd installation
rejects them. They do not provide a durable message queue or replay.

## loopUntil(options)

Create a reusable step that repeats another step or workflow.

| Option | Meaning |
| --- | --- |
| `body` | The step or workflow to execute each round. |
| `maxRounds` | Required upper bound, at least one. |
| `until({ output, round })` | Stop when this returns or resolves to `true`. |
| `next({ output, round }, previousInput)` | Produce the next round's input. |
| `name` | Optional definition name. |
| `definitionKey` | Optional definition identity. |

Rounds are numbered from one. The result contains `output`, the final round's
output; `rounds`, the number of completed rounds; and `settled`, whether `until`
succeeded before the limit. Reaching `maxRounds` returns `settled: false`. It
does not establish that the task succeeded.

See the [implement-review example](/quirks/use-cases/implement-review).

## Direct exports

Alongside the factories and `loopUntil`, Quirks currently exports the
`ModelManager`, `SessionHarness`, `Git`, and `Worktree` classes.

The public `Workspaces` type describes `workspaces.add` and `workspaces.git`.
The lower-level catalogue implementation is not a Quirks export.

Other exported types include agent specifications, session settings and storage,
harness references, runtime resources, schedule calendar types, monitor change
types, and `LoopUntilResult`.
