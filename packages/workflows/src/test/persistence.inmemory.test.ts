import { describe, expect, test } from "vitest";
import { createInMemoryPersistenceContractHarness } from "../in-memory-execution-persistence";
import type {
  ExecutionPersistence,
  ExecutionRepository,
  InMemoryExecutionPersistence,
} from "../persistence";
import { createInMemoryExecutionPersistence } from "../persistence";
import { orchestratorStoreFromPersistence } from "../persistence-compatibility";
import type {
  JobRunClaimOutcome,
  JobRunClaimTransaction,
  QueueRecord,
  RunFrame,
} from "../store";
import { InMemoryOrchestratorStore } from "../store";
import {
  ExecutionConflictRetriesExhaustedError,
  JobAlreadySettledError,
} from "../types";
import { executionPersistenceContract } from "./helpers/persistence.contract";
import { orchestratorStoreContract } from "./helpers/store.contract";

executionPersistenceContract("in-memory execution persistence", () =>
  createInMemoryPersistenceContractHarness()
);
orchestratorStoreContract("composed in-memory persistence", () =>
  orchestratorStoreFromPersistence(createInMemoryExecutionPersistence())
);

class DelayedQueueStore extends InMemoryOrchestratorStore {
  protected override async writeQueue(record: QueueRecord): Promise<void> {
    await Promise.resolve();
    return super.writeQueue(record);
  }
}

class FrameBoundaryStore extends InMemoryOrchestratorStore {
  readonly writtenFrames: RunFrame[] = [];
  invalidHydration = false;

  protected override writeFrame(frame: RunFrame): Promise<void> {
    this.writtenFrames.push(structuredClone(frame));
    return super.writeFrame(frame);
  }

  protected override async readFrames(runId: string): Promise<RunFrame[]> {
    if (this.invalidHydration) {
      return [{ at: 1, cursor: -1, payload: null, runId } as never];
    }
    return super.readFrames(runId);
  }
}

class JobCatchUpOutcomeStore extends InMemoryOrchestratorStore {
  catchUpOutcome: unknown;

  protected override withJobRunClaimTransaction(
    jobId: string,
    operation: (
      transaction: JobRunClaimTransaction
    ) => Promise<JobRunClaimOutcome>
  ): Promise<JobRunClaimOutcome> {
    return super.withJobRunClaimTransaction(jobId, async (transaction) => {
      const outcome = await operation(transaction);
      if (outcome.status === "settled") {
        this.catchUpOutcome = outcome;
      }
      return outcome;
    });
  }
}

