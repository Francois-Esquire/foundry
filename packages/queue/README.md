# @foundry/queue

A durable execution queue built on Effect. Submit a **Job**; the queue
starts a **Run** when its **Concurrency pool** has a free slot, retries
failures with backoff as new runs, suspends runs on durable **Suspensions**,
and records every transition with a domain event in the same commit. The
terms are defined in [CONTEXT.md](./CONTEXT.md).

```ts
import { Queue } from "@foundry/queue";
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const queue = yield* Queue;
  yield* queue.register("send-email", (context) =>
    Effect.succeed({ kind: "complete", output: { to: context.job.input } })
  );
  return yield* queue.submit({
    handler: { name: "send-email" },
    input: "ops@example.com",
    policy: {
      idempotencyKey: "welcome:42",
      retry: { backoff: { initialMs: 1000, kind: "exponential" }, maxAttempts: 5 },
      timeoutMs: 30_000,
    },
  });
});

Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(Queue.memory())));
```

A handler returns `complete`, `suspended` (with a suspension request), or
`bailed` (an `ErrorShape` that is never retried). An error in the error
channel is retried under the job's retry policy. `RunContext.signal` aborts
when the run is cancelled, times out, or is drained. On resume,
`resolutions` and `checkpoint` carry what the run needs to replay.
`resolveSuspension` takes an optional `expectedRevision` and fails with
`StaleSuspensionRevisionError` when the suspension has moved on. `removeJob`
deletes a settled job with its runs and suspensions in one commit, records
`job.removed` with the job and its run ids, and fails with
`JobNotSettledError` while the job is open and `JobNotFoundError` once
another queue removed it first. `awaitJob(jobId)` returns the
job once it is complete, failed, or cancelled, whichever queue settled it;
it fails with `JobNotFoundError` for an unknown job and `JobRemovedError`
when the job is removed while awaited.

`submit` takes an optional `runId` for the first run, and fails with
`RunAlreadyExistsError` when a run already has it. A run's `startedAt` is
when it first started, kept across suspending and resuming. A suspended
run needs no hand-over or adoption: any queue may resolve its suspension, and the
resumed run is unowned. `abandon(runId, error)` fails an open run that no fiber of this queue drives, without
retrying it, for a run whose driver is gone.

`Queue.layer(options)` takes `identity` (a portable runtime identity by
default), `instanceId` (this queue's own name, a fresh UUID by default),
`isOwnerGone` (`() => false` by default, so portable runtimes never falsely
declare another process gone; `recover(options)` can override it per call),
`defaultLimit` (the limit for a pool nobody configured, 1 by default),
`pools`, and `syncIntervalMs` (500 by default; `Infinity` turns it off). It
needs a `QueueStore`. Closing its scope stops admission and interrupts
running fibers. Their runs stay `running` until `recover` interrupts them,
from this process once the closed queue's instance is gone, or from another
once its process is gone. Node and Bun hosts can use `@foundry/queue/node`
(`nodeQueueOptions`, `nodeQueueLayer`, `createNodeQueueClient`) to wire OS
`thisProcess()` identity and `isGone` liveness defaults automatically.

A submitted run is owned by the queue that submitted it. Retry runs and
resumed runs are unowned: any live queue that is not retiring and has the
handler registered starts them. `retire(successor?)` refuses new top-level
work, while running runs finish untouched and `drain()` waits for them. A
child a running run submits (`links.parentRunId`) is still admitted, owned
by the retiring queue, which starts it; it starts no other queued run. It
keeps the queued children of its running runs, submitted before or after
it retired, and hands the other queued runs it owns to `successor`, or
leaves them unowned when there is none, and returns their ids.

Several queues, in one process or many, can share a store. Every commit
raises the store's `watermark`. A queue that sees it move starts newly
available runs, interrupts a run it is running that another queue
cancelled (aborting its `signal`), and wakes `awaitJob` callers.

## Seams

| Export | What it is |
| --- | --- |
| `.` | `Queue` tag and layers, domain types, events, errors |
| `./store` | `QueueStore` tag and `QueueWrite` |
| `./store/memory` | `MemoryQueueStore`, the default store |
| `./store/sqlite` | `SqliteQueueStore({ database, scope, onCommit? })` on Drizzle |
| `./store/tables` | Drizzle tables `queue_jobs`, `queue_runs`, `queue_suspensions`, `queue_pools`, `queue_watermarks` |
| `./client` | `createQueueClient()`, a Promise wrapper for plain TypeScript callers; its `register` takes a handler that returns an outcome, a promise of one, or an Effect, and its `saveCheckpoint` can be awaited or yielded |
| `./node` | `nodeQueueOptions()`, `nodeQueueLayer()`, and `createNodeQueueClient()` with Node/Bun OS process identity (`thisProcess()`) and liveness (`isGone`) defaults |

The SQLite store's `onCommit(transaction, write)` runs inside the commit's
transaction and receives the events it records, so an outbox writes them in
the same transaction. A commit writes and deletes in batches, so one commit
may hold more records than a statement can bind.

Every write names the revision it expects each run and suspension it
changes to hold. A store checks them, and that no other job holds a written
job's idempotency key, in the commit's own transaction, and refuses a stale
write with `WriteConflictError`; the queue then reads again and decides
again, so several queues can share one store.

`@foundry/workflows/queue-handler` runs a workflow on this queue as a
handler.
