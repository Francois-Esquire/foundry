import { describe, expect, test } from "vitest";
import {
  InconsistentStoreSnapshotError,
  InvalidStoreSnapshotError,
  UnsupportedStoreSnapshotVersionError,
} from "../errors";
import type { OrchestratorStoreSnapshot } from "../store";
import {
  InMemoryOrchestratorStore,
  ORCHESTRATOR_STORE_SNAPSHOT_VERSION,
} from "../store";

async function makeMixedStore(): Promise<InMemoryOrchestratorStore> {
  const store = new InMemoryOrchestratorStore();
  const queue = await store.ensureQueue({
    extensions: { "host.queue": { region: "local", revision: 1 } },
    id: "qu-snapshot",
    name: "snapshot",
  });
  const job = await store.createJob({
    definition: { name: "documents.generate", version: "1" },
    id: "jb-snapshot",
    input: { parts: ["one", "two"], prompt: "draft" },
    links: {
      sessionId: "session-1",
      subjectId: "document-1",
      taskId: "task-1",
    },
  });
  const managed = await store.claimJobRun(job.id, {
    definition: { name: "documents.generate", version: "1" },
    extensions: { "host.run": { attempt: 1 } },
    id: "rn-managed",
    input: { prompt: "draft" },
    links: { sessionId: "session-1", subjectId: "document-1" },
    queueId: queue.id,
    step: "documents.generate",
  });
  await store.updateRun(managed.run.id, {
    metadata: { retained: { terminal: true } },
    output: { blocks: [1, 2], documentId: "document-1" },
    status: "complete",
    timestamps: { completedAt: 20 },
  });
  await store.updateJob(job.id, {
    status: "complete",
    timestamps: { completedAt: 20 },
  });

  const suspended = await store.createRun({
    extensions: { "host.run": { attention: true } },
    id: "rn-suspended",
    input: { documentId: "document-2" },
    links: { sessionId: "session-2", subjectId: "document-2" },
    queueId: queue.id,
    step: "approval",
  });
  await store.updateRun(suspended.id, { status: "suspended" });
  const pending = await store.createSuspension({
    id: "su-pending",
    kind: "approval",
    name: "review",
    reason: "review required",
    request: { documentId: "document-2", reviewers: ["mike"] },
    runId: suspended.id,
    stepPath: ["approval"],
  });

  const resolvedRun = await store.createRun({
    id: "rn-resolved",
    input: null,
    links: { parentRunId: suspended.id },
    queueId: queue.id,
    step: "permission",
  });
  await store.updateRun(resolvedRun.id, { status: "suspended" });
  const resolved = await store.createSuspension({
    id: "su-resolved",
    kind: "permission",
    name: "allow",
    reason: "permission required",
    request: { capability: "write" },
    runId: resolvedRun.id,
    stepPath: ["permission"],
  });
  const resolution = await store.settleSuspension(resolved.id, {
    expectedRevision: 0,
    outcome: { resolution: { decision: "allow" }, status: "resolved" },
  });

  const cancelledRun = await store.createRun({
    id: "rn-cancelled",
    input: null,
    queueId: queue.id,
    step: "cancelled",
  });
  await store.updateRun(cancelledRun.id, { status: "suspended" });
  await store.createSuspension({
    id: "su-cancelled",
    kind: "input",
    name: "input",
    reason: "input required",
    request: null,
    runId: cancelledRun.id,
    stepPath: ["cancelled"],
  });
  await store.cancelRun(cancelledRun.id);

  await store.appendRunFrame({
    at: 10,
    payload: { kind: "output", value: { delta: "done" } },
    runId: managed.run.id,
  });
  await store.appendRunFrame({
    at: 20,
    payload: {
      kind: "lifecycle",
      value: { event: "complete", status: "complete" },
    },
    runId: managed.run.id,
  });
  await store.appendRunFrame({
    at: 30,
    payload: { kind: "suspension", value: pending },
    runId: suspended.id,
  });
  await store.appendRunFrame({
    at: 40,
    payload: { kind: "suspension", value: resolution.suspension },
    runId: resolvedRun.id,
  });
  return store;
}

function jsonRoundTrip(
  snapshot: OrchestratorStoreSnapshot
): OrchestratorStoreSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as OrchestratorStoreSnapshot;
}

