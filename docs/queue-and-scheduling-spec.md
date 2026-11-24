# Phase 1 Specification: `@foundry/queue` and `@foundry/scheduling`

## Goal

Build two focused, lean, Effect-native packages from scratch in Phase 1:

1. **`@foundry/queue`** (`packages/queue`) — durable execution queue with named concurrency pools, `Job`, `Run`, `Wait`, `Lease`, and transactional domain events.
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
   - Keep aggregates small and reference other aggregates by ID (`JobId`, `RunId`, `WaitId`, `ScheduleId`).
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

Reuse `JsonValue` from `@foundry/lib/json` and `ProcessIdentity` (`thisProcess`, `sameProcess`, `isGone`) from `@foundry/lib/process-identity`.

#### Branded / Prefixed IDs & Value Objects
- `JobId` (`jb-<uuid>`), `RunId` (`rn-<uuid>`), `WaitId` (`wt-<uuid>`), `PoolName` (non-empty string, default `"default"`).
- `Instant`: epoch milliseconds (`number`, UTC) — clean for `Clock.currentTimeMillis`, SQLite integer columns, and comparisons.
- `HandlerRef`: `{ readonly name: string; readonly version?: string }`
- `Failure`: `{ readonly code: string; readonly message: string; readonly stack?: string }`
- `Lease`: `{ readonly owner: ProcessIdentity; readonly claimedAt: Instant; readonly expiresAt?: Instant }`
- `Backoff`:
  - `{ readonly kind: "fixed"; readonly delayMs: number }`
  - `{ readonly kind: "exponential"; readonly initialMs: number; readonly factor?: number; readonly maxDelayMs?: number }`
  - `{ readonly kind: "linear"; readonly initialMs: number; readonly stepMs: number; readonly maxDelayMs?: number }`
  - `{ readonly kind: "jittered"; readonly initialMs: number; readonly factor?: number; readonly maxDelayMs?: number }`
- `RetryPolicy`: `{ readonly maxAttempts: number; readonly backoff?: Backoff; readonly maxElapsedMs?: number }`
- `ExecutionPolicy`: `{ readonly retry?: RetryPolicy; readonly timeoutMs?: number; readonly idempotencyKey?: string }`
- `CausalLinks`: `{ readonly parentJobId?: JobId; readonly parentRunId?: RunId; readonly triggerId?: string; readonly source?: string; readonly tags?: Readonly<Record<string, string>> }`
- `WaitRequest`: `{ readonly key: string; readonly kind: string; readonly reason: string; readonly request: JsonValue }`
- `RunOutcome` (returned by a worker Effect):
  - `{ readonly kind: "completed"; readonly output: JsonValue }`
  - `{ readonly kind: "parked"; readonly wait: WaitRequest }`
  - `{ readonly kind: "bailed"; readonly error: Failure }` *(terminal business rejection — never retried)*
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
    | { readonly kind: "waiting"; readonly runId: RunId; readonly waitId: WaitId }
    | { readonly kind: "completed"; readonly runId: RunId; readonly output: JsonValue; readonly completedAt: Instant }
    | { readonly kind: "failed"; readonly lastRunId: RunId; readonly error: Failure; readonly failedAt: Instant }
    | { readonly kind: "cancelled"; readonly reason?: string; readonly cancelledAt: Instant };

  interface Job {
    readonly id: JobId;
    readonly handler: HandlerRef;
    readonly input: JsonValue;
    readonly pool: PoolName;
    readonly policy: ExecutionPolicy;
    readonly links: CausalLinks;
    readonly state: JobState;
    readonly createdAt: Instant;
  }
  ```
  *Invariants:*
  - At most one non-terminal `Run` per `Job`.
  - Once `completed`, `failed`, or `cancelled`, a `Job` never starts another `Run`.
  - Submitting with an existing `policy.idempotencyKey` returns the existing `Job` without duplicating work.

- **`Run`** *(Aggregate Root — one execution attempt)*:
  ```ts
  type RunState =
    | { readonly kind: "queued"; readonly availableAt: Instant; readonly queuedAt: Instant; readonly owner?: ProcessIdentity }
    | { readonly kind: "running"; readonly lease: Lease; readonly startedAt: Instant }
    | { readonly kind: "parked"; readonly waitId: WaitId; readonly parkedAt: Instant }
    | { readonly kind: "completed"; readonly output: JsonValue; readonly startedAt: Instant; readonly completedAt: Instant }
    | { readonly kind: "failed"; readonly error: Failure; readonly retryable: boolean; readonly startedAt: Instant; readonly failedAt: Instant }
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
  - Transitioning to `parked`, `completed`, `failed`, `cancelled`, or `interrupted` releases the concurrency slot immediately.
  - `checkpoint` is opaque JSON owned by the worker (future seam for `@foundry/workflows`).

