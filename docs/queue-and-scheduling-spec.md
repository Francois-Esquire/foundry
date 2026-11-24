# Phase 1 Specification: `@foundry/queue` and `@foundry/scheduling`

## Goal

Build two focused, lean, Effect-native packages from scratch in Phase 1:

1. **`@foundry/queue`** (`packages/queue`) — durable execution queue with named concurrency pools, `Job`, `Run`, `Suspension`, `Lease`, and transactional domain events.
2. **`@foundry/scheduling`** (`packages/scheduling`) — time-driven scheduler with `Schedule`, `Occurrence`, `ScheduleCursor`, overlap/misfire rules, and a narrow `Dispatch` seam into `@foundry/queue`.

**Phase 1 boundary (strict):**
- Do **not** modify `packages/workflows`, `apps/marbles`, `apps/works`, or any existing package.
- Do **not** integrate either package into existing apps yet.
- Do prove that `@foundry/scheduling` composes with `@foundry/queue` via a thin adapter (`@foundry/scheduling/queue`).

---

## Architecture & Design Principles

Follow three disciplines strictly:

1. **Deep modules (`codebase-design`):**
   - Each package exposes a small, high-leverage **interface** and hides concurrency, supervision, retries, and persistence behind it.
   - Only introduce a **seam** where 2+ real **adapters** exist (`QueueStore`: Memory + SQLite; `ScheduleStore`: Memory + SQLite; `Dispatch`: Queue + Fake; `Clock`: Effect `Clock` Live + `TestClock`; `Handler`: Workflow/Task/Build).
   - **The interface is the test surface.** Test through the public seam, not internal helpers.
2. **Domain modeling (`domain-modeling` + DDD):**
   - Keep **Queue** and **Scheduling** as separate bounded contexts. Queue knows nothing about cron, calendars, or workflow steps. Scheduling knows nothing about concurrency slots, retries of step bodies, or fibers.
   - Use discriminated unions for every lifecycle state so invalid states are unrepresentable (no bags of nullable timestamps).
   - Keep aggregates small and reference other aggregates by ID (`JobId`, `RunId`, `SuspensionId`, `ScheduleId`).
   - Ship a pure-glossary `CONTEXT.md` in each package (`packages/queue/CONTEXT.md` and `packages/scheduling/CONTEXT.md`) following `.agents/skills/domain-modeling/CONTEXT-FORMAT.md` — **definitions only, no implementation details**.
3. **Clean, lean Effect code (`clean-code`):**
   - Core implementation is **100% pure Effect** (`Context.Tag`, `Layer`, `Scope`, `Fiber`, `Ref`, `Deferred`, `Queue`, `PubSub`, `Stream`, `Schedule`, `Clock`).
   - **Never** call `Effect.runSync` / `Effect.runPromise` inside core modules, **never** mix Promise mutexes with Effect semaphores, and **never** add Symbol backdoors.
   - Provide **one** thin `ManagedRuntime`-backed Promise client at the edge (`./client`) for plain-TS callers.
   - Keep functions small, intention-revealing, and free of `Manager` / `Processor` / `Data` / `Info` naming smells.
   - **Target lean size:** roughly ~700–1,200 LOC for `packages/queue/src` (excl. tests) and ~500–900 LOC for `packages/scheduling/src` (excl. tests). Simplest clean code that satisfies every invariant wins.

---

## Package 1: `@foundry/queue` (`packages/queue`)

### Ubiquitous Language & Data Structures

Reuse `JsonValue` from `@foundry/lib/json`, `ProcessIdentity` (`thisProcess`, `isGone`) from `@foundry/lib/process-identity`, and `InstanceIdentity` (`openInstance`, `closeInstance`, `sameInstance`, `instanceGone`) from `@foundry/lib/instance-identity`.

