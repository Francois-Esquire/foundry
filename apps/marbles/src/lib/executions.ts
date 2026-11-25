import type { JsonValue } from "@foundry/lib/json";
import { sameProcess, thisProcess } from "@foundry/lib/node/process-identity";
import type {
  ConcurrencyPool,
  Job,
  JobId,
  QueueEvent,
  Run,
} from "@foundry/queue";
import type {
  ExecutionAnnex,
  ExecutionObservation,
  ExecutionRun,
  ExecutionRuns,
  ExecutionSubscription,
  PoolConfig,
  PoolStats,
  RetentionGap,
} from "./execution-record";
import {
  annexOf,
  bySequence,
  executionOf,
  now,
  withObservation,
} from "./execution-record";
import { SETTLED_EXECUTION_STATUSES } from "./execution-statuses";
import type { ExecutionStore } from "./execution-store";
import { storedObservation, storedProgress } from "./execution-store";
import type { RunQueue } from "./run-queue";

export type {
  ExecutionObservation,
  ExecutionRun,
  ExecutionRuns,
  ExecutionSubscription,
  ExecutionUsage,
  HostObservation,
  ModelTurnObservation,
  ObservationStatus,
  PoolConfig,
  PoolStats,
  RetentionGap,
  ToolCallObservation,
} from "./execution-record";
// biome-ignore lint/performance/noBarrelFile: Preserve the existing execution API while its record boundary has a canonical home.
export { DEFAULT_POOL } from "./execution-record";

type QueueReads = Pick<
  RunQueue,
  | "configurePool"
  | "pools"
  | "instanceId"
  | "awaitJob"
  | "getJob"
  | "getRun"
  | "listJobs"
  | "listRuns"
  | "removeJob"
  | "subscribe"
>;

interface Known {
  readonly job: Job;
  readonly run: Run;
}

export interface ExecutionsOptions {
  readonly pools?: Readonly<Record<string, PoolConfig>>;
  readonly removed?: (run: ExecutionRun) => Promise<void> | void;
  readonly store: ExecutionStore;
  readonly warn: (line: string) => void;
}

function ownedBy(run: Run, instanceId: string | undefined): boolean {
  if (run.state.kind === "running") {
    return run.state.lease.owner.instanceId === instanceId;
  }
  if (run.state.kind !== "queued" || run.state.owner === undefined) {
    return false;
  }
  const { owner } = run.state;
  return owner.instanceId === undefined
    ? sameProcess(owner, thisProcess())
    : owner.instanceId === instanceId;
}

