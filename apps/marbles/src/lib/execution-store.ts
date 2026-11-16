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

/**
 * Where a workspace's Execution Runs are kept: each run's record by id,
 * its observations one row each beside it, and what pruning removed, by
 * host scope (`RetentionGap`).
 *
 * `ExecutionRecords` (`lib/execution-records.ts`) holds every rule of the
 * domain; the store keeps two kinds of write apart, so engines sharing it
 * never undo one another:
 *
 * - A lifecycle change (`transition`: started, parked, resumed, settled,
 *   cancelled, taken over, interrupted) is made only on a run stored in
 *   one of the statuses it allows and owned by the process it names, and
 *   writes only the lifecycle fields: status, owner, error, start and
 *   settle times, and the queued input it drops. Nothing else blocks it.
 * - An advisory change (`advise`, a run's progress, and `observe`, one
 *   observation, replacing one of its id and moving it last, at the same
 *   cost however many the run has) is made only on a run not settled, and
 *   writes only its own field: one that comes after a settle is dropped.
 *
 * Every write that is made raises the run's revision by one, so a reader
 * orders what it is told; the revision guards nothing. A read inside
 * `transaction` sees no other engine's write until it settles.
 *
 * `MemoryExecutionStore` keeps everything in this process, for one
 * engine; the Marbles database keeps it on disk (`database/executions.ts`),
 * shared by every engine over it.
 */
export interface ExecutionStore extends ExecutionView {
  /** Refuse every call from now on, once those under way have settled. */
  close(): Promise<void>;
  /**
   * `work` over a view no other engine writes to until it settles; what it
   * wrote is kept when it resolves, and nothing of it when it rejects.
   */
  transaction<T>(work: (view: ExecutionView) => Promise<T>): Promise<T>;
}

/** The Execution Runs, as a store or a transaction in progress sees them. */
export interface ExecutionView {
  /** Set `progress` on the run `id`, unless it is settled or not kept. */
  advise(
    id: string,
    change: { readonly progress: JsonValue; readonly updatedAt: string }
  ): Promise<Written>;
  /**
   * Keep a new run's record whole, its observations aside; `false`,
   * keeping nothing, when a run of its id is kept already.
   */
  create(run: ExecutionRun): Promise<boolean>;
  /** What pruning has removed so far, by host scope. */
  gaps(): Promise<readonly RetentionGap[]>;
  /** The run `id` with its observations; `undefined` when none is kept. */
  get(id: string): Promise<StoredExecution | undefined>;
  /** Every run kept, with its observations, in admission order (`sequence`, then id). */
  list(): Promise<readonly StoredExecution[]>;
  /**
   * Record `observation` on the run `id`, or replace the one of its id,
   * which then comes last, unless the run is settled or not kept.
   */
  observe(
    id: string,
    observation: ExecutionObservation,
    updatedAt: string
  ): Promise<Written>;
  /** Keep `gap` as its scope's, whole. */
  putGap(gap: RetentionGap): Promise<void>;
  /** Forget the run `id` and its observations; nothing when none is kept. */
  remove(id: string): Promise<void>;
  /** Make the lifecycle change on the run `id`, when it allows the run as stored. */
  transition(id: string, change: LifecycleChange): Promise<Written>;
  /** The run kept for the definition `name` and caller's `source`, if one is. */
  withSource(
    name: string,
    source: string
  ): Promise<StoredExecution | undefined>;
}

/**
 * A change of a run's lifecycle, made only when the run is stored in one
 * of `from` and owned by `owner`. Its fields are the only ones it writes.
 */
export interface LifecycleChange {
  /** Drop the queued input: a run that has started keeps none. */
  readonly dropInput?: boolean;
  /** Why it failed or was interrupted; the stored one stays without. */
  readonly error?: ExecutionRun["error"];
  /** The statuses the run must be stored in. */
  readonly from: readonly ExecutionStatus[];
  /** Its owner from now on; `owner` stays when omitted. */
  readonly newOwner?: ProcessIdentity;
  /** The process that must own it as stored. */
  readonly owner: ProcessIdentity;
  /** When it settled; set once, by a settle. */
  readonly settledAt?: string;
  /** When it started; set once, by a start. */
  readonly startedAt?: string;
  readonly status: ExecutionStatus;
  readonly updatedAt: string;
}