#### Branded / Prefixed IDs & Value Objects
- `JobId` (`jb-<uuid>`), `RunId` (`rn-<uuid>`), `SuspensionId` (`su-<uuid>`), `PoolName` (non-empty string, default `"default"`).
- `Instant`: epoch milliseconds (`number`, UTC) — clean for `Clock.currentTimeMillis`, SQLite integer columns, and comparisons.
- `HandlerRef`: `{ readonly name: string; readonly version?: string }`
- `ErrorShape`: `{ readonly name: string; readonly message: string; readonly stack?: string }`
- `QueueOwner`: `InstanceIdentity`, a `ProcessIdentity` plus an optional `instanceId`. Every `Queue` names itself with a fresh `instanceId` (`QueueOptions.instanceId` overrides it), so two queues in one OS process never take each other's leases as their own. An owner without an `instanceId` (one handed over to a `ProcessIdentity`) belongs to any queue in that process.
- `Lease`: `{ readonly owner: QueueOwner; readonly claimedAt: Instant; readonly expiresAt?: Instant }`
- `Backoff`:
  - `{ readonly kind: "fixed"; readonly delayMs: number }`
  - `{ readonly kind: "exponential"; readonly initialMs: number; readonly factor?: number; readonly maxDelayMs?: number }`
  - `{ readonly kind: "linear"; readonly initialMs: number; readonly stepMs: number; readonly maxDelayMs?: number }`
  - `{ readonly kind: "jittered"; readonly initialMs: number; readonly factor?: number; readonly maxDelayMs?: number }`
