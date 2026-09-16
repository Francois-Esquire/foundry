import { describe, expect, test } from "vitest";

import type {
  RunFrame,
  RunRecord,
  SuspensionCancellation,
  SuspensionCancellationTransaction,
  SuspensionParking,
  SuspensionParkingTransaction,
  SuspensionRecord,
  SuspensionSettlement,
  SuspensionSettlementTransaction,
} from "../store";

import { InMemoryOrchestratorStore } from "../store";
import {
  RecordAlreadyExistsError,
  RecordInUseError,
  SuspensionAlreadySettledError,
} from "../types";
import { makeInMemoryStore } from "./helpers/store";
import { orchestratorStoreContract } from "./helpers/store.contract";

orchestratorStoreContract("in-memory", makeInMemoryStore);

class FailingSettlementStore extends InMemoryOrchestratorStore {
  failSettlement = false;

  protected override writeSuspensionSettlement(input: {
    previousSuspension: SuspensionRecord;
    nextSuspension: SuspensionRecord;
    previousRun: RunRecord;
    nextRun: RunRecord;
  }): Promise<void> {
    if (this.failSettlement) {
      return Promise.reject(new Error("injected settlement failure"));
    }
    return super.writeSuspensionSettlement(input);
  }
}

class LegacyRunProjectionStore extends InMemoryOrchestratorStore {
  protected override writeRun(record: RunRecord): Promise<void> {
    const { definition: _definition, links: _links, ...legacy } = record;
    return super.writeRun(legacy);
  }
}

class FrameHookStore extends InMemoryOrchestratorStore {
  readonly writtenFrames: RunFrame[] = [];

  protected override writeFrame(frame: RunFrame): Promise<void> {
    this.writtenFrames.push(structuredClone(frame));
    return super.writeFrame(frame);
  }
}

class SuspensionTransactionHookStore extends InMemoryOrchestratorStore {
  parkingTransactions = 0;
  settlementTransactions = 0;
  cancellationTransactions = 0;

  protected override withSuspensionParkingTransaction(
    runId: string,
    address: string,
    operation: (
      transaction: SuspensionParkingTransaction
    ) => Promise<SuspensionParking>
  ): Promise<SuspensionParking> {
    this.parkingTransactions += 1;
    return super.withSuspensionParkingTransaction(runId, address, operation);
  }

  protected override withSuspensionSettlementTransaction(
    id: string,
    operation: (
      transaction: SuspensionSettlementTransaction
    ) => Promise<SuspensionSettlement>
  ): Promise<SuspensionSettlement> {
    this.settlementTransactions += 1;
    return super.withSuspensionSettlementTransaction(id, operation);
  }

  protected override withSuspensionCancellationTransaction(
    runId: string,
    operation: (
      transaction: SuspensionCancellationTransaction
    ) => Promise<SuspensionCancellation>
  ): Promise<SuspensionCancellation> {
    this.cancellationTransactions += 1;
    return super.withSuspensionCancellationTransaction(runId, operation);
  }
}

