import type { JsonValue } from "@foundry/lib/json";
import {
  type ProcessIdentity,
  sameProcess,
} from "@foundry/lib/process-identity";
import type { Job, Run } from "@foundry/queue";
import { queueJobs, queueRuns } from "@foundry/queue/store/tables";
import { and, asc, eq, sql } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import { inList } from "~/database/lists";
import {
  marblesExecutionGaps,
  marblesExecutionObservations,
  marblesExecutions,
} from "~/database/tables";
import type { StoreDatabase } from "~/database/types";
import { RecordsGate } from "~/lib/events/records-gate";
import type {
  ExecutionObservation,
  ExecutionRun,
  RetentionGap,
  StoredAnnex,
} from "~/lib/executions/record";
import { annexOf, executionOf } from "~/lib/executions/record";
import type { ExecutionStore, Removal } from "~/lib/executions/store";
import {
  storedObservation,
  storedProgress,
  storedRetentionGap,
  withRemovals,
} from "~/lib/executions/store";

export interface DatabaseExecutionStoreOptions {
  readonly database: StoreDatabase;
  readonly scope: string;
}

type Queries = Pick<StoreDatabase, "delete" | "insert" | "select" | "update">;

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

  get(id: string): Promise<StoredAnnex | undefined> {
    return this.#call(async () => {
      const [annex] = await annexesIn(this.#database, this.#scope, [id]);
      return annex;
    });
  }

  gaps(): Promise<readonly RetentionGap[]> {
    return this.#call(() => gapsIn(this.#database, this.#scope));
  }

  list(): Promise<readonly StoredAnnex[]> {
    return this.#call(() => annexesIn(this.#database, this.#scope));
  }

  observe(
    id: string,
    observation: ExecutionObservation,
    updatedAt: string
  ): Promise<void> {
    return this.#owning(
      () => storedObservation(id, observation),
      (kept) =>
        this.#database.transaction(async (transaction) => {
          const [last] = await transaction
            .select({
              position: sql<number>`coalesce(max(${marblesExecutionObservations.position}), 0)`,
            })
            .from(marblesExecutionObservations)
            .where(this.#observed(id));
          const position = (last?.position ?? 0) + 1;
          await transaction
            .insert(marblesExecutionObservations)
            .values({
              observation: kept as unknown,
              observationId: kept.id,
              position,
              runId: id,
              scope: this.#scope,
            })
            .onConflictDoUpdate({
              set: { observation: kept as unknown, position },
              target: [
                marblesExecutionObservations.scope,
                marblesExecutionObservations.runId,
                marblesExecutionObservations.observationId,
              ],
            });
          await this.#touch(transaction, id, { updatedAt });
        })
    );
  }

  progress(id: string, progress: JsonValue, updatedAt: string): Promise<void> {
    return this.#owning(
      () => storedProgress(id, progress),
      (kept) =>
        this.#touch(this.#database, id, {
          progress: JSON.stringify(kept),
          updatedAt,
        })
    );
  }

  remove(
    ids: readonly string[],
    removals: readonly Removal[],
    updatedAt: string
  ): Promise<readonly RetentionGap[]> {
    return this.#call(() =>
      this.#database.transaction(async (transaction) => {
        const known = new Map(
          (await gapsIn(transaction, this.#scope)).map((gap) => [
            gap.scope,
            gap,
          ])
        );
        const gaps = withRemovals(known, removals, updatedAt);
        for (const scope of new Set(removals.map((each) => each.scope))) {
          const gap = gaps.get(scope);
          if (gap === undefined) {
            continue;
          }
          const kept = storedRetentionGap(gap);
          const fields = {
            removed: kept.removed,
            through: kept.through,
            updatedAt: kept.updatedAt,
          };
          await transaction
            .insert(marblesExecutionGaps)
            .values({ ...fields, gapScope: kept.scope, scope: this.#scope })
            .onConflictDoUpdate({
              set: fields,
              target: [
                marblesExecutionGaps.scope,
                marblesExecutionGaps.gapScope,
              ],
            });
        }
        await removeAnnexes(transaction, this.#scope, ids);
        return [...gaps.values()];
      })
    );
  }

  async #touch(
    database: Queries,
    id: string,
    fields: { readonly progress?: string; readonly updatedAt: string }
  ): Promise<void> {
    await database
      .insert(marblesExecutions)
      .values({ id, revision: 1, scope: this.#scope, ...fields })
      .onConflictDoUpdate({
        set: { ...fields, revision: sql`${marblesExecutions.revision} + 1` },
        target: [marblesExecutions.scope, marblesExecutions.id],
      });
  }

  #observed(id: string) {
    return and(
      eq(marblesExecutionObservations.scope, this.#scope),
      eq(marblesExecutionObservations.runId, id)
    );
  }

  #owning<V>(stored: () => V, write: (kept: V) => Promise<void>) {
    let kept: V;
    try {
      kept = stored();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#call(() => write(kept));
  }

  #call<T>(call: () => Promise<T>): Promise<T> {
    return this.#gate.run(() => asBusy(call));
  }
}