- **`Wait`** *(Entity — durable external pause)*:
  ```ts
  type WaitState =
    | { readonly kind: "pending"; readonly createdAt: Instant }
    | { readonly kind: "resolved"; readonly value: JsonValue; readonly resolvedAt: Instant }
    | { readonly kind: "cancelled"; readonly reason?: string; readonly cancelledAt: Instant };

  interface Wait {
    readonly id: WaitId;
    readonly runId: RunId;
    readonly key: string;
    readonly kind: string;
    readonly reason: string;
    readonly request: JsonValue;
    readonly revision: number;
    readonly state: WaitState;
  }
  ```
  *Invariants:*
  - Parking the same `(runId, key)` while already pending is idempotent (returns existing pending `Wait`).
  - `resolveWait(waitId, value)` atomically settles the `Wait` as `resolved`, transitions `Run` from `parked → queued` (preserving its `attempt` and `checkpoint`), and transitions `Job` from `waiting → active` (or `pending` until claimed).
  - `cancelWait(waitId, reason?)` atomically settles the `Wait` as `cancelled` and cancels its `Run` and `Job`.
  - Settling an already-settled `Wait` fails with a typed `WaitAlreadySettledError`.

#### Domain Events (`QueueEvent`)
Immutable past-tense facts emitted atomically with store commits and streamed via `queue.events`:
- `JobSubmitted`, `JobSettled`
- `RunQueued`, `RunStarted`, `RunParked`, `RunResumed`, `RunCompleted`, `RunFailed`, `RunCancelled`, `RunInterrupted`, `RunHandedOver`
- `WaitOpened`, `WaitResolved`, `WaitCancelled`

Each event carries `{ readonly id: string; readonly at: Instant; readonly type: ...; ... }`.

#### Worker Seam (`RunHandler` & `RunContext`)
```ts
interface RunContext {
  readonly job: Job;
  readonly run: Run;
  readonly resolvedWaits: ReadonlyMap<string, JsonValue>; // resolved waits for this Run by wait.key
  readonly checkpoint: JsonValue | undefined;
  readonly saveCheckpoint: (value: JsonValue) => Effect.Effect<void, QueueError>;
  readonly signal: AbortSignal; // aborted automatically when the Effect fiber is interrupted
}

type RunHandler = (ctx: RunContext) => Effect.Effect<RunOutcome, Failure>;
```
*Why this seam matters:*
- When `Queue.cancel(...)` interrupts a running fiber, `signal` aborts automatically and Effect finalizers unwind cleanly.
- On resume after `Parked`, `ctx.resolvedWaits` carries the settled resolution(s) by `wait.key` and `ctx.checkpoint` carries the saved checkpoint, so a worker (like a future Workflow) can replay cleanly without knowing anything about the store.

#### Typed Errors (Effect `Data.TaggedError`)
Small, clear tagged errors:
- `JobNotFoundError`, `RunNotFoundError`, `WaitNotFoundError`
- `HandlerNotRegisteredError`, `HandlerAlreadyRegisteredError`
- `WaitAlreadySettledError`, `QueueRetiringError`, `InvalidPoolLimitError`, `StoreError`

