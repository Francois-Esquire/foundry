import { randomUUID } from "node:crypto";
import { StoreError } from "@foundry/queue";
import type { QueueStoreService, QueueWrite } from "@foundry/queue/store";
import { makeMemoryQueueStore } from "@foundry/queue/store/memory";
import { Effect } from "effect";

import { RecordsGate } from "~/lib/events/records";
import type { ExecutionRun } from "~/lib/execution-record";
import type { LifecycleChange } from "~/lib/execution-store";
import type { RecordedScope } from "~/lib/run-scope";
import { storableJson } from "~/lib/state/json";
import type { RunRecord } from "~/lib/workflow-runs";
import {
  commitEffect,
  isRunId,
  readRun,
  runStatusOf,
  runStoreEffect,
  storeEffect,
} from "~/lib/workflow-runs";

export interface RunStore {
  claim(runId: string, when: ClaimCondition): Promise<boolean>;
  close(): Promise<void>;
  readonly durable: boolean;
  open(
    recorded: (runId: string) => RecordedScope | undefined,
    follows?: RunFollower
  ): Promise<QueueStoreService>;
  recorded(runId: string): Promise<StoredScope>;
  release(runId?: string): Promise<void>;
  remove(runId: string): Promise<void>;
}

export type RunFollower = (
  runId: string,
  status: string
) => LifecycleChange | undefined;

export type ClaimCondition = (
  stored: RunRecord | null,
  execution?: ExecutionRun | null
) => boolean;

export const ANY_STORED_RUN: ClaimCondition = () => true;

export interface StoredScope {
  readonly ledger: Readonly<Record<string, unknown>>;
  readonly literals?: RecordedScope["literals"];
  readonly session?: string;
}

export type TerminalRunStatus = "complete" | "failed" | "cancelled";

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> =
  new Set<TerminalRunStatus>(["complete", "failed", "cancelled"]);

export const removalOf = (
  store: Pick<QueueStoreService, "getRun" | "listRuns" | "listSuspensions">,
  runId: string
): Effect.Effect<QueueWrite, StoreError> =>
  Effect.gen(function* () {
    const run = isRunId(runId) ? yield* store.getRun(runId) : undefined;
    if (run === undefined) {
      return {};
    }
    const runs = yield* store.listRuns({ jobId: run.jobId });
    const suspensions = yield* Effect.forEach(runs, (each) =>
      store.listSuspensions({ runId: each.id })
    );
    return {
      deleteJobs: [run.jobId],
      deleteRuns: runs.map((each) => each.id),
      deleteSuspensions: suspensions.flat().map((suspension) => suspension.id),
    };
  });

export interface FiledRun {
  readonly runId: string;
  readonly scope?: RecordedScope;
  readonly settled: boolean;
  readonly status: string;
}

export function filedRuns(
  write: QueueWrite,
  recorded: (runId: string) => RecordedScope | undefined
): readonly FiledRun[] {
  return (write.runs ?? []).map((run) => {
    const scope = recorded(run.id);
    const status = runStatusOf(run.state);
    return {
      runId: run.id,
      ...(scope === undefined ? {} : { scope: storedScope(run.id, scope) }),
      settled: TERMINAL_RUN_STATUSES.has(status),
      status,
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
  readonly #owner = randomUUID();
  readonly #owners = new Map<string, string>();
  readonly #scopes = new Map<string, RecordedScope>();
  readonly #queue = Effect.runSync(makeMemoryQueueStore);

  claim(runId: string, when: ClaimCondition): Promise<boolean> {
    return this.#gate.run(async () => {
      if (!when(await readRun(this.#queue, runId))) {
        return false;
      }
      const owner = this.#owners.get(runId);
      if (owner !== undefined && owner !== this.#owner) {
        return false;
      }
      this.#owners.set(runId, this.#owner);
      return true;
    });
  }

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
      const queue = this.#queue;
      await runStoreEffect(
        Effect.flatMap(removalOf(queue, runId), (removal) =>
          queue.commit(removal)
        )
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
}
