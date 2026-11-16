import { randomUUID } from "node:crypto";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
import type {
  WorkflowStore,
  WorkflowStoreWrite,
} from "@foundry/workflows/store";
import type { WorkflowTransaction } from "@foundry/workflows/store/sqlite";
import { SqliteWorkflowStore } from "@foundry/workflows/store/sqlite";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { aroundCalls, asBusy } from "~/database/busy";
import { ChangeRecorder } from "~/database/changes";
import { followExecution, readExecution } from "~/database/executions";
import { inList } from "~/database/lists";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import {
  CHANGED,
  claimJudged,
  heldBy,
  NO_OWNER,
  type OwnerColumns,
  ownedHere,
  rowOwner,
  sameOwnerColumns,
} from "~/database/owner";
import { marblesWorkflowRuns } from "~/database/tables";
import { stateDatabase } from "~/layout";
import { RecordsGate } from "~/lib/events/records";
import { RUNS, sourceKey } from "~/lib/events/source";
import type { RecordedScope } from "~/lib/run-scope";
import type {
  ClaimCondition,
  RunFollower,
  RunStore,
  StoredScope,
} from "~/lib/run-store";
import { filedRuns, removalOf } from "~/lib/run-store";

const RUNS_KEY = sourceKey(RUNS) ?? "runs";

class RunMovedError extends Error {
  override readonly name = "RunMovedError";

  constructor(runId: string) {
    super(
      `run ${runId} is not held by this engine any more; the engine that holds it changes it`
    );
  }
}

export interface DatabaseRunStoreOptions {
  readonly changes?: ChangeRecorder;
  readonly database: StoreDatabase;
  readonly scope: string;
}

const recordedRow = z.object({
  ledger: z.record(z.string(), z.unknown()),
  literals: z.record(z.string(), z.record(z.string(), z.unknown())),
  sessionId: z.string().nullable(),
});

export class DatabaseRunStore implements RunStore {
  readonly durable = true;
  readonly #database: StoreDatabase;
  readonly #scope: string;
  readonly #changes: ChangeRecorder;
  readonly #owner = randomUUID();
  readonly #gate = new RecordsGate("the run store is closed");

  constructor(options: DatabaseRunStoreOptions) {
    this.#database = options.database;
    this.#scope = options.scope;
    this.#changes = options.changes ?? new ChangeRecorder(options.scope);
  }

  claim(runId: string, when: ClaimCondition): Promise<boolean> {
    return this.#call(() =>
      claimJudged(
        () => this.#ownerOf(this.#database, runId),
        (seen) => seen !== undefined && this.#heldElsewhere(seen),
        (seen, held) => this.#claimIn(runId, when, seen, held),
        false
      )
    );
  }

  async #ownerOf(
    database: StoreDatabase | WorkflowTransaction,
    runId: string
  ): Promise<OwnerColumns | undefined> {
    const [row] = await database
      .select({
        ownerId: marblesWorkflowRuns.ownerId,
        ownerPid: marblesWorkflowRuns.ownerPid,
        ownerStarted: marblesWorkflowRuns.ownerStarted,
      })
      .from(marblesWorkflowRuns)
      .where(this.#run(runId));
    return row;
  }

  #claimIn(
    runId: string,
    when: ClaimCondition,
    seen: OwnerColumns | undefined,
    held: boolean
  ): Promise<boolean | typeof CHANGED> {
    return this.#database.transaction(async (transaction) => {
      const stored = await new SqliteWorkflowStore({
        database: transaction,
        scope: this.#scope,
      }).getRun(runId);
      const execution = await readExecution(transaction, this.#scope, runId);
      if (!when(stored, execution)) {
        return false;
      }
      if (!sameOwnerColumns(await this.#ownerOf(transaction, runId), seen)) {
        return CHANGED;
      }
      if (held) {
        return false;
      }
      await transaction
        .insert(marblesWorkflowRuns)
        .values({
          ledger: {},
          literals: {},
          ...this.#owned(),
          runId,
          scope: this.#scope,
        })
        .onConflictDoUpdate({
          set: this.#owned(),
          target: [marblesWorkflowRuns.scope, marblesWorkflowRuns.runId],
        });
      return true;
    });
  }

  close(): Promise<void> {
    return this.#gate.close();
  }

  open(
    recorded: (runId: string) => RecordedScope | undefined,
    follows?: RunFollower
  ): Promise<WorkflowStore> {
    return this.#call(() =>
      Promise.resolve(
        aroundCalls(
          this.#changes.causing(
            new SqliteWorkflowStore({
              database: this.#database,
              onCommit: async (transaction, write) => {
                await this.#file(transaction, write, recorded);
                await this.#follow(transaction, write, follows);
                await this.#changes.record(transaction, RUNS_KEY, write.events);
              },
              scope: this.#scope,
            })
          ),
          (call) => this.#call(call)
        )
      )
    );
  }

  recorded(runId: string): Promise<StoredScope> {
    return this.#call(async () => {
      const [row] = await this.#database
        .select({
          ledger: marblesWorkflowRuns.ledger,
          literals: marblesWorkflowRuns.literals,
          sessionId: marblesWorkflowRuns.sessionId,
        })
        .from(marblesWorkflowRuns)
        .where(this.#run(runId));
      if (row === undefined) {
        return { ledger: {} };
      }
      const { ledger, literals, sessionId } = recordedRow.parse(row);
      return sessionId === null
        ? { ledger }
        : { ledger, literals, session: sessionId };
    });
  }

  release(runId?: string): Promise<void> {
    return this.#call(async () => {
      await this.#database
        .update(marblesWorkflowRuns)
        .set(NO_OWNER)
        .where(
          and(
            eq(marblesWorkflowRuns.scope, this.#scope),
            eq(marblesWorkflowRuns.ownerId, this.#owner),
            runId === undefined
              ? undefined
              : eq(marblesWorkflowRuns.runId, runId)
          )
        );
    });
  }

  remove(runId: string): Promise<void> {
    return this.#call(() =>
      this.#database.transaction(async (transaction) => {
        const workflows = new SqliteWorkflowStore({
          database: transaction,
          scope: this.#scope,
        });
        await workflows.commit(await removalOf(workflows, runId));
        await transaction.delete(marblesWorkflowRuns).where(this.#run(runId));
      })
    );
  }

  async #file(
    transaction: WorkflowTransaction,
    write: WorkflowStoreWrite,
    recorded: (runId: string) => RecordedScope | undefined
  ): Promise<void> {
    for (const { runId, scope, settled } of filedRuns(write, recorded)) {
      const held = await this.#ownerOf(transaction, runId);
      if (
        held !== undefined &&
        held.ownerId !== null &&
        held.ownerId !== this.#owner
      ) {
        throw new RunMovedError(runId);
      }
      const owner = settled ? NO_OWNER : this.#owned();
      const recording =
        scope === undefined
          ? owner
          : {
              ledger: { ...scope.ledger },
              literals: { ...scope.literals },
              ...owner,
              sessionId: scope.session.id,
            };
      await transaction
        .insert(marblesWorkflowRuns)
        .values({
          ledger: {},
          literals: {},
          ...recording,
          runId,
          scope: this.#scope,
        })
        .onConflictDoUpdate({
          set: recording,
          target: [marblesWorkflowRuns.scope, marblesWorkflowRuns.runId],
        });
    }
    const deleted = write.deleteRuns ?? [];
    if (deleted.length > 0) {
      await transaction
        .delete(marblesWorkflowRuns)
        .where(
          and(
            eq(marblesWorkflowRuns.scope, this.#scope),
            inList(marblesWorkflowRuns.runId, deleted)
          )
        );
    }
  }

  async #follow(
    transaction: WorkflowTransaction,
    write: WorkflowStoreWrite,
    follows: RunFollower | undefined
  ): Promise<void> {
    for (const run of follows === undefined ? [] : (write.putRuns ?? [])) {
      const change = follows?.(run.id, run.status);
      if (change !== undefined) {
        await followExecution(transaction, this.#scope, run.id, change);
      }
    }
  }

  #heldElsewhere(row: {
    readonly ownerId: string | null;
    readonly ownerPid: number | null;
    readonly ownerStarted: string | null;
  }): boolean {
    return (
      row.ownerId !== null &&
      row.ownerId !== this.#owner &&
      heldBy(row) !== null
    );
  }

  #owned() {
    return ownedHere(this.#owner);
  }

  #run(runId: string) {
    return and(
      eq(marblesWorkflowRuns.scope, this.#scope),
      eq(marblesWorkflowRuns.runId, runId)
    );
  }

  #call<T>(call: () => Promise<T>): Promise<T> {
    return this.#gate.run(() => asBusy(call));
  }
}

