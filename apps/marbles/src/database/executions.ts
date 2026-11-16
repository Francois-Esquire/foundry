import type { JsonValue } from "@foundry/lib/json";
import { and, asc, eq, sql } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import {
  marblesExecutionGaps,
  marblesExecutionObservations,
  marblesExecutions,
} from "~/database/tables";
import { RecordsGate } from "~/lib/events/records";
import type {
  ExecutionObservation,
  ExecutionRun,
  RetentionGap,
} from "~/lib/execution-record";
import { parseStored } from "~/lib/execution-record";
import type {
  ExecutionStore,
  ExecutionView,
  LifecycleChange,
  StoredExecution,
  Written,
} from "~/lib/execution-store";
import {
  advisable,
  allows,
  changed,
  storedChange,
  storedExecutionRun,
  storedObservation,
  storedProgress,
  storedRetentionGap,
} from "~/lib/execution-store";

export interface DatabaseExecutionStoreOptions {
  readonly database: StoreDatabase;
  readonly scope: string;
}

export class DatabaseExecutionStore implements ExecutionStore {
  readonly #database: StoreDatabase;
  readonly #scope: string;
  readonly #gate = new RecordsGate("the execution store is closed");

  constructor(options: DatabaseExecutionStoreOptions) {
    this.#database = options.database;
    this.#scope = options.scope;
  }

  close(): Promise<void> {
    return this.#gate.close();
  }

  transaction<T>(work: (view: ExecutionView) => Promise<T>): Promise<T> {
    return this.#call(() =>
      this.#database.transaction((transaction) =>
        work(new DatabaseView(transaction, this.#scope))
      )
    );
  }

  get(id: string): Promise<StoredExecution | undefined> {
    return this.#call(() => this.#view().get(id));
  }

  gaps(): Promise<readonly RetentionGap[]> {
    return this.#call(() => this.#view().gaps());
  }

  list(): Promise<readonly StoredExecution[]> {
    return this.#call(() => this.#view().list());
  }

  withSource(
    name: string,
    source: string
  ): Promise<StoredExecution | undefined> {
    return this.#call(() => this.#view().withSource(name, source));
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
      this.#view().create(owned)
    );
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

  transition(id: string, change: LifecycleChange): Promise<Written> {
    return this.#owning(
      change,
      (value) => storedChange(id, value),
      (owned) => this.transaction((view) => view.transition(id, owned))
    );
  }

  putGap(gap: RetentionGap): Promise<void> {
    return this.#owning(gap, storedRetentionGap, (owned) =>
      this.#view().putGap(owned)
    );
  }

  remove(id: string): Promise<void> {
    return this.transaction((view) => view.remove(id));
  }

  #view(): DatabaseView {
    return new DatabaseView(this.#database, this.#scope);
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
    return this.#call(() => write(owned));
  }

  #call<T>(call: () => Promise<T>): Promise<T> {
    return this.#gate.run(() => asBusy(call));
  }
}

export async function followExecution(
  database: Queries,
  scope: string,
  id: string,
  change: LifecycleChange
): Promise<boolean> {
  return (await new DatabaseView(database, scope).transition(id, change))
    .applied;
}

export async function readExecution(
  database: Queries,
  scope: string,
  id: string
): Promise<ExecutionRun | null> {
  const stored = await new DatabaseView(database, scope).get(id);
  return (stored && parseStored(stored)) ?? null;
}

type ExecutionRow = typeof marblesExecutions.$inferSelect;

type KeptRecord = Omit<ExecutionRun, "observations">;

type Queries = Pick<StoreDatabase, "delete" | "insert" | "select" | "update">;

class DatabaseView implements ExecutionView {
  readonly #database: Queries;
  readonly #scope: string;

  constructor(database: Queries, scope: string) {
    this.#database = database;
    this.#scope = scope;
  }

