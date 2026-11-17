import { randomUUID } from "node:crypto";
import type { RunRecord } from "@foundry/workflows/schema";
import type {
  WorkflowStore,
  WorkflowStoreWrite,
} from "@foundry/workflows/store";
import { MemoryWorkflowStore } from "@foundry/workflows/store/memory";

import { RecordsGate } from "~/lib/events/records";
import type { RecordedScope } from "~/lib/run-scope";
import { storableJson } from "~/lib/state/json";

export interface RunStore {
  claim(runId: string, when: ClaimCondition): Promise<boolean>;
  close(): Promise<void>;
  readonly durable: boolean;
  open(
    recorded: (runId: string) => RecordedScope | undefined
  ): Promise<WorkflowStore>;
  recorded(runId: string): Promise<StoredScope>;
  release(runId?: string): Promise<void>;
  remove(runId: string): Promise<void>;
}

export type ClaimCondition = (stored: RunRecord | null) => boolean;

export const ANY_STORED_RUN: ClaimCondition = () => true;

export interface StoredScope {
  readonly ledger: Readonly<Record<string, unknown>>;
  readonly literals?: RecordedScope["literals"];
  readonly session?: string;
}

type TerminalRunStatus = "complete" | "failed" | "cancelled";

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> =
  new Set<TerminalRunStatus>(["complete", "failed", "cancelled"]);

export async function removalOf(
  store: WorkflowStore,
  runId: string
): Promise<WorkflowStoreWrite> {
  const run = await store.getRun(runId);
  if (run === null) {
    return {};
  }
  const suspensions: string[] = [];
  let after: number | undefined;
  do {
    const page = await store.listSuspensions({
      limit: 100,
      runId,
      ...(after === undefined ? {} : { after }),
    });
    suspensions.push(...page.items.map((suspension) => suspension.id));
    after = page.next;
  } while (after !== undefined);
  const jobId = run.links?.jobId;
  return {
    ...(jobId === undefined ? {} : { deleteJobs: [jobId] }),
    deleteRunFrames: [runId],
    deleteRuns: [runId],
    deleteSuspensions: suspensions,
  };
}

export function filedRuns(
  write: WorkflowStoreWrite,
  recorded: (runId: string) => RecordedScope | undefined
): readonly {
  readonly runId: string;
  readonly scope?: RecordedScope;
  readonly settled: boolean;
}[] {
  return (write.putRuns ?? []).map((run) => {
    const scope = recorded(run.id);
    return {
      runId: run.id,
      ...(scope === undefined ? {} : { scope: storedScope(run.id, scope) }),
      settled: TERMINAL_RUN_STATUSES.has(run.status),
    };
  });
}

function storedScope(runId: string, scope: RecordedScope): RecordedScope {
  const at = `run ${JSON.stringify(runId)}`;
  return {
    ledger: storableJson(
      `${at} ledger`,
      scope.ledger
    ) as RecordedScope["ledger"],
    ...(scope.literals === undefined
      ? {}
      : {
          literals: storableJson(
            `${at} literals`,
            scope.literals
          ) as RecordedScope["literals"],
        }),
    session: {
      id: storableJson(`${at} session`, scope.session.id) as string,
    },
  };
}

export class MemoryRunStore implements RunStore {
  readonly durable = false;
  readonly #gate = new RecordsGate("the run store is closed");
  readonly #owner = randomUUID();
  readonly #owners = new Map<string, string>();
  readonly #scopes = new Map<string, RecordedScope>();
  readonly #workflows = new MemoryWorkflowStore();

