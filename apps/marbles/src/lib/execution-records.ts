import { randomUUID } from "node:crypto";
import type { JsonValue } from "@foundry/lib/json";
import {
  isGone,
  type ProcessIdentity,
  sameProcess,
  thisProcess,
} from "@foundry/lib/process-identity";
import {
  bySequence,
  DEFAULT_QUEUE,
  type EnqueueInput,
  type ExecutionObservation,
  type ExecutionRun,
  type ExecutionSubscription,
  indexOf,
  jsonInput,
  now,
  parseStored,
  type RetentionGap,
  withObservation,
} from "./execution-record";
import type { ExecutionStatus } from "./execution-statuses";
import {
  EXECUTION_STATUSES,
  SETTLED_EXECUTION_STATUSES,
} from "./execution-statuses";
import type {
  ExecutionStore,
  ExecutionView,
  LifecycleChange,
  StoredExecution,
  Written,
} from "./execution-store";
import { storedProgress } from "./execution-store";
import type { RunStore } from "./run-store";
import { ANY_STORED_RUN } from "./run-store";

/** Unsettled, and this process's to settle. */
function ownedHere(run: ExecutionRun): boolean {
  return (
    sameProcess(run.owner, thisProcess()) &&
    !SETTLED_EXECUTION_STATUSES.has(run.status)
  );
}

function sameOwner(one: ProcessIdentity, other: ProcessIdentity): boolean {
  return one.pid === other.pid && one.started === other.started;
}

type Ending = "complete" | "failed" | "cancelled" | "interrupted";

interface Failure {
  readonly code: string;
  readonly message?: string;
}

const UNSETTLED: readonly ExecutionStatus[] = EXECUTION_STATUSES.filter(
  (status) => !SETTLED_EXECUTION_STATUSES.has(status)
);

function settling(
  owner: ProcessIdentity,
  status: Ending,
  error?: Failure,
  newOwner?: ProcessIdentity
): LifecycleChange {
  const at = now();
  return {
    dropInput: true,
    ...(error === undefined ? {} : { error }),
    from: UNSETTLED,
    ...(newOwner === undefined ? {} : { newOwner }),
    owner,
    settledAt: at,
    status,
    updatedAt: at,
  };
}

const INTERRUPTED = {
  code: "interrupted",
  message: "its process exited while it was running",
} as const;

const RETRY_FIRST_MS = 100;
const RETRY_LONGEST_MS = 30_000;

/** Storage and cleanup owned by the durable execution authority. */
export interface ExecutionRecordsOptions {
  readonly removed?: (run: ExecutionRun) => Promise<void> | void;
  readonly runs?: Pick<RunStore, "claim" | "release">;
  readonly store: ExecutionStore;
  readonly warn: (line: string) => void;
}

