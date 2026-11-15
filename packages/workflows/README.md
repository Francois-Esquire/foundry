# @foundry/workflows

A durable workflow runtime. Steps compose into trees, run under a queue,
survive a process restart, and can suspend mid-flight waiting on a human.

Effect-backed inside, plain TypeScript at every exported seam.

## Quick start

### A step

```typescript
import { Step } from "@foundry/workflows/step";

const greet = Step.create({
  name: "greet",
  input: { who: "world" },
  execute: async (input, ctx) => {
    ctx.log("info", "starting", { who: input.who });
    return `hello ${input.who}`;
  },
});

await greet.run(); // "hello world"
```

Bodies can also be async generators — every `yield` routes through `ctx.write`
and becomes a stream chunk, and the `return` value becomes the output:

```typescript
execute: async function* (input, ctx) {
  for (const line of lines) yield line; // → ctx.write(line)
  return summary;
};
```

### A durable run

```typescript
import { Orchestrator } from "@foundry/workflows/orchestrator";

const orchestrator = new Orchestrator({ config });
orchestrator.register("analyze", () => buildAnalyzeStep());
await orchestrator.setup();
await orchestrator.start();

const job = await orchestrator.createJob("analyze", input);
const run = await orchestrator.execute(job.id);

await run.result();
```

Registered by **name**, not by reference. That indirection is what makes
recovery possible: after a restart, `orchestrator.recover()` finds runs that
were mid-flight and rebuilds them from the registry.

### A reusable definition

When behavior is a reusable named definition rather than a one-off runtime
factory, extend `Step` or `Workflow`. Its descriptor is available before a Run
exists; `.factory()` materializes a fresh runtime for every dispatch.

```typescript
interface SummarizeContext {
  readonly name: string;
  readonly tenantId: string;
  readonly traceId?: string;
}

class Summarize extends Step<{ text: string }, string, SummarizeContext> {
  readonly definitionKey = "documents.summarize";
  readonly name = "Summarize document";

  protected async execute({ text }: { text: string }): Promise<string> {
    return text.slice(0, 200);
  }
}

const summarize = new Summarize();
orchestrator.register(summarize.definitionKey, summarize.factory());
```

For direct, non-durable use, `.create()` binds reusable shared context and its
returned invocation receives the input. Per-invocation context overrides the
create-time context. The Orchestrator supplies durable execution context through
`.factory()`; application code does not pass it.

```typescript
const invocation = summarize.create({ tenantId: "acme" });
const summary = await invocation.run({ text: document }, { traceId });
```

`Workflow` definitions declare named placements with `graph.step()`, groups,
and branches. A nested workflow compiles inline beneath the parent Run, so its
steps share the parent snapshot, streaming, suspension, cancellation, and
durable recovery path.

## How it comes together

```
Step           one frame — a body, children, cancellation, a stream
  Workflow     a Step tree as one run — status, telemetry, a result
    Queue      concurrency, dispatch, persistence, recovery
      Orchestrator  the host-facing façade — registry, jobs, runs, suspensions
```

**A Step owns four slices**, allocated lazily on first access (or at
`step.run()` if never touched):

| Slice        | Owns                                           | Shared   |
| ------------ | ---------------------------------------------- | -------- |
| `Snapshot`   | tree state, per-step status, results           | per Run  |
| `Channels`   | the broadcast hub — chunks and events          | per Run  |
| `Executable` | one frame's execution and cancellation         | per Step |
| `Composer`   | tree walking, `parallel` / `race` / `sequence` | per Step |

Snapshot and Channels being per-Run is why a child deep in the tree can write
to the run's stream and appear in the run's results without threading anything
through its ancestors.

**Children drain in a post-body cascade.** Declare them in `spec.children` or
fork them with `ctx.fork`; they run after the body returns. A body that opts
into Koa-style `await ctx.next()` drains them in append order with failure
propagation. A body that skips it gets fire-and-forget draining — the children
still run, but their failures do not reach the parent.

**Three ways a step ends:**

- **Return a value** — normal success.
- **Return `bail(error)`** — a business failure as a _value_. Terminal: no
  retries, ever. The Promise form throws `StepBailError` carrying the original,
  so `try`/`catch` still works while `instanceof` recovers the typed value.
- **Throw** — an infrastructure failure. Retryable under the step's
  `RetryPolicy`.

That distinction is the point. "The invoice was already paid" and "the database
was unreachable" should not share a retry policy.

