import { randomUUID } from "node:crypto";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
import type {
  WorkflowStore,
  WorkflowStoreWrite,
} from "@foundry/workflows/store";
import type { WorkflowTransaction } from "@foundry/workflows/store/sqlite";
import { SqliteWorkflowStore } from "@foundry/workflows/store/sqlite";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { aroundCalls, asBusy } from "~/database/busy";
import { ChangeRecorder } from "~/database/changes";
import { followExecution, readExecution } from "~/database/executions";
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

/**
 * A workspace's workflow Runs in the Marbles database: the
 * `@foundry/workflows` rows scoped by the workspace id, and beside each Run
 * Marbles' own row (`marbles_workflow_runs`), what its scope recorded and
 * which engine owns it.
 *
 * The row is written by `SqliteWorkflowStore`'s `onCommit` hook, on the
 * transaction the hook is handed, so a Run and what its scope recorded
 * commit or roll back together, and the engine that commits a Run owns it
 * until a commit settles it. A claim (adopting a parked Run, or settling
 * one an exited process left) is one transaction that reads the owner and
 * takes it, so two engines, in this process or another, never both own a
 * Run. An owner whose process has exited owns nothing. Every call surfaces
 * a lock waited on too long as a `DatabaseBusyError`.
 */

const RUNS_KEY = sourceKey(RUNS) ?? "runs";

export interface DatabaseRunStoreOptions {
  /**
   * What the workspace's stores in this process record their change facts
   * through, so a commit wakes delivery at once; one of this store's own
   * when omitted, whose commits delivery notices on its next tick.
   */
  readonly changes?: ChangeRecorder;
  /** The database the host keeps open; never one of its transactions, since a Run's commit must be there for good. */
  readonly database: StoreDatabase;
  /** The workspace id. */
  readonly scope: string;
}

/** A row's recording, as it must read back. */
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
  /** This store's identity as an owner: one per engine, so two in one process are told apart. */
  readonly #owner = randomUUID();
  /** Every call, the workflow records' included, so `close` waits for those under way. */
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
        // Asked outside the transaction: no process is asked under its lock.
        (seen) => seen !== undefined && this.#heldElsewhere(seen),
        (seen, held) => this.#claimIn(runId, when, seen, held),
        false
      )
    );
  }

  /** The owner columns of the Run `runId`'s row, as `database` reads them now. */
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

  /** The claim's transaction, on the owner `seen` and whether it was `held`. */
  #claimIn(
    runId: string,
    when: ClaimCondition,
    seen: OwnerColumns | undefined,
    held: boolean
  ): Promise<boolean | typeof CHANGED> {
    return this.#database.transaction(async (transaction) => {
      // Read in the claim's own transaction, the Run and its Execution
      // Run beside it: no write lands between them and the claim, from
      // this process or another.
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

  /**
   * Refuse every call from now on, the workflow records' included, once
   * those under way have settled: the host may then close the database
   * with no transaction of the store's left open on it.
   */
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
      // A recording always names the run's session; a row without one is an owner's alone.
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

  /**
   * What `write` files beside its Runs, in its own `transaction`: each Run
   * it puts unsettled has this store as its owner, and the recording of
   * its scope when there is one here; each Run it settles is owned by no
   * one; each Run it deletes loses its row.
   */
  async #file(
    transaction: WorkflowTransaction,
    write: WorkflowStoreWrite,
    recorded: (runId: string) => RecordedScope | undefined
  ): Promise<void> {
    for (const { runId, scope, settled } of filedRuns(write, recorded)) {
      const owner = settled ? NO_OWNER : this.#owned();
      // Without a recording, the row keeps what it had and changes owner.
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

  /** Each Execution Run `follows` answers for a Run `write` puts, in its `transaction`. */
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

  /** Owned by another engine whose process is still there. */
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

  /** Run `call` unless closed, and say what went wrong in the database's terms. */
  #call<T>(call: () => Promise<T>): Promise<T> {
    return this.#gate.run(() => asBusy(call));
  }
}

/** A workspace's Run as `status` lists it. */
export interface StoredRun {
  /** In ms since the epoch. */
  readonly createdAt: number;
  readonly id: string;
  /** The process of the engine that owns it; `null` when none does. */
  readonly owner: ProcessIdentity | null;
  readonly status: string;
  readonly step: string;
}

/**
 * Every Run the workspace `scope` keeps in the Marbles database at the
 * state root `state`, read only (`readDatabase`), in the order they were
 * first put. Empty with no database, or nothing migrated into it.
 */
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