export class ExecutionRecords {
  readonly #store: ExecutionStore;
  readonly #warn: (line: string) => void;
  readonly #records = new Map<string, ExecutionRun>();
  readonly #listeners = new Set<(run: ExecutionRun) => void>();
  readonly #removed: (run: ExecutionRun) => Promise<void> | void;
  readonly #runs: Pick<RunStore, "claim" | "release"> | undefined;
  /** Each record's observation positions by id, for the array it was built for. */
  readonly #indexes = new WeakMap<
    readonly ExecutionObservation[],
    Map<string, number>
  >();
  #gaps = new Map<string, RetentionGap>();
  #sequence = 0;
  #writes: Promise<unknown> = Promise.resolve();
  readonly #unsettled = new Map<
    string,
    { readonly error?: Failure; readonly status: Ending }
  >();
  readonly #retry: {
    passing: boolean;
    timer?: ReturnType<typeof setTimeout>;
    wait: number;
  } = { passing: false, wait: RETRY_FIRST_MS };

  constructor(options: ExecutionRecordsOptions) {
    this.#store = options.store;
    this.#warn = options.warn;
    this.#removed = options.removed ?? (() => undefined);
    this.#runs = options.runs;
  }

  async flush(): Promise<void> {
    await this.#writes;
  }

  gaps(): readonly RetentionGap[] {
    return [...this.#gaps.values()];
  }

  get(id: string): ExecutionRun | undefined {
    return this.#records.get(id);
  }

  list(): readonly ExecutionRun[] {
    return [...this.#records.values()].sort(bySequence);
  }

  async prune(
    ids: Iterable<string>,
    scopeOf: (run: ExecutionRun) => string
  ): Promise<readonly ExecutionRun[]> {
    const candidates = [...new Set(ids)].flatMap((id) => {
      const run = this.#records.get(id);
      return run && SETTLED_EXECUTION_STATUSES.has(run.status) ? [run] : [];
    });
    const cleaned: ExecutionRun[] = [];
    for (const candidate of candidates) {
      const run = this.#parse(await this.#store.get(candidate.id));
      if (run === undefined) {
        this.#records.delete(candidate.id);
        continue;
      }
      if (!SETTLED_EXECUTION_STATUSES.has(run.status)) {
        this.#learn(run);
        continue;
      }
      try {
        await this.#removed(run);
        cleaned.push(run);
      } catch (error) {
        this.#warn(`[state] run ${run.id} not removed: ${String(error)}`);
      }
    }
    if (cleaned.length === 0) {
      return [];
    }
    const { gaps, removed } = await this.#persist(() =>
      this.#store.transaction((view) =>
        removing(view, cleaned, scopeOf, (stored) => this.#parse(stored))
      )
    );
    this.#gaps = gaps;
    for (const run of removed) {
      this.#records.delete(run.id);
    }
    return removed;
  }

  async subscribe(
    listener: (run: ExecutionRun) => void
  ): Promise<ExecutionSubscription> {
    this.#listeners.add(listener);
    await this.#refresh();
    return {
      snapshot: this.list(),
      unsubscribe: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  async load(): Promise<void> {
    this.#gaps = gapsOf(await this.#store.gaps());
    for (const run of await this.#stored()) {
      this.#records.set(run.id, run);
      this.#sequence = Math.max(this.#sequence, run.sequence);
    }
  }

  async #stored(): Promise<ExecutionRun[]> {
    const runs: ExecutionRun[] = [];
    for (const stored of await this.#store.list()) {
      const run = this.#parse(stored);
      if (run === undefined) {
        this.#warn(
          `[state] skipped executions/${stored.id}: not an execution run`
        );
        continue;
      }
      runs.push(run);
    }
    return runs;
  }

  #parse(stored: StoredExecution | undefined): ExecutionRun | undefined {
    return (
      stored &&
      parseStored(stored, (count) =>
        this.#warn(
          `[state] skipped ${String(count)} unreadable observation(s) in executions/${stored.id}`
        )
      )
    );
  }

  async #refresh(): Promise<void> {
    let stored: ExecutionRun[];
    let gaps: readonly RetentionGap[];
    try {
      stored = await this.#stored();
      gaps = await this.#store.gaps();
    } catch (error) {
      this.#warn(`[state] executions not refreshed: ${String(error)}`);
      return;
    }
    this.#gaps = gapsOf(gaps);
    const seen = new Set<string>();
    for (const run of stored) {
      seen.add(run.id);
      this.#sequence = Math.max(this.#sequence, run.sequence);
      this.#learn(run);
    }
    for (const [id, local] of this.#records) {
      if (!(seen.has(id) || ownedHere(local))) {
        this.#records.delete(id);
      }
    }
  }

  async enqueue(request: EnqueueInput): Promise<{
    readonly existing: boolean;
    readonly run: ExecutionRun;
  }> {
    // Before anything is recorded: an input that is not JSON never queues.
    const input =
      request.input === undefined ? undefined : jsonInput(request.input);
    const { source } = request;
    const launched = await this.#persist(() =>
      this.#store.transaction(async (view) => {
        const stored =
          source === undefined
            ? undefined
            : this.#parse(await view.withSource(request.name, source));
        if (stored) {
          return { existing: true, run: stored };
        }
        const run = this.#queued(request, input);
        if (!(await view.create(run))) {
          throw new Error(`execution run ${run.id} is stored already`);
        }
        return { existing: false, run };
      })
    );
    this.#sequence = Math.max(this.#sequence, launched.run.sequence);
    this.#learn(launched.run);
    return launched;
  }

  #queued(request: EnqueueInput, input: JsonValue | undefined): ExecutionRun {
    this.#sequence = Math.max(Date.now(), this.#sequence + 1);
    const at = now();
    return {
      correlation: { ...request.correlation },
      id: `rn-${randomUUID()}`,
      ...(input === undefined ? {} : { input }),
      kind: request.kind,
      name: request.name,
      observations: [],
      owner: thisProcess(),
      queue: request.queue,
      revision: 1,
      sequence: this.#sequence,
      ...(request.source === undefined ? {} : { source: request.source }),
      status: "queued",
      timestamps: { queuedAt: at, updatedAt: at },
    };
  }

  progress(id: string, value: JsonValue): void {
    this.#saveProgress(id, value).catch((error: unknown) => {
      this.#warn(
        `[state] execution ${id} progress not saved: ${String(error)}`
      );
    });
  }

  async #saveProgress(id: string, value: JsonValue): Promise<void> {
    const progress = storedProgress(id, value);
    await this.#persist(async () => {
      const run = this.#records.get(id);
      if (!run || SETTLED_EXECUTION_STATUSES.has(run.status)) {
        return;
      }
      await this.#took(
        id,
        await this.#store.advise(id, { progress, updatedAt: now() })
      );
    });
  }

  observe(
    id: string,
    observation: ExecutionObservation,
    options?: { readonly keepStart?: boolean }
  ): Promise<boolean> {
    return this.#persist(async () => {
      const run = this.#records.get(id);
      if (!run || SETTLED_EXECUTION_STATUSES.has(run.status)) {
        return false;
      }
      const index =
        this.#indexes.get(run.observations) ?? indexOf(run.observations);
      const observations = withObservation(
        run.observations,
        index,
        observation,
        options?.keepStart ?? false
      );
      const recorded = observations.at(-1) ?? observation;
      const written = await this.#store.observe(id, recorded, now());
      if (written.applied) {
        this.#indexes.set(observations, index);
      }
      await this.#took(id, written, written.applied ? observations : undefined);
      return written.applied;
    }).catch((error: unknown) => {
      this.#warn(
        `[state] execution ${id} observation not saved: ${String(error)}`
      );
      return false;
    });
  }

  async adoptParked(run: {
    readonly createdAt: number;
    readonly id: string;
    readonly name: string;
  }): Promise<void> {
    if (this.#records.has(run.id)) {
      return;
    }
    const at = Number.isFinite(run.createdAt)
      ? new Date(run.createdAt).toISOString()
      : now();
    const sequence = Number.isFinite(run.createdAt)
      ? run.createdAt
      : this.#sequence + 1;
    this.#sequence = Math.max(this.#sequence, sequence);
    const record: ExecutionRun = {
      correlation: {},
      id: run.id,
      kind: "workflow",
      name: run.name,
      observations: [],
      owner: thisProcess(),
      queue: DEFAULT_QUEUE,
      revision: 1,
      sequence,
      status: "suspended",
      timestamps: { queuedAt: at, startedAt: at, updatedAt: now() },
    };
    if (await this.#persist(() => this.#store.create(record))) {
      this.#learn(record);
    } else {
      this.#learn(this.#parse(await this.#store.get(run.id)));
    }
  }

  protected async startRecord(id: string): Promise<void> {
    const at = now();
    const written = await this.#persist(() =>
      this.#store.transition(id, {
        dropInput: true,
        from: ["queued"],
        owner: thisProcess(),
        startedAt: at,
        status: "running",
        updatedAt: at,
      })
    );
    const stored = await this.#took(id, written);
    if (!written.applied) {
      throw new Error(
        `execution run ${id} is ${stored?.status ?? "gone"} now; it does not start`
      );
    }
  }

  protected moveRecord(id: string, status: "running" | "suspended"): void {
    const at = now();
    this.#persist(
      async () =>
        await this.#took(
          id,
          await this.#store.transition(id, {
            from: [status === "running" ? "suspended" : "running"],
            owner: thisProcess(),
            status,
            updatedAt: at,
          })
        )
    ).catch((error: unknown) => {
      this.#warn(`[state] execution ${id} not saved: ${String(error)}`);
    });
  }

  async takeReleased(id: string): Promise<boolean> {
    const written = await this.#persist(() =>
      this.#store.transaction(async (view): Promise<Written> => {
        const stored = this.#parse(await view.get(id));
        if (stored?.status !== "suspended") {
          return { applied: false, record: stored };
        }
        return await view.transition(id, {
          from: ["suspended"],
          newOwner: thisProcess(),
          owner: stored.owner,
          status: "suspended",
          updatedAt: now(),
        });
      })
    );
    await this.#took(id, written);
    return written.applied;
  }

  async readHanded(id: string): Promise<ExecutionRun | undefined> {
    const stored = this.#parse(await this.#store.get(id));
    if (
      stored?.status !== "queued" ||
      !sameProcess(stored.owner, thisProcess())
    ) {
      return;
    }
    this.#learn(stored);
    return this.#records.get(id);
  }

  protected async handQueued(
    id: string,
    choose: (view: ExecutionView) => Promise<ProcessIdentity | undefined>
  ): Promise<boolean> {
    const written = await this.#persist(() =>
      this.#store.transaction(async (view): Promise<Written> => {
        const stored = this.#parse(await view.get(id));
        if (
          stored?.status !== "queued" ||
          !sameProcess(stored.owner, thisProcess())
        ) {
          return { applied: false, record: stored };
        }
        const successor = await choose(view);
        if (successor === undefined || sameProcess(successor, thisProcess())) {
          throw new Error("no other engine is current to hand it to");
        }
        return await view.transition(id, {
          from: ["queued"],
          newOwner: successor,
          owner: stored.owner,
          status: "queued",
          updatedAt: now(),
        });
      })
    );
    await this.#took(id, written);
    return written.applied;
  }

  async peek(id: string): Promise<ExecutionRun | undefined> {
    return this.#parse(await this.#store.get(id));
  }

  async queuedHere(): Promise<readonly string[]> {
    return (
      (await this.#store.queuedOwnedBy?.(thisProcess())) ??
      this.list()
        .filter(
          (run) =>
            run.status === "queued" && sameProcess(run.owner, thisProcess())
        )
        .map((run) => run.id)
    );
  }

  async takeQueuedFrom(
    id: string,
    owner: ProcessIdentity
  ): Promise<ExecutionRun | undefined> {
    if (!isGone(owner)) {
      return;
    }
    const written = await this.#persist(() =>
      this.#store.transaction(async (view): Promise<Written> => {
        const stored = this.#parse(await view.get(id));
        if (stored?.status !== "queued" || !sameOwner(stored.owner, owner)) {
          return { applied: false, record: stored };
        }
        return await view.transition(id, {
          from: ["queued"],
          newOwner: thisProcess(),
          owner: stored.owner,
          status: "queued",
          updatedAt: now(),
        });
      })
    );
    const taken = await this.#took(id, written);
    return written.applied ? taken : undefined;
  }

  protected async cancelQueued(id: string): Promise<boolean> {
    const before = this.#parse(await this.#store.get(id));
    const mayCancel =
      before !== undefined &&
      (sameProcess(before.owner, thisProcess()) || isGone(before.owner));
    const written = await this.#persist(() =>
      this.#store.transaction(async (view): Promise<Written> => {
        const stored = this.#parse(await view.get(id));
        if (
          stored?.status !== "queued" ||
          !mayCancel ||
          !sameOwner(stored.owner, before.owner)
        ) {
          return { applied: false, record: stored };
        }
        return await view.transition(id, {
          ...settling(stored.owner, "cancelled", undefined, thisProcess()),
          from: ["queued"],
        });
      })
    );
    await this.#took(id, written);
    return written.applied;
  }

  follows(runId: string, status: string): LifecycleChange | undefined {
    const run = this.#records.get(runId);
    if (!(run && run.kind === "workflow" && ownedHere(run))) {
      return;
    }
    const moves =
      (status === "suspended" && run.status === "running") ||
      (status === "running" && run.status === "suspended");
    return moves
      ? {
          from: [run.status],
          owner: thisProcess(),
          status,
          updatedAt: now(),
        }
      : undefined;
  }

  /** Whether the store holds the run's record settled, read afresh. */
  async storedSettled(id: string): Promise<boolean> {
    const run = this.#parse(await this.#store.get(id));
    return run !== undefined && SETTLED_EXECUTION_STATUSES.has(run.status);
  }

  async cancelOrphan(id: string): Promise<boolean> {
    const known = this.#records.get(id);
    if (
      !known ||
      SETTLED_EXECUTION_STATUSES.has(known.status) ||
      !isGone(known.owner)
    ) {
      return false;
    }
    const runs = known.kind === "workflow" ? this.#runs : undefined;
    if (runs && !(await runs.claim(id, ANY_STORED_RUN))) {
      return false;
    }
    try {
      const written = await this.#persist(() =>
        this.#store.transaction(async (view): Promise<Written> => {
          const stored = this.#parse(await view.get(id));
          if (
            !stored ||
            SETTLED_EXECUTION_STATUSES.has(stored.status) ||
            !sameOwner(stored.owner, known.owner)
          ) {
            return { applied: false, record: stored };
          }
          return await view.transition(
            id,
            settling(stored.owner, "cancelled", undefined, thisProcess())
          );
        })
      );
      await this.#took(id, written);
      return written.applied;
    } finally {
      await runs?.release(id);
    }
  }

  async recover(options: {
    readonly adopted: ReadonlySet<string>;
    readonly fileStatus?: (run: ExecutionRun) => string | undefined;
    readonly readmit: (run: ExecutionRun) => boolean;
  }): Promise<readonly ExecutionRun[]> {
    const readmitted: ExecutionRun[] = [];
    const orphans = this.list().filter(
      (run) =>
        !SETTLED_EXECUTION_STATUSES.has(run.status) &&
        (options.adopted.has(run.id) ||
          isGone(run.owner) ||
          (run.status === "queued" && sameProcess(run.owner, thisProcess())))
    );
    for (const orphan of orphans) {
      let taken: { readonly readmit: boolean; readonly written: Written };
      try {
        taken = await this.#persist(() =>
          this.#store.transaction(async (view) => {
            const run = this.#parse(await view.get(orphan.id));
            const next =
              run &&
              recovered(run, options, sameOwner(run.owner, orphan.owner));
            if (!next) {
              return {
                readmit: false,
                written: { applied: false, record: run },
              };
            }
            const written = await view.transition(orphan.id, next.change);
            return { readmit: written.applied && next.readmit, written };
          })
        );
      } catch (error) {
        this.#warn(
          `[state] execution ${orphan.id} not taken over, left as it was: ${String(error)}`
        );
        continue;
      }
      const stored = await this.#took(orphan.id, taken.written);
      if (taken.readmit && stored) {
        readmitted.push(stored);
      }
    }
    return readmitted.sort(bySequence);
  }

  async settle(
    id: string,
    status: Ending,
    error?: Failure
  ): Promise<ExecutionRun | undefined> {
    this.#unsettled.delete(id);
    return await this.#settleNow(id, status, error);
  }

  async #settleNow(
    id: string,
    status: Ending,
    error?: Failure
  ): Promise<ExecutionRun | undefined> {
    const local = this.#records.get(id);
    if (!local || SETTLED_EXECUTION_STATUSES.has(local.status)) {
      return local;
    }
    let written: Written;
    try {
      written = await this.#persist(() =>
        this.#store.transition(id, settling(thisProcess(), status, error))
      );
    } catch (failure) {
      this.#unsettled.set(id, {
        ...(error === undefined ? {} : { error }),
        status,
      });
      if (!this.#retry.passing) {
        this.#scheduleRetry();
      }
      throw failure;
    }
    const stored = await this.#took(id, written);
    if (
      written.applied ||
      (stored && SETTLED_EXECUTION_STATUSES.has(stored.status))
    ) {
      return stored;
    }
    throw new Error(
      stored === undefined
        ? `execution run ${id} is no longer stored; its settle is not recorded`
        : `execution run ${id} is owned by pid ${String(stored.owner.pid)} now; its settle is not recorded`
    );
  }

  async retrySettlements(): Promise<void> {
    const failures: unknown[] = [];
    this.#retry.passing = true;
    try {
      for (const [id, { error, status }] of [...this.#unsettled]) {
        this.#unsettled.delete(id);
        try {
          await this.#settleNow(id, status, error);
        } catch (failure) {
          failures.push(failure);
        }
      }
    } finally {
      this.#retry.passing = false;
    }
    if (this.#unsettled.size === 0) {
      this.#retry.wait = RETRY_FIRST_MS;
    } else {
      this.#retry.wait = Math.min(this.#retry.wait * 2, RETRY_LONGEST_MS);
      this.#scheduleRetry();
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${String(failures.length)} settlement(s) could not be recorded`
      );
    }
  }

  stopRetrying(): void {
    clearTimeout(this.#retry.timer);
    this.#retry.timer = undefined;
  }

  #scheduleRetry(): void {
    if (this.#retry.timer !== undefined) {
      return;
    }
    const timer = setTimeout(() => {
      this.#retry.timer = undefined;
      this.retrySettlements().catch(() => undefined);
    }, this.#retry.wait);
    timer.unref?.();
    this.#retry.timer = timer;
  }

  async #took(
    id: string,
    written: Written,
    observations?: readonly ExecutionObservation[]
  ): Promise<ExecutionRun | undefined> {
    if (written.record === undefined) {
      return;
    }
    const local = this.#records.get(id);
    const run = parseStored({
      id,
      observations: observations ?? local?.observations ?? [],
      value: written.record,
    });
    const current =
      observations === undefined && run && revealsUnread(written, run, local)
        ? await this.#reread(run)
        : run;
    this.#learn(current);
    return current;
  }

  async #reread(run: ExecutionRun): Promise<ExecutionRun> {
    try {
      return this.#parse(await this.#store.get(run.id)) ?? run;
    } catch (error) {
      this.#warn(
        `[state] execution ${run.id} not read back after a write: ${String(error)}`
      );
      return run;
    }
  }

  #persist<T>(write: () => Promise<T>): Promise<T> {
    const landing = this.#writes.then(write);
    this.#writes = landing.catch(() => undefined);
    return landing;
  }

  #learn(stored: ExecutionRun | undefined): void {
    if (stored === undefined) {
      return;
    }
    const local = this.#records.get(stored.id);
    if (!local || stored.revision > local.revision) {
      this.#publish(stored);
    }
  }

  #publish(run: ExecutionRun): void {
    this.#records.set(run.id, run);
    for (const listener of this.#listeners) {
      try {
        listener(run);
      } catch (error) {
        this.#warn(`[executions] a subscriber failed: ${String(error)}`);
      }
    }
  }
}

function revealsUnread(
  written: Written,
  run: ExecutionRun,
  local: ExecutionRun | undefined
): boolean {
  if (local === undefined) {
    return true;
  }
  const own = written.applied ? 1 : 0;
  return run.revision > local.revision + own;
}

function gapsOf(gaps: readonly RetentionGap[]): Map<string, RetentionGap> {
  return new Map(gaps.map((gap) => [gap.scope, gap]));
}

async function removing(
  view: ExecutionView,
  runs: readonly ExecutionRun[],
  scopeOf: (run: ExecutionRun) => string,
  parse: (stored: StoredExecution | undefined) => ExecutionRun | undefined
): Promise<{
  readonly gaps: Map<string, RetentionGap>;
  readonly removed: readonly ExecutionRun[];
}> {
  const gaps = gapsOf(await view.gaps());
  const at = now();
  const removed: ExecutionRun[] = [];
  const changed = new Set<string>();
  for (const cleaned of runs) {
    const run = parse(await view.get(cleaned.id));
    if (!(run && SETTLED_EXECUTION_STATUSES.has(run.status))) {
      continue;
    }
    const scope = scopeOf(run);
    const gap = gaps.get(scope);
    const settled = run.timestamps.settledAt ?? run.timestamps.updatedAt;
    gaps.set(scope, {
      removed: (gap?.removed ?? 0) + 1,
      scope,
      through: gap && gap.through > settled ? gap.through : settled,
      updatedAt: at,
    });
    changed.add(scope);
    removed.push(run);
  }
  for (const scope of changed) {
    const gap = gaps.get(scope);
    if (gap) {
      await view.putGap(gap);
    }
  }
  for (const run of removed) {
    await view.remove(run.id);
  }
  return { gaps, removed };
}

function recovered(
  run: ExecutionRun,
  options: Parameters<ExecutionRecords["recover"]>[0],
  judgedGone: boolean
): { readonly change: LifecycleChange; readonly readmit: boolean } | undefined {
  const ours = options.adopted.has(run.id);
  if (SETTLED_EXECUTION_STATUSES.has(run.status) || !(ours || judgedGone)) {
    return;
  }
  const at = now();
  const from = [run.status];
  const { owner } = run;
  if (ours) {
    return {
      change: {
        from,
        newOwner: thisProcess(),
        owner,
        status: run.status === "running" ? "suspended" : run.status,
        updatedAt: at,
      },
      readmit: false,
    };
  }
  if (run.status === "queued") {
    return options.readmit(run)
      ? {
          change: {
            from,
            newOwner: thisProcess(),
            owner,
            status: "queued",
            updatedAt: at,
          },
          readmit: true,
        }
      : undefined;
  }
  const ending = reconciled(run, options.fileStatus?.(run));
  if (ending === undefined) {
    return;
  }
  if (ending === "suspended") {
    return {
      change: { from, owner, status: "suspended", updatedAt: at },
      readmit: false,
    };
  }
  return {
    change: {
      ...settling(
        owner,
        ending,
        ending === "interrupted" ? INTERRUPTED : undefined,
        thisProcess()
      ),
      from,
    },
    readmit: false,
  };
}

function reconciled(
  run: ExecutionRun,
  file: string | undefined
): Ending | "suspended" | undefined {
  if (run.kind === "task") {
    return run.status === "running" ? "interrupted" : undefined;
  }
  if (file === "complete" || file === "failed" || file === "cancelled") {
    return file;
  }
  if (file === "suspended") {
    return run.status === "running" ? "suspended" : undefined;
  }
  // Resumed and running when its process exited, or never parked.
  return file !== undefined || run.status === "running"
    ? "interrupted"
    : undefined;
}
