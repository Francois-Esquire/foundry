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

/**
 * Where an engine keeps its workflow Runs: the `@foundry/workflows` records
 * its Orchestrator runs over, and beside each Run what the run's scope
 * recorded (`RecordedScope`) and which engine owns it. A Run is owned by
 * the engine that dispatched or adopted it until it settles or the engine
 * stops; an owner that has exited owns nothing.
 *
 * The store enforces no rule of the engine's: which parked Runs an engine
 * takes on at start is `lib/run-recovery.ts`, and which Runs may be removed
 * is the Execution Runs' retention (`ExecutionRecords.prune`). It keeps
 * what it is told, and a claim takes effect atomically, so two engines
 * over one store never both own a Run.
 *
 * `MemoryRunStore` keeps everything in this process; the Marbles database
 * keeps it on disk (`database/runs.ts`), where it outlives the process.
 */
export interface RunStore {
  /**
   * Own a Run no live engine owns, while the Run as stored satisfies
   * `when`, read in the same atomic step as the claim, so no change to the
   * Run lands between the decision and the claim; whether this store owns
   * it now. Every claim says what it requires of the Run
   * (`ANY_STORED_RUN` when ownership is all it decides on).
   */
  claim(runId: string, when: ClaimCondition): Promise<boolean>;
  /** Refuse every call from now on; a handle the store opened itself closes. */
  close(): Promise<void>;
  /**
   * Whether what it keeps outlives the process, so a Run parked here is
   * adopted by the next process that can answer it.
   */
  readonly durable: boolean;
  /**
   * The workflow records, once per engine. Every commit that puts a Run
   * files beside it, in the same transaction, what `recorded` answers for
   * it, and makes this store its owner until a commit settles it.
   */
  open(
    recorded: (runId: string) => RecordedScope | undefined
  ): Promise<WorkflowStore>;
  /** What the Run's scope last recorded: an empty ledger when it recorded nothing. */
  recorded(runId: string): Promise<StoredScope>;
  /** Give up the Run, or with no id every Run this store owns, as its engine stops. */
  release(runId?: string): Promise<void>;
  /** A settled Run and everything kept of it, gone in one write. */
  remove(runId: string): Promise<void>;
}

/**
 * Whether a Run, as the store holds it at the claim (`null` when it holds
 * none), may be claimed. Asked inside the claim's atomic step, so it must
 * only read: what it is told and what this process already holds.
 */
export type ClaimCondition = (stored: RunRecord | null) => boolean;

/** A claim that requires nothing of the Run: ownership is all it decides. */
export const ANY_STORED_RUN: ClaimCondition = () => true;

/**
 * What a Run's scope recorded, as the store gives it back: the ledger and
 * literals as they were, and the session's id when one was recorded.
 */
export interface StoredScope {
  readonly ledger: Readonly<Record<string, unknown>>;
  readonly literals?: RecordedScope["literals"];
  readonly session?: string;
}

type TerminalRunStatus = "complete" | "failed" | "cancelled";

/** Run statuses that are settled for good: nothing will run, resume, or need cancelling. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> =
  new Set<TerminalRunStatus>(["complete", "failed", "cancelled"]);

/**
 * The write that removes a Run and everything the workflow records hold of
 * it: its frames, its Suspensions, its Job and itself. Read through
 * `store`, which a caller hands the view of the transaction it commits in.
 */
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

/**
 * How a commit's Runs change what is kept beside them: for each Run put,
 * the scope recorded for it when there is one, as a plain copy, and
 * whether the commit settles it. Shared by every store, so they cannot
 * read a commit differently. A recording JSON would not give back as it
 * is (`storableJson`) throws a `NotStorableError` naming it, and the
 * commit is refused whole.
 */
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

/** The plain copy of what a Run's scope recorded that every store keeps. */
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

/**
 * The run store held in this process: nothing outlives it, so a parked Run
 * is never adopted by a later process. Each engine has its own.
 */
export class MemoryRunStore implements RunStore {
  readonly durable = false;
  readonly #gate = new RecordsGate("the run store is closed");
  readonly #owner = randomUUID();
  readonly #owners = new Map<string, string>();
  readonly #scopes = new Map<string, RecordedScope>();
  readonly #workflows = new MemoryWorkflowStore();

  claim(runId: string, when: ClaimCondition): Promise<boolean> {
    return this.#gate.run(() =>
      // In the workflow records' own transaction: nothing commits between.
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
      // A copy, as the database reads one, so a caller changing what it
      // is given changes nothing kept here.
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

  /**
   * `store`, handing `filed` what each commit files once it has landed: a
   * transaction's commits once the transaction has. Each of its calls is
   * made `through` what is given, a transaction's view's as they are.
   */
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
        // Taken as the commit is called, as the store takes its write.
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

/** What one commit files beside its Runs. */
interface Filed {
  readonly deleted: readonly string[];
  readonly runs: ReturnType<typeof filedRuns>;
}