#### Queue Module Interface (`Context.Tag` + scoped `Layer`)
```ts
interface QueueService {
  readonly register: (name: string, handler: RunHandler) => Effect.Effect<void, HandlerAlreadyRegisteredError>;
  readonly submit: (input: SubmitJobInput) => Effect.Effect<Job, QueueError>;
  readonly cancel: (id: JobId | RunId, reason?: string) => Effect.Effect<void, QueueError>;
  readonly resolveWait: (waitId: WaitId, value: JsonValue) => Effect.Effect<Wait, QueueError>;
  readonly cancelWait: (waitId: WaitId, reason?: string) => Effect.Effect<Wait, QueueError>;
  readonly configurePool: (pool: ConcurrencyPool) => Effect.Effect<void, InvalidPoolLimitError>;
  readonly pause: Effect.Effect<void>;
  readonly resume: Effect.Effect<void>;
  readonly drain: (graceMs?: number) => Effect.Effect<void, QueueError>;
  readonly retire: (successor?: ProcessIdentity) => Effect.Effect<readonly RunId[], QueueError>;
  readonly recover: (options?: { readonly isOwnerGone?: (owner: ProcessIdentity) => boolean }) => Effect.Effect<RecoverySummary, QueueError>;
  readonly getJob: (id: JobId) => Effect.Effect<Job | undefined, StoreError>;
  readonly getRun: (id: RunId) => Effect.Effect<Run | undefined, StoreError>;
  readonly getWait: (id: WaitId) => Effect.Effect<Wait | undefined, StoreError>;
  readonly listJobs: (filter?: JobFilter) => Effect.Effect<readonly Job[], StoreError>;
  readonly listRuns: (filter?: RunFilter) => Effect.Effect<readonly Run[], StoreError>;
  readonly listWaits: (filter?: WaitFilter) => Effect.Effect<readonly Wait[], StoreError>;
  readonly pools: Effect.Effect<readonly PoolStats[]>;
  readonly events: Stream.Stream<QueueEvent>;
}
```
*Key behaviors:*
- **Scoped lifecycle:** Opening `Queue.layer(...)` inside a `Scope` starts the internal dispatcher fiber; closing the `Scope` pauses admission, interrupts cleanly, and shuts down `PubSub`s without leaking fibers.
- **Dynamic concurrency:** Calling `configurePool({ name, limit, state })` immediately adjusts how many runs may execute in that pool and wakes waiting runs if limit increased or pool resumed.
- **Retry / timeout:** When a handler fails with a retryable `Failure` (or times out per `policy.timeoutMs`) and `attempt < policy.retry.maxAttempts`, the current `Run` transitions to `failed { retryable: true }` and a **new `Run`** (`attempt + 1`) is atomically enqueued with `availableAt = now + backoffDelay`. When exhausted (or on `Bailed`), the `Job` settles as `failed`.
- **Retirement & hand-over:** `retire(successor?)` closes top-level admission (`QueueRetiringError` for new top-level `submit`), **allows** child jobs whose `links.parentRunId` is currently active to still admit (preventing parent/child deadlocks), and if `successor` is provided, atomically hands over unstarted top-level `queued` runs to `successor` (emitting `RunHandedOver`).
- **Crash recovery:** `recover({ isOwnerGone })` scans `running` runs whose `lease.owner` is gone, marks them `interrupted`, retries the `Job` if `policy.retry` allows another attempt (otherwise fails the `Job`), and re-admits `queued` runs owned by this process (or unowned).

#### Storage Seam (`QueueStore` `Context.Tag`)
- One small atomic persistence seam: read/list methods + `transaction` (or atomic `commit(write)` with optional `onCommit(tx, write)` hook carrying emitted `QueueEvent`s).
- Two adapters:
  1. `MemoryQueueStore` (`@foundry/queue/store/memory`) — default in-memory `Layer`.
  2. `SqliteQueueStore` (`@foundry/queue/store/sqlite`) + Drizzle tables (`@foundry/queue/store/tables`: `queue_jobs`, `queue_runs`, `queue_waits`, `queue_pools`, scoped by `scope` string, using `@foundry/lib/turns` for in-process serialization just like `@foundry/tasks`).

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
    | { readonly kind: "once"; readonly at: Instant };
  ```
  Validate at registration (`everyMs > 0`, `hour 0..23`, `minute 0..59`, valid cron expression / timezone) — fail with `InvalidCadenceError`.
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
    readonly state: "enabled" | "paused";
    readonly createdAt: Instant;
  }
  ```
- **`Occurrence`** *(Entity — one scheduled firing)*:
  ```ts
  type OccurrenceState =
    | { readonly kind: "claimed"; readonly lease: Lease; readonly claimedAt: Instant }
    | { readonly kind: "dispatched"; readonly jobId: string; readonly dispatchedAt: Instant }
    | { readonly kind: "skipped"; readonly reason: "overlap" | "misfire" | "paused" | "already-claimed"; readonly at: Instant }
    | { readonly kind: "settled"; readonly jobId: string; readonly outcome: "completed" | "failed" | "cancelled"; readonly settledAt: Instant };

  interface Occurrence {
    readonly id: OccurrenceId;
    readonly scheduleId: ScheduleId;
    readonly scheduledFor: Instant;
    readonly state: OccurrenceState;
  }
  ```
- **`ScheduleCursor`** *(durable watermark)*:
  ```ts
  interface ScheduleCursor {
    readonly scheduleId: ScheduleId;
    readonly lastScheduledFor?: Instant;
    readonly lastSettledAt?: Instant;
    readonly nextDueAt: Instant | null; // null after a `once` schedule has fired
    readonly activeJobId?: string;
  }
  ```

#### Domain Events (`ScheduleEvent`)
- `ScheduleRegistered`, `SchedulePaused`, `ScheduleResumed`, `ScheduleRemoved`
- `OccurrenceClaimed`, `OccurrenceSkipped`, `OccurrenceDispatched`, `OccurrenceSettled`

#### Pure Cadence Math (`nextDue`)
Export pure, side-effect-free functions:
- `nextDue(cadence: Cadence, after: Instant): Instant | null`
- `dueOccurrences(cadence: Cadence, nextDueAt: Instant, now: Instant, misfire: MisfirePolicy): { readonly toFire: Instant | null; readonly skipped: readonly Instant[]; readonly nextDueAt: Instant | null }`
  - If `now < nextDueAt`: nothing due yet.
  - If multiple slots elapsed while asleep/down (`misfire`):
    - `"run-once"`: fires the **latest** due slot once, records earlier missed slots (or collapses cleanly), advances `nextDueAt` past `now`.
    - `"skip"`: skips overdue slots older than the current window and advances `nextDueAt` past `now`.

