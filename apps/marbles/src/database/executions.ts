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
  StoredExecution,
} from "~/lib/execution-store";
import {
  storedExecutionRun,
  storedObservation,
  storedRetentionGap,
} from "~/lib/execution-store";

/**
 * A workspace's Execution Runs in the Marbles database, scoped by the
 * workspace id: each record in `marbles_executions`, its observations in
 * `marbles_execution_observations`, and what pruning removed in
 * `marbles_execution_gaps`. A record put is one statement that lands only
 * over a lower revision; an observation is one row written and its run's
 * revision raised, in one transaction, whatever the run holds already. A
 * `transaction` is a write transaction, which takes the database's write
 * lock before it reads, so two engines, in this process or another, never
 * act on one run at once. Every call surfaces a lock waited on too long as
 * a `DatabaseBusyError`.
 */

export interface DatabaseExecutionStoreOptions {
  /** The database the host keeps open, or one of its transactions. */
  readonly database: StoreDatabase;
  /** The workspace id. */
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
      this.#view().put(owned)
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
    return this.#call(() => write(owned));
  }

  #call<T>(call: () => Promise<T>): Promise<T> {
    return this.#gate.run(() => asBusy(call));
  }
}

/**
 * Replace the record of `run` kept in the Execution Runs of `scope` on
 * `database`, or a transaction on it, when a lower revision of it is
 * kept there: whether it was. A run this database does not keep (its
 * engine keeps Execution Runs elsewhere) is left alone. For a store whose
 * commit carries a run's record with its own.
 */
export async function followExecution(
  database: Queries,
  scope: string,
  run: ExecutionRun
): Promise<boolean> {
  const { id: _id, scope: _scope, ...fields } = rowOf(run, scope);
  const replaced = await database
    .update(marblesExecutions)
    .set(fields)
    .where(
      and(
        eq(marblesExecutions.scope, scope),
        eq(marblesExecutions.id, run.id),
        sql`${marblesExecutions.revision} < ${run.revision}`
      )
    )
    .returning({ id: marblesExecutions.id });
  return replaced.length > 0;
}

/**
 * The Execution Run `id` of `scope` as `database`, or a transaction on it,
 * keeps it; `null` when it keeps none, or none that reads as a run. For a
 * store whose transaction decides on a run's record with its own.
 */
export async function readExecution(
  database: Queries,
  scope: string,
  id: string
): Promise<ExecutionRun | null> {
  const stored = await new DatabaseView(database, scope).get(id);
  return (stored && parseStored(stored)) ?? null;
}

type ExecutionRow = typeof marblesExecutions.$inferSelect;

/** What a view reads and writes through: the database, or any transaction on it. */
type Queries = Pick<StoreDatabase, "delete" | "insert" | "select" | "update">;

/** The Execution Runs of `scope` as `database`, or a transaction on it, holds them. */
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

  async observe(
    id: string,
    observation: ExecutionObservation,
    at: { readonly revision: number; readonly updatedAt: string }
  ): Promise<boolean> {
    const kept = storedObservation(id, observation);
    const raised = await this.#database
      .update(marblesExecutions)
      .set({
        revision: sql`max(${marblesExecutions.revision}, ${at.revision})`,
        updatedAt: sql`case when ${marblesExecutions.revision} < ${at.revision} then ${at.updatedAt} else ${marblesExecutions.updatedAt} end`,
      })
      .where(this.#run(id))
      .returning({ id: marblesExecutions.id });
    if (raised.length === 0) {
      return false;
    }
    // After every observation the run has, by the index on its positions.
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
    return true;
  }

  async put(run: ExecutionRun): Promise<boolean> {
    const row = rowOf(run, this.#scope);
    const { id: _id, scope: _scope, ...fields } = row;
    const kept = await this.#database
      .insert(marblesExecutions)
      .values(row)
      .onConflictDoUpdate({
        set: fields,
        setWhere: sql`excluded.revision > ${marblesExecutions.revision}`,
        target: [marblesExecutions.scope, marblesExecutions.id],
      })
      .returning({ id: marblesExecutions.id });
    return kept.length > 0;
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

  /** Each row as the store gives it back, with its observations in order. */
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

/** JSON text for a value that may be `null`; SQL NULL for none. */
function jsonText(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** A stored JSON text's value; one that is not JSON reads as itself, which the record refuses. */
function fromJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { unreadable: text };
  }
}

/** The row of `run`'s record in the form every store keeps it (`storedExecutionRun`). */
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

/** A row as the record it holds, its observations aside, unchecked. */
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
    owner: { pid: row.ownerPid },
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
