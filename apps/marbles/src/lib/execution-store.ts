import type { JsonValue } from "@foundry/lib/json";
import {
  type ProcessIdentity,
  sameProcess,
} from "@foundry/lib/process-identity";
import { RecordsGate } from "~/lib/events/records";
import { storableJson } from "~/lib/state/json";
import type {
  ExecutionObservation,
  ExecutionRun,
  RetentionGap,
} from "./execution-record";
import type { ExecutionStatus } from "./execution-statuses";
import { SETTLED_EXECUTION_STATUSES } from "./execution-statuses";

export interface ExecutionStore extends ExecutionView {
  close(): Promise<void>;
  transaction<T>(work: (view: ExecutionView) => Promise<T>): Promise<T>;
}

export interface ExecutionView {
  advise(
    id: string,
    change: { readonly progress: JsonValue; readonly updatedAt: string }
  ): Promise<Written>;
  create(run: ExecutionRun): Promise<boolean>;
  gaps(): Promise<readonly RetentionGap[]>;
  get(id: string): Promise<StoredExecution | undefined>;
  list(): Promise<readonly StoredExecution[]>;
  observe(
    id: string,
    observation: ExecutionObservation,
    updatedAt: string
  ): Promise<Written>;
  putGap(gap: RetentionGap): Promise<void>;
  remove(id: string): Promise<void>;
  transition(id: string, change: LifecycleChange): Promise<Written>;
  withSource(
    name: string,
    source: string
  ): Promise<StoredExecution | undefined>;
}

export interface LifecycleChange {
  readonly dropInput?: boolean;
  readonly error?: ExecutionRun["error"];
  readonly from: readonly ExecutionStatus[];
  readonly newOwner?: ProcessIdentity;
  readonly owner: ProcessIdentity;
  readonly settledAt?: string;
  readonly startedAt?: string;
  readonly status: ExecutionStatus;
  readonly updatedAt: string;
}

export interface Written {
  readonly applied: boolean;
  readonly record: unknown;
}

export interface StoredExecution {
  readonly id: string;
  readonly observations: readonly unknown[];
  readonly value: unknown;
}

export function storedExecutionRun(run: ExecutionRun): ExecutionRun {
  const { observations: _observations, ...record } = run;
  return {
    ...(storableJson(
      `execution run ${JSON.stringify(run.id)}`,
      record
    ) as unknown as Omit<ExecutionRun, "observations">),
    observations: [],
  };
}

export function storedObservation(
  runId: string,
  observation: ExecutionObservation
): ExecutionObservation {
  return storableJson(
    `execution run ${JSON.stringify(runId)} observation ${JSON.stringify(observation.id)}`,
    observation
  ) as unknown as ExecutionObservation;
}

export function storedProgress(runId: string, progress: JsonValue): JsonValue {
  return storableJson(
    `execution run ${JSON.stringify(runId)} progress`,
    progress
  );
}

export function storedChange(
  runId: string,
  change: LifecycleChange
): LifecycleChange {
  return storableJson(
    `execution run ${JSON.stringify(runId)} change`,
    change
  ) as unknown as LifecycleChange;
}

export function storedRetentionGap(gap: RetentionGap): RetentionGap {
  return storableJson(
    `retention gap ${JSON.stringify(gap.scope)}`,
    gap
  ) as unknown as RetentionGap;
}

export function allows(
  change: LifecycleChange,
  record: {
    readonly owner: { readonly pid: number; readonly started?: string | null };
    readonly status: string;
  }
): boolean {
  return (
    (change.from as readonly string[]).includes(record.status) &&
    sameProcess(
      { pid: record.owner.pid, started: record.owner.started ?? null },
      change.owner
    )
  );
}

export function advisable(status: string): boolean {
  return !SETTLED_EXECUTION_STATUSES.has(status as ExecutionStatus);
}

type KeptRecord = Omit<ExecutionRun, "observations">;

export function changed(
  record: KeptRecord,
  change: LifecycleChange
): KeptRecord {
  const { input, error, ...rest } = record;
  const timestamps = {
    ...record.timestamps,
    ...(change.startedAt === undefined || record.timestamps.startedAt
      ? {}
      : { startedAt: change.startedAt }),
    ...(change.settledAt === undefined ? {} : { settledAt: change.settledAt }),
    updatedAt: change.updatedAt,
  };
  return {
    ...rest,
    ...(change.dropInput || input === undefined ? {} : { input }),
    ...((change.error ?? error) === undefined
      ? {}
      : { error: change.error ?? error }),
    owner: change.newOwner ?? record.owner,
    revision: record.revision + 1,
    status: change.status,
    timestamps,
  };
}