/** What a write found: whether it was made, and the run's record as stored after it. */
export interface Written {
  readonly applied: boolean;
  /**
   * The record as stored once the write settled, its observations aside,
   * unchecked; `undefined` when the run is not kept.
   */
  readonly record: unknown;
}

/**
 * A run as the store gives it back: its record and its observations in the
 * order they were last recorded, neither checked. `ExecutionRecords`
 * reads them through `parseStored`.
 */
export interface StoredExecution {
  readonly id: string;
  readonly observations: readonly unknown[];
  /** The record, without its observations. */
  readonly value: unknown;
}

/**
 * The copy of a run's record every store keeps, its observations aside:
 * plain JSON as it reads back (`storableJson`), so a record reads back the
 * same from memory as from the database. One JSON would not give back as
 * it is is refused with a `NotStorableError` naming the part.
 */
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

/** The copy of an observation every store keeps, as `storedExecutionRun` keeps a record. */
export function storedObservation(
  runId: string,
  observation: ExecutionObservation
): ExecutionObservation {
  return storableJson(
    `execution run ${JSON.stringify(runId)} observation ${JSON.stringify(observation.id)}`,
    observation
  ) as unknown as ExecutionObservation;
}

/** The copy of a run's progress every store keeps, as `storedExecutionRun` keeps a record. */
export function storedProgress(runId: string, progress: JsonValue): JsonValue {
  return storableJson(
    `execution run ${JSON.stringify(runId)} progress`,
    progress
  );
}

/** The copy of a lifecycle change every store keeps, as `storedExecutionRun` keeps a record. */
export function storedChange(
  runId: string,
  change: LifecycleChange
): LifecycleChange {
  return storableJson(
    `execution run ${JSON.stringify(runId)} change`,
    change
  ) as unknown as LifecycleChange;
}

/** The copy of a retention gap every store keeps, as `storedExecutionRun` keeps a record. */
export function storedRetentionGap(gap: RetentionGap): RetentionGap {
  return storableJson(
    `retention gap ${JSON.stringify(gap.scope)}`,
    gap
  ) as unknown as RetentionGap;
}

/** Whether a lifecycle change allows `record`, as stored. */
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

/** Whether an advisory change may still be made on a run stored as `status`. */
export function advisable(status: string): boolean {
  return !SETTLED_EXECUTION_STATUSES.has(status as ExecutionStatus);
}

/** A run's record as it is kept, its observations aside. */
type KeptRecord = Omit<ExecutionRun, "observations">;

/** `record` with `change` made, its revision raised: the lifecycle fields alone. */
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

/** A run as kept: never changed in place, so a transaction can share it. */
interface Kept {
  readonly observations: ReadonlyMap<string, ExecutionObservation>;
  readonly record: KeptRecord;
}

/**
 * The Execution Runs held in this process, for one engine: nothing
 * outlives it. Everything is copied in and out, so no caller shares a
 * reference with the store; one transaction runs at a time, and a write
 * outside one waits its turn. A transaction stages what it changes over
 * what is kept (`Staged`), so it costs what it touches, not every run
 * kept, and only a transaction whose work resolves changes what is kept.
 */
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

  /**
   * `write` on the copy of `value` `stored` makes now, as every store keeps
   * it; one it refuses rejects, keeping nothing.
   */
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

/**
 * What one view reads and writes: the runs and gaps as kept, and over them
 * what its transaction has changed so far, which its reads see too. Only
 * `apply` changes what is kept, so a view whose work rejects, or a read's,
 * leaves it as it was. Runs list in the order they are kept, a run
 * created after every other, as copying the maps and writing to the copy
 * would order them.
 */
class Staged {
  readonly #runs: Map<string, Kept>;
  readonly #gaps: Map<string, RetentionGap>;
  /** Each run this transaction put, or removed (`undefined`). */
  readonly #changed = new Map<string, Kept | undefined>();
  /** The runs it created, in the order it last created each. */
  readonly #created = new Set<string>();
  readonly #changedGaps = new Map<string, RetentionGap>();

  constructor(runs: Map<string, Kept>, gaps: Map<string, RetentionGap>) {
    this.#runs = runs;
    this.#gaps = gaps;
  }

  run(id: string): Kept | undefined {
    return this.#changed.has(id) ? this.#changed.get(id) : this.#runs.get(id);
  }

  /** Every run, in the order it is kept. */
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

  /** Keep what this transaction changed. */
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

/** A view over what `staged` reads, writing to it. */
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
    // Only this run's observations are copied, and moved last when seen again.
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