export async function unheldParkedRuns(
  database: StoreDatabase,
  scope: string
): Promise<readonly string[]> {
  const store = new SqliteWorkflowStore({ database, scope });
  const parked: string[] = [];
  let after: number | undefined;
  do {
    const page = await asBusy(() =>
      store.listRuns({
        limit: 200,
        status: ["suspended"],
        ...(after === undefined ? {} : { after }),
      })
    );
    parked.push(...page.items.map((run) => run.id));
    after = page.next;
  } while (after !== undefined);
  if (parked.length === 0) {
    return [];
  }
  const rows = await asBusy(() =>
    database
      .select({
        ownerPid: marblesWorkflowRuns.ownerPid,
        ownerStarted: marblesWorkflowRuns.ownerStarted,
        runId: marblesWorkflowRuns.runId,
      })
      .from(marblesWorkflowRuns)
      .where(
        and(
          eq(marblesWorkflowRuns.scope, scope),
          inList(marblesWorkflowRuns.runId, parked)
        )
      )
  );
  const held = new Set(
    rows.filter((row) => heldBy(row) !== null).map((row) => row.runId)
  );
  return parked.filter((runId) => !held.has(runId));
}

export interface StoredRun {
  readonly createdAt: number;
  readonly id: string;
  readonly owner: ProcessIdentity | null;
  readonly status: string;
  readonly step: string;
}

export async function readStoredRuns(
  state: string,
  scope: string
): Promise<readonly StoredRun[]> {
  const read = await asBusy(() =>
    readDatabase(stateDatabase(state), async (database) => {
      const store = new SqliteWorkflowStore({ database, scope });
      const owners = new Map(
        (
          await database
            .select({
              ownerPid: marblesWorkflowRuns.ownerPid,
              ownerStarted: marblesWorkflowRuns.ownerStarted,
              runId: marblesWorkflowRuns.runId,
            })
            .from(marblesWorkflowRuns)
            .where(eq(marblesWorkflowRuns.scope, scope))
        ).map((row) => [row.runId, rowOwner(row)])
      );
      const runs: StoredRun[] = [];
      let after: number | undefined;
      do {
        const page = await store.listRuns({
          limit: 200,
          ...(after === undefined ? {} : { after }),
        });
        for (const run of page.items) {
          runs.push({
            createdAt: run.timestamps.createdAt,
            id: run.id,
            owner: owners.get(run.id) ?? null,
            status: run.status,
            step: run.step,
          });
        }
        after = page.next;
      } while (after !== undefined);
      return runs;
    })
  );
  return read ?? [];
}
