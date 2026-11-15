import { RecordsGate } from "~/lib/events/records";
import { storableJson } from "~/lib/state/json";
import type {
  ExecutionObservation,
  ExecutionRun,
  RetentionGap,
} from "./execution-record";

/**
 * Where a workspace's Execution Runs are kept: each run's record by id,
 * its observations one row each beside it, and what pruning removed, by
 * host scope (`RetentionGap`).
 *
 * The store keeps what it is told; `ExecutionRecords`
 * (`lib/execution-records.ts`) holds every rule of the domain. Two
 * storage rules are the store's own, so that engines sharing it never
 * undo one another: a record put is kept only over a lower revision of
 * itself (`put` says whether it was), and an observation recorded again by
 * its id replaces the one before and moves last, raising its run's
 * revision, at the same cost however many the run has. A read inside
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
  /** What pruning has removed so far, by host scope. */
  gaps(): Promise<readonly RetentionGap[]>;
  /** The run `id` with its observations; `undefined` when none is kept. */
  get(id: string): Promise<StoredExecution | undefined>;
  /** Every run kept, with its observations, in admission order (`sequence`, then id). */
  list(): Promise<readonly StoredExecution[]>;
  /**
   * Record `observation` on the run `id`, or replace the one of its id,
   * which then comes last; the run's record takes `revision` and
   * `updatedAt` unless it has a higher revision already. `false`, keeping
   * nothing, when the run is not kept.
   */
  observe(
    id: string,
    observation: ExecutionObservation,
    at: { readonly revision: number; readonly updatedAt: string }
  ): Promise<boolean>;
  /**
   * Keep `run`'s record, its observations aside, unless a revision of it as
   * high or higher is kept: whether this one is kept now.
   */
  put(run: ExecutionRun): Promise<boolean>;
  /** Keep `gap` as its scope's, whole. */
  putGap(gap: RetentionGap): Promise<void>;
  /** Forget the run `id` and its observations; nothing when none is kept. */
  remove(id: string): Promise<void>;
  /** The run kept for the definition `name` and caller's `source`, if one is. */
  withSource(
    name: string,
    source: string
  ): Promise<StoredExecution | undefined>;
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

/** The copy of a retention gap every store keeps, as `storedExecutionRun` keeps a record. */
export function storedRetentionGap(gap: RetentionGap): RetentionGap {
  return storableJson(
    `retention gap ${JSON.stringify(gap.scope)}`,
    gap
  ) as unknown as RetentionGap;
}

/** A run's record as it is kept: everything but its observations. */
function recordOf(run: ExecutionRun): Omit<ExecutionRun, "observations"> {
  const { observations: _observations, ...record } = storedExecutionRun(run);
  return record;
}

interface Kept {
  readonly observations: Map<string, ExecutionObservation>;
  record: Omit<ExecutionRun, "observations">;
}

/**
 * The Execution Runs held in this process, for one engine: nothing
 * outlives it. Everything is copied in and out, so no caller shares a
 * reference with the store; one transaction runs at a time, and a write
 * outside one waits its turn.
 */
export class MemoryExecutionStore implements ExecutionStore {
  readonly #gate = new RecordsGate("the execution store is closed");
  #runs = new Map<string, Kept>();
  #gaps = new Map<string, RetentionGap>();
  #turn: Promise<unknown> = Promise.resolve();

  close(): Promise<void> {
    return this.#gate.close();
  }

  transaction<T>(work: (view: ExecutionView) => Promise<T>): Promise<T> {
    return this.#gate.run(() => {
      const running = this.#turn.then(async () => {
        const runs = new Map(
          [...this.#runs].map(([id, kept]) => [
            id,
            { observations: new Map(kept.observations), record: kept.record },
          ])
        );
        const gaps = new Map(this.#gaps);
        const result = await work(new MemoryView(runs, gaps));
        this.#runs = runs;
        this.#gaps = gaps;
        return result;
      });
      this.#turn = running.catch(() => undefined);
      return running;
    });
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

  withSource(
    name: string,
    source: string
  ): Promise<StoredExecution | undefined> {
    return this.#read((view) => view.withSource(name, source));
  }

  observe(
    id: string,
    observation: ExecutionObservation,
    at: { readonly revision: number; readonly updatedAt: string }
  ): Promise<boolean> {
    return this.#owning(
      observation,
      (value) => storedObservation(id, value),
      (owned) => this.transaction((view) => view.observe(id, owned, at))
    );
  }

  put(run: ExecutionRun): Promise<boolean> {
    return this.#owning(run, storedExecutionRun, (owned) =>
      this.transaction((view) => view.put(owned))
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

  #read<T>(read: (view: ExecutionView) => Promise<T>): Promise<T> {
    return this.#gate.run(() => read(new MemoryView(this.#runs, this.#gaps)));
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

/** A view over `runs` and `gaps`, changing them in place. */
class MemoryView implements ExecutionView {
  readonly #runs: Map<string, Kept>;
  readonly #gaps: Map<string, RetentionGap>;

  constructor(runs: Map<string, Kept>, gaps: Map<string, RetentionGap>) {
    this.#runs = runs;
    this.#gaps = gaps;
  }

  get(id: string): Promise<StoredExecution | undefined> {
    const kept = this.#runs.get(id);
    return Promise.resolve(kept && storedOf(id, kept));
  }

  gaps(): Promise<readonly RetentionGap[]> {
    return Promise.resolve(structuredClone([...this.#gaps.values()]));
  }

  list(): Promise<readonly StoredExecution[]> {
    return Promise.resolve(
      [...this.#runs]
        .sort(
          ([a, first], [b, second]) =>
            first.record.sequence - second.record.sequence || a.localeCompare(b)
        )
        .map(([id, kept]) => storedOf(id, kept))
    );
  }

  withSource(
    name: string,
    source: string
  ): Promise<StoredExecution | undefined> {
    for (const [id, kept] of this.#runs) {
      if (kept.record.name === name && kept.record.source === source) {
        return Promise.resolve(storedOf(id, kept));
      }
    }
    return Promise.resolve(undefined);
  }

  observe(
    id: string,
    observation: ExecutionObservation,
    at: { readonly revision: number; readonly updatedAt: string }
  ): Promise<boolean> {
    const kept = this.#runs.get(id);
    if (kept === undefined) {
      return Promise.resolve(false);
    }
    kept.observations.delete(observation.id);
    kept.observations.set(observation.id, storedObservation(id, observation));
    if (kept.record.revision < at.revision) {
      kept.record = {
        ...kept.record,
        revision: at.revision,
        timestamps: { ...kept.record.timestamps, updatedAt: at.updatedAt },
      };
    }
    return Promise.resolve(true);
  }

  put(run: ExecutionRun): Promise<boolean> {
    const kept = this.#runs.get(run.id);
    if (kept && kept.record.revision >= run.revision) {
      return Promise.resolve(false);
    }
    this.#runs.set(run.id, {
      observations: kept?.observations ?? new Map(),
      record: recordOf(run),
    });
    return Promise.resolve(true);
  }

  putGap(gap: RetentionGap): Promise<void> {
    this.#gaps.set(gap.scope, storedRetentionGap(gap));
    return Promise.resolve();
  }

  remove(id: string): Promise<void> {
    this.#runs.delete(id);
    return Promise.resolve();
  }
}

function storedOf(id: string, kept: Kept): StoredExecution {
  return {
    id,
    observations: structuredClone([...kept.observations.values()]),
    value: structuredClone(kept.record),
  };
}
