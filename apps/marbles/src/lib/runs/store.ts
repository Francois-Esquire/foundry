import { StoreError } from "@foundry/queue";
import type { QueueStoreService, QueueWrite } from "@foundry/queue/store";
import { makeMemoryQueueStore } from "@foundry/queue/store/memory";
import { Effect } from "effect";

import { RecordsGate } from "~/lib/events/records-gate";
import { commitEffect, runStoreEffect, storeEffect } from "~/lib/runs/records";
import type { RecordedScope } from "~/lib/runs/scope";
import { storableJson } from "~/lib/shared/json-data";

export interface RunStore {
  close(): Promise<void>;
  readonly durable: boolean;
  open(
    recorded: (runId: string) => RecordedScope | undefined
  ): Promise<QueueStoreService>;
  recorded(runId: string): Promise<StoredScope>;
}

export interface StoredScope {
  readonly ledger: Readonly<Record<string, unknown>>;
  readonly literals?: RecordedScope["literals"];
  readonly session?: string;
}

export type TerminalRunStatus = "complete" | "failed" | "cancelled";

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> =
  new Set<TerminalRunStatus>(["complete", "failed", "cancelled"]);

export interface FiledRun {
  readonly runId: string;
  readonly scope: RecordedScope;
}

export function filedRuns(
  write: QueueWrite,
  recorded: (runId: string) => RecordedScope | undefined
): readonly FiledRun[] {
  return (write.runs ?? []).flatMap((run) => {
    const scope = recorded(run.id);
    return scope === undefined
      ? []
      : [{ runId: run.id, scope: storedScope(run.id, scope) }];
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

const readEveryField = (_unread: Record<PropertyKey, never>) => undefined;

export function ownedQueueWrite(write: QueueWrite): QueueWrite {
  const {
    deleteJobs,
    deleteRuns,
    deleteSuspensions,
    events,
    expected,
    jobs,
    pools,
    runs,
    suspensions,
    ...unread
  } = write;
  readEveryField(unread);
  return {
    ...(deleteJobs === undefined ? {} : { deleteJobs }),
    ...(deleteRuns === undefined ? {} : { deleteRuns }),
    ...(deleteSuspensions === undefined ? {} : { deleteSuspensions }),
    ...(events === undefined ? {} : { events }),
    ...(expected === undefined ? {} : { expected }),
    ...(jobs === undefined ? {} : { jobs }),
    ...(pools === undefined ? {} : { pools }),
    ...(runs === undefined ? {} : { runs }),
    ...(suspensions === undefined ? {} : { suspensions }),
  };
}

export function gatedQueueStore(
  store: QueueStoreService,
  around: <T>(call: () => Promise<T>) => Promise<T>
): QueueStoreService {
  const through = <A>(effect: Effect.Effect<A, StoreError>) =>
    storeEffect(() => around(() => runStoreEffect(effect)));
  return {
    ...(store.capabilities === undefined
      ? {}
      : { capabilities: store.capabilities }),
    commit: (write) =>
      commitEffect(() => around(() => runStoreEffect(store.commit(write)))),
    getJob: (id) => through(store.getJob(id)),
    getRun: (id) => through(store.getRun(id)),
    getSuspension: (id) => through(store.getSuspension(id)),
    listJobs: (filter) => through(store.listJobs(filter)),
    listPools: Effect.suspend(() => through(store.listPools)),
    listRuns: (filter) => through(store.listRuns(filter)),
    listSuspensions: (filter) => through(store.listSuspensions(filter)),
    watermark: Effect.suspend(() => through(store.watermark)),
  };
}

interface Filed {
  readonly deleted: readonly string[];
  readonly runs: readonly FiledRun[];
}

export class MemoryRunStore implements RunStore {
  readonly durable = false;
  readonly #gate = new RecordsGate("the run store is closed");
  readonly #scopes = new Map<string, RecordedScope>();
  readonly #queue = Effect.runSync(makeMemoryQueueStore);

  close(): Promise<void> {
    return this.#gate.close();
  }

  open(
    recorded: (runId: string) => RecordedScope | undefined
  ): Promise<QueueStoreService> {
    return this.#gate.run(() => {
      const gated = gatedQueueStore(this.#queue, (call) =>
        this.#gate.run(call)
      );
      return Promise.resolve({
        ...gated,
        commit: (write: QueueWrite) =>
          Effect.suspend(() => {
            const owned = ownedQueueWrite(write);
            return Effect.flatMap(
              Effect.try({
                catch: (cause) => new StoreError({ cause }),
                try: (): Filed => ({
                  deleted: [...(owned.deleteRuns ?? [])],
                  runs: filedRuns(owned, recorded),
                }),
              }),
              (taken) =>
                Effect.tap(gated.commit(owned), () => this.#file(taken))
            );
          }),
      });
    });
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

  #file({ deleted, runs }: Filed): void {
    for (const run of runs) {
      this.#scopes.set(run.runId, run.scope);
    }
    for (const runId of deleted) {
      this.#scopes.delete(runId);
    }
  }
}
