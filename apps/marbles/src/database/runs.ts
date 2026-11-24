import { randomUUID } from "node:crypto";
import type { QueueStoreService, QueueWrite } from "@foundry/queue/store";
import type { QueueTransaction } from "@foundry/queue/store/sqlite";
import { makeSqliteQueueStore } from "@foundry/queue/store/sqlite";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import { removeShares } from "~/database/associations";
import { asBusy } from "~/database/busy";
import { ChangeRecorder } from "~/database/changes";
import { followExecution, readExecution } from "~/database/executions";
import { inList } from "~/database/lists";
import type { StoreDatabase } from "~/database/open";
import {
  CHANGED,
  claimJudged,
  heldBy,
  NO_OWNER,
  type OwnerColumns,
  ownedHere,
  sameOwnerColumns,
} from "~/database/owner";
import { marblesWorkflowRuns } from "~/database/tables";
import { causingRun, RecordsGate } from "~/lib/events/records";
import { RUNS, sourceKey } from "~/lib/events/source";
import type { RecordedScope } from "~/lib/run-scope";
import type {
  ClaimCondition,
  RunFollower,
  RunStore,
  StoredScope,
} from "~/lib/run-store";
import {
  filedRuns,
  gatedQueueStore,
  ownedQueueWrite,
  removalOf,
} from "~/lib/run-store";
import { readRun, runEventsOf, runStoreEffect } from "~/lib/workflow-runs";

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
  readonly #letGo = new Set<string>();
  readonly #gate = new RecordsGate("the run store is closed");

  constructor(options: DatabaseRunStoreOptions) {
    this.#database = options.database;
    this.#scope = options.scope;
    this.#changes = options.changes ?? new ChangeRecorder(options.scope);
  }

  claim(runId: string, when: ClaimCondition): Promise<boolean> {
    return this.#call(async () => {
      const claimed: boolean = await claimJudged<boolean, boolean>(
        () => this.#ownerOf(this.#database, runId),
        (seen) => seen !== undefined && this.#heldElsewhere(seen),
        (seen, held) => this.#claimIn(runId, when, seen, held),
        false
      );
      if (claimed) {
        this.#letGo.delete(runId);
      }
      return claimed;
    });
  }

  async #ownerOf(
    database: StoreDatabase | QueueTransaction,
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
      const stored = await readRun(
        makeSqliteQueueStore({ database: transaction, scope: this.#scope }),
        runId
      );
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
  ): Promise<QueueStoreService> {
    const causes = new WeakMap<QueueWrite, string | null>();
    const store = makeSqliteQueueStore({
      database: this.#database,
      onCommit: async (transaction, write) => {
        await this.#file(transaction, write, recorded);
        await this.#follow(transaction, write, follows);
        await this.#changes.record(
          transaction,
          RUNS_KEY,
          runEventsOf(write.events ?? []),
          causes.get(write) ?? null
        );
        await removeShares(
          transaction,
          "run",
          this.#scope,
          write.deleteRuns ?? []
        );
      },
      scope: this.#scope,
    });
    return this.#call(() => {
      const gated = gatedQueueStore(store, (call) => this.#call(call));
      return Promise.resolve({
        ...gated,
        commit: (write: QueueWrite) => {
          const cause = causingRun();
          return Effect.suspend(() => {
            const owned = ownedQueueWrite(write);
            causes.set(owned, cause);
            return gated.commit(owned);
          });
        },
      });
    });
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
    if (runId !== undefined) {
      this.#letGo.add(runId);
    }
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
        const queue = makeSqliteQueueStore({
          database: transaction,
          scope: this.#scope,
        });
        const removal = await runStoreEffect(removalOf(queue, runId));
        await runStoreEffect(queue.commit(removal));
        await transaction
          .delete(marblesWorkflowRuns)
          .where(
            and(
              eq(marblesWorkflowRuns.scope, this.#scope),
              inList(marblesWorkflowRuns.runId, [
                ...new Set([runId, ...(removal.deleteRuns ?? [])]),
              ])
            )
          );
        await removeShares(
          transaction,
          "run",
          this.#scope,
          removal.deleteRuns ?? []
        );
      })
    );
  }

  async #file(
    transaction: QueueTransaction,
    write: QueueWrite,
    recorded: (runId: string) => RecordedScope | undefined
  ): Promise<void> {
    for (const { runId, scope, settled } of filedRuns(write, recorded)) {
      if (this.#letGo.has(runId)) {
        throw new RunMovedError(runId);
      }
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
    transaction: QueueTransaction,
    write: QueueWrite,
    follows: RunFollower | undefined
  ): Promise<void> {
    if (follows === undefined) {
      return;
    }
    for (const { runId, status } of filedRuns(write, () => undefined)) {
      const change = follows(runId, status);
      if (change !== undefined) {
        await followExecution(transaction, this.#scope, runId, change);
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

export async function unheldSuspendedRuns(
  database: StoreDatabase,
  scope: string
): Promise<readonly string[]> {
  const store = makeSqliteQueueStore({ database, scope });
  const suspended = (
    await asBusy(() => runStoreEffect(store.listRuns({ state: "suspended" })))
  ).map((run) => run.id);
  if (suspended.length === 0) {
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
          inList(marblesWorkflowRuns.runId, suspended)
        )
      )
  );
  const held = new Set(
    rows.filter((row) => heldBy(row) !== null).map((row) => row.runId)
  );
  return suspended.filter((runId) => !held.has(runId));
}