**Suspension is how a run waits on the world.** `ctx.suspend()` parks the frame
under a durable name; the run is persisted and the process may exit. Later,
`run.resume(name, value)` settles it. Resume identity is the tuple
`(stepPath, name, occurrence)` — durable, and owned by the engine, so nothing
downstream invents its own resume key.

---

## `@foundry/workflows/step`

The execution primitive.

```typescript
Step.create(spec): Step<I, O, X>; // the constructor
Step.make(spec): Promise<Step>; // back-compat sugar; resolves immediately
Step.from(name, body): Promise<Step<void, O>>; // no input, no children
```

```typescript
interface StepSpec<I, O, X> {
  name: string;
  input: I;
  execute: (
    input,
    ctx,
  ) => Promise<O | Bail> | AsyncGenerator<unknown, O | Bail>;
  children?: readonly (StepSpec | Step)[];
  seed?: Omit<X, "name">;
  config?: Partial<ExecutableConfig>;
  id?: string; // restore paths only — keeps a hydrated Step's identity
}
```

A `Step` instance can be attached to at most one parent. Passing an
already-bound Step to a second parent throws `"already bound"`.

### Running

```typescript
step.run(input?, ctxExtension?): Promise<O>; // throws StepBailError on bail
step.dispose(): Promise<void>; // idempotent
```

### Observing

```typescript
step.status / statusChanges: ReadableStream<StepStatus>;
step.output / outputChanges: ReadableStream<O>;
step.progress / progressChanges: ReadableStream<number>;
step.stream: ReadableStream<ChunkPayload>;
step.channelStream: ReadableStream<ChannelMessage>; // shared run messages; one reader
step.changes: ReadableStream<SnapshotState>;
step.state / steps / results / workflow; // snapshot reads
step.isTerminal / paused / aborted / reason / signal;
```

### Controlling

```typescript
step.abort(reason?) / onAbort(handler): Unsubscribe;
step.pause(reason?) / resume() / waitIfPaused();
step.skip(reason?);
step.suspend<T>(args, occurrence?) / resolve(name, value) / resolveOccurrence(…);
step.write(value) / pipe(source) / emit(type, payload) / log(level, msg, fields);
step.fork(spec) / step(spec);
```

### The body's context

`ctx` spreads your seed type `X` onto framework affordances. Framework fields
win — `X` cannot define `step`, `path`, `signal`, or `children`.

```typescript
ctx.step / path / signal / children;
ctx.fork(spec) / next();
ctx.write(v) / pipe(src) / emit(type, payload) / log(level, msg, fields);
ctx.suspend<T>({ name, kind, reason, request });

ctx.resultOf<T>(name) / statusOf(name); // sibling access, sync, path-relative
ctx.state / steps / results / workflow; // promise-wrapped

ctx.invoke(step, input, as?); // drive a pre-built child inline
ctx.parallel(specs, name?); // concurrent under a group frame
ctx.race(specs, name?); // first wins, rest interrupted
ctx.branch(predicate, ifTrue, ifFalse, input, name?);
ctx.sequence(steps, initialInput, name?); // each output feeds the next
```

`ctx.resultOf` is how sibling steps share data — the grade step reads the scan
step's output by name rather than by reference. It is path-relative and
synchronous because it reads the run's shared Snapshot.

## `@foundry/workflows/workflow`

A Step tree as one addressable run.

```typescript
Workflow.create(spec) / attach(step, input);

workflow.run(input?, context?): Promise<O>;
workflow.result(): Promise<WorkflowResult<O>>;
workflow.cancel(reason?): Promise<void>;
workflow.resolve(name, value) / resolveOccurrence(…): Promise<void>;
workflow.resume(name, value) / resumeOccurrence(…): Promise<void>;

workflow.status: RunStatus;
workflow.statusChanges: ReadableStream<RunStatus>;
workflow.state: WorkflowState;
workflow.stateChanges: ReadableStream<WorkflowState>;

workflow.setAuditSink(sink) / setRunId(id);
```

```typescript
type WorkflowResult<O> =
  WorkflowComplete<O> | WorkflowFailed | WorkflowCancelled;
type RunStatus =
  "queued" | "running" | "suspended" | "complete" | "failed" | "cancelled";
```

`deriveWorkflowTree(step, input)` walks a Step's compositional tree into the
`WorkflowSnapshot` shape persisted at `metadata.workflow.tree`. The tree is
identity-only — `key` is the namespaced path, `name` the local name, `index` the
sibling order. Per-step status lives separately in a flat map keyed by the same
`key`, which is what lets status update without rewriting the tree.

