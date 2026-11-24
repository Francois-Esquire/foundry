# @foundry/workflows

The workflow kernel. Steps compose into trees, run as one Workflow, and can
suspend mid-flight waiting on a human. Durability comes from
[`@foundry/queue`](../queue): `@foundry/workflows/queue-handler` runs a
Workflow as a queue handler, checkpoints its settled steps on the Run, and
turns a suspended step into a queue Suspension.

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
import { Queue } from "@foundry/queue";
import { workflowHandler } from "@foundry/workflows/queue-handler";
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const queue = yield* Queue;
  yield* queue.register(
    "analyze",
    workflowHandler((input, { job, run }) => buildAnalyzeStep(input))
  );
  return yield* queue.submit({ handler: { name: "analyze" }, input });
});
```

The queue owns jobs, runs, retries, pools, suspensions and recovery; the
handler owns only the Workflow. On every attempt it builds the Workflow from
the factory, seeds the steps the Run's checkpoint records as settled, hands
each resolved suspension back by its occurrence key, and drives it:

- a returned value completes the Run (`null` when results are transient);
- `bail(error)` bails it, so the job fails without a retry;
- a thrown error fails the attempt, retried under the job's policy;
- `ctx.suspend()` suspends it on a queue Suspension keyed
  `suspensionOccurrenceKey(stepPath, name, occurrence)`.

`restoreWorkflow(workflow, checkpoint)` seeds a live Workflow from a Run's
checkpoint, for a host that holds the Workflow across a suspension.

### A reusable definition

When behavior is a reusable named definition rather than a one-off runtime
factory, extend `Step` or `Workflow`. Its descriptor is available before a Run
exists; `.factory()` materializes a fresh runtime for every dispatch.

```typescript
class Summarize extends Step<{ text: string }, string> {
  readonly definitionKey = "documents.summarize";
  readonly name = "Summarize document";

  protected async execute({ text }: { text: string }): Promise<string> {
    return text.slice(0, 200);
  }
}

const summarize = new Summarize();
yield* queue.register(
  summarize.definitionKey,
  workflowHandler((input) => summarize.factory()(input as { text: string }))
);
```

For direct, non-durable use, `.create()` binds reusable shared context and its
returned invocation receives the input. Per-invocation context overrides the
create-time context.

```typescript
const invocation = summarize.create({ tenantId: "acme" });
const summary = await invocation.run({ text: document }, { traceId });
```

`Workflow` definitions declare named placements with `graph.step()`, groups,
and branches. A nested workflow compiles inline beneath the parent Run, so its
steps share the parent snapshot, streaming, suspension and cancellation.

## How it comes together

```
Step             one frame — a body, children, cancellation, a stream
  Workflow       a Step tree as one run — status, telemetry, a result
    queue-handler  a Workflow as an @foundry/queue handler — checkpoints,
                   suspensions, retries through the queue
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

**Suspension is how a run waits on the world.** `ctx.suspend()` suspends the frame
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
`WorkflowSnapshot` shape a checkpoint keeps as its `tree`. The tree is
identity-only — `key` is the namespaced path, `name` the local name, `index` the
sibling order. Per-step status lives separately in a flat map keyed by the same
`key`, which is what lets status update without rewriting the tree.


## `@foundry/workflows/queue-handler`

```typescript
workflowHandler(factory, { onStart?, onFinish? }): RunHandler;
restoreWorkflow(workflow, checkpoint): Promise<void>;
WorkflowCheckpointSchema; // { steps, telemetry?, tree }
type WorkflowRunFactory = (input, { job, run }: WorkflowExecution) => Step | Workflow;
```

`onStart` hands the host the live Workflow when an attempt starts, so it can
stream its messages; `onFinish` runs when the attempt ends, however it ends.

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

Every approval is the same mechanic under a different vocabulary: suspend under a
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
type RunStatus / Duration / CancellationSignal / Unsubscribe;
interface RetryPolicy { maxAttempts?; backoff?; maxElapsed?; shouldRetry? }
type BackoffStrategy = fixed | exponential | linear | jittered;
interface Bail<E> { _bail: true; error: E }
bail(error) / isBail(v) / StepBailError / isStepBailError(e);
interface Logger { debug/info/warn/error }
```

`RetryPolicy` is declarative on purpose — authors say _what_ they want and the
runtime decides _how_ to schedule it.

## `@foundry/workflows/executable`

```typescript
interface BaseContext / ExecutableConfig;
SuspendSignal / isSuspendSignal(e);
suspensionOccurrenceKey(stepPath, name, occurrence);
parseSuspensionOccurrenceKey(key);
```

## `@foundry/workflows/schema`

The Zod schemas of the values the kernel persists and streams: step and
workflow snapshots, the suspension state, channel events, telemetry and
`ErrorShape`. `./snapshot`, `./channels`, and `./types` re-export the same
schemas and types. Effect stays the runtime.

## Notes

### Effect at the seam

The package's stated principle is "Effect-backed inside, plain TS at the seam."
`Step` and `Workflow` both honour it: `run()` and `resolve()` return a
`Promise`, `statusChanges` a `ReadableStream`. Effect stays on private
members, so a consumer holding either needs no Effect in scope.

### Entry points

The root export, `@foundry/workflows`, is `Step`, `Workflow`, the queue
handler and `JsonValue`. Every other entry is a named subpath, and there is no
wildcard, so the surface is exactly what the map lists.

Types resolve from `dist/`, not `src/`. Rebuild before a consumer typechecks
against a changed public API.

### `Step.make`

`Step.make` is `Step.create` wrapped in an already-resolved Promise, kept for
callers that still `await` it. New code should use `Step.create`.

## Local checks

Tests live in `src/test/`; shared helpers live in `src/test/helpers/`.
Run `bun run test`, `bun run typecheck`, and `bun run build` from this package.
Lint and formatting are owned by the repository root.