export class Executions implements ExecutionRuns {
  readonly #store: ExecutionStore;
  readonly #warn: (line: string) => void;
  readonly #removed: (run: ExecutionRun) => Promise<void> | void;
  readonly #initial = new Map<string, ConcurrencyPool>();
  readonly #known = new Map<string, Known>();
  readonly #runOf = new Map<JobId, string>();
  readonly #submitted = new Map<JobId, Job>();
  readonly #annexes = new Map<string, ExecutionAnnex>();
  readonly #records = new Map<string, ExecutionRun>();
  readonly #listeners = new Set<(run: ExecutionRun) => void>();
  readonly #settling = new Map<string, PromiseWithResolvers<ExecutionRun>>();
  readonly #awaiting = new Set<string>();
  #gaps = new Map<string, RetentionGap>();
  #queue: QueueReads | undefined;
  #unsubscribe: (() => void) | undefined;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(options: ExecutionsOptions) {
    this.#store = options.store;
    this.#warn = options.warn;
    this.#removed = options.removed ?? (() => undefined);
    for (const [name, config] of Object.entries(options.pools ?? {})) {
      this.#initial.set(name, {
        limit: typeof config === "number" ? config : config.limit,
        name,
        state: "active",
      });
    }
  }

  async configurePool(pool: string, config: PoolConfig): Promise<void> {
    const configured: ConcurrencyPool = {
      limit: typeof config === "number" ? config : config.limit,
      name: pool,
      state: "active",
    };
    if (this.#queue === undefined) {
      this.#initial.set(pool, configured);
    } else {
      await this.#queue.configurePool(configured);
    }
  }

  initialPools(): readonly ConcurrencyPool[] {
    return [...this.#initial.values()];
  }

  pools(): Promise<readonly PoolStats[]> {
    return this.#queue?.pools() ?? Promise.resolve([]);
  }

  attach(queue: QueueReads): void {
    this.#queue = queue;
    this.#unsubscribe = queue.subscribe((event) => this.#learnEvent(event));
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async load(): Promise<void> {
    const queue = this.#queue;
    if (queue === undefined) {
      return;
    }
    const existing = new Set(this.#records.keys());
    const [gaps, annexes, jobs, runs] = await Promise.all([
      this.#store.gaps(),
      this.#store.list(),
      queue.listJobs(),
      queue.listRuns(),
    ]);
    this.#gaps = gapsOf(gaps);
    for (const stored of annexes) {
      this.#annexes.set(stored.id, this.#parsed(stored));
    }
    const byId = new Map(jobs.map((job) => [job.id, job]));
    const seen = new Set<string>();
    for (const run of runs) {
      const job = byId.get(run.jobId);
      if (job !== undefined) {
        seen.add(run.id);
        this.#learn(job, run);
      }
    }
    for (const id of existing) {
      if (!seen.has(id)) {
        this.#forget(id);
      }
    }
  }

  get(id: string): ExecutionRun | undefined {
    return this.#records.get(id);
  }

  owned(): readonly ExecutionRun[] {
    const instanceId = this.#queue?.instanceId;
    return [...this.#known.values()]
      .filter((known) => ownedBy(known.run, instanceId))
      .flatMap((known) => this.#records.get(known.run.id) ?? [])
      .sort(bySequence);
  }

  list(): readonly ExecutionRun[] {
    return [...this.#records.values()].sort(bySequence);
  }

  gaps(): readonly RetentionGap[] {
    return [...this.#gaps.values()];
  }

  async flush(): Promise<void> {
    await this.#writes;
  }

  settled(id: string): Promise<ExecutionRun> {
    const known = this.#records.get(id);
    if (known !== undefined && SETTLED_EXECUTION_STATUSES.has(known.status)) {
      return Promise.resolve(known);
    }
    const pending = this.#settling.get(id);
    if (pending !== undefined) {
      return pending.promise;
    }
    const waiting = Promise.withResolvers<ExecutionRun>();
    this.#settling.set(id, waiting);
    this.#watchEnd(id);
    return waiting.promise;
  }

  #watchEnd(id: string): void {
    if (this.#awaiting.has(id)) {
      return;
    }
    this.#awaiting.add(id);
    this.#awaitEnd(id)
      .catch((error: unknown) => {
        const waiting = this.#settling.get(id);
        this.#settling.delete(id);
        waiting?.reject(error);
      })
      .finally(() => this.#awaiting.delete(id));
  }

  async #awaitEnd(id: string): Promise<void> {
    const queue = this.#queue;
    if (queue === undefined) {
      return;
    }
    const run = this.#known.get(id)?.run ?? (await queue.getRun(id));
    if (run === undefined) {
      throw new Error(`run ${id} is not stored`);
    }
    const job = await queue.awaitJob(run.jobId);
    await this.refresh(id);
    const waiting = this.#settling.get(id);
    if (waiting === undefined) {
      return;
    }
    const last = this.#records.get(this.#runOf.get(job.id) ?? id);
    if (last === undefined || !SETTLED_EXECUTION_STATUSES.has(last.status)) {
      throw new Error(`run ${id} ended without a settled record`);
    }
    this.#settling.delete(id);
    waiting.resolve(last);
  }

  async peek(id: string): Promise<ExecutionRun | undefined> {
    await this.refresh(id);
    return this.#records.get(id);
  }

  async refresh(id: string): Promise<void> {
    const queue = this.#queue;
    if (queue === undefined) {
      return;
    }
    const [stored, run] = await Promise.all([
      this.#store.get(id),
      queue.getRun(id),
    ]);
    const job = run && (await queue.getJob(run.jobId));
    if (run === undefined || job === undefined) {
      this.#forget(id);
      return;
    }
    if (
      stored !== undefined &&
      stored.revision > (this.#annexes.get(id)?.revision ?? -1)
    ) {
      this.#annexes.set(id, this.#parsed(stored));
    }
    this.#learn(job, run);
  }

  watch(listener: (run: ExecutionRun) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async subscribe(
    listener: (run: ExecutionRun) => void
  ): Promise<ExecutionSubscription> {
    this.#listeners.add(listener);
    try {
      await this.load();
    } catch (error) {
      this.#warn(`[state] executions not refreshed: ${String(error)}`);
    }
    return {
      snapshot: this.list(),
      unsubscribe: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  progress(id: string, value: JsonValue): void {
    if (!this.#open(id)) {
      return;
    }
    let progress: JsonValue;
    try {
      progress = storedProgress(id, value);
    } catch (error) {
      this.#warn(
        `[state] execution ${id} progress not saved: ${String(error)}`
      );
      return;
    }
    this.#persist(async () => {
      if (!this.#open(id)) {
        return;
      }
      const at = now();
      await this.#store.progress(id, progress, at);
      this.#annex(id, (annex) => ({ ...annex, progress, updatedAt: at }));
    }).catch((error: unknown) =>
      this.#warn(`[state] execution ${id} progress not saved: ${String(error)}`)
    );
  }

  observe(
    id: string,
    observation: ExecutionObservation,
    options?: { readonly keepStart?: boolean }
  ): Promise<boolean> {
    if (!this.#open(id)) {
      return Promise.resolve(false);
    }
    let stored: ExecutionObservation;
    try {
      stored = storedObservation(id, observation);
    } catch (error) {
      this.#warn(
        `[state] execution ${id} observation not saved: ${String(error)}`
      );
      return Promise.resolve(false);
    }
    return this.#persist(async () => {
      if (!this.#open(id)) {
        return false;
      }
      const observations = withObservation(
        this.#annexes.get(id)?.observations ?? [],
        stored,
        options?.keepStart ?? false
      );
      const at = now();
      await this.#store.observe(id, observations.at(-1) ?? stored, at);
      this.#annex(id, (annex) => ({ ...annex, observations, updatedAt: at }));
      return true;
    }).catch((error: unknown) => {
      this.#warn(
        `[state] execution ${id} observation not saved: ${String(error)}`
      );
      return false;
    });
  }

  #open(id: string): boolean {
    const run = this.#records.get(id);
    return run !== undefined && !SETTLED_EXECUTION_STATUSES.has(run.status);
  }

  async prune(
    ids: Iterable<string>,
    scopeOf: (run: ExecutionRun) => string
  ): Promise<readonly ExecutionRun[]> {
    const queue = this.#queue;
    if (queue === undefined) {
      return [];
    }
    const removed: ExecutionRun[] = [];
    for (const id of new Set(ids)) {
      const run = await this.peek(id);
      if (!(run && SETTLED_EXECUTION_STATUSES.has(run.status))) {
        continue;
      }
      try {
        await this.#removed(run);
        await queue.removeJob(run.jobId as JobId);
        removed.push(run);
      } catch (error) {
        if (!removedElsewhere(error)) {
          this.#warn(`[state] run ${run.id} not removed: ${String(error)}`);
        }
      }
    }
    if (removed.length === 0) {
      return [];
    }
    const gaps = await this.#persist(() =>
      this.#store.remove(
        removed.map((run) => run.id),
        removed.map((run) => ({
          scope: scopeOf(run),
          through: run.timestamps.settledAt ?? run.timestamps.updatedAt,
        })),
        now()
      )
    );
    this.#gaps = gapsOf(gaps);
    for (const run of removed) {
      this.#forget(run.id);
    }
    return removed;
  }

  #parsed(stored: Parameters<typeof annexOf>[0]): ExecutionAnnex {
    return annexOf(stored, (count) =>
      this.#warn(
        `[state] skipped ${String(count)} unreadable observation(s) in executions/${stored.id}`
      )
    );
  }

  #learnEvent(event: QueueEvent): void {
    if (event.type === "job.removed") {
      for (const runId of event.runIds) {
        this.#forget(runId);
      }
      return;
    }
    if ("job" in event) {
      const runId = this.#runOf.get(event.job.id);
      const known = runId === undefined ? undefined : this.#known.get(runId);
      if (known === undefined && event.type === "job.submitted") {
        this.#submitted.set(event.job.id, event.job);
      } else if (known !== undefined) {
        this.#learn(event.job, known.run);
      }
      return;
    }
    if (!("run" in event)) {
      return;
    }
    const { run } = event;
    const job = this.#known.get(run.id)?.job ?? this.#submitted.get(run.jobId);
    if (job !== undefined) {
      this.#submitted.delete(run.jobId);
      this.#learn(job, run);
      return;
    }
    this.#queue
      ?.getJob(run.jobId)
      .then((found) => found && this.#learn(found, run))
      .catch((error: unknown) =>
        this.#warn(`[state] execution ${run.id} not read: ${String(error)}`)
      );
  }

  #learn(job: Job, run: Run): void {
    const latest = this.#known.get(run.id);
    if (latest !== undefined && latest.run.revision > run.revision) {
      return;
    }

    const first = this.#runOf.get(job.id);
    if (first !== undefined && first !== run.id) {
      const current = this.#known.get(first)?.run;
      if (current !== undefined && current.attempt > run.attempt) {
        return;
      }
      this.#drop(first);
    }
    this.#known.set(run.id, { job, run });
    this.#runOf.set(job.id, run.id);
    const record = executionOf(job, run, this.#annexes.get(run.id));
    const known = this.#records.get(run.id);
    if (known === undefined || record.revision > known.revision) {
      this.#publish(record);
    }
  }

  #annex(id: string, change: (annex: ExecutionAnnex) => ExecutionAnnex): void {
    const before = this.#annexes.get(id) ?? {
      id,
      observations: [],
      revision: 0,
    };
    const annex = { ...change(before), revision: before.revision + 1 };
    this.#annexes.set(id, annex);
    const known = this.#known.get(id);
    if (known !== undefined) {
      this.#publish(executionOf(known.job, known.run, annex));
    }
  }

  #forget(id: string): void {
    this.#drop(id);
    const waiting = this.#settling.get(id);
    if (waiting !== undefined) {
      this.#settling.delete(id);
      waiting.reject(new Error(`run ${id} was removed before it settled`));
    }
  }

  #drop(id: string): void {
    const known = this.#known.get(id);
    if (known !== undefined && this.#runOf.get(known.job.id) === id) {
      this.#runOf.delete(known.job.id);
    }
    this.#known.delete(id);
    this.#records.delete(id);
    this.#annexes.delete(id);
  }

  #publish(run: ExecutionRun): void {
    this.#records.set(run.id, run);
    if (SETTLED_EXECUTION_STATUSES.has(run.status)) {
      this.#settling.get(run.id)?.resolve(run);
      this.#settling.delete(run.id);
    }
    for (const listener of this.#listeners) {
      try {
        listener(run);
      } catch (error) {
        this.#warn(`[executions] a subscriber failed: ${String(error)}`);
      }
    }
  }

  #persist<T>(write: () => Promise<T>): Promise<T> {
    const landing = this.#writes.then(write);
    this.#writes = landing.catch(() => undefined);
    return landing;
  }
}

function gapsOf(gaps: readonly RetentionGap[]): Map<string, RetentionGap> {
  return new Map(gaps.map((gap) => [gap.scope, gap]));
}

function removedElsewhere(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "JobNotFoundError"
  );
}