describe("in-memory persistence seams", () => {
  test("Queue ensure returns the first persisted writer under overlap", async () => {
    const store = new DelayedQueueStore();
    const [first, second] = await Promise.all([
      store.ensureQueue({ id: "queue-race", name: "First" }),
      store.ensureQueue({ id: "queue-race", name: "Second" }),
    ]);

    expect(first.name).toBe("First");
    expect(second).toEqual(first);
    await expect(store.listQueues()).resolves.toEqual([first]);
  });

  test("uses the canonical frame decoder before writes and after hydration", async () => {
    const store = new FrameBoundaryStore();
    const run = await store.createRun({
      id: "rn-frame-boundary",
      input: null,
      queueId: "main",
      step: "publish",
    });

    await expect(
      store.appendRunFrame({
        payload: { kind: "output", value: undefined } as never,
        runId: run.id,
      })
    ).rejects.toThrow();
    expect(store.writtenFrames).toEqual([]);

    store.invalidHydration = true;
    await expect(store.listRunFrames(run.id)).rejects.toThrow();
  });

  test("commits Job catch-up as a typed outcome before the legacy error", async () => {
    const store = new JobCatchUpOutcomeStore();
    const job = await store.createJob({
      definition: { name: "documents.generate" },
      id: "jb-catch-up",
      input: null,
    });
    const claim = await store.claimJobRun(job.id, {
      id: "rn-catch-up",
      input: null,
      queueId: "main",
      step: "documents.generate",
    });
    await store.updateRun(claim.run.id, { status: "complete" });

    await expect(
      store.claimJobRun(job.id, {
        input: null,
        queueId: "main",
        step: "documents.generate",
      })
    ).rejects.toBeInstanceOf(JobAlreadySettledError);
    expect(store.catchUpOutcome).toMatchObject({
      job: { id: job.id, status: "complete" },
      status: "settled",
    });
    await expect(store.getJob(job.id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  test("retries one optimistic aggregate conflict and then succeeds", async () => {
    const injected = withJobClaimConflicts(
      createInMemoryExecutionPersistence(),
      1
    );
    const store = orchestratorStoreFromPersistence(injected.persistence);
    const job = await store.createJob({
      definition: { name: "documents.generate" },
      id: "jb-retry-once",
      input: null,
    });

    await expect(
      store.claimJobRun(job.id, {
        id: "rn-retry-once",
        input: null,
        queueId: "main",
        step: "documents.generate",
      })
    ).resolves.toMatchObject({ run: { id: "rn-retry-once" } });
    expect(injected.attempts()).toBe(2);
  });

  test("terminates an always-conflicting aggregate operation", async () => {
    const injected = withJobClaimConflicts(
      createInMemoryExecutionPersistence(),
      Number.POSITIVE_INFINITY
    );
    const store = orchestratorStoreFromPersistence(injected.persistence);
    const job = await store.createJob({
      definition: { name: "documents.generate" },
      id: "jb-retry-exhausted",
      input: null,
    });

    const claim = store.claimJobRun(job.id, {
      id: "rn-retry-exhausted",
      input: null,
      queueId: "main",
      step: "documents.generate",
    });
    await expect(claim).rejects.toBeInstanceOf(
      ExecutionConflictRetriesExhaustedError
    );
    await expect(claim).rejects.toMatchObject({
      attempts: 8,
      name: "ExecutionConflictRetriesExhaustedError",
      operation: "job.claim-run",
    });
    expect(injected.attempts()).toBe(8);
    expect((await store.listRuns({})).items).toEqual([]);
  });

  test("round-trips the composed in-memory persistence snapshot", async () => {
    const persistence = createInMemoryExecutionPersistence();
    const store = orchestratorStoreFromPersistence(persistence);
    await store.ensureQueue({ id: "snapshot-queue", name: "Snapshot" });
    const run = await store.createRun({
      id: "rn-snapshot-composed",
      input: { revision: 1 },
      queueId: "snapshot-queue",
      step: "publish",
    });
    await store.appendRunFrame({
      at: 2,
      payload: { kind: "output", value: { text: "retained" } },
      runId: run.id,
    });

    const restoredPersistence = createInMemoryExecutionPersistence({
      snapshot: persistence.snapshot(),
    });
    const restored = orchestratorStoreFromPersistence(restoredPersistence);
    await expect(restored.getRun(run.id)).resolves.toEqual(run);
    await expect(restored.listRunFrames(run.id)).resolves.toMatchObject([
      { cursor: 0, payload: { value: { text: "retained" } } },
    ]);
  });
});

function withJobClaimConflicts(
  persistence: InMemoryExecutionPersistence,
  conflictCount: number
): { persistence: ExecutionPersistence; attempts(): number } {
  let attempts = 0;
  const repository = new Proxy(persistence.repository, {
    get(target, property) {
      if (property === "commitJobRunClaim") {
        return async (
          input: Parameters<ExecutionRepository["commitJobRunClaim"]>[0]
        ) => {
          attempts += 1;
          if (attempts <= conflictCount) {
            return { status: "conflict" as const };
          }
          return target.commitJobRunClaim(input);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return value;
    },
  });
  return {
    attempts: () => attempts,
    persistence: { journal: persistence.journal, repository },
  };
}
