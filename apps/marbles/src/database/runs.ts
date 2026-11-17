import { randomUUID } from "node:crypto";
import { processAlive } from "@foundry/lib/file-lock";
import type {
  WorkflowStore,
  WorkflowStoreWrite,
} from "@foundry/workflows/store";
import type { WorkflowTransaction } from "@foundry/workflows/store/sqlite";
import { SqliteWorkflowStore } from "@foundry/workflows/store/sqlite";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { aroundCalls, asBusy } from "~/database/busy";
import { followExecution, readExecution } from "~/database/executions";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import { marblesWorkflowRuns } from "~/database/tables";
import { stateDatabase } from "~/layout";
import { RecordsGate } from "~/lib/events/records";
import type { RecordedScope } from "~/lib/run-scope";
import type {
  ClaimCondition,
  RunFollower,
  RunStore,
  StoredScope,
} from "~/lib/run-store";
import { filedRuns, removalOf } from "~/lib/run-store";

export interface DatabaseRunStoreOptions {
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
  readonly #owner = randomUUID();
  readonly #gate = new RecordsGate("the run store is closed");

  constructor(options: DatabaseRunStoreOptions) {
    this.#database = options.database;
    this.#scope = options.scope;
  }

  claim(runId: string, when: ClaimCondition): Promise<boolean> {
    return this.#call(() =>
      this.#database.transaction(async (transaction) => {
        const stored = await new SqliteWorkflowStore({
          database: transaction,
          scope: this.#scope,
        }).getRun(runId);
        const execution = await readExecution(transaction, this.#scope, runId);
        if (!when(stored, execution)) {
          return false;
        }
        const [row] = await transaction
          .select({
            ownerId: marblesWorkflowRuns.ownerId,
            ownerPid: marblesWorkflowRuns.ownerPid,
          })
          .from(marblesWorkflowRuns)
          .where(this.#run(runId));
        if (row !== undefined && this.#heldElsewhere(row)) {
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
      })
    );
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
          new SqliteWorkflowStore({
            database: this.#database,
            onCommit: async (transaction, write) => {
              await this.#file(transaction, write, recorded);
              await this.#follow(transaction, write, follows);
            },
            scope: this.#scope,
          }),
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
        .set({ ownerId: null, ownerPid: null })
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
      const owner = settled ? { ownerId: null, ownerPid: null } : this.#owned();
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
            inArray(marblesWorkflowRuns.runId, [...deleted])
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
  }): boolean {
    return (
      row.ownerId !== null &&
      row.ownerId !== this.#owner &&
      row.ownerPid !== null &&
      processAlive(row.ownerPid)
    );
  }

  #owned() {
    return { ownerId: this.#owner, ownerPid: process.pid };
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

export interface StoredRun {
  readonly createdAt: number;
  readonly id: string;
  readonly owner: number | null;
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
              runId: marblesWorkflowRuns.runId,
            })
            .from(marblesWorkflowRuns)
            .where(eq(marblesWorkflowRuns.scope, scope))
        ).map((row) => [row.runId, row.ownerPid])
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
