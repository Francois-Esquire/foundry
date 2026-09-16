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

const job = await orchestrator.createJob({ definition: "analyze", input });
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
new Orchestrator({ config, persistence?, store?, logger?, registry?, queueExtensions? });
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
orchestrator.createJob(options): Promise<JobRecord>;
orchestrator.execute(jobId): Promise<DispatchedWorkflow>;
orchestrator.run(step, input, options?): Promise<DispatchedWorkflow>; // direct

orchestrator.getJob(id) / listJobs(query?) / cancelJob(id);
orchestrator.getRun(id) / listRuns(query?) / cancelRun(id) / get(runId);
orchestrator.observe(runId, options?): RunObservation;
```

Job and run are distinct: a job is the _intent_ (a definition name plus input),
a run is one _attempt_ at it. That is what lets a job be retried without losing
the history of what already failed.

Hosts can supply admission and cancellation participants with transactional
`ExecutionPersistence`. Participants use the supplied repository and journal;
their effects commit with the Run decision. Factory construction cannot claim
effects or emit outputs. Retained queued Jobs use the admission participant too.

Job admission returns its handle before behavior starts on a later host turn.
Committed handles are already indexed and counted by `drain`. Hosts composing
outer transactions must supply `afterCommit`: dispatch and cancellation signals
wait for that outer commit, and rollback drops them. Cancellation participants
serialize their decision with settlement; already-settled success stays intact.

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
orchestrator.listQueueDiagnostics(): readonly QueueDiagnostic[];
orchestrator.on(event, handler): Unsubscribe;
```

## `@foundry/workflows/queue`

The layer below the orchestrator. Reach for it directly only when you are
building a runtime rather than using one.

```typescript
queue.dispatch(step, input, …) / adopt(…) / dispatchPersisted(…) / hydrate(…);
queue.status(runId) / snapshot(runId) / results(runId) / error(runId);
queue.get(runId) / active() / pending() / size();
queue.findRecoverableRuns(): readonly RecoverableRun[];
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

Events are Effect `Schema.TaggedStruct`s, so they decode as well as encode:

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
class Snapshot { … }
```

Every shape has a matching `Schema` export (`StepSnapshotSchema`,
`SnapshotStateSchema`, …) — decode at the persistence boundary rather than
casting.

## `@foundry/workflows/step-hooks`

Cross-cutting behaviour without editing bodies.

```typescript
const wrapped = withStepHooks(step, {
  before: (input, ctx) => …,
  afterSuccess: ({ input, output, ctx }) => …,
  afterFailure: ({ input, error, ctx }) => …,
  afterSuspension: ({ input, suspension, ctx }) => …,
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

Plus every domain error re-exported: `RunNotFoundError`,
`SuspensionAlreadySettledError`, `StaleSuspensionRevisionError`,
`RunReplayGapError`, and about twenty more. They are named classes, so a caller
branches on the type rather than matching a message.

`RetryPolicy` is declarative on purpose — authors say _what_ they want and the
runtime decides _how_ to schedule it.

## `@foundry/workflows/persistence`

The seam a host implements to make runs durable.

```typescript
interface ExecutionPersistence {
  readonly repository: ExecutionRepository; // records: jobs, runs, suspensions
  readonly journal: RunJournal; // append-only frames
}

createInMemoryExecutionPersistence(options?): InMemoryExecutionPersistence;
```

Two seams, not one. The repository answers "what is true now"; the journal is
append-only history. Decoders (`decodeRunRecord`, `decodeRunFrame`,
`decodeSuspensionRecord`, …) are exported so an adapter validates rather than
casts at its boundary.

## `@foundry/workflows/testing`

Contract suites — run them against your own persistence implementation.

```typescript
import {
  executionPersistenceContract,
  orchestratorStoreContract,
} from "@foundry/workflows/testing";

orchestratorStoreContract(() => new MyStore());
executionPersistenceContract(() => myPersistence());
```

This is the intended way to validate a custom store. The in-memory
implementation passes them, so they define the behaviour rather than describe it.

## `@foundry/workflows/config` · `/executable` · `/logger` · `/store`

```typescript
// config
contributeQueueConfig(config, overrides); // call before constructing
QUEUE_CONFIG_PREFIX / defaultQueueConfig / QueueConfigSchema;
defaultStepExecution / resolveStepExecution(step);

// executable — one frame's execution
interface BaseContext / ExecutableConfig / Witness / DriveOptions;
SuspendSignal / isSuspendSignal(e) / suspensionOccurrenceKey(…);

// logger
interface OrchestratorLogger / class BaseOrchestratorLogger;
type RunLifecycleEvent;
```

`./store` is a compatibility barrel that re-exports the execution coordinator
whole. Its own docblock says new persistence implementations should use the
repository, journal, and persistence seams instead — treat it as the old door.

---

## Notes

### Effect at the seam

The package's stated principle is "Effect-backed inside, plain TS at the seam."
`Step` honours it: `run()` returns a `Promise`, `statusChanges` a
`ReadableStream`.

`Workflow` does not. Its surface returns `Effect.Effect<…>` and
`Stream.Stream<…>` for `status`, `state`, `result()`, `run()`, `cancel()`, and
`resolve()` — only `runPromise()` crosses back. A consumer holding a `Workflow`
needs Effect in scope; a consumer holding a `Step` does not.

In practice most hosts go through `Orchestrator`, which is Promise-based
throughout, so the leak is narrower than it looks. Worth knowing before you
reach for `Workflow` directly.

### Entry points

There is no root export. `import … from "@foundry/workflows"` does not resolve —
all 15 entries are named subpaths, and unlike `@foundry/lib/config` there is no
wildcard, so the surface is exactly what the map lists.

Types resolve from `dist/`, not `src/`. Rebuild before a consumer typechecks
against a changed public API.

### Size

13,175 lines. Two files carry a third of it: `execution-coordinator.ts` (1,910)
and `queue.ts` (1,470). Both are runtime internals reached through
`Orchestrator`, not surfaces you call.

`Step.make` is `Step.create` wrapped in an already-resolved Promise, kept for
callers that still `await` it. New code should use `Step.create`.

## Local checks

Tests live in `src/test/`; shared helpers live in `src/test/helpers/`.
Run `bun run test`, `bun run typecheck`, and `bun run build` from this package.
Lint and formatting are owned by the repository root.