async function gapsIn(
  database: Queries,
  scope: string
): Promise<readonly RetentionGap[]> {
  const rows = await database
    .select()
    .from(marblesExecutionGaps)
    .where(eq(marblesExecutionGaps.scope, scope));
  return rows.map((row) => ({
    removed: row.removed,
    scope: row.gapScope,
    through: row.through,
    updatedAt: row.updatedAt,
  }));
}

export async function removeAnnexes(
  database: Queries,
  scope: string,
  ids: readonly string[]
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await database
    .delete(marblesExecutionObservations)
    .where(
      and(
        eq(marblesExecutionObservations.scope, scope),
        inList(marblesExecutionObservations.runId, ids)
      )
    );
  await database
    .delete(marblesExecutions)
    .where(
      and(eq(marblesExecutions.scope, scope), inList(marblesExecutions.id, ids))
    );
}

export async function executionScopes(
  database: Queries,
  id: string
): Promise<readonly string[]> {
  const rows = await database
    .select({ scope: queueRuns.scope })
    .from(queueRuns)
    .where(eq(queueRuns.id, id as Run["id"]));
  return rows.map((row) => row.scope);
}

async function annexesIn(
  database: Queries,
  scope: string,
  only?: readonly string[]
): Promise<readonly StoredAnnex[]> {
  const rows = await database
    .select()
    .from(marblesExecutions)
    .where(
      and(
        eq(marblesExecutions.scope, scope),
        only === undefined ? undefined : inList(marblesExecutions.id, only)
      )
    );
  const observed = await database
    .select({
      observation: marblesExecutionObservations.observation,
      runId: marblesExecutionObservations.runId,
    })
    .from(marblesExecutionObservations)
    .where(
      and(
        eq(marblesExecutionObservations.scope, scope),
        only === undefined
          ? undefined
          : inList(marblesExecutionObservations.runId, only)
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
  const annexes = new Map<string, StoredAnnex>(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        observations: byRun.get(row.id) ?? [],
        ...(row.progress === null
          ? {}
          : { progress: fromJsonText(row.progress) }),
        revision: row.revision,
        updatedAt: row.updatedAt,
      },
    ])
  );
  for (const [id, observations] of byRun) {
    if (!annexes.has(id)) {
      annexes.set(id, { id, observations, revision: 0 });
    }
  }
  return [...annexes.values()];
}

function fromJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { unreadable: text };
  }
}

export async function readExecution(
  database: Queries,
  scope: string,
  id: string
): Promise<ExecutionRun | null> {
  const [runRow] = await database
    .select({ body: queueRuns.body })
    .from(queueRuns)
    .where(and(eq(queueRuns.scope, scope), eq(queueRuns.id, id as Run["id"])));
  if (runRow === undefined) {
    return null;
  }
  const run = runRow.body;
  const [jobRow] = await database
    .select({ body: queueJobs.body })
    .from(queueJobs)
    .where(and(eq(queueJobs.scope, scope), eq(queueJobs.id, run.jobId)));
  if (jobRow === undefined) {
    return null;
  }
  const [annex] = await annexesIn(database, scope, [id]);
  return executionOf(
    jobRow.body as Job,
    run,
    annex === undefined ? undefined : annexOf(annex)
  );
}

async function queuedIn(
  database: StoreDatabase,
  scope: string
): Promise<readonly Run[]> {
  const rows = await asBusy(() =>
    database
      .select({ body: queueRuns.body })
      .from(queueRuns)
      .where(and(eq(queueRuns.scope, scope), eq(queueRuns.state, "queued")))
  );
  return rows
    .map((row) => row.body)
    .sort((one, other) =>
      one.state.kind === "queued" && other.state.kind === "queued"
        ? one.state.queuedAt - other.state.queuedAt
        : 0
    );
}

export async function queuedRunsOwnedBy(
  database: StoreDatabase,
  scope: string,
  owner: ProcessIdentity
): Promise<readonly string[]> {
  return (await queuedRuns(database, scope))
    .filter((run) => sameProcess(run.owner, owner))
    .map((run) => run.id);
}

export async function queuedRuns(
  database: StoreDatabase,
  scope: string
): Promise<
  readonly {
    readonly id: string;
    readonly owner: ProcessIdentity;
  }[]
> {
  return (await queuedIn(database, scope)).flatMap((run) =>
    run.state.kind === "queued" && run.state.owner !== undefined
      ? [
          {
            id: run.id,
            owner: {
              pid: run.state.owner.pid,
              started: run.state.owner.started,
            },
          },
        ]
      : []
  );
}