## `@foundry/workflows/orchestrator`

The host-facing façade. Most applications talk to this and nothing else.

```typescript
new Orchestrator({ config, store?, logger?, registry?, queueExtensions?,
                   admissionParticipant?, cancellationParticipant? });
```

`config` is a `@foundry/lib/config` registry. The orchestrator self-contributes its
`queue` slice idempotently and reads `queue.concurrency` and `queue.defaultName`
from it — call `contributeQueueConfig(config, {...})` _before_ construction to
change them.

### Lifecycle

```typescript
await orchestrator.setup(); // prepare persistence
await orchestrator.start(); // begin dispatching
await orchestrator.recover(): readonly string[]; // rebuild interrupted runs
await orchestrator.stop({ graceMs? });
```

### Definitions

```typescript
orchestrator.register(name, factory);
orchestrator.resolve(name, …) / resolveDefinition(…) / registered();
```

A `Factory` returns a Step or Workflow. `Registry` is also exported standalone
if you want to build one up before construction.

### Jobs and runs

```typescript
orchestrator.createJob(definition, input, options?): Promise<JobRecord>;
orchestrator.execute(jobId): Promise<DispatchedWorkflow>;
orchestrator.run(name, input, options?): Promise<DispatchedWorkflow>; // direct

orchestrator.getJob(id) / listJobs(query?) / cancelJob(id);
orchestrator.getRun(id) / listRuns(query?) / cancelRun(id) / get(runId);
orchestrator.observe(runId, options?): Promise<RunObservation>;
```

Job and run are distinct: a job is the _intent_ (a definition name plus input),
a run is one _attempt_ at it. That is what lets a job be retried without losing
the history of what already failed.