  async get(id: string): Promise<StoredExecution | undefined> {
    const [row] = await this.#database
      .select()
      .from(marblesExecutions)
      .where(this.#run(id));
    return row && (await this.#stored([row]))[0];
  }

  async gaps(): Promise<readonly RetentionGap[]> {
    const rows = await this.#database
      .select()
      .from(marblesExecutionGaps)
      .where(eq(marblesExecutionGaps.scope, this.#scope));
    return rows.map((row) => ({
      removed: row.removed,
      scope: row.gapScope,
      through: row.through,
      updatedAt: row.updatedAt,
    }));
  }

  async list(): Promise<readonly StoredExecution[]> {
    const rows = await this.#database
      .select()
      .from(marblesExecutions)
      .where(eq(marblesExecutions.scope, this.#scope))
      .orderBy(asc(marblesExecutions.sequence), asc(marblesExecutions.id));
    return this.#stored(rows);
  }

  async withSource(
    name: string,
    source: string
  ): Promise<StoredExecution | undefined> {
    const [row] = await this.#database
      .select()
      .from(marblesExecutions)
      .where(
        and(
          eq(marblesExecutions.scope, this.#scope),
          eq(marblesExecutions.name, name),
          eq(marblesExecutions.source, source)
        )
      )
      .limit(1);
    return row && (await this.#stored([row]))[0];
  }

  async advise(
    id: string,
    change: { readonly progress: JsonValue; readonly updatedAt: string }
  ): Promise<Written> {
    const record = await this.#record(id);
    if (!(record && advisable(record.status))) {
      return { applied: false, record };
    }
    return {
      applied: true,
      record: await this.#replace({
        ...record,
        progress: storedProgress(id, change.progress),
        revision: record.revision + 1,
        timestamps: { ...record.timestamps, updatedAt: change.updatedAt },
      }),
    };
  }

  async create(run: ExecutionRun): Promise<boolean> {
    const kept = await this.#database
      .insert(marblesExecutions)
      .values(rowOf(run, this.#scope))
      .onConflictDoNothing()
      .returning({ id: marblesExecutions.id });
    return kept.length > 0;
  }

  async observe(
    id: string,
    observation: ExecutionObservation,
    updatedAt: string
  ): Promise<Written> {
    const record = await this.#record(id);
    if (!(record && advisable(record.status))) {
      return { applied: false, record };
    }
    const kept = storedObservation(id, observation);
    const position = sql<number>`(select coalesce(max("position"), 0) + 1 from "marbles_execution_observations" where "scope" = ${this.#scope} and "run_id" = ${id})`;
    const row = {
      observation: kept as unknown,
      observationId: kept.id,
      position,
      runId: id,
      scope: this.#scope,
    };
    await this.#database
      .insert(marblesExecutionObservations)
      .values(row)
      .onConflictDoUpdate({
        set: { observation: row.observation, position: row.position },
        target: [
          marblesExecutionObservations.scope,
          marblesExecutionObservations.runId,
          marblesExecutionObservations.observationId,
        ],
      });
    return {
      applied: true,
      record: await this.#replace({
        ...record,
        revision: record.revision + 1,
        timestamps: { ...record.timestamps, updatedAt },
      }),
    };
  }

  async transition(id: string, change: LifecycleChange): Promise<Written> {
    const record = await this.#record(id);
    if (!(record && allows(change, record))) {
      return { applied: false, record };
    }
    return {
      applied: true,
      record: await this.#replace(changed(record, storedChange(id, change))),
    };
  }

  async #record(id: string): Promise<KeptRecord | undefined> {
    const [row] = await this.#database
      .select()
      .from(marblesExecutions)
      .where(this.#run(id));
    return row && (recordOf(row) as KeptRecord);
  }

  async #replace(record: KeptRecord): Promise<KeptRecord> {
    const {
      id: _id,
      scope: _scope,
      ...fields
    } = rowOf({ ...record, observations: [] }, this.#scope);
    await this.#database
      .update(marblesExecutions)
      .set(fields)
      .where(this.#run(record.id));
    return record;
  }

  async putGap(given: RetentionGap): Promise<void> {
    const gap = storedRetentionGap(given);
    const fields = {
      removed: gap.removed,
      through: gap.through,
      updatedAt: gap.updatedAt,
    };
    await this.#database
      .insert(marblesExecutionGaps)
      .values({ ...fields, gapScope: gap.scope, scope: this.#scope })
      .onConflictDoUpdate({
        set: fields,
        target: [marblesExecutionGaps.scope, marblesExecutionGaps.gapScope],
      });
  }

  async remove(id: string): Promise<void> {
    await this.#database
      .delete(marblesExecutionObservations)
      .where(
        and(
          eq(marblesExecutionObservations.scope, this.#scope),
          eq(marblesExecutionObservations.runId, id)
        )
      );
    await this.#database.delete(marblesExecutions).where(this.#run(id));
  }

  async #stored(
    rows: readonly ExecutionRow[]
  ): Promise<readonly StoredExecution[]> {
    if (rows.length === 0) {
      return [];
    }
    const only = rows.length === 1 ? rows[0]?.id : undefined;
    const observed = await this.#database
      .select({
        observation: marblesExecutionObservations.observation,
        runId: marblesExecutionObservations.runId,
      })
      .from(marblesExecutionObservations)
      .where(
        and(
          eq(marblesExecutionObservations.scope, this.#scope),
          only === undefined
            ? undefined
            : eq(marblesExecutionObservations.runId, only)
        )
      )
      .orderBy(
        asc(marblesExecutionObservations.runId),
        asc(marblesExecutionObservations.position)
      );
    const byRun = new Map<string, unknown[]>();
    for (const { observation, runId } of observed) {
      const list = byRun.get(runId) ?? [];
      list.push(observation);
      byRun.set(runId, list);
    }
    return rows.map((row) => ({
      id: row.id,
      observations: byRun.get(row.id) ?? [],
      value: recordOf(row),
    }));
  }

  #run(id: string) {
    return and(
      eq(marblesExecutions.scope, this.#scope),
      eq(marblesExecutions.id, id)
    );
  }
}

function jsonText(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function fromJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { unreadable: text };
  }
}

function rowOf(
  given: ExecutionRun,
  scope: string
): typeof marblesExecutions.$inferInsert {
  const run = storedExecutionRun(given);
  return {
    correlation: { ...run.correlation },
    errorCode: run.error?.code ?? null,
    errorMessage: run.error?.message ?? null,
    id: run.id,
    input: jsonText(run.input),
    kind: run.kind,
    name: run.name,
    ownerPid: run.owner.pid,
    ownerStarted: run.owner.started,
    progress: jsonText(run.progress),
    queue: run.queue,
    queuedAt: run.timestamps.queuedAt,
    revision: run.revision,
    scope,
    sequence: run.sequence,
    settledAt: run.timestamps.settledAt ?? null,
    source: run.source ?? null,
    startedAt: run.timestamps.startedAt ?? null,
    status: run.status,
    updatedAt: run.timestamps.updatedAt,
  };
}

function recordOf(row: ExecutionRow): unknown {
  return {
    correlation: row.correlation,
    ...(row.errorCode === null
      ? {}
      : {
          error: {
            code: row.errorCode,
            ...(row.errorMessage === null ? {} : { message: row.errorMessage }),
          },
        }),
    id: row.id,
    ...(row.input === null ? {} : { input: fromJsonText(row.input) }),
    kind: row.kind,
    name: row.name,
    owner: { pid: row.ownerPid, started: row.ownerStarted },
    ...(row.progress === null ? {} : { progress: fromJsonText(row.progress) }),
    queue: row.queue,
    revision: row.revision,
    sequence: row.sequence,
    ...(row.source === null ? {} : { source: row.source }),
    status: row.status,
    timestamps: {
      queuedAt: row.queuedAt,
      ...(row.settledAt === null ? {} : { settledAt: row.settledAt }),
      ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
      updatedAt: row.updatedAt,
    },
  };
}