- `RetryPolicy`: `{ readonly maxAttempts: number; readonly backoff?: Backoff; readonly maxElapsedMs?: number }`
- `ExecutionPolicy`: `{ readonly retry?: RetryPolicy; readonly timeoutMs?: number; readonly idempotencyKey?: string }`
- `Links`: `{ readonly parentJobId?: JobId; readonly parentRunId?: RunId; readonly triggerId?: string; readonly source?: string; readonly tags?: Readonly<Record<string, string>> }`
- `SuspensionRequest`: `{ readonly key: string; readonly kind: string; readonly reason: string; readonly request: JsonValue }`
- `RunOutcome` (returned by a worker Effect):
  - `{ readonly kind: "complete"; readonly output: JsonValue }`
  - `{ readonly kind: "suspended"; readonly suspension: SuspensionRequest }`
  - `{ readonly kind: "bailed"; readonly error: ErrorShape }` *(terminal business rejection — never retried)*
  - *(A failure in Effect's error channel is a retryable infrastructure failure governed by `RetryPolicy`.)*

#### Aggregates & Entities
- **`ConcurrencyPool`**:
  ```ts
  interface ConcurrencyPool {
    readonly name: PoolName;
    readonly limit: number; // integer >= 1 or Number.POSITIVE_INFINITY
    readonly state: "active" | "paused";
  }
  interface PoolStats extends ConcurrencyPool {
    readonly active: number;
    readonly waiting: number;
  }
  ```
- **`Job`** *(Aggregate Root — intent)*:
  ```ts
  type JobState =
    | { readonly kind: "pending" }
    | { readonly kind: "active"; readonly runId: RunId; readonly attempt: number }
    | { readonly kind: "suspended"; readonly runId: RunId; readonly suspensionId: SuspensionId }
    | { readonly kind: "complete"; readonly runId: RunId; readonly output: JsonValue; readonly completedAt: Instant }
    | { readonly kind: "failed"; readonly lastRunId: RunId; readonly error: ErrorShape; readonly failedAt: Instant }
    | { readonly kind: "cancelled"; readonly reason?: string; readonly cancelledAt: Instant };

  interface Job {
    readonly id: JobId;
    readonly handler: HandlerRef;
    readonly input: JsonValue;
    readonly pool: PoolName;
    readonly policy: ExecutionPolicy;
    readonly links: Links;
    readonly state: JobState;
    readonly createdAt: Instant;
  }
  ```
  *Invariants:*
  - At most one non-terminal `Run` per `Job`.
  - Once `complete`, `failed`, or `cancelled`, a `Job` never starts another `Run`.
  - Submitting with an existing `policy.idempotencyKey` returns the existing `Job` without duplicating work.

- **`Run`** *(Aggregate Root — one execution attempt)*:
  ```ts
  type RunState =
    | { readonly kind: "queued"; readonly availableAt: Instant; readonly queuedAt: Instant; readonly owner?: QueueOwner }
    | { readonly kind: "running"; readonly lease: Lease }
    | { readonly kind: "suspended"; readonly suspensionId: SuspensionId; readonly suspendedAt: Instant }
    | { readonly kind: "complete"; readonly output: JsonValue; readonly completedAt: Instant }
    | { readonly kind: "failed"; readonly error: ErrorShape; readonly retryable: boolean; readonly failedAt: Instant }
    | { readonly kind: "cancelled"; readonly reason?: string; readonly cancelledAt: Instant }
    | { readonly kind: "interrupted"; readonly lease: Lease; readonly reason: string; readonly interruptedAt: Instant };

  interface Run {
    readonly id: RunId;
    readonly jobId: JobId;
    readonly attempt: number;
    readonly pool: PoolName;
    readonly revision: number;
    readonly state: RunState;
    readonly checkpoint?: JsonValue;
  }
  ```
  *Invariants:*
  - Only `running` holds a slot in its `ConcurrencyPool`.
  - `queued` runs are eligible once `Clock.currentTimeMillis >= availableAt` (unifies immediate dispatch, delayed runs, and durable retry backoff).
  - Transitioning to `suspended`, `complete`, `failed`, `cancelled`, or `interrupted` releases the concurrency slot immediately.
  - `checkpoint` is opaque JSON owned by the worker (future seam for `@foundry/workflows`).

- **`Suspension`** *(Entity — durable external pause)*:
  ```ts
  type SuspensionState =
    | { readonly kind: "pending"; readonly createdAt: Instant }
    | { readonly kind: "resolved"; readonly value: JsonValue; readonly resolvedAt: Instant }
    | { readonly kind: "cancelled"; readonly reason?: string; readonly cancelledAt: Instant };

  interface Suspension {
    readonly id: SuspensionId;
    readonly runId: RunId;
    readonly key: string;
    readonly kind: string;
    readonly reason: string;
    readonly request: JsonValue;
    readonly revision: number;
    readonly state: SuspensionState;
  }
  ```
  *Invariants:*
  - Suspending on the same `(runId, key)` while already pending is idempotent (returns existing pending `Suspension`).
  - `resolveSuspension(suspensionId, value)` atomically settles the `Suspension` as `resolved`, transitions `Run` from `suspended → queued` (preserving its `attempt` and `checkpoint`), and transitions `Job` from `suspended → active` (or `pending` until claimed).
  - `cancelSuspension(suspensionId, reason?)` atomically settles the `Suspension` as `cancelled`; when its `Run` is suspended on it, the `Run` and `Job` are cancelled with it. A pending `Suspension` its `Run` is not suspended on is cancelled alone.
  - Settling an already-settled `Suspension` fails with a typed `SuspensionAlreadySettledError`.

#### Domain Events (`QueueEvent`)
Immutable past-tense facts emitted atomically with store commits. `queue.subscribe` (scoped) returns a stream that receives every event committed after the subscription is open:
- `job.submitted`, `job.settled`, `job.removed` (`{ job, runIds }`, committed by `removeJob`)
- `run.queued`, `run.started`, `run.suspended`, `run.resumed`, `run.completed`, `run.failed`, `run.cancelled`, `run.interrupted`, `run.handed_over`
- `suspension.opened`, `suspension.resolved`, `suspension.cancelled`

Each event carries `{ readonly id: string; readonly at: Instant; readonly type: ...; ... }`.

#### Worker Seam (`RunHandler` & `RunContext`)
```ts
interface RunContext {
  readonly job: Job;
  readonly run: Run;
  readonly resolutions: ReadonlyMap<string, JsonValue>; // resolved suspensions for this Run by suspension.key
  readonly checkpoint: JsonValue | undefined;
  readonly saveCheckpoint: (value: JsonValue) => Effect.Effect<void, QueueError>;
  readonly signal: AbortSignal; // aborted automatically when the Effect fiber is interrupted
}

type RunHandler = (ctx: RunContext) => Effect.Effect<RunOutcome, ErrorShape>;
```
*Why this seam matters:*
- When `Queue.cancel(...)` interrupts a running fiber, `signal` aborts automatically and Effect finalizers unwind cleanly.
- On resume after `suspended`, `ctx.resolutions` carries the settled resolution(s) by `suspension.key` and `ctx.checkpoint` carries the saved checkpoint, so a worker (like a future Workflow) can replay cleanly without knowing anything about the store.

#### Typed Errors (Effect `Data.TaggedError`)
Small, clear tagged errors:
- `JobNotFoundError`, `RunNotFoundError`, `SuspensionNotFoundError`
- `HandlerNotRegisteredError`, `HandlerAlreadyRegisteredError`
- `JobNotSettledError`, `JobRemovedError`
- `SuspensionAlreadySettledError`, `StaleSuspensionRevisionError`, `QueueRetiringError`, `InvalidPoolLimitError`, `InvalidRetryPolicyError`, `StoreError`, `WriteConflictError`

#### Queue Module Interface (`Context.Tag` + scoped `Layer`)
```ts
interface QueueService {
  readonly register: (name: string, handler: RunHandler) => Effect.Effect<void, HandlerAlreadyRegisteredError>;
  readonly submit: (input: SubmitJobInput) => Effect.Effect<Job, QueueError>;
  readonly cancel: (id: JobId | RunId, reason?: string) => Effect.Effect<void, QueueError>;
  readonly awaitJob: (id: JobId) => Effect.Effect<Job, QueueError>;
  readonly resolveSuspension: (suspensionId: SuspensionId, value: JsonValue) => Effect.Effect<Suspension, QueueError>;
  readonly cancelSuspension: (suspensionId: SuspensionId, reason?: string) => Effect.Effect<Suspension, QueueError>;
  readonly configurePool: (pool: ConcurrencyPool) => Effect.Effect<void, InvalidPoolLimitError | QueueError>;
  readonly pause: Effect.Effect<void>;
  readonly resume: Effect.Effect<void>;
  readonly drain: (graceMs?: number) => Effect.Effect<void, QueueError>;
  readonly retire: (successor?: QueueOwner) => Effect.Effect<readonly RunId[], QueueError>;
  readonly recover: (options?: { readonly isOwnerGone?: (owner: ProcessIdentity) => boolean }) => Effect.Effect<RecoverySummary, QueueError>;
  readonly getJob: (id: JobId) => Effect.Effect<Job | undefined, StoreError>;
  readonly getRun: (id: RunId) => Effect.Effect<Run | undefined, StoreError>;
  readonly getSuspension: (id: SuspensionId) => Effect.Effect<Suspension | undefined, StoreError>;
  readonly listJobs: (filter?: JobFilter) => Effect.Effect<readonly Job[], StoreError>;
  readonly listRuns: (filter?: RunFilter) => Effect.Effect<readonly Run[], StoreError>;
  readonly listSuspensions: (filter?: SuspensionFilter) => Effect.Effect<readonly Suspension[], StoreError>;
  readonly pools: Effect.Effect<readonly PoolStats[]>;
  readonly subscribe: Effect.Effect<Stream.Stream<QueueEvent>, never, Scope.Scope>;
}
```
*Key behaviors:*
- **Scoped lifecycle:** Opening `Queue.layer(...)` inside a `Scope` starts the internal dispatcher fiber; closing the `Scope` pauses admission, interrupts cleanly, and shuts down `PubSub`s without leaking fibers.
- **Dynamic concurrency:** Calling `configurePool({ name, limit, state })` immediately adjusts how many runs may execute in that pool and wakes waiting runs if limit increased or pool resumed.
- **Retry / timeout:** When a handler fails with a retryable `ErrorShape` (or times out per `policy.timeoutMs`) and `attempt < policy.retry.maxAttempts`, the current `Run` transitions to `failed { retryable: true }` and a **new `Run`** (`attempt + 1`) is atomically enqueued with `availableAt = now + backoffDelay`. When exhausted (or on `Bailed`), the `Job` settles as `failed`.
- **Ownership of queued runs:** a submitted first run is owned by the submitting queue. Retry runs and runs resumed by `resolveSuspension` are unowned, so any live, non-retiring queue with the handler registered may start them.
- **Retirement & hand-over:** `retire(successor?)` closes top-level admission (`QueueRetiringError` for new top-level `submit`) and still admits child jobs whose `links.parentRunId` is running here, owned by the retiring queue, which starts them. A retiring queue starts no other queued run; its running runs finish untouched and `drain()` waits for them. Queued runs the retiring queue owns are handed over to `successor` (emitting `run.handed_over`), or left unowned when there is no successor; a queued child whose parent is still running here stays owned by the retiring queue, which starts it. `retire` returns the ids of the runs it handed over.
- **Crash recovery:** `recover({ isOwnerGone })` scans `running` runs whose `lease.owner` is gone, marks them `interrupted`, retries the `Job` if `policy.retry` allows another attempt (otherwise fails the `Job`), and adopts `queued` runs whose owner is gone, keeping those owned by this queue (or unowned) available to start; `RecoverySummary.adopted` lists them all. An owner in this process is gone when its queue has closed; an owner in another process is gone when `isOwnerGone` (default `isGone`) says so.
- **Shared stores:** every commit raises the store's `watermark`. Each queue reads it every `syncIntervalMs` (default 500; `Infinity` turns it off) and, when it moved, starts newly available queued runs, interrupts (aborting `signal`) any running fiber whose run another queue cancelled, and wakes `awaitJob` callers.
- **Awaiting a job:** `awaitJob(jobId)` returns the terminal `Job` (`complete | failed | cancelled`), whichever queue or process settled it. It fails with `JobNotFoundError` when the job does not exist and `JobRemovedError` when it is removed while awaited.

#### Storage Seam (`QueueStore` `Context.Tag`)
- One small atomic persistence seam: read/list methods, an atomic `commit(write)` with optional `onCommit(tx, write)` hook carrying emitted `QueueEvent`s, and `watermark`, a per-scope counter every commit raises.
- Two adapters:
  1. `MemoryQueueStore` (`@foundry/queue/store/memory`) — default in-memory `Layer`.
  2. `SqliteQueueStore` (`@foundry/queue/store/sqlite`) + Drizzle tables (`@foundry/queue/store/tables`: `queue_jobs`, `queue_runs`, `queue_suspensions`, `queue_pools`, `queue_watermarks`, scoped by `scope` string, using `@foundry/lib/turns` for in-process serialization just like `@foundry/tasks`).

#### Exports for `@foundry/queue`
Keep exports clean and minimal:
- `.` — `Queue`, `QueueService`, domain types, errors, `MemoryQueueStore` re-export or default layer
- `./store` — `QueueStore` tag and write/query interfaces
- `./store/memory` — `MemoryQueueStore` layer
- `./store/sqlite` — `SqliteQueueStore` layer
- `./store/tables` — Drizzle SQLite table definitions (`drizzle-orm` optional peerDependency)
- `./client` — thin `ManagedRuntime`-backed Promise wrapper (`createQueueClient`)

---

## Package 2: `@foundry/scheduling` (`packages/scheduling`)

### Ubiquitous Language & Data Structures

Uses `croner` (`^9.1.0`) for `cron` and `calendar` evaluation.

#### Branded IDs & Value Objects
- `ScheduleId` (caller-provided key, e.g. `"nightly-sync"`), `OccurrenceId` (deterministic: `${scheduleId}:${scheduledFor}`).
- `Weekday`: `"sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat"`
- `Cadence`:
  ```ts
  type Cadence =
    | { readonly kind: "interval"; readonly everyMs: number }
    | { readonly kind: "calendar"; readonly hour: number; readonly minute: number; readonly weekdays?: readonly Weekday[]; readonly timezone: string }
    | { readonly kind: "cron"; readonly expression: string; readonly timezone: string }
    | { readonly kind: "once"; readonly at: Instant }
    | { readonly kind: "delay"; readonly afterSettleMs: number; readonly initialDelayMs?: number };
  ```
  Validate at registration (`everyMs > 0`, `hour 0..23`, `minute 0..59`, valid cron expression / timezone, `afterSettleMs >= 1`, `initialDelayMs >= 0`) — fail with `InvalidCadenceError`. A `delay` cadence accepts only `overlap: "skip"` and `misfire: "run-once"`; any other policy fails registration with `InvalidCadenceError`.
  - `delay` first comes due `initialDelayMs ?? afterSettleMs` after registration. Once its occurrence is dispatched, `nextDueAt` is `null` until the dispatched job settles; the next occurrence is due `afterSettleMs` after the job's own settle time. A due `delay` occurrence is dispatched alone however late it is seen, and stays due until it is dispatched.
- `OverlapPolicy`: `"skip" | "allow" | "cancel-previous"`
- `MisfirePolicy`: `"run-once" | "skip"`
- `DispatchTarget`:
  ```ts
  interface DispatchTarget {
    readonly handler: { readonly name: string; readonly version?: string };
    readonly input: JsonValue;
    readonly pool?: string;
    readonly policy?: { readonly retry?: unknown; readonly timeoutMs?: number };
  }
  ```
  *(Keep `DispatchTarget` structurally compatible with `@foundry/queue` without forcing `@foundry/scheduling` core to depend on `@foundry/queue`! Only the `./queue` adapter imports `@foundry/queue`.)*

#### Aggregates & Entities
- **`Schedule`** *(Aggregate Root)*:
  ```ts
  interface Schedule {
    readonly id: ScheduleId;
    readonly cadence: Cadence;
    readonly target: DispatchTarget;
    readonly overlap: OverlapPolicy;
    readonly misfire: MisfirePolicy;
    readonly state: "active" | "paused";
    readonly createdAt: Instant;
  }
  ```
- **`Occurrence`** *(Entity — one due moment of a schedule)*:
  ```ts
  type OccurrenceState =
    | { readonly kind: "claimed"; readonly lease: Lease; readonly claimedAt: Instant }
    | { readonly kind: "dispatched"; readonly jobId: string; readonly dispatchedAt: Instant }
    | { readonly kind: "skipped"; readonly reason: "overlap" | "misfire" | "already-claimed"; readonly at: Instant }
    | { readonly kind: "settled"; readonly jobId: string; readonly outcome: "complete" | "failed" | "cancelled"; readonly settledAt: Instant };

  interface Occurrence {
    readonly id: OccurrenceId;
    readonly scheduleId: ScheduleId;
    readonly scheduledFor: Instant;
    readonly state: OccurrenceState;
  }
  ```
- **`ScheduleCursor`** *(durable progress)*:
  ```ts
  interface ScheduleCursor {
    readonly scheduleId: ScheduleId;
    readonly lastScheduledFor?: Instant;
    readonly lastSettledAt?: Instant;
    readonly nextDueAt: Instant | null; // null after a `once` schedule was dispatched, and while a `delay` schedule's work is open
    readonly activeJobId?: string;
  }
  ```

#### Domain Events (`ScheduleEvent`)
- `schedule.registered`, `schedule.paused`, `schedule.resumed`, `schedule.removed`
- `occurrence.claimed`, `occurrence.skipped`, `occurrence.dispatched`, `occurrence.settled`

#### Pure Cadence Math (`nextDue`)
Export pure, side-effect-free functions:
- `nextDue(cadence: Cadence, after: Instant): Instant | null`
- `dueOccurrences(cadence: Cadence, nextDueAt: Instant, now: Instant, misfire: MisfirePolicy): { readonly toDispatch: Instant | null; readonly skipped: readonly Instant[]; readonly nextDueAt: Instant | null }`
  - If `now < nextDueAt`: nothing due yet.
  - If multiple due times elapsed while asleep/down (`misfire`):
    - `"run-once"`: dispatches the **latest** due time once, records earlier missed ones (or collapses cleanly), advances `nextDueAt` past `now`.
    - `"skip"`: skips overdue occurrences older than the current window and advances `nextDueAt` past `now`.

#### Dispatch Seam (`ScheduleDispatch` `Context.Tag`)
```ts
interface ScheduleDispatchService {
  readonly submit: (request: {
    readonly target: DispatchTarget;
    readonly idempotencyKey: string;
    readonly scheduleId: ScheduleId;
    readonly scheduledFor: Instant;
  }) => Effect.Effect<{ readonly jobId: string }, DispatchError>;
  readonly status: (jobId: string) => Effect.Effect<
    | { readonly kind: "open" }
    | { readonly kind: "settled"; readonly outcome: "complete" | "failed" | "cancelled"; readonly settledAt: Instant },
    DispatchError
  >;
  readonly cancel: (jobId: string, reason?: string) => Effect.Effect<void, DispatchError>;
}
```
*Overlap semantics:*
- Before dispatching a due `Occurrence`, if `cursor.activeJobId` exists, check `dispatch.status(cursor.activeJobId)`.
- A Job that is `pending`, `active`, or `suspended` reports `{ kind: "open" }`; a terminal one reports its outcome and the job's own terminal time as `settledAt`.
  - `overlap: "skip"` → record `Occurrence` as `skipped { reason: "overlap" }` and advance `nextDueAt`.
  - `overlap: "cancel-previous"` → call `dispatch.cancel(activeJobId, "superseded by next schedule occurrence")` then submit the new Job.
  - `overlap: "allow"` → submit the new Job immediately.
- Once settled, record the job's `settledAt` as the occurrence's `settledAt` and the cursor's `lastSettledAt`, and clear `activeJobId`.

#### Scheduler Module Interface (`Context.Tag` + scoped `Layer`)
```ts
interface SchedulerService {
  readonly register: (input: RegisterScheduleInput) => Effect.Effect<Schedule, ScheduleError>;
  readonly unregister: (id: ScheduleId) => Effect.Effect<void, ScheduleError>;
  readonly pause: (id: ScheduleId) => Effect.Effect<Schedule, ScheduleError>;
  readonly resume: (id: ScheduleId) => Effect.Effect<Schedule, ScheduleError>;
  readonly triggerNow: (id: ScheduleId) => Effect.Effect<Occurrence, ScheduleError>;
  readonly tick: Effect.Effect<readonly Occurrence[], ScheduleError>; // evaluate due schedules once right now
  readonly get: (id: ScheduleId) => Effect.Effect<Schedule | undefined, ScheduleError>;
  readonly list: Effect.Effect<readonly Schedule[], ScheduleError>;
  readonly cursor: (id: ScheduleId) => Effect.Effect<ScheduleCursor | undefined, ScheduleError>;
  readonly latestOccurrence: (id: ScheduleId) => Effect.Effect<Occurrence | undefined, ScheduleError>;
  readonly subscribe: Effect.Effect<Stream.Stream<ScheduleEvent>, never, Scope.Scope>;
}
```
- The scoped `Scheduler.layer(...)` runs a single lightweight loop fiber using Effect `Clock.sleep` computed dynamically from the soonest `nextDueAt` (woken immediately via a `Deferred`/signal whenever schedules are registered/resumed/unregistered — no wasteful tight polling).
- `SchedulerOptions`:
  - `identity`, `instanceId`: the claim owner. Every scheduler names itself with a fresh `instanceId`, so two schedulers in one process never take each other's claims as their own. A claim whose scheduler in this process has closed is taken over.
  - `retryDelayMs` (default 1000), `maxRetryDelayMs` (default 60 000): a schedule whose evaluation fails is retried after `retryDelayMs`, doubling per consecutive failure up to `maxRetryDelayMs`, reset by its next successful evaluation.
  - `settlePollMs` (default 5000): how often open dispatched work is checked for settlement.
  - `syncIntervalMs` (off by default): wake at least this often to observe schedules and cursors another writer changed. It is off by default, unlike the queue's 500 ms, because a scheduler already wakes for its own changes, at every due time it knows and every `settlePollMs` while work is open, and claims keep peers from dispatching one due time twice.
  - `maxOccurrencesPerSchedule` (default 100): each commit keeps only the newest this many settled or skipped occurrences of every schedule it touches; claimed and dispatched occurrences are never pruned.

#### Storage Seam & Queue Adapter
- **`ScheduleStore` (`Context.Tag`)**: reads, `claim`, `releaseClaim(id, owner)` (deletes an occurrence still claimed by that owner, after its dispatch failed), `commit(write)` (a write's `maxOccurrencesPerSchedule` prunes terminal settled/skipped occurrences of the schedules it touches in the same transaction; its `expectedCursors` must equal the stored cursors or the commit fails with `CursorConflictError` and writes nothing, and the scheduler evaluates again from the stored cursor), and `latestOccurrence(scheduleId)` (newest by `scheduledFor`).
  - `MemoryScheduleStore` (`@foundry/scheduling/store/memory`)
  - `SqliteScheduleStore` (`@foundry/scheduling/store/sqlite` + `@foundry/scheduling/store/tables`: `scheduling_schedules`, `scheduling_cursors`, `scheduling_occurrences`, scoped by `scope`, atomic claim via primary key `(scope, id)`). `claim(occurrence, replacing)` takes over a claim only if the stored occurrence still equals the one the scheduler read; the scheduler judges the old owner gone (`SchedulerOptions.isOwnerGone`, `isGone` by default) before it opens that transaction, and dispatches under the same occurrence id as idempotency key.
- **`QueueDispatchLayer` (`@foundry/scheduling/queue`)**:
  - Thin adapter (~30–50 LOC) bridging `ScheduleDispatch` to `@foundry/queue`'s `Queue` tag (`submit` with `idempotencyKey`, `links.triggerId = scheduleId`, `status` mapping `pending|active|suspended → { kind: "open" }` and terminal jobs to their `completedAt` / `failedAt` / `cancelledAt`, `cancel`).

#### Exports for `@foundry/scheduling`
- `.` — `Scheduler`, `SchedulerService`, `ScheduleDispatch`, cadence helpers (`nextDue`, `parseEvery`), domain types, errors
- `./store` — `ScheduleStore` tag & interfaces
- `./store/memory` — `MemoryScheduleStore` layer
- `./store/sqlite` — `SqliteScheduleStore` layer
- `./store/tables` — Drizzle SQLite table definitions (`drizzle-orm` optional peerDependency)
- `./queue` — `QueueDispatchLayer` adapter for `@foundry/queue`
- `./client` — thin `ManagedRuntime`-backed Promise wrapper (`createSchedulerClient`)

---

## Testing Strategy (Vitest — Lean, High-Signal, Zero Overtesting)

- Use **Vitest** (`vitest run`), tests in `src/test/`.
- **Test behavior at the public interface seam only.** Do not write tests for private helpers, trivial field getters, or redundant permutations of the same invariant.
- **Zero real wall-clock sleeps:** use Effect's `TestClock.adjust(...)` for every timeout, retry backoff, delayed run, cadence tick, misfire, and overlap test so both suites finish in well under a second.
- Target **3 concise, focused test files per package**:
  - `packages/queue/src/test/`:
    1. `queue.test.ts` — submit/idempotency, pool concurrency & live `configurePool` resize/pause, retry backoff (`TestClock`) vs `bailed` (no retry), timeout, cancellation (queued withdrawal & running fiber interruption + `AbortSignal`), drain, and the `subscribe` stream.
    2. `lifecycle.test.ts` — `suspended` releasing pool slot & `resolveSuspension`/`cancelSuspension` with `checkpoint` + `resolutions`, crash `recover` (dead owner → `interrupted` + retry), `retire` (blocks top-level, allows child of active parent, hands over queued runs), and `client` smoke check.
    3. `store.sqlite.test.ts` — Drizzle `:memory:` SQLite persistence round-trip, atomic transitions, `onCommit` events, and scope isolation.
  - `packages/scheduling/src/test/`:
    1. `cadence.test.ts` — `nextDue` & `dueOccurrences` for `interval`, `calendar` (weekdays + timezone), `cron`, and `once`, plus invalid cadence rejection.
    2. `scheduler.test.ts` — `TestClock`-driven loop, atomic occurrence claiming & idempotency, `overlap` (`skip` including suspended/open jobs, `allow`, `cancel-previous`), `misfire` (`run-once`, `skip`), `pause`/`resume`/`triggerNow`, and real end-to-end composition with `@foundry/queue` via `QueueDispatchLayer`.
    3. `store.sqlite.test.ts` — Drizzle `:memory:` SQLite persistence round-trip, atomic claim contention (two claims for same occurrence → one wins), and scope isolation.

---

## Repo Conventions & Verification Gate

- Keep dependency versions explicit and consistent with existing workspace packages (no catalogs):
  - `effect: "^3.22.1"`, `croner: "^9.1.0"`, `zod: "^4.4.3"`, `drizzle-orm: "^0.45.4"` (optional peerDependency + devDependency), `@libsql/client: "^0.18.0"`, `@effect/language-service: "^0.87.2"`, `@types/bun: "1.3.14"`, `@vitest/coverage-v8: "^4.1.9"`, `typescript: "^6.0.3"`, `vitest: "^4.1.9"`, `@foundry/core: "workspace:*"`, `@foundry/lib: "workspace:*"`, `@foundry/tsconfig: "workspace:*"`.
- Run `bun install` in the worktree so `bun.lock` reflects the two new workspace packages.
- All of the following must pass in the worktree before handback:
  - `bun run fix packages/queue packages/scheduling`
  - `bun run build --filter=@foundry/queue --filter=@foundry/scheduling`
  - `bun run test --filter=@foundry/queue --filter=@foundry/scheduling`
  - `bun run validate` (Ultracite check, Sherif `lint:deps`, `typecheck`, Knip `dead-code`)

---

## Next Phases (Out of Scope for Phase 1)

- **Phase 2 (`@foundry/workflows`, done):** `workflows`'s internal `Queue` and `Orchestrator` queue wrapper are removed; `Workflow` plugs into `@foundry/queue` as a `RunHandler` (`@foundry/workflows/queue-handler`) backed by `RunContext.checkpoint`, `RunContext.resolutions`, and the `suspended` `RunOutcome`. `workflow-effect-access.ts` stays as the internal seam the handler drives (`run`, `cancel`, `state`, `restoreTelemetry`).
- **Phase 3 (Host adoption):** Marbles runs every run, workflow or host task, as a job of one `@foundry/queue` per engine (`lib/run-queue.ts`): each Marbles queue is a concurrency pool, a launch is submitted at once, and retirement, hand-over, draining, recovery and removal are the queue's (`retire`, `drain`, `awaitJob`, `recover`, `removeJob`). Its Execution Runs are a projection of the queue's Jobs and Runs (`lib/executions.ts`) with only Marbles' observations, progress and retention gaps kept beside them, removed with a job through `job.removed` in the same commit. Its schedules and monitor polling run on `@foundry/scheduling`'s `Scheduler` over `SqliteScheduleStore` (`lib/schedule-loop.ts`, with its `ScheduleDispatch` in `lib/schedule-dispatch.ts`); a monitor keeps its pending launch in `marbles_monitor_states`. Adopting the packages in `apps/works` remains Phase 3.