#### Dispatch Seam (`ScheduleDispatch` `Context.Tag`)
```ts
interface ScheduleDispatchService {
  readonly submit: (request: {
    readonly target: DispatchTarget;
    readonly idempotencyKey: string;
    readonly scheduleId: ScheduleId;
    readonly scheduledFor: Instant;
  }) => Effect.Effect<{ readonly jobId: string }, DispatchError>;
  readonly status: (jobId: string) => Effect.Effect<"open" | "completed" | "failed" | "cancelled", DispatchError>;
  readonly cancel: (jobId: string, reason?: string) => Effect.Effect<void, DispatchError>;
}
```
*Overlap semantics:*
- Before dispatching a due `Occurrence`, if `cursor.activeJobId` exists, check `dispatch.status(cursor.activeJobId)`.
- A Job that is `pending`, `active`, or `waiting` (parked) reports `"open"`.
  - `overlap: "skip"` → record `Occurrence` as `skipped { reason: "overlap" }` and advance `nextDueAt`.
  - `overlap: "cancel-previous"` → call `dispatch.cancel(activeJobId, "superseded by next schedule occurrence")` then submit the new Job.
  - `overlap: "allow"` → submit the new Job immediately.
- Once settled, record `lastSettledAt` and clear `activeJobId`.

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
  readonly events: Stream.Stream<ScheduleEvent>;
}
```
- The scoped `Scheduler.layer(...)` runs a single lightweight loop fiber using Effect `Clock.sleep` computed dynamically from the soonest `nextDueAt` (woken immediately via a `Deferred`/signal whenever schedules are registered/resumed/unregistered — no wasteful tight polling).

#### Storage Seam & Queue Adapter
- **`ScheduleStore` (`Context.Tag`)**:
  - `MemoryScheduleStore` (`@foundry/scheduling/store/memory`)
  - `SqliteScheduleStore` (`@foundry/scheduling/store/sqlite` + `@foundry/scheduling/store/tables`: `scheduling_schedules`, `scheduling_cursors`, `scheduling_occurrences`, scoped by `scope`, atomic claim via primary key `(scope, id)`).
- **`QueueDispatchLayer` (`@foundry/scheduling/queue`)**:
  - Thin adapter (~30–50 LOC) bridging `ScheduleDispatch` to `@foundry/queue`'s `Queue` tag (`submit` with `idempotencyKey`, `links.triggerId = scheduleId`, `status` mapping `pending|active|waiting → "open"`, `cancel`).

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
    1. `queue.test.ts` — submit/idempotency, pool concurrency & live `configurePool` resize/pause, retry backoff (`TestClock`) vs `bailed` (no retry), timeout, cancellation (queued withdrawal & running fiber interruption + `AbortSignal`), drain, and `events` stream.
    2. `lifecycle.test.ts` — `parked` releasing pool slot & `resolveWait`/`cancelWait` with `checkpoint` + `resolvedWaits`, crash `recover` (dead owner → `interrupted` + retry), `retire` (blocks top-level, allows child of active parent, hands over queued runs), and `client` smoke check.
    3. `store.sqlite.test.ts` — Drizzle `:memory:` SQLite persistence round-trip, atomic transitions, `onCommit` events, and scope isolation.
  - `packages/scheduling/src/test/`:
    1. `cadence.test.ts` — `nextDue` & `dueOccurrences` for `interval`, `calendar` (weekdays + timezone), `cron`, and `once`, plus invalid cadence rejection.
    2. `scheduler.test.ts` — `TestClock`-driven loop, atomic occurrence claiming & idempotency, `overlap` (`skip` including parked/open jobs, `allow`, `cancel-previous`), `misfire` (`run-once`, `skip`), `pause`/`resume`/`triggerNow`, and real end-to-end composition with `@foundry/queue` via `QueueDispatchLayer`.
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

- **Phase 2 (`@foundry/workflows`):** Remove `workflows`'s internal `Queue`, `workflow-effect-access.ts`, and `Orchestrator` queue wrapper; plug `Workflow` into `@foundry/queue` as a `RunHandler` backed by `RunContext.checkpoint`, `RunContext.resolvedWaits`, and `RunOutcome.parked`.
- **Phase 3 (Host adoption):** Migrate `apps/marbles` off its duplicate `Executions`/`Launcher`/`schedule.ts` onto `@foundry/queue` + `@foundry/scheduling`, eliminating `ORCHESTRATOR_CONCURRENCY = Number.MAX_SAFE_INTEGER` and dual run-record reconciliation; adopt `@foundry/queue` / `@foundry/scheduling` directly in `apps/works` where needed.