interface Kept {
  readonly observations: ReadonlyMap<string, ExecutionObservation>;
  readonly record: KeptRecord;
}

export class MemoryExecutionStore implements ExecutionStore {
  readonly #gate = new RecordsGate("the execution store is closed");
  readonly #runs = new Map<string, Kept>();
  readonly #gaps = new Map<string, RetentionGap>();
  #turn: Promise<unknown> = Promise.resolve();

  close(): Promise<void> {
    return this.#gate.close();
  }

  transaction<T>(work: (view: ExecutionView) => Promise<T>): Promise<T> {
    return this.#gate.run(() => {
      const running = this.#turn.then(async () => {
        const staged = new Staged(this.#runs, this.#gaps);
        const result = await work(new MemoryView(staged));
        staged.apply();
        return result;
      });
      this.#turn = running.catch(() => undefined);
      return running;
    });
  }

  advise(
    id: string,
    change: { readonly progress: JsonValue; readonly updatedAt: string }
  ): Promise<Written> {
    return this.#owning(
      change,
      (value) => ({
        progress: storedProgress(id, value.progress),
        updatedAt: value.updatedAt,
      }),
      (owned) => this.transaction((view) => view.advise(id, owned))
    );
  }

  create(run: ExecutionRun): Promise<boolean> {
    return this.#owning(run, storedExecutionRun, (owned) =>
      this.transaction((view) => view.create(owned))
    );
  }

  get(id: string): Promise<StoredExecution | undefined> {
    return this.#read((view) => view.get(id));
  }

  gaps(): Promise<readonly RetentionGap[]> {
    return this.#read((view) => view.gaps());
  }

  list(): Promise<readonly StoredExecution[]> {
    return this.#read((view) => view.list());
  }

  observe(
    id: string,
    observation: ExecutionObservation,
    updatedAt: string
  ): Promise<Written> {
    return this.#owning(
      observation,
      (value) => storedObservation(id, value),
      (owned) => this.transaction((view) => view.observe(id, owned, updatedAt))
    );
  }

  putGap(gap: RetentionGap): Promise<void> {
    return this.#owning(gap, storedRetentionGap, (owned) =>
      this.transaction((view) => view.putGap(owned))
    );
  }

  remove(id: string): Promise<void> {
    return this.transaction((view) => view.remove(id));
  }

  transition(id: string, change: LifecycleChange): Promise<Written> {
    return this.#owning(
      change,
      (value) => storedChange(id, value),
      (owned) => this.transaction((view) => view.transition(id, owned))
    );
  }

  withSource(
    name: string,
    source: string
  ): Promise<StoredExecution | undefined> {
    return this.#read((view) => view.withSource(name, source));
  }

  #read<T>(read: (view: ExecutionView) => Promise<T>): Promise<T> {
    return this.#gate.run(() =>
      read(new MemoryView(new Staged(this.#runs, this.#gaps)))
    );
  }

  #owning<V, T>(
    value: V,
    stored: (value: V) => V,
    write: (owned: V) => Promise<T>
  ): Promise<T> {
    let owned: V;
    try {
      owned = stored(value);
    } catch (error) {
      return Promise.reject(error);
    }
    return write(owned);
  }
}

class Staged {
  readonly #runs: Map<string, Kept>;
  readonly #gaps: Map<string, RetentionGap>;
  readonly #changed = new Map<string, Kept | undefined>();
  readonly #created = new Set<string>();
  readonly #changedGaps = new Map<string, RetentionGap>();

  constructor(runs: Map<string, Kept>, gaps: Map<string, RetentionGap>) {
    this.#runs = runs;
    this.#gaps = gaps;
  }

  run(id: string): Kept | undefined {
    return this.#changed.has(id) ? this.#changed.get(id) : this.#runs.get(id);
  }

  *runs(): Generator<readonly [string, Kept]> {
    for (const id of this.#runs.keys()) {
      const kept = this.#created.has(id) ? undefined : this.run(id);
      if (kept) {
        yield [id, kept];
      }
    }
    for (const id of this.#created) {
      const kept = this.#changed.get(id);
      if (kept) {
        yield [id, kept];
      }
    }
  }

  create(id: string, kept: Kept): void {
    this.#created.delete(id);
    this.#created.add(id);
    this.#changed.set(id, kept);
  }

  put(id: string, kept: Kept): void {
    this.#changed.set(id, kept);
  }

