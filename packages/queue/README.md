# @foundry/queue

A durable execution queue built on Effect. Submit a **Job**; the queue
starts a **Run** when its **Concurrency pool** has a free slot, retries
failures with backoff as new runs, parks runs on durable **Waits**, and
records every transition with a domain event in the same commit. The terms
are defined in [CONTEXT.md](./CONTEXT.md).

```ts
import { Queue } from "@foundry/queue";
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const queue = yield* Queue;
  yield* queue.register("send-email", (context) =>
    Effect.succeed({ kind: "completed", output: { to: context.job.input } })
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

A handler returns `completed`, `parked` (with a wait request), or `bailed`
(a failure that is never retried). A failure in the error channel is
retried under the job's retry policy. `RunContext.signal` aborts when the
run is cancelled, times out, or is drained. On resume, `resolvedWaits` and
`checkpoint` carry what the run needs to replay.

`Queue.layer(options)` takes `identity`, `defaultLimit` (the limit for a
pool nobody configured, unbounded by default), and `pools`. It needs a
`QueueStore`. Closing its scope stops admission and interrupts running
fibers. Their runs stay `running` until `recover` reclaims them.

## Seams

| Export | What it is |
| --- | --- |
| `.` | `Queue` tag and layers, domain types, events, errors |
| `./store` | `QueueStore` tag and `QueueWrite` |
| `./store/memory` | `MemoryQueueStore`, the default store |
| `./store/sqlite` | `SqliteQueueStore({ database, scope, onCommit? })` on Drizzle |
| `./store/tables` | Drizzle tables `queue_jobs`, `queue_runs`, `queue_waits`, `queue_pools` |
| `./client` | `createQueueClient()`, a Promise wrapper for plain TypeScript callers |

The SQLite store's `onCommit(transaction, write)` runs inside the commit's
transaction and receives the events it records, so an outbox writes them in
the same transaction.

Next: `@foundry/workflows` runs on this queue as a handler, and hosts adopt
it in place of their own run bookkeeping.
