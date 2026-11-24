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
deletes a settled job with its runs and suspensions in one commit, and fails
with `JobNotSettledError` while the job is open.

`submit` takes an optional `runId` for the first run, and fails with
`RunAlreadyExistsError` when a run already has it. A run's `startedAt` is
when it first started, kept across suspending and resuming. `adopt(runId)`
takes over a suspended run: its pending suspensions move to a new revision,
so a resolution read before the takeover fails as stale. `abandon(runId,
error)` fails an open run that no fiber of this queue drives, without
retrying it, for a run whose driver is gone.

`Queue.layer(options)` takes `identity`, `defaultLimit` (the limit for a
pool nobody configured, 1 by default), and `pools`. It needs a
`QueueStore`. Closing its scope stops admission and interrupts running
fibers. Their runs stay `running` until `recover` reclaims them.

## Seams

| Export | What it is |
| --- | --- |
| `.` | `Queue` tag and layers, domain types, events, errors |
| `./store` | `QueueStore` tag and `QueueWrite` |
| `./store/memory` | `MemoryQueueStore`, the default store |
| `./store/sqlite` | `SqliteQueueStore({ database, scope, onCommit? })` on Drizzle |
| `./store/tables` | Drizzle tables `queue_jobs`, `queue_runs`, `queue_suspensions`, `queue_pools` |
| `./client` | `createQueueClient()`, a Promise wrapper for plain TypeScript callers; its `register` takes a handler that returns an outcome, a promise of one, or an Effect |

The SQLite store's `onCommit(transaction, write)` runs inside the commit's
transaction and receives the events it records, so an outbox writes them in
the same transaction. A commit writes and deletes in batches, so one commit
may hold more records than a statement can bind.

`@foundry/workflows/queue-handler` runs a workflow on this queue as a
handler.