  remove(id: string): void {
    this.#changed.set(id, undefined);
  }

  gaps(): RetentionGap[] {
    return [...new Map([...this.#gaps, ...this.#changedGaps]).values()];
  }

  putGap(gap: RetentionGap): void {
    this.#changedGaps.set(gap.scope, gap);
  }

  apply(): void {
    for (const [id, kept] of this.#changed) {
      if (kept === undefined || this.#created.has(id)) {
        this.#runs.delete(id);
      } else {
        this.#runs.set(id, kept);
      }
    }
    for (const id of this.#created) {
      const kept = this.#changed.get(id);
      if (kept) {
        this.#runs.set(id, kept);
      }
    }
    for (const [scope, gap] of this.#changedGaps) {
      this.#gaps.set(scope, gap);
    }
  }
}

class MemoryView implements ExecutionView {
  readonly #staged: Staged;

  constructor(staged: Staged) {
    this.#staged = staged;
  }

  advise(
    id: string,
    change: { readonly progress: JsonValue; readonly updatedAt: string }
  ): Promise<Written> {
    const kept = this.#staged.run(id);
    if (!(kept && advisable(kept.record.status))) {
      return Promise.resolve(writtenOf(false, kept?.record));
    }
    const record = {
      ...kept.record,
      progress: storedProgress(id, change.progress),
      revision: kept.record.revision + 1,
      timestamps: { ...kept.record.timestamps, updatedAt: change.updatedAt },
    };
    this.#staged.put(id, { observations: kept.observations, record });
    return Promise.resolve(writtenOf(true, record));
  }

  create(run: ExecutionRun): Promise<boolean> {
    if (this.#staged.run(run.id)) {
      return Promise.resolve(false);
    }
    const { observations: _observations, ...record } = storedExecutionRun(run);
    this.#staged.create(run.id, { observations: new Map(), record });
    return Promise.resolve(true);
  }

  get(id: string): Promise<StoredExecution | undefined> {
    const kept = this.#staged.run(id);
    return Promise.resolve(kept && storedOf(id, kept));
  }

  gaps(): Promise<readonly RetentionGap[]> {
    return Promise.resolve(structuredClone(this.#staged.gaps()));
  }

  list(): Promise<readonly StoredExecution[]> {
    return Promise.resolve(
      [...this.#staged.runs()]
        .sort(
          ([a, first], [b, second]) =>
            first.record.sequence - second.record.sequence || a.localeCompare(b)
        )
        .map(([id, kept]) => storedOf(id, kept))
    );
  }

  observe(
    id: string,
    observation: ExecutionObservation,
    updatedAt: string
  ): Promise<Written> {
    const kept = this.#staged.run(id);
    if (!(kept && advisable(kept.record.status))) {
      return Promise.resolve(writtenOf(false, kept?.record));
    }
    const observations = new Map(kept.observations);
    observations.delete(observation.id);
    observations.set(observation.id, storedObservation(id, observation));
    const record = {
      ...kept.record,
      revision: kept.record.revision + 1,
      timestamps: { ...kept.record.timestamps, updatedAt },
    };
    this.#staged.put(id, { observations, record });
    return Promise.resolve(writtenOf(true, record));
  }

  putGap(gap: RetentionGap): Promise<void> {
    this.#staged.putGap(storedRetentionGap(gap));
    return Promise.resolve();
  }

  remove(id: string): Promise<void> {
    this.#staged.remove(id);
    return Promise.resolve();
  }

  transition(id: string, change: LifecycleChange): Promise<Written> {
    const kept = this.#staged.run(id);
    if (!(kept && allows(change, kept.record))) {
      return Promise.resolve(writtenOf(false, kept?.record));
    }
    const record = changed(kept.record, storedChange(id, change));
    this.#staged.put(id, { observations: kept.observations, record });
    return Promise.resolve(writtenOf(true, record));
  }

  withSource(
    name: string,
    source: string
  ): Promise<StoredExecution | undefined> {
    for (const [id, kept] of this.#staged.runs()) {
      if (kept.record.name === name && kept.record.source === source) {
        return Promise.resolve(storedOf(id, kept));
      }
    }
    return Promise.resolve(undefined);
  }
}

function writtenOf(applied: boolean, record: KeptRecord | undefined): Written {
  return { applied, record: record && structuredClone(record) };
}

function storedOf(id: string, kept: Kept): StoredExecution {
  return {
    id,
    observations: structuredClone([...kept.observations.values()]),
    value: structuredClone(kept.record),
  };
}