describe("InMemoryOrchestratorStore", () => {
  test("routes Suspension mutations through transaction-wide adapter hooks", async () => {
    const store = new SuspensionTransactionHookStore();
    const firstRun = await store.createRun({
      input: null,
      queueId: "main",
      step: "publish",
    });
    const first = await store.parkSuspension({
      kind: "approval",
      name: "approval",
      reason: "review",
      request: null,
      runId: firstRun.id,
      stepPath: ["publish"],
    });
    await store.settleSuspension(first.suspension.id, {
      expectedRevision: 0,
      outcome: { resolution: true, status: "resolved" },
    });

    const secondRun = await store.createRun({
      input: null,
      queueId: "main",
      step: "publish",
    });
    await store.parkSuspension({
      kind: "approval",
      name: "approval",
      reason: "review",
      request: null,
      runId: secondRun.id,
      stepPath: ["publish"],
    });
    await store.cancelRunSuspensions(secondRun.id);

    expect(store.parkingTransactions).toBe(2);
    expect(store.settlementTransactions).toBe(1);
    expect(store.cancellationTransactions).toBe(1);
  });

  test("settles a Suspension only once under concurrent resolution", async () => {
    const store = makeInMemoryStore();
    const run = await store.createRun({
      input: null,
      queueId: "main",
      step: "publish",
    });
    await store.updateRun(run.id, { status: "suspended" });
    const suspension = await store.createSuspension({
      kind: "approval",
      name: "approval",
      reason: "approval required",
      request: null,
      runId: run.id,
      stepPath: ["publish"],
    });

    const results = await Promise.allSettled([
      store.settleSuspension(suspension.id, {
        expectedRevision: 0,
        outcome: { resolution: { winner: "first" }, status: "resolved" },
      }),
      store.settleSuspension(suspension.id, {
        expectedRevision: 0,
        outcome: { resolution: { winner: "second" }, status: "resolved" },
      }),
    ]);

    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(
      results[1].status === "rejected" ? results[1].reason : null
    ).toBeInstanceOf(SuspensionAlreadySettledError);
    await expect(store.getSuspension(suspension.id)).resolves.toMatchObject({
      resolution: { winner: "first" },
      revision: 1,
    });
  });

  test("rejects duplicate Run IDs without overwriting the first record", async () => {
    const store = makeInMemoryStore();
    const first = await store.createRun({
      id: "rn-same",
      input: null,
      queueId: "main",
      step: "first",
    });

    await expect(
      store.createRun({
        id: first.id,
        input: null,
        queueId: "main",
        step: "second",
      })
    ).rejects.toBeInstanceOf(RecordAlreadyExistsError);
    await expect(store.getRun(first.id)).resolves.toMatchObject({
      step: "first",
    });
  });

  test("restores Run definition and links from reserved persisted metadata", async () => {
    const store = new LegacyRunProjectionStore();
    const run = await store.createRun({
      definition: { name: "publish", version: "1" },
      input: null,
      links: { sessionId: "session-1", subjectId: "subject-1" },
      queueId: "main",
      step: "publish",
    });

    await expect(store.getRun(run.id)).resolves.toMatchObject({
      definition: { name: "publish", version: "1" },
      links: { sessionId: "session-1", subjectId: "subject-1" },
    });
    await store.updateRun(run.id, {
      metadata: { workflow: { status: "running" } },
    });
    expect(
      (await store.listRuns({ links: { sessionId: "session-1" } })).items
    ).toHaveLength(1);
  });

  test("assigns frame cursors before calling the adapter write hook", async () => {
    const store = new FrameHookStore();
    const run = await store.createRun({
      input: null,
      queueId: "main",
      step: "publish",
    });
    await Promise.all([
      store.appendRunFrame({
        payload: { kind: "output", value: "first" },
        runId: run.id,
      }),
      store.appendRunFrame({
        payload: { kind: "output", value: "second" },
        runId: run.id,
      }),
    ]);

    expect(store.writtenFrames.map((frame) => frame.cursor)).toEqual([0, 1]);
  });

  test("prevents deletes that would leave dangling execution records", async () => {
    const store = makeInMemoryStore();
    const job = await store.createJob({
      definition: { name: "publish" },
      input: null,
    });
    const claim = await store.claimJobRun(job.id, {
      input: null,
      queueId: "main",
      step: "publish",
    });
    const run = claim.run;
    const suspension = await store.createSuspension({
      kind: "approval",
      name: "approval",
      reason: "approval required",
      request: null,
      runId: run.id,
      stepPath: ["publish"],
    });
    await store.appendRunFrame({
      payload: { kind: "suspension", value: suspension },
      runId: run.id,
    });

    await expect(store.deleteJob(job.id)).rejects.toBeInstanceOf(
      RecordInUseError
    );
    await expect(store.deleteRun(run.id)).rejects.toBeInstanceOf(
      RecordInUseError
    );
    await expect(store.deleteSuspension(suspension.id)).rejects.toBeInstanceOf(
      RecordInUseError
    );

    await store.deleteRunFrames(run.id);
    await store.deleteSuspension(suspension.id);
    await store.deleteRun(run.id);
    await store.deleteJob(job.id);
  });

  test("does not partially apply a failed Suspension settlement", async () => {
    const store = new FailingSettlementStore();
    const run = await store.createRun({
      input: null,
      queueId: "main",
      step: "publish",
    });
    await store.updateRun(run.id, { status: "suspended" });
    const suspension = await store.createSuspension({
      kind: "approval",
      name: "approval",
      reason: "approval required",
      request: { changeId: "change-1" },
      runId: run.id,
      stepPath: ["publish"],
    });
    store.failSettlement = true;

    await expect(
      store.settleSuspension(suspension.id, {
        expectedRevision: 0,
        outcome: { resolution: { allowed: true }, status: "resolved" },
        runPatch: { metadata: { resumed: true } },
      })
    ).rejects.toThrow("injected settlement failure");
    await expect(store.getSuspension(suspension.id)).resolves.toEqual(
      suspension
    );
    await expect(store.getRun(run.id)).resolves.toMatchObject({
      metadata: {},
      status: "suspended",
    });
  });

  test("creates and reads fully-formed runs", async () => {
    const store = makeInMemoryStore();
    const created = await store.createRun({
      input: { id: 1 },
      queueId: "queue-1",
      step: "publish",
    });

    expect(created.id).toMatch(/^rn-/);
    expect(created).toMatchObject({
      error: null,
      extensions: {},
      output: null,
      queueId: "queue-1",
      status: "queued",
      step: "publish",
      tags: {},
      timestamps: { completedAt: null, failedAt: null, startedAt: null },
    });
    expect(created.timestamps.createdAt).toEqual(expect.any(Number));
    await expect(store.getRun(created.id)).resolves.toEqual(created);
  });

  test("patches runs without replacing tags, timestamps, or extension keys", async () => {
    const store = makeInMemoryStore();
    const run = await store.createRun({
      extensions: {
        "engine.workspace": "alpha",
        "foundry.task": { labels: ["urgent", null], retry: false },
      },
      id: "run-1",
      input: null,
      queueId: "queue-1",
      step: "publish",
      tags: { surface: "ui" },
    });

    const updated = await store.updateRun(run.id, {
      extensions: {
        "foundry.task": { retry: true },
        "host.trace": true,
      },
      status: "running",
      tags: { env: "docker" },
      timestamps: { startedAt: 42 },
    });
    expect(updated).toMatchObject({
      ...run,
      extensions: {
        "engine.workspace": "alpha",
        "foundry.task": { retry: true },
        "host.trace": true,
      },
      status: "running",
      tags: { env: "docker", surface: "ui" },
      timestamps: { ...run.timestamps, startedAt: 42 },
    });
    await expect(
      store.updateRun("unknown", { status: "failed" })
    ).resolves.toBe(null);
  });

  test("filters runs by queue, status, and tag superset", async () => {
    const store = makeInMemoryStore();
    const ui = await store.createRun({
      id: "ui",
      input: null,
      queueId: "queue-1",
      step: "publish",
      tags: { env: "docker", surface: "ui" },
    });
    const api = await store.createRun({
      id: "api",
      input: null,
      queueId: "queue-1",
      step: "publish",
      tags: { surface: "ui" },
    });
    await store.createRun({
      id: "other",
      input: null,
      queueId: "queue-2",
      step: "publish",
    });
    const runningApi = await store.updateRun(api.id, { status: "running" });
    if (!runningApi) {
      throw new Error("expected API Run to exist");
    }
    const oldestUiRuns = [ui, runningApi].sort((left, right) => {
      const byCreatedAt =
        left.timestamps.createdAt - right.timestamps.createdAt;
      return byCreatedAt || left.id.localeCompare(right.id);
    });

    expect((await store.listRuns({ queueId: "queue-2" })).items).toHaveLength(
      1
    );
    expect((await store.listRuns({ status: "running" })).items).toEqual([
      runningApi,
    ]);
    expect(
      (
        await store.listRuns({
          order: "oldest",
          status: ["queued", "running"],
          tags: { surface: "ui" },
        })
      ).items
    ).toEqual(oldestUiRuns);
    expect(
      (await store.listRuns({ tags: { env: "docker", surface: "ui" } })).items
    ).toEqual([ui]);
  });

  test("deletes runs", async () => {
    const store = makeInMemoryStore();
    await store.createRun({
      id: "run-1",
      input: null,
      queueId: "queue-1",
      step: "publish",
    });

    await store.deleteRun("run-1");
    await expect(store.getRun("run-1")).resolves.toBeNull();
  });

  test("creates and patches queues idempotently", async () => {
    const store = makeInMemoryStore();
    const created = await store.ensureQueue({
      extensions: {
        "engine.workspace": "alpha",
        "foundry.task": { enabled: true, priorities: [1, 2] },
      },
      id: "queue-1",
      name: "First",
    });
    const duplicate = await store.ensureQueue({
      id: "queue-1",
      name: "Ignored",
    });

    expect(duplicate).toEqual(created);
    expect(created.lastError).toBeNull();
    await expect(store.listQueues()).resolves.toEqual([created]);
    await expect(
      store.updateQueue(created.id, {
        extensions: {
          "foundry.task": { enabled: false },
          "host.trace": null,
        },
        lastError: { message: "driver failed", name: "QueueError" },
        status: "stopped",
      })
    ).resolves.toEqual({
      ...created,
      extensions: {
        "engine.workspace": "alpha",
        "foundry.task": { enabled: false },
        "host.trace": null,
      },
      lastError: { message: "driver failed", name: "QueueError" },
      status: "stopped",
    });
    await expect(
      store.updateQueue("unknown", { status: "paused" })
    ).resolves.toBeNull();

    await expect(
      store.ensureQueue({ id: "queue-2", name: "Default" })
    ).resolves.toMatchObject({ extensions: {} });
  });

  test("rejects invalid or reserved extensions at the store boundary", async () => {
    const store = makeInMemoryStore();

    await expect(
      store.createRun({
        extensions: { "workflows.internal": true },
        input: null,
        queueId: "queue-1",
        step: "publish",
      })
    ).rejects.toThrow(/reserved/);
    await expect(
      store.ensureQueue({
        extensions: { "host.trace": Number.NaN },
        id: "queue-1",
        name: "First",
      })
    ).rejects.toThrow(/JSON-safe/);
  });

  test("does not expose mutable extension references", async () => {
    const store = makeInMemoryStore();
    const run = await store.createRun({
      extensions: { "host.trace": { ids: ["original"] } },
      id: "run-1",
      input: null,
      queueId: "queue-1",
      step: "publish",
    });
    const read = await store.getRun(run.id);
    if (!read) {
      throw new Error("expected run");
    }
    (read.extensions["host.trace"] as { ids: string[] }).ids.push("mutated");

    await expect(store.getRun(run.id)).resolves.toMatchObject({
      extensions: { "host.trace": { ids: ["original"] } },
    });
  });

  test("keeps current extensions when a workflow snapshot update lands", async () => {
    const store = makeInMemoryStore();
    const run = await store.createRun({
      extensions: { "host.trace": { revision: 1 } },
      id: "run-1",
      input: null,
      queueId: "queue-1",
      step: "publish",
    });
    await store.updateRun(run.id, {
      extensions: { "host.trace": { revision: 2 } },
    });
    await store.updateRun(run.id, {
      metadata: { workflow: { status: "suspended" } },
      status: "suspended",
    });

    await expect(store.getRun(run.id)).resolves.toMatchObject({
      extensions: { "host.trace": { revision: 2 } },
      metadata: { workflow: { status: "suspended" } },
    });
  });

  test("projects non-terminal runs for recovery", async () => {
    const store = makeInMemoryStore();
    const queued = await store.createRun({
      id: "queued",
      input: { value: 1 },
      queueId: "queue-1",
      step: "publish",
    });
    const complete = await store.createRun({
      id: "complete",
      input: null,
      queueId: "queue-1",
      step: "publish",
    });
    await store.updateRun(complete.id, { status: "complete" });
    await store.createRun({
      id: "other-queue",
      input: null,
      queueId: "queue-2",
      step: "publish",
    });

    await expect(store.findRecoverableRuns("queue-1")).resolves.toEqual([
      {
        extensions: {},
        id: queued.id,
        input: queued.input,
        lastStatus: queued.status,
        metadata: {},
        step: queued.step,
      },
    ]);
  });
});