function mutableSnapshot(snapshot: OrchestratorStoreSnapshot) {
  return structuredClone(snapshot) as unknown as {
    version: number;
    queues: Record<string, unknown>[];
    jobs: Record<string, unknown>[];
    runs: Record<string, unknown>[];
    suspensions: Record<string, unknown>[];
    frames: Record<string, unknown>[];
  };
}

describe("InMemoryOrchestratorStore snapshots", () => {
  test("round-trips mixed JSON state through public queries", async () => {
    const original = await makeMixedStore();
    const captured = original.snapshot();
    expect(captured.version).toBe(ORCHESTRATOR_STORE_SNAPSHOT_VERSION);
    expect(() => JSON.stringify(captured)).not.toThrow();

    const restored = new InMemoryOrchestratorStore({
      snapshot: jsonRoundTrip(captured),
    });
    expect(await restored.listQueues()).toEqual(await original.listQueues());
    expect(await restored.listJobs()).toEqual(await original.listJobs());
    expect(await restored.listRuns({})).toEqual(await original.listRuns({}));
    expect(await restored.listSuspensions()).toEqual(
      await original.listSuspensions()
    );
    for (const run of (await original.listRuns({ limit: 200 })).items) {
      expect(await restored.listRunFrames(run.id)).toEqual(
        await original.listRunFrames(run.id)
      );
    }
    expect(restored.snapshot()).toEqual(captured);
  });

  test("deep-clones constructor input and every captured snapshot", async () => {
    const original = await makeMixedStore();
    const input = mutableSnapshot(jsonRoundTrip(original.snapshot()));
    const restored = new InMemoryOrchestratorStore({ snapshot: input });
    const baseline = restored.snapshot();

    const inputQueue = input.queues[0] as {
      extensions: { "host.queue": { region: string } };
    };
    inputQueue.extensions["host.queue"].region = "mutated-input";
    const inputJob = input.jobs[0] as { input: { prompt: string } };
    inputJob.input.prompt = "mutated-input";
    const inputRun = input.runs[0] as {
      output: { documentId: string };
      metadata: { retained: { terminal: boolean } };
    };
    inputRun.output.documentId = "mutated-input";
    inputRun.metadata.retained.terminal = false;
    const inputSuspension = input.suspensions[0] as {
      request: { documentId: string };
    };
    inputSuspension.request.documentId = "mutated-input";
    const inputFrame = input.frames[0] as {
      payload: { value: { delta: string } };
    };
    inputFrame.payload.value.delta = "mutated-input";
    expect(restored.snapshot()).toEqual(baseline);

    const output = mutableSnapshot(restored.snapshot());
    output.queues.length = 0;
    output.jobs.length = 0;
    output.runs.length = 0;
    output.suspensions.length = 0;
    output.frames.length = 0;
    expect(restored.snapshot()).toEqual(baseline);
  });

  test("rejects unsupported and malformed versions or records", async () => {
    const valid = (await makeMixedStore()).snapshot();
    expect(
      () =>
        new InMemoryOrchestratorStore({
          snapshot: { ...valid, version: 2 },
        })
    ).toThrow(UnsupportedStoreSnapshotVersionError);
    expect(
      () => new InMemoryOrchestratorStore({ snapshot: { version: 1 } })
    ).toThrow(InvalidStoreSnapshotError);
    for (const version of ["2", Number.NaN, 2n, {}, null]) {
      expect(
        () =>
          new InMemoryOrchestratorStore({
            snapshot: { ...valid, version },
          })
      ).toThrow(InvalidStoreSnapshotError);
    }

    const malformedJob = mutableSnapshot(valid);
    malformedJob.jobs[0] = { ...malformedJob.jobs[0], id: "not-a-job" };
    expect(
      () => new InMemoryOrchestratorStore({ snapshot: malformedJob })
    ).toThrow(InvalidStoreSnapshotError);

    const nonJsonRun = mutableSnapshot(valid);
    nonJsonRun.runs[0] = { ...nonJsonRun.runs[0], output: undefined };
    expect(
      () => new InMemoryOrchestratorStore({ snapshot: nonJsonRun })
    ).toThrow(InvalidStoreSnapshotError);
  });

  test.each(["queues", "jobs", "runs", "suspensions"] as const)(
    "rejects duplicate identities in %s",
    async (section) => {
      const corrupt = mutableSnapshot((await makeMixedStore()).snapshot());
      corrupt[section].push(structuredClone(corrupt[section][0] ?? {}));
      expect(
        () => new InMemoryOrchestratorStore({ snapshot: corrupt })
      ).toThrow(InconsistentStoreSnapshotError);
    }
  );

  test("rejects dangling Queue, Job, parent Run, and Suspension references", async () => {
    const valid = (await makeMixedStore()).snapshot();

    const missingQueue = mutableSnapshot(valid);
    missingQueue.runs[0] = {
      ...missingQueue.runs[0],
      queueId: "qu-missing",
    };
    expect(
      () => new InMemoryOrchestratorStore({ snapshot: missingQueue })
    ).toThrow(InconsistentStoreSnapshotError);

    const missingJob = mutableSnapshot(valid);
    const managedIndex = missingJob.runs.findIndex(
      (run) =>
        (run.links as { jobId?: string } | undefined)?.jobId !== undefined
    );
    missingJob.runs[managedIndex] = {
      ...missingJob.runs[managedIndex],
      links: { jobId: "jb-missing" },
    };
    expect(
      () => new InMemoryOrchestratorStore({ snapshot: missingJob })
    ).toThrow(InconsistentStoreSnapshotError);

    const conflictingJobContext = mutableSnapshot(valid);
    conflictingJobContext.runs[managedIndex] = {
      ...conflictingJobContext.runs[managedIndex],
      links: { jobId: "jb-snapshot", sessionId: "session-conflict" },
    };
    expect(
      () => new InMemoryOrchestratorStore({ snapshot: conflictingJobContext })
    ).toThrow(InconsistentStoreSnapshotError);

    const missingParentRun = mutableSnapshot(valid);
    const childIndex = missingParentRun.runs.findIndex(
      (run) =>
        (run.links as { parentRunId?: string } | undefined)?.parentRunId !==
        undefined
    );
    missingParentRun.runs[childIndex] = {
      ...missingParentRun.runs[childIndex],
      links: { parentRunId: "rn-missing" },
    };
    expect(
      () => new InMemoryOrchestratorStore({ snapshot: missingParentRun })
    ).toThrow(InconsistentStoreSnapshotError);

    const missingRun = mutableSnapshot(valid);
    missingRun.suspensions[0] = {
      ...missingRun.suspensions[0],
      runId: "rn-missing",
    };
    expect(
      () => new InMemoryOrchestratorStore({ snapshot: missingRun })
    ).toThrow(InconsistentStoreSnapshotError);
  });

  test("rejects contradictory Job, Run, and pending Suspension lifecycles", async () => {
    const valid = (await makeMixedStore()).snapshot();

    const terminalJobWithActiveRun = mutableSnapshot(valid);
    const managedIndex = terminalJobWithActiveRun.runs.findIndex(
      (run) =>
        (run.links as { jobId?: string } | undefined)?.jobId === "jb-snapshot"
    );
    terminalJobWithActiveRun.jobs[0] = {
      ...terminalJobWithActiveRun.jobs[0],
      status: "cancelled",
    };
    terminalJobWithActiveRun.runs[managedIndex] = {
      ...terminalJobWithActiveRun.runs[managedIndex],
      status: "queued",
    };
    terminalJobWithActiveRun.frames = terminalJobWithActiveRun.frames.filter(
      (frame) => frame.runId !== "rn-managed"
    );
    expect(
      () =>
        new InMemoryOrchestratorStore({ snapshot: terminalJobWithActiveRun })
    ).toThrow(InconsistentStoreSnapshotError);

    const pendingOnQueuedRun = mutableSnapshot(valid);
    const pending = pendingOnQueuedRun.suspensions.find(
      (suspension) => suspension.status === "pending"
    );
    const pendingRunIndex = pendingOnQueuedRun.runs.findIndex(
      (run) => run.id === pending?.runId
    );
    pendingOnQueuedRun.runs[pendingRunIndex] = {
      ...pendingOnQueuedRun.runs[pendingRunIndex],
      status: "queued",
    };
    expect(
      () => new InMemoryOrchestratorStore({ snapshot: pendingOnQueuedRun })
    ).toThrow(InconsistentStoreSnapshotError);
  });

  test("rejects invalid frame ownership and per-Run cursor disorder", async () => {
    const valid = (await makeMixedStore()).snapshot();

    const missingRun = mutableSnapshot(valid);
    missingRun.frames[0] = {
      ...missingRun.frames[0],
      runId: "rn-missing",
    };
    expect(
      () => new InMemoryOrchestratorStore({ snapshot: missingRun })
    ).toThrow(InconsistentStoreSnapshotError);

    const mismatchedSuspension = mutableSnapshot(valid);
    const suspensionFrameIndex = mismatchedSuspension.frames.findIndex(
      (frame) =>
        (frame.payload as { kind?: string } | undefined)?.kind === "suspension"
    );
    const suspensionFrame = mismatchedSuspension.frames[
      suspensionFrameIndex
    ] as { payload: { value: Record<string, unknown> } };
    suspensionFrame.payload.value = {
      ...suspensionFrame.payload.value,
      runId: "rn-managed",
    };
    expect(
      () => new InMemoryOrchestratorStore({ snapshot: mismatchedSuspension })
    ).toThrow(InvalidStoreSnapshotError);

    const disorder = mutableSnapshot(valid);
    const managedFrames = disorder.frames.filter(
      (frame) => frame.runId === "rn-managed"
    );
    managedFrames[1] = { ...managedFrames[1], cursor: 3 };
    const secondManagedIndex = disorder.frames.findIndex(
      (frame) => frame.runId === "rn-managed" && frame.cursor === 1
    );
    disorder.frames[secondManagedIndex] = managedFrames[1];
    expect(() => new InMemoryOrchestratorStore({ snapshot: disorder })).toThrow(
      InconsistentStoreSnapshotError
    );
  });

  test("rejects duplicate or lifecycle-contradictory terminal frames", async () => {
    const valid = (await makeMixedStore()).snapshot();

    const duplicateTerminal = mutableSnapshot(valid);
    duplicateTerminal.frames.push({
      at: 30,
      cursor: 2,
      payload: {
        kind: "lifecycle",
        value: { event: "complete", status: "complete" },
      },
      runId: "rn-managed",
    });
    expect(
      () => new InMemoryOrchestratorStore({ snapshot: duplicateTerminal })
    ).toThrow(InconsistentStoreSnapshotError);

    const afterTerminal = mutableSnapshot(valid);
    afterTerminal.frames.push({
      at: 31,
      cursor: 2,
      payload: { kind: "progress", value: 1 },
      runId: "rn-managed",
    });
    expect(
      () => new InMemoryOrchestratorStore({ snapshot: afterTerminal })
    ).toThrow(InconsistentStoreSnapshotError);

    const terminalOnActive = mutableSnapshot(valid);
    terminalOnActive.frames.push({
      at: 40,
      cursor: 1,
      payload: {
        kind: "lifecycle",
        value: { event: "complete", status: "complete" },
      },
      runId: "rn-suspended",
    });
    expect(
      () => new InMemoryOrchestratorStore({ snapshot: terminalOnActive })
    ).toThrow(InconsistentStoreSnapshotError);

    const mismatchedTerminal = mutableSnapshot(valid);
    const terminalIndex = mismatchedTerminal.frames.findIndex(
      (frame) =>
        frame.runId === "rn-managed" &&
        (frame.payload as { kind?: string } | undefined)?.kind === "lifecycle"
    );
    mismatchedTerminal.frames[terminalIndex] = {
      ...mismatchedTerminal.frames[terminalIndex],
      payload: {
        kind: "lifecycle",
        value: { event: "failed", status: "failed" },
      },
    };
    expect(
      () => new InMemoryOrchestratorStore({ snapshot: mismatchedTerminal })
    ).toThrow(InconsistentStoreSnapshotError);
  });

  test("constructor rejection leaves no partially seeded target", async () => {
    const valid = (await makeMixedStore()).snapshot();
    const corrupt = mutableSnapshot(valid);
    corrupt.runs.push(structuredClone(corrupt.runs[0] ?? {}));

    expect(() => new InMemoryOrchestratorStore({ snapshot: corrupt })).toThrow(
      InconsistentStoreSnapshotError
    );
    const seededAfterRejection = new InMemoryOrchestratorStore({
      snapshot: valid,
    });
    expect(seededAfterRejection.snapshot()).toEqual(valid);
  });
});