`store` is the execution records' domain API, an `OrchestratorStore`. It
defaults to an `ExecutionCoordinator` over a `MemoryWorkflowStore`; see
[Storage](#storage) for keeping the records in SQLite.

Hosts can supply admission and cancellation participants over a store that
offers transactions. Each participant runs inside the store transaction of
the change it joins, and receives the `OrchestratorStore` bound to it as
`store`: what it does there commits with the Run decision, and a throw rolls
both back. Factory construction cannot claim effects or emit outputs.
Retained queued Jobs use the admission participant too.

Job admission returns its handle before behavior starts on a later host turn.
Committed handles are already indexed and counted by `drain`. Dispatch and
cancellation signals follow the store call that committed them, so the
`Orchestrator` and `Queue` refuse, at construction, a store whose commits a
host transaction may still roll back (`durability: "host"`; see
[Storage](#storage)). Cancellation participants serialize their decision
with settlement; already-settled success stays intact.

The Run journal retains one terminal lifecycle frame. Explicit output receipts
and named effect claims can follow it for reconciliation, presentation changes
and external callbacks. They do not reopen execution: later progress, ordinary
logs and nonterminal lifecycle activity remain invalid. Repeated terminal
appends return the original frame; repeated effect claims return `null`.

### Suspensions

```typescript
orchestrator.getSuspension(id) / listSuspensions(query?);
run.resume(name, value) / resumeOccurrence(…);
```

### Queue control

```typescript
orchestrator.pause() / resume() / drain({ graceMs? }) / clearQueue();
orchestrator.listQueueDiagnostics(): Promise<readonly QueueDiagnostic[]>;
orchestrator.on(event, handler): Unsubscribe;
```

## `@foundry/workflows/queue`

The layer below the orchestrator. Reach for it directly only when you are
building a runtime rather than using one.

```typescript
queue.dispatch(step, input, …) / adopt(…) / dispatchPersisted(…) / hydrate(…);
queue.status(runId) / snapshot(runId) / results(runId) / error(runId);
queue.get(runId) / active() / pending() / size();
queue.findRecoverableRuns(): Promise<readonly RecoverableRun[]>;
queue.withRunControl(runId, fn) / applyAuthoritativeCancellation(runId);
queue.pause() / resume() / drain(opts?) / shutdown(opts?);
queue.awaitPersistence(runId) / on(event, handler);
```

`awaitPersistence` exists because dispatch returns before the run's first write
lands. A test that asserts on stored state immediately after dispatch needs it;
production code generally does not.

## `@foundry/workflows/approval`

The one place an approval becomes a suspension.

```typescript
const answer = await suspendForApproval(ctx, {
  name: "module.capability",
  reason: "Wants to write outside the workspace",
  request: { path, mode }, // persisted verbatim as JSON
  parseResolution: (raw) => resolutionSchema.parse(raw),
});
```

Every approval is the same mechanic under a different vocabulary: park under a
durable name, embed the request as JSON, resume with the human's answer. Agent
tool calls, module capability calls, a CLI prompt — only the name and the
validated shape differ.

`parseResolution` is not optional decoration. The resolution is arbitrary JSON
from the engine's perspective; skipping validation means trusting persistence to
have written what you expect, which is how a fabricated approval reaches an
effect.

This lives here rather than in each host because two hosts had already grown
their own copies and drifted — one validated its resolution, the other trusted
it, and one silently dropped a field the other carried.

## `@foundry/workflows/channels`

The broadcast hub, shared per run.

```typescript
type ChunkPayload<S> = …; // text | data
interface ChannelChunk<S> { … }
type ChannelMessage<S> = ChannelChunk | ChannelEvent;
```

Each event has a Zod schema keyed by `_tag` (`StepStartedEvent`, …), and
`ChannelEventSchema` decodes any of them:

```
step.started · step.complete · step.failed · step.bailed
step.suspended · step.paused · step.resumed · step.skipped
step.aborted · step.progress · step.resolved · custom
```

## `@foundry/workflows/snapshot`

Persisted run state, schema-first.

```typescript
type StepStatus = …;
interface WorkflowSnapshot { name; input; steps; cursor }
interface StepSnapshot { … }
interface SnapshotState { … }
```

Every shape has a matching Zod schema (`StepSnapshotSchema`,
`SnapshotStateSchema`, …), defined in `./schema` — decode at the persistence
boundary rather than casting.

## `@foundry/workflows/step-hooks`

Cross-cutting behaviour without editing bodies.

```typescript
const wrapped = withStepHooks(spec, {
  before: [{ name: "authorize", execute: (input, ctx) => … }],
  after: {
    success: [{ name: "audit", execute: ({ input, output }, ctx) => … }],
    failure: [{ name: "alert", execute: ({ input, error }, ctx) => … }],
    suspension: [
      { name: "notify", execute: ({ input, suspension, occurrence }) => … },
    ],
  },
});
```

Suspension gets its own hook because it is neither success nor failure — a
two-outcome model would report a run waiting on a human as one or the other.

## `@foundry/workflows/types`

```typescript
type RunStatus / QueueStatus / Duration / CancellationSignal / Unsubscribe;
interface RetryPolicy { maxAttempts?; backoff?; maxElapsed?; shouldRetry? }
type BackoffStrategy = fixed | exponential | linear | jittered;
interface Bail<E> { _bail: true; error: E }
bail(error) / isBail(v) / StepBailError / isStepBailError(e);
interface Logger { debug/info/warn/error }
```

`RetryPolicy` is declarative on purpose — authors say _what_ they want and the
runtime decides _how_ to schedule it.

## `@foundry/workflows/config` · `/executable` · `/logger` · `/store`

```typescript
// config
contributeQueueConfig(config, overrides); // call before constructing
QUEUE_CONFIG_PREFIX / defaultQueueConfig / QueueConfigSchema;
defaultStepExecution / resolveStepExecution(step);

// executable — one frame's execution
interface BaseContext / ExecutableConfig;
SuspendSignal / isSuspendSignal(e) / suspensionOccurrenceKey(…);

// logger
interface OrchestratorLogger / class BaseOrchestratorLogger;
type RunLifecycleEvent;
```

`./store` is the persistence seam alone; see [Storage](#storage).

## `@foundry/workflows/schema`

The single definition of every record the stores persist or return: Queue,
Job, Run, Suspension, Run frame, and the in-memory store snapshot, plus the
snapshot and channel-event values they embed. Each is a Zod schema with its
type inferred from it; `./snapshot`, `./channels`, and `./types` re-export
the same schemas and types. Effect stays the runtime.

`RunRecordSchema` admits a Run the way the store always has and returns it
unchanged, so fields it does not declare survive. `RunRecordShapeSchema` is
the plain object schema of the declared fields, which a Run table derives
from. `PersistedMetadataSchema` and `PersistedWorkflowSchema` describe the
workflows namespaces of a Run's `metadata`; other namespaces stay open.

## Storage

| Path                               | Holds                                                         |
| ---------------------------------- | ------------------------------------------------------------- |
| `@foundry/workflows`               | `ExecutionCoordinator`, which holds every execution rule.      |
| `@foundry/workflows/store`         | `WorkflowStore`, its write, list queries and page types.       |
| `@foundry/workflows/store/memory`  | `MemoryWorkflowStore`, the default the coordinator uses.       |
| `@foundry/workflows/store/sqlite`  | `SqliteWorkflowStore`, over a host's Drizzle database.         |
| `@foundry/workflows/store/tables`  | Its Drizzle tables, `workflow_*`.                              |
| `@foundry/workflows/testing/store` | `describeWorkflowStore`, the suite every store passes.         |

A `WorkflowStore` keeps Queues, Jobs, Runs, Suspensions and the Run
journal's frames, and applies one `commit(write)` atomically: deletes, then
puts. It enforces nothing. Unique ids, lifecycle transitions, first-writer
Queues, the atomic aggregates (a managed Job attempt, a cancellation, a
parked or settled Suspension), a Run's frame sequence and effect claims are
the rules of `ExecutionCoordinator`. Each change is one read-modify-write
ending in one commit, inside the store's `transaction` when it offers one.
So two coordinators over one store, two engines on one database say, never
interleave. A read made of several store reads (a snapshot, the frames of
every Run) runs in one transaction too. Without `transaction`, a coordinator
serializes its own changes and no further.

```ts
import { ExecutionCoordinator } from "@foundry/workflows";
import { Orchestrator } from "@foundry/workflows/orchestrator";
import { SqliteWorkflowStore } from "@foundry/workflows/store/sqlite";

const store = new SqliteWorkflowStore({
  database, // a drizzle-orm/libsql database, or a transaction on one
  scope: workspaceId,
  // Optional: runs in the commit's transaction, after the store's statements.
  onCommit: async (transaction, write) => {
    await transaction.insert(changes).values({ write });
  },
});
const orchestrator = new Orchestrator({
  config,
  store: new ExecutionCoordinator({ store }),
});
```

`ExecutionCoordinator.snapshot()` returns every record as one checked
`OrchestratorStoreSnapshot`. `restore(snapshot)` puts a snapshot that
validates into a store that holds nothing, in one commit.
`MemoryWorkflowStore.snapshot()` reads the memory store's records at once,
synchronously, as of the last completed commit. It is not part of
`WorkflowStore`, and its records are not checked against each other. Marbles
writes its run files from it.

### Reads

List reads return records in the order they were first put, filtered by
exact column values (a Run's `queueId` and `status`, a Suspension's `runId`
and `status`, a Job's `status`, a frame's `runId`) and paged by an opaque
cursor and a limit. Both stores honour them alike, and the suite proves it.
Searching, matching tags and links, sorting by creation time and paging by
offset happen in the coordinator, over every record the store's filter
returns. So `listRuns({ search })` reads every Run in the scope, a Job's
attempts are found by reading every Run, since a legacy Run keeps its Job
link only in its metadata, and `listFrames()` reads every frame. That is
what the memory store did before. A store-side search and a Job-link column
are later work.

A cursor stays valid however many records are deleted around it: a store
never hands a position out twice in a scope, so a record put after the
cursor was taken lists after it. The memory store counts positions for its
whole life; the SQLite store keeps the count in `workflow_positions`, so it
survives deletes, other connections and reopening. A scope that has no
counter row yet (rows written before the table existed) gets one in its
first commit that puts or deletes anything: it starts past every position
any of the scope's tables holds before that commit's deletes, so neither a
delete in the same commit nor a delete-only commit lets a position come
back.

### Tables

Every table holds its record from `./schema` with one column per top-level
field, as the record holds it. Text stays text. Epoch milliseconds and
counters are integers. A field holding an object, an array or any JSON value
(`definition`, `links`, `input`, `output`, `metadata`, `extensions`, `tags`,
`snapshot`, `timestamps`, `payload`, `stepPath`, `request`, `resolution`,
`error`, `lastError`) is JSON text, read back whole. Every table also has
`scope`, first in every key, and `position`, the order a row was first put in
its scope. A row put again keeps its position. No read filters or orders on
anything inside a JSON column. `workflow_positions` holds one row per scope,
`next`, the position the scope's next new row of any table takes. It is the
one table no record defines: positions computed from the rows that survive
would be handed out again after a delete, and a cursor past them would skip
the new rows.

| Table                  | Key                         | Indexes                                    |
| ---------------------- | --------------------------- | ------------------------------------------ |
| `workflow_queues`      | `(scope, id)`               | `(scope, position)`                        |
| `workflow_jobs`        | `(scope, id)`               | `(scope, position)`                        |
| `workflow_runs`        | `(scope, id)`               | `(scope, position)`                        |
| `workflow_suspensions` | `(scope, id)`               | `(scope, position)`, `(scope, run_id, position)` |
| `workflow_run_frames`  | `(scope, run_id, cursor)`   | `(scope, position)`, `(scope, run_id, position)` |
| `workflow_positions`   | `(scope)`                   |                                            |

A NULL is `null` where the record takes `null` (`error`, `last_error`,
`resolution`, and a JSON value that is `null`). It is the field left out where
the record may leave it out: a Run's `definition` and `links`, since `{}` is
not absent. No field is both. A Run keeps fields its schema does not declare,
as `RunRecordSchema` admits it unchanged: `workflow_runs.undeclared` holds them
as one JSON object, NULL when there are none, and a read puts them back after
the declared fields. An entry named `__proto__`, in a dictionary or among a
Run's undeclared fields, is written by `JSON.stringify` and read back by
`JSON.parse` as an own data property; the suite reads one back from each
store.

Reads take each column as SQLite returns it, parse JSON columns, and pass
the record through the checks every write passes, its schema included. So
anything the store writes reads back, and anything it reads back can be
written again. A row the store would not have written is refused, with an
error naming the scope, the record and the column or field.

### `onCommit`

Each `commit` is one database transaction, and a throwing `onCommit` rolls it
back. `onCommit(transaction, write)` runs after the store's statements and
receives the store's own copy of the write, taken when `commit` was called:

- every record put, whole, in the write's order, as the store wrote it;
- every id each delete named (`deleteJobs`, `deleteRuns`,
  `deleteSuspensions`), and for `deleteRunFrames`, the Run ids whose frames
  all went. Each delete list is present, empty when the write named none.

It cannot learn whether a put filed a new record or replaced one, what a
replaced or deleted record held, or whether a delete found anything: the
store has written when the hook runs. A frame put is always new by the
coordinator's rules, as it only appends at the next cursor. A Run's status
change shows as the Run put whole. The write does not say which domain
command made it, and a host transaction handed in as `database` commits only
with the host.

Each coordinator command that changes anything is one commit, so one
`onCommit` per command; a command that changes nothing, or that is refused,
commits nothing and the hook does not run. A participant's own commands
inside a transaction each commit through the transaction's view, and each
calls `onCommit` inside the one transaction. Per command, the write holds:

| Command                                  | The write                                                                 | No commit when                                   |
| ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| `ensureQueue`                            | `putQueues`: the new Queue                                                | the Queue exists                                 |
| `updateQueue`                            | `putQueues`: the Queue                                                    | the Queue is missing                             |
| `createJob`                              | `putJobs`: the new Job                                                    |                                                  |
| `updateJob`                              | `putJobs`: the Job                                                        | it is missing, or ended and the status differs  |
| `claimJobRun`                            | `putJobs`: the Job, active; `putRuns`: the new Run                        |                                                  |
| `claimJobRun`, an earlier attempt done   | `putJobs`: the Job, complete. The call then rejects with `JobAlreadySettledError` |                                          |
| `cancelJob`                              | `putJobs`, `putRuns` (its live Run, if any), `putSuspensions` (each pending one, cancelled) |                                |
| `deleteJob`                              | `deleteJobs`: its id                                                      |                                                  |
| `createRun`                              | `putRuns`: the new Run                                                    |                                                  |
| `updateRun`                              | `putRuns`: the Run                                                        | it is missing, or ended and the status differs  |
| `deleteRun`                              | `deleteRuns`: its id                                                      |                                                  |
| `createSuspension`                       | `putSuspensions`: the new Suspension                                      |                                                  |
| `parkSuspension`                         | `putRuns`: the Run, suspended; `putSuspensions`: the new Suspension      | the occurrence is parked already                 |
| `settleSuspension`                       | `putRuns`: the Run, queued or cancelled; `putSuspensions`: the Suspension |                                                  |
| `cancelRun`, `cancelRunSuspensions`      | `putRuns`: the Run, cancelled; `putSuspensions`: each pending one, cancelled | `cancelRunSuspensions` finds it ended otherwise |
| `deleteSuspension`                       | `deleteSuspensions`: its id                                               |                                                  |
| `appendRunFrame`, `claimRunEffect`       | `putFrames`: the new frame                                                | a terminal frame or the claim exists already     |
| `deleteRunFrames`                        | `deleteRunFrames`: the Run id                                             |                                                  |
| `restore`                                | every record of the snapshot, put                                         |                                                  |

The write names no command; a host that needs one tells the commands apart by
the shape above.

### Exclusion and host requirements

Two coordinators over one `SqliteWorkflowStore` are kept apart. In this
process the store's calls take turns, so one made while a transaction runs
waits for it. Across connections, each transaction takes SQLite's write lock
at its first statement: Drizzle's libSQL driver begins every transaction with
`BEGIN IMMEDIATE`. A write from another process then waits for as long as its
connection's busy timeout allows, or fails with `SQLITE_BUSY`. It never lands
between a transaction's reads and its commit.

Host requirement: the store's queue covers only its own instance. Within one
process, the host must serialize writes per database file across every
client and store on it, a store per scope included (Marbles does). A second
libSQL client in the same process does not wait usefully: libSQL waits out
its busy timeout synchronously, holding up the thread the first client needs
to commit, so it blocks for the whole timeout and then fails with
`SQLITE_BUSY`. On a `:memory:` database a second store's call during a
transaction fails outright, as libSQL gives it a new, empty connection.
Connection settings such as WAL and the busy timeout are the host's.

A defect of `@libsql/client` 0.18.0, which the store cannot work around: a
client whose `BEGIN` fails with `SQLITE_BUSY` keeps the failed statement
open, and its next transaction fails at `COMMIT` with "SQL statements in
progress". In rollback-journal mode the file can stay blocked even for a
fresh client; in WAL mode a fresh client works. The store cannot reset a
client it was handed. So a host should put the database in WAL mode, and
replace its client after a `SQLITE_BUSY`.

Each store takes one call at a time, so a call to the store itself from
inside its own transaction's `work`, or from `onCommit`, could only wait for
itself. It is refused at once with a `ReentrantCallError` from
`@foundry/lib/turns` that says to use the view, or the transaction, instead.
The same holds a level up: a participant that calls the Orchestrator's own
`store` instead of the one it was handed is refused, not left waiting.
`Turns` tells the two apart by asynchronous context, so it does not detect
wait cycles: a transaction that awaits a continuation registered outside it
while that continuation calls the outer store still deadlocks.

A store states when a commit that resolved is there for good, as
`durability`. `"commit"` (the default): at once. `"host"`: only once a
transaction the store sits inside, which someone else owns, commits; until
then that owner may roll it back. A `SqliteWorkflowStore` handed a Drizzle
transaction as its `database` is `"host"` and refuses `"commit"`; over a
plain database pass `"host"` when the host has begun a transaction of its own
on the connection, which the store cannot see. A transaction's view is
`"host"` on every store, and `ExecutionCoordinator.durability` is its
store's. The coordinator and plain record work run over a `"host"` store.
The `Orchestrator` and `Queue` refuse one at construction: they start
workflow code, dispatch and signal cancellations once a commit resolves, and
would act on Runs a rollback removes. Run them over a store on the database
itself, outside the host's transaction.

The package ships table definitions only. It owns no migrations and opens no
database; the host composes the tables into its own schema. `drizzle-orm` is
an optional peer dependency, loaded only by `./store/sqlite` and
`./store/tables`.

### Limits

Storage limits of the SQLite store, not rules of the package. `commit`
refuses, before writing anything and through a transaction's view as well, a
write holding a value SQLite or JSON would not give back as it was. It
rejects with a `RangeError` naming the field, such as `putRuns[0].queueId` or
`putRuns[2].metadata.list[3]`:

- Text holding U+0000 (libSQL reads it back cut at the NUL) or not
  well-formed UTF-16 (a lone surrogate is bound as U+FFFD on Node and as
  nothing on Bun) in a plain-text column: an id, a Run's `queueId` or `step`,
  a status, a Queue's `name`, a Suspension's `kind`, `name`, `reason` or
  `runId`, a frame's `runId`. JSON escapes both, so JSON columns keep them. A
  read, list or delete by such a key finds nothing, as no row can hold one,
  and the constructor refuses such a `scope`.
- An integer column (`createdAt` of a Queue, a Suspension's `occurrence` and
  `revision`, a frame's `at` and `cursor`) holding NaN, an infinity, `-0`, or
  a number beyond `Number.MAX_SAFE_INTEGER` either way.
- In a JSON column or an undeclared Run field: NaN, an infinity, `-0`,
  `undefined` or a hole in an array, a `bigint`, a function, a symbol, a value
  that contains itself, or an object that is not plain (a `Date`, a `Map`).
- A property holding `undefined`, a required field left out, `null` in a Run's
  `definition` or `links`, a field a Job, Queue, Suspension or frame does not
  have, which no column would keep, and a record its schema refuses.

The memory store keeps all of these as `structuredClone` copies them, with
byte memory unshared (below). The
coordinator writes none but the text and `-0` cases: it
drops `undefined` entries from a Run's and a Job's `definition` and `links`,
and normalizes a Run's JSON data. A JSON value is bound as one text value,
under SQLite's default limit of 1,000,000,000 bytes. A commit of many records
is batched under SQLite's limit of 32,766 bound parameters per statement,
inside its one transaction.

Claiming or cancelling a Job reads every Run in the scope, under the store's
exclusion, to find the Job's attempts (a legacy Run names its Job only in its
metadata). Over SQLite that holds the write lock for the read of the whole
`workflow_runs` scope, so its cost grows with the number of Runs kept.

### Ownership

A store takes its own copy of a write when `commit` is called, before it
waits for its turn. Both stores start from one capture of it: each property
the write's type names is read once, by name, so one given as a getter on a
prototype or as an own property that is not enumerable counts like any
other, and nothing else on the object is read. That capture, and one read of
every record in it, is what the store checks, writes and hands to
`onCommit`; a getter that answers differently a second time changes
nothing. The capture refuses, with a `TypeError` naming the property and
before anything is written, a list that is not an array, a delete id that
is not text, and a record that is not a plain object (made by `{}` or
`Object.create(null)`) with every own property enumerable: a copy of
anything else could keep less than the record shows, and differently in
each store. List queries are captured the same way, by name, with `status`
an array of text and `queueId` and `runId` text.

The memory store then copies with `structuredClone` and moves every
`SharedArrayBuffer` in the copy (which `structuredClone` keeps shared on
Node), bare or behind a view, into a fresh `ArrayBuffer`, on every write and
on every read: `get*`, `list*`, `snapshot()` and a transaction's view. Each
shared buffer becomes one fresh buffer; each view onto it (every typed-array
kind and `DataView`, a view onto part of it included) a view of the same
kind, offset and length onto that buffer, so views that shared a buffer
still share one. The walk reaches all `structuredClone` keeps: object and
array entries, `Map` keys and values, `Set` values, and an `Error`'s own
properties, its non-enumerable `cause` (nested) included, and an
`AggregateError`'s `errors` on a runtime whose clone keeps them (Node's
clones it as a plain `Error` without them). The SQLite store refuses bytes
and Errors in a record, naming the field, so it holds none.

`ExecutionCoordinator` takes every command's arguments as they stand when the
command is called: one deep copy, bytes unshared, taken before anything
else runs, and the only one the command reads. Every public method gets it
in one place, so a command added later does too. An argument the copy
refuses (a function, say) rejects the call, and so does an argument object
the copy would read less of than it shows: one made by a class or another
prototype, or one with an own property that is not enumerable.

`ExecutionCoordinator.transaction` rolls back whenever its work throws,
whatever it throws. A direct `claimJobRun` of a Job whose earlier attempt
completed writes the Job as complete and then rejects with
`JobAlreadySettledError`; inside a transaction that rejection rolls the
write back with everything else, as any throw does. Admission does not
claim that way: inside its transaction the settled Job is an outcome, not a
throw, so the transaction commits the Job as complete, and the claim is
refused once it has.

---

## Notes

### Effect at the seam

The package's stated principle is "Effect-backed inside, plain TS at the seam."
`Step` and `Workflow` both honour it: `run()` and `resolve()` return a
`Promise`, `statusChanges` a `ReadableStream`. Effect stays on private
members, so a consumer holding either needs no Effect in scope.

### Entry points

The root export, `@foundry/workflows`, is the execution records' domain API:
`ExecutionCoordinator`, `OrchestratorStore` and its command types, snapshot
validation, and the decoders. It exports no store. Every other entry is a
named subpath, and unlike `@foundry/lib/config` there is no wildcard, so the
surface is exactly what the map lists.

Types resolve from `dist/`, not `src/`. Rebuild before a consumer typechecks
against a changed public API.

### `Step.make`

`Step.make` is `Step.create` wrapped in an already-resolved Promise, kept for
callers that still `await` it. New code should use `Step.create`.

## Local checks

Tests live in `src/test/`; shared helpers live in `src/test/helpers/`.
Run `bun run test`, `bun run typecheck`, and `bun run build` from this package.
Lint and formatting are owned by the repository root.