  claim(runId: string, when: ClaimCondition): Promise<boolean> {
    return this.#gate.run(() =>
      this.#workflows.transaction(async (view) => {
        if (!when(await view.getRun(runId))) {
          return false;
        }
        const owner = this.#owners.get(runId);
        if (owner !== undefined && owner !== this.#owner) {
          return false;
        }
        this.#owners.set(runId, this.#owner);
        return true;
      })
    );
  }

  close(): Promise<void> {
    return this.#gate.close();
  }

  open(
    recorded: (runId: string) => RecordedScope | undefined
  ): Promise<WorkflowStore> {
    return this.#gate.run(() =>
      Promise.resolve(
        this.#filing(this.#workflows, recorded, (filed) => this.#file(filed), {
          through: (call) => this.#gate.run(call),
        })
      )
    );
  }

  recorded(runId: string): Promise<StoredScope> {
    return this.#gate.run(() => {
      const scope = structuredClone(this.#scopes.get(runId));
      return Promise.resolve(
        scope === undefined
          ? { ledger: {} }
          : {
              ledger: scope.ledger,
              ...(scope.literals === undefined
                ? {}
                : { literals: scope.literals }),
              session: scope.session.id,
            }
      );
    });
  }

  release(runId?: string): Promise<void> {
    return this.#gate.run(() => {
      for (const [id, owner] of this.#owners) {
        if (owner === this.#owner && (runId === undefined || id === runId)) {
          this.#owners.delete(id);
        }
      }
      return Promise.resolve();
    });
  }

  remove(runId: string): Promise<void> {
    return this.#gate.run(async () => {
      await this.#workflows.transaction(async (view) =>
        view.commit(await removalOf(view, runId))
      );
      this.#scopes.delete(runId);
      this.#owners.delete(runId);
    });
  }

  #file({ deleted, runs }: Filed): void {
    for (const run of runs) {
      if (run.scope !== undefined) {
        this.#scopes.set(run.runId, run.scope);
      }
      if (run.settled) {
        this.#owners.delete(run.runId);
      } else {
        this.#owners.set(run.runId, this.#owner);
      }
    }
    for (const runId of deleted) {
      this.#scopes.delete(runId);
      this.#owners.delete(runId);
    }
  }

  #filing(
    store: WorkflowStore,
    recorded: (runId: string) => RecordedScope | undefined,
    filed: (commit: Filed) => void,
    {
      through = (call) => call(),
    }: {
      readonly through?: <T>(call: () => Promise<T>) => Promise<T>;
    } = {}
  ): WorkflowStore {
    const { transaction } = store;
    return {
      commit: (write) => {
        let taken: Filed;
        try {
          taken = {
            deleted: [...(write.deleteRuns ?? [])],
            runs: filedRuns(write, recorded),
          };
        } catch (error) {
          return Promise.reject(error);
        }
        return through(async () => {
          await store.commit(write);
          filed(taken);
        });
      },
      ...(store.durability === undefined
        ? {}
        : { durability: store.durability }),
      getJob: (id) => through(() => store.getJob(id)),
      getQueue: (id) => through(() => store.getQueue(id)),
      getRun: (id) => through(() => store.getRun(id)),
      getSuspension: (id) => through(() => store.getSuspension(id)),
      listFrames: (query) => through(() => store.listFrames(query)),
      listJobs: (query) => through(() => store.listJobs(query)),
      listQueues: () => through(() => store.listQueues()),
      listRuns: (query) => through(() => store.listRuns(query)),
      listSuspensions: (query) => through(() => store.listSuspensions(query)),
      ...(transaction === undefined
        ? {}
        : {
            transaction: <T>(
              work: (view: WorkflowStore) => Promise<T>
            ): Promise<T> =>
              through(async () => {
                const pending: Filed[] = [];
                const result = await transaction.call<
                  WorkflowStore,
                  [(view: WorkflowStore) => Promise<T>],
                  Promise<T>
                >(store, (view) =>
                  work(
                    this.#filing(view, recorded, (commit) =>
                      pending.push(commit)
                    )
                  )
                );
                for (const commit of pending) {
                  filed(commit);
                }
                return result;
              }),
          }),
    };
  }
}

interface Filed {
  readonly deleted: readonly string[];
  readonly runs: ReturnType<typeof filedRuns>;
}
