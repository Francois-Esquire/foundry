---
title: Tasks and observability
description: Keep a backlog with dependencies, react to every change with observe, and read what each run did.
---

Three words coordinate work that outlives a single run. `tasks` holds what
there is to do. `observe` reacts when something changes. `runs` reads what
each run did. Together with `.enqueue()` they make the outer loop from
[Get started](/marbles/get-started/outer-loop).

`runs`, `.enqueue()`, and observers in `marbles list` need the current
source checkout.

## The backlog

`tasks` is the workspace's backlog, kept in the Marbles database. Every
process on the machine reads and writes the same tasks, and under
`--dry-run` they stay in memory. The API is the
[Tasks](https://github.com/Francois-Esquire/foundry/blob/main/packages/tasks/README.md)
package's.

A task has a `title`, an optional `description`, `tags`, and JSON
`metadata` that you own. Its `status` is `open`, `active`, `completed`, or
`cancelled`. `updatedAt` doubles as an optimistic token.

```ts
import { step, tasks } from "@foundry.sh/marbles";

step("next-task").do(async () => {
  const next = (await tasks.ready({ limit: 1, tags: { all: ["triage"] } })).items[0];
  if (!next) return "nothing ready";
  await tasks.start(next.id, { expectedUpdatedAt: next.updatedAt });
  await tasks.update(next.id, { metadata: { picked: true } });
  return next.title;
});
```

| Call | Answers or does |
| --- | --- |
| `get(id)`, `list(query)` | One task or a page of them, filtered by `status`, `parentId`, or `tags: { all, any }`. |
| `ready(query)` | Open tasks nothing holds back, oldest first. |
| `create(input, { parent, dependsOn })` | A new task, with its parent and dependencies. |
| `update(id, patch, token?)` | Changes title, description, tags, or metadata. Metadata keys merge; `null` removes one. |
| `start`, `complete`, `cancel` | Moves the status. A settled task must be reopened before it moves again. |
| `change({ operations })` | One atomic batch of creates, updates, status moves, and dependency edges. |

Use `tasks` in a step, an observer, or a monitor handler. A host refuses
calls while its source loads. From the shell, `marbles tasks` has the same
operations, and the [MCP server](/marbles/reference/mcp) exposes them to
other agents.

## Dependency graphs

A dependency is an edge from one task to another. `ready()` leaves out a
task until everything it depends on has settled, either way, so a
cancelled dependency never strands its dependents. Cycles and self links
are refused when written. A parent reference shapes a hierarchy;
`get(id, { depth })` returns subtasks beneath it.

`ready()` is a read. Between that read and your write, another writer can
start the task or add a dependency to it. Claim work in one batch that
checks both:

```ts
await tasks.change({
  operations: [
    {
      expectedUpdatedAt: task.updatedAt,
      kind: "task.set_status",
      requireReady: true,
      status: "active",
      task: { id: task.id },
    },
  ],
});
```

A stale token refuses the batch with `TaskError` code `conflict`, and a
task that is no longer ready with `not_ready`. The `start` shorthand checks
the token but not readiness.

## Observe what changed

`observe(source, handler, options?)` calls `handler` with each change fact
the source commits in the workspace, from the observer's first start on.

| Source | Facts |
| --- | --- |
| `tasks` | `tasks.changed`, one per write, holding each task `before` and `after` and the edges added and removed |
| `workflow` | `run.queued`, `run.started`, `run.parked`, `run.resumed`, `run.completed`, `run.failed`, `run.cancelled`, `run.updated`, `run.removed` |
| `artifact` | `artifact.created`, `artifact.written`, and the others, plus `artifact.shared` and `artifact.unshared` |
| `agent` | `session.created`, `session.updated`, `session.messages.appended` |
| `sandbox` | `sandbox.created`, `sandbox.started`, `sandbox.stopped`, `sandbox.failed`, `sandbox.destroyed` |
| `workspace` | `workspace.created`, `workspace.updated`, `workspace.entries.changed`, `workspace.removed` |

Every fact is `{ type, id, at, ... }` with the ids of what it is about, such
as `runId` on a run fact. Read the object by id for anything more.
`options.types` narrows delivery to those types, and `options.timeout` sets
the time limit for one call in ms.

```ts
import { observe, runs, workflow } from "@foundry.sh/marbles";

observe(
  workflow,
  async ({ runId }) => {
    const run = await runs.get(runId);
    console.error(`${run?.name} failed: ${run?.error}`);
  },
  { name: "failures", types: ["run.failed"] }
);
```

An observer is known by its name: `options.name`, else the `const` it is
assigned to, else the handler's function name. Editing a handler keeps its
place. Renaming it starts a new observer from that moment.

Delivery follows a few rules:

- **At least once, in order.** Each observer gets its source's facts in
  commit order. A handler that throws keeps its place and gets the same
  fact again after a backoff, from one second doubling to five minutes.
  Make handlers safe to repeat.
- **Independent.** A slow, failing, or stuck observer never delays another.
- **Own writes come next pass.** Facts a handler writes to its own source
  arrive on the following pass.
- **Outside any run.** A handler runs outside every write and every run. A
  definition it runs or enqueues starts a run of its own.
- **One host at a time.** Across an engine switch, the retiring generation
  hands each observer to the next at the place it stopped.

The [API reference](/marbles/reference/api#exports) gives the timing,
retention, and compaction details.

## Hand off work

A handler should return quickly, so hand long work to a run.
`definition.enqueue(input, { key })` admits a run and resolves with
`{ id, result }` without waiting. Put the task id in the run's input: the
run then says which task it serves, and an observer of `workflow` can find
that task even when the run settles before anything else is written.

Put the task id in the key too. Delivery is at least once, so a handler
that enqueued and then threw sees the same change again. With a key, the
second delivery gets the first run back instead of starting another:

```ts
observe(tasks, async function dispatch() {
  const ready = await tasks.ready({ tags: { all: ["review"] } });
  for (const task of ready.items) {
    await review.enqueue({ task: task.id }, { key: `review:${task.id}` });
  }
});
```

Every later pass that still sees the task ready gets the same run back,
so nothing is enqueued twice. [The outer
loop](/marbles/get-started/outer-loop#write-the-loop) also claims each task
after enqueuing it, so later passes skip it.

The key matches whatever that run became, including `failed`. When a task
can be retried or revised, add a counter that advances each time it comes
back, such as `` `review:${task.id}:attempt-${attempt}` ``. [Enqueue once
per key](/marbles/concepts/steps-and-workflows#enqueue-once-per-key) has the
rules, and [Run, enqueue, or
lock](/marbles/concepts/steps-and-workflows#run-enqueue-or-lock) compares
the ways to start a definition.

### Hand off by name

The dispatcher does not need to import what it starts. When the review
workflow lives in another file, `workflow.enqueue` finds it by the name it
was declared with:

```ts
observe(tasks, async function dispatch() {
  const ready = await tasks.ready({ tags: { all: ["review"] } });
  for (const task of ready.items) {
    await workflow.enqueue("review", { task: task.id }, { key: `review:${task.id}` });
  }
});
```

A by-name enqueue and `review.enqueue(...)` share one key per definition
name, so either spelling gets the other's run back. `workflow.enqueue`
takes only a workflow; for a step, it refuses and names `step.enqueue`.
[Enqueue by name](/marbles/concepts/steps-and-workflows#enqueue-by-name)
has the rest of the rules.

## Inspect runs

`runs` reads the workspace's runs and never starts one:

```ts
const run = await runs.get(id);
const failed = await runs.list({ name: "check-task", status: "failed" });
```

`runs.get(id)` returns a `RunView` or `null`. `runs.list({ name?, status? })`
returns matching runs, oldest first; `status` takes one status or an array.

| Field | Holds |
| --- | --- |
| `id`, `name`, `kind` | The run id, its definition's name, and `"workflow"` or `"task"`. |
| `status` | `queued`, `running`, `suspended`, `complete`, `failed`, `cancelled`, or `interrupted`. |
| `input`, `output`, `error` | The run's input, the result once `complete`, the error message otherwise. |
| `queuedAt`, `startedAt`, `endedAt` | ISO timestamps. |

Status names differ from fact names. A parked run has status `suspended`
and emitted `run.parked`; a finished run has status `complete` and emitted
`run.completed`.

`runs` reads inside a step, an observer, or a monitor handler. Like `tasks`,
it refuses while a source loads and once its host is disposed.

## Watch it live

The same records drive what you see:

- `marbles status` shows recent runs and each observer's position, failures,
  last error, and next retry.
- `marbles list` prints `[observer] name ← source types` for each observer.
- `marbles watch <runId>` follows a run's output until it ends.
- The dashboard shows runs, their steps, and live agent turns, and the Feed
  holds reports and questions.

[The Marbles UI](/marbles/get-started/marbles-ui) is the tour.

Next: [Monitoring and scheduling](/marbles/concepts/monitoring-and-scheduling).
