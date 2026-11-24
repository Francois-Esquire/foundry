# @foundry/scheduling

A time-driven scheduler built on Effect. Register a **Schedule** with a
**Cadence**. The scheduler sleeps until the next occurrence is due, claims the
**Occurrence** once, and hands it to a `ScheduleDispatch` with
`scheduleId:scheduledFor` as the idempotency key. Overlap and misfire rules
decide what happens when work is still open or when occurrences piled up while
the scheduler was paused or down. The terms are defined in
[CONTEXT.md](./CONTEXT.md).

```ts
import { Queue } from "@foundry/queue";
import { MemoryScheduleStore, Scheduler } from "@foundry/scheduling";
import { QueueDispatchLayer } from "@foundry/scheduling/queue";
import { Effect, Layer } from "effect";

const live = Scheduler.layer().pipe(
  Layer.provide(QueueDispatchLayer),
  Layer.provide(MemoryScheduleStore),
  Layer.provideMerge(Queue.memory())
);

const program = Effect.gen(function* () {
  const scheduler = yield* Scheduler;
  yield* scheduler.register({
    cadence: { hour: 2, kind: "calendar", minute: 0, timezone: "Europe/Paris" },
    id: "nightly-sync",
    misfire: "run-once",
    overlap: "skip",
    target: { handler: { name: "sync" }, input: { full: true } },
  });
});
```

Defaults: overlap `skip`, misfire `run-once`. Registering an existing id
updates it in place. It keeps its paused state, and its cursor unless the
cadence changed.

A `{ kind: "delay", afterSettleMs, initialDelayMs? }` cadence first fires
`initialDelayMs` (or `afterSettleMs`) after registration, then
`afterSettleMs` after each dispatched job settles, timed from the job's own
settle time. It fires at most once however long the scheduler was away,
and it accepts only overlap `skip` and misfire `run-once`.

`ScheduleDispatch.status(jobId)` returns `{ kind: "open" }` or
`{ kind: "settled", outcome, settledAt }`. `Scheduler.layer(options)`
takes `identity` and `instanceId` (the claim owner, a fresh UUID per
scheduler), `isOwnerGone`, `retryDelayMs` (1000) and `maxRetryDelayMs`
(60 000) for per-schedule failure backoff, `settlePollMs` (5000),
`syncIntervalMs` (off) to notice schedules another writer stored, and
`maxOccurrencesPerSchedule` (100) to prune settled and skipped occurrences.
`latestOccurrence(id)` reads a schedule's newest occurrence.
`triggerNow` dispatches immediately, even while a schedule is paused. The
pure helpers `nextDue`, `dueOccurrences`, `validateCadence`, and
`parseEvery` are exported for previews and validation.

## Seams

| Export | What it is |
| --- | --- |
| `.` | `Scheduler`, `ScheduleDispatch`, cadence helpers, domain types, errors |
| `./store` | `ScheduleStore` tag and `ScheduleWrite` |
| `./store/memory` | `MemoryScheduleStore` |
| `./store/sqlite` | `SqliteScheduleStore({ database, scope, onCommit? })` on Drizzle |
| `./store/tables` | Drizzle tables `scheduling_schedules`, `scheduling_cursors`, `scheduling_occurrences` |
| `./queue` | `QueueDispatchLayer`, the adapter onto `@foundry/queue` and the only module that imports it |
| `./client` | `createSchedulerClient({ dispatch })`, a Promise wrapper |

Next: hosts replace their own schedule loops with this package.
