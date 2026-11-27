import type { Job, QueueEvent } from "@foundry/queue";
import type { QueueStoreService, QueueWrite } from "@foundry/queue/store";
import type { QueueTransaction } from "@foundry/queue/store/sqlite";
import { makeSqliteQueueStore } from "@foundry/queue/store/sqlite";
import { queueJobs } from "@foundry/queue/store/tables";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import { asBusy } from "~/database/busy";
import { ChangeRecorder } from "~/database/changes";
import { removeAnnexes } from "~/database/executions";
import { inList } from "~/database/lists";
import { marblesWorkflowRuns } from "~/database/tables";
import type { StoreDatabase } from "~/database/types";
import { RecordsGate } from "~/lib/events/records-gate";
import { RUNS, sourceKey } from "~/lib/events/source";
import { isTask } from "~/lib/execution-record";
import type { RecordedScope } from "~/lib/run-scope";
import type { RunStore, StoredScope } from "~/lib/run-store";
import { filedRuns, gatedQueueStore, ownedQueueWrite } from "~/lib/run-store";
import { runEventsOf } from "~/lib/workflow-runs";

const RUNS_KEY = sourceKey(RUNS) ?? "runs";

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
  readonly #gate = new RecordsGate("the run store is closed");

  constructor(options: DatabaseRunStoreOptions) {
    this.#database = options.database;
    this.#scope = options.scope;
    this.#changes = options.changes ?? new ChangeRecorder(options.scope);
  }

  close(): Promise<void> {
    return this.#gate.close();
  }

  open(
    recorded: (runId: string) => RecordedScope | undefined
  ): Promise<QueueStoreService> {
    const causes = new WeakMap<QueueWrite, string | null>();
    const store = makeSqliteQueueStore({
      database: this.#database,
      onCommit: async (transaction, write) => {
        const deleted = write.deleteRuns ?? [];
        await this.#file(transaction, write, recorded);
        await this.#changes.record(
          transaction,
          RUNS_KEY,
          runEventsOf(await this.#workflowEvents(transaction, write)),
          causes.get(write) ?? null
        );
        await removeAnnexes(transaction, this.#scope, deleted);
      },
      scope: this.#scope,
    });
    return this.#call(() => {
      const gated = gatedQueueStore(store, (call) => this.#call(call));
      return Promise.resolve({
        ...gated,
        commit: (write: QueueWrite) => {
          const cause = this.#changes.cause();
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
        .where(
          and(
            eq(marblesWorkflowRuns.scope, this.#scope),
            eq(marblesWorkflowRuns.runId, runId)
          )
        );
      if (row === undefined) {
        return { ledger: {} };
      }
      const { ledger, literals, sessionId } = recordedRow.parse(row);
      return sessionId === null
        ? { ledger }
        : { ledger, literals, session: sessionId };
    });
  }

  async #file(
    transaction: QueueTransaction,
    write: QueueWrite,
    recorded: (runId: string) => RecordedScope | undefined
  ): Promise<void> {
    for (const { runId, scope } of filedRuns(write, recorded)) {
      const recording = {
        ledger: { ...scope.ledger },
        literals: { ...scope.literals },
        sessionId: scope.session.id,
      };
      await transaction
        .insert(marblesWorkflowRuns)
        .values({ ...recording, runId, scope: this.#scope })
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

  async #workflowEvents(
    transaction: QueueTransaction,
    write: QueueWrite
  ): Promise<readonly QueueEvent[]> {
    const jobs = new Map<string, Job | undefined>(
      (write.jobs ?? []).map((job) => [job.id, job])
    );
    const kept: QueueEvent[] = [];
    for (const event of write.events ?? []) {
      if (!("run" in event)) {
        kept.push(event);
        continue;
      }
      const { jobId } = event.run;
      if (!jobs.has(jobId)) {
        const [row] = await transaction
          .select({ body: queueJobs.body })
          .from(queueJobs)
          .where(
            and(eq(queueJobs.scope, this.#scope), eq(queueJobs.id, jobId))
          );
        jobs.set(jobId, row?.body);
      }
      const job = jobs.get(jobId);
      if (job === undefined || !isTask(job)) {
        kept.push(event);
      }
    }
    return kept;
  }

  #call<T>(call: () => Promise<T>): Promise<T> {
    return this.#gate.run(() => asBusy(call));
  }
}
