# @foundry/tasks

The backlog. A Task says what there is to do, `ready()` says what is next,
and a settled status says what is done. Execution lives in
[workflows](../workflows/README.md); a Job correlates to a task by id only.

Database-free, plain TypeScript. Dependencies and a parent reference shape
the graph, availability is derived from it, and every mutation is one atomic
batch in a command language that code, a CLI, and agent tools all share.

## Quick start

```ts
import { Tasks } from "@foundry/tasks";

const tasks = new Tasks(); // MemoryTaskStore unless a store is supplied

const design = await tasks.create({ title: "Design the API" });
const build = await tasks.create(
  { title: "Build it", metadata: { size: "m" } },
  { dependsOn: [{ id: design.id }] }
);

await tasks.ready(); // → items: [design]; build waits on design
await tasks.start(design.id);
await tasks.complete(design.id);
await tasks.ready(); // → items: [build]
```

A runner loops over `ready()`, starts a task, hands the work to whatever
executes it, and completes or cancels the task when that finishes.

## The record

```ts
interface Task {
  id: TaskId; // "tk-" + 8 hex chars unless the caller supplies one
  title: string;
  description: string | null;
  status: "open" | "active" | "completed" | "cancelled";
  parentId: TaskId | null; // hierarchy is a plain parent reference
  metadata: JsonObject; // host-owned, JSON-safe
  createdAt: string; // ISO 8601
  updatedAt: string; // the optimistic token
  settledAt: string | null; // set on complete/cancel, cleared on reopen
}
```

A dependency is a separate directed edge: `{ taskId, dependsOnId }`. Self
links, duplicates, and cycles are refused at write time.

## Reads

| Call                       | Answers                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `get(id, { depth })`       | One task or `null`.                                               |
| `list(query)`              | Every task, oldest first; filter by `status` and `parentId`.      |
| `ready(query)`             | Open tasks nothing holds back, oldest first.                      |
| `availability(id)`         | `ready`, `active`, `blocked { blockedBy, waitingOn }`, `settled`. |
| `children(id, { depth })`  | Direct children, oldest first.                                    |
| `dependencies(id)`         | `{ dependsOn, dependents }`.                                      |

`list` returns `Page<TaskNode, number>` and `ready` returns `Page<Task, number>`,
both from `@foundry/core/pagination` with an offset cursor. `list({ parentId: null })` selects root tasks.

`depth` is how many levels of subtasks come back beneath each task, and it
defaults to 0. At depth 0 a task is the plain record. Above it, each task
carries `subtasks`, each of those carries its own down to the limit, and an
empty `subtasks` means the task has no children:

```ts
await tasks.get(epic.id, { depth: 2 }); // epic → stories → their subtasks
await tasks.list({ parentId: null, depth: 1 }); // every root with its children
```

Availability is pure and stored nowhere. A dependency stops blocking once its
target has settled either way, so cancelled work never strands its dependents.
With `parentGate: true` an open task also waits for every open ancestor, so a
parent has to be started before its children are offered. It is off by default.

## Writes

Every mutation is one `change` batch, applied whole or refused whole, and run
one at a time in the process:

```ts
const result = await tasks.change({
  operations: [
    { kind: "task.create", key: "epic", input: { title: "Ship tasks" } },
    { kind: "task.create", key: "a", input: { title: "Design" }, parent: { key: "epic" } },
    { kind: "task.create", key: "b", input: { title: "Build" }, parent: { key: "epic" } },
    { kind: "dependency.add", task: { key: "b" }, dependsOn: { key: "a" } },
    { kind: "task.set_status", task: { id }, status: "active", expectedUpdatedAt },
    { kind: "task.update", task: { id }, patch: { title, description, metadata } },
    { kind: "task.move", task: { id }, parent: null },
    { kind: "dependency.remove", task: { id }, dependsOn: { id: other } },
  ],
});
// result.changed: [{ id, key? }] for every task an operation acted on,
// the one it created or its `task`; a parent or dependsOn target is not listed.
// result.tasks: the committed record of each, in the same order
```

A `TaskRef` is `{ id }` for a stored task or `{ key }` for one created earlier
in the same batch. `expectedUpdatedAt` is an optimistic token: the write is
refused with `conflict` when the task has moved on. Every write stamps an
instant strictly later than anything the store held when it began, so writes
that run one after another never share a token, whatever the clock says.
Writes from two instances that overlap can; see Persistence. `task.set_status`
allows any move except settled to settled; reopen first.

The shorthands each wrap one operation: `create(input, { parent, dependsOn })`,
`update(id, patch, token)`, `start(id, token)`, `complete(id, token)`,
`cancel(id, token)`.

`remove(id, token)` is the one deletion and is deliberately outside the batch
language. It refuses while children exist or while the host's `inUse(id)`
answers true, then drops dependency edges in both directions.

`taskChangeSchema` on `@foundry/tasks/operations` validates a batch at an
edge such as an MCP tool, and is bound to the hand-written `TaskChange` type
so the two cannot drift.

## Errors

Every refusal is a `TaskError` with a stable `code`: `not_found`, `conflict`,
`cycle`, `invalid_status`, `invalid_placement`, `invalid_operation`,
`task_in_use`. A `depth` that is not a non-negative integer is a caller bug,
not a refusal, and throws a plain `RangeError`.

## Persistence

`TaskStore` on `@foundry/tasks/store` is the seam: `snapshot()`, `get(id)`,
and `commit(write)` where a write puts and deletes tasks and edges all or
nothing. The store enforces nothing; every rule is checked before a write
reaches it, and values crossing the seam are detached. `MemoryTaskStore` is
the default. Two `Tasks` instances over one store can still interleave;
serialization is per instance.

## Correlation with workflows

Tasks knows nothing about Jobs. A runner puts the task id in the Job's
`links` when it dispatches, and supplies `inUse` to `Tasks` so a task cannot
be removed while a Job still points at it.

## Scripts

- `bun run test`, `test:watch`, `test:coverage`
- `bun run typecheck`, `build`, `clean`
