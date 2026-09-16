import { expect, test } from "vitest";

import type {
  JobRecord,
  RunFramePayload,
  RunRecord,
} from "../../execution-records";
import type { ExecutionPersistence } from "../../persistence";

export interface PersistenceContractHarness {
  readonly persistence: ExecutionPersistence;
  replaceRunFrames(runId: string, values: readonly unknown[]): Promise<void>;
}

export type PersistenceFactory = () =>
  | PersistenceContractHarness
  | Promise<PersistenceContractHarness>;

/** Shared behavioral proof for repository and journal adapters. */
export function executionPersistenceContract(
  name: string,
  makeHarness: PersistenceFactory
): void {
  test(`${name} repository atomically keeps the first Queue`, async () => {
    const { repository } = (await makeHarness()).persistence;
    const firstCandidate = queue("First");
    const secondCandidate = queue("Second");
    const [first, second] = await Promise.all([
      repository.ensureQueueRecord(firstCandidate),
      repository.ensureQueueRecord(secondCandidate),
    ]);

    expect(second).toEqual(first);
    await expect(repository.listQueueRecords()).resolves.toEqual([first]);
  });

  test(`${name} repository commits Job catch-up as typed data`, async () => {
    const { repository } = (await makeHarness()).persistence;
    const previousJob = job();
    const completedRun = run({ jobId: previousJob.id, status: "complete" });
    const nextJob: JobRecord = {
      ...previousJob,
      status: "complete",
      timestamps: { ...previousJob.timestamps, completedAt: 2 },
    };
    await repository.ensureQueueRecord(queue("Contract"));
    await repository.putJob(previousJob);
    await repository.putRun(completedRun);

    await expect(
      repository.commitJobRunClaim({
        expectedJob: previousJob,
        expectedRuns: [completedRun],
        nextJob,
        status: "settled",
      })
    ).resolves.toEqual({ job: nextJob, status: "settled" });
    await expect(repository.getJob(previousJob.id)).resolves.toEqual(nextJob);
  });

  test(`${name} repository commits one managed Job attempt atomically`, async () => {
    const { repository } = (await makeHarness()).persistence;
    const previousJob = job();
    const firstRun = run({ id: "rn-first", jobId: previousJob.id });
    const secondRun = run({ id: "rn-second", jobId: previousJob.id });
    await repository.ensureQueueRecord(queue("Contract"));
    await repository.putJob(previousJob);

    const outcomes = await Promise.all([
      repository.commitJobRunClaim({
        expectedJob: previousJob,
        expectedRuns: [],
        nextJob: previousJob,
        run: firstRun,
        status: "claimed",
      }),
      repository.commitJobRunClaim({
        expectedJob: previousJob,
        expectedRuns: [],
        nextJob: previousJob,
        run: secondRun,
        status: "claimed",
      }),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "claimed",
      "conflict",
    ]);
    expect((await repository.listRunRecords()).items).toHaveLength(1);
  });

  test(`${name} stale Job cancellation conflicts with a concurrent claim`, async () => {
    const { repository } = (await makeHarness()).persistence;
    const previousJob = job();
    const claimedRun = run({ id: "rn-concurrent", jobId: previousJob.id });
    const cancelledJob: JobRecord = {
      ...previousJob,
      status: "cancelled",
      timestamps: { ...previousJob.timestamps, cancelledAt: 2 },
    };
    await repository.ensureQueueRecord(queue("Contract"));
    await repository.putJob(previousJob);
    await expect(
      repository.commitJobRunClaim({
        expectedJob: previousJob,
        expectedRuns: [],
        nextJob: previousJob,
        run: claimedRun,
        status: "claimed",
      })
    ).resolves.toMatchObject({ status: "claimed" });

    await expect(
      repository.commitJobCancellation({
        expectedRuns: [],
        nextJob: cancelledJob,
        nextRun: null,
        nextSuspensions: [],
        previousJob,
        previousRun: null,
        previousSuspensions: [],
      })
    ).resolves.toEqual({ status: "conflict" });
    await expect(repository.getJob(previousJob.id)).resolves.toEqual(
      previousJob
    );
    await expect(repository.getRun(claimedRun.id)).resolves.toEqual(claimedRun);
  });

  test(`${name} journal validates writes, hydration, ordering, and terminal uniqueness`, async () => {
    const harness = await makeHarness();
    const { repository, journal } = harness.persistence;
    const record = run();
    await repository.ensureQueueRecord(queue("Contract"));
    await repository.putRun(record);
    await expect(
      journal.appendRunFrame({
        payload: { kind: "output", value: undefined } as never,
        runId: record.id,
      })
    ).rejects.toThrow();

    const output = await journal.appendRunFrame({
      at: 1,
      payload: { kind: "output", value: { text: "ready" } },
      runId: record.id,
    });
    const [firstTerminal, secondTerminal] = await Promise.all([
      journal.appendRunFrame({
        at: 2,
        payload: {
          kind: "lifecycle",
          value: { event: "complete", source: "queue" },
        },
        runId: record.id,
      }),
      journal.appendRunFrame({
        at: 3,
        payload: {
          kind: "lifecycle",
          value: { event: "complete", source: "reconcile" },
        },
        runId: record.id,
      }),
    ]);
    expect(output.cursor).toBe(0);
    expect(secondTerminal).toEqual(firstTerminal);
    await expect(
      journal.listRunFrames(record.id, output.cursor)
    ).resolves.toEqual([firstTerminal]);
    await expect(
      journal.appendRunFrame({
        payload: { kind: "progress", value: 1 },
        runId: record.id,
      })
    ).rejects.toThrow();
    await expect(journal.listRunFrames(record.id)).resolves.toEqual([
      output,
      firstTerminal,
    ]);

    await harness.replaceRunFrames(record.id, [
      { at: 1, cursor: -1, payload: null, runId: record.id },
    ]);
    await expect(journal.listRunFrames(record.id)).rejects.toThrow();

    const outputFrame = (cursor: number) => ({
      at: cursor + 1,
      cursor,
      payload: { kind: "output", value: { cursor } },
      runId: record.id,
    });
    const terminalFrame = (cursor: number, event: "complete" | "failed") => ({
      at: cursor + 1,
      cursor,
      payload: { kind: "lifecycle", value: { event } },
      runId: record.id,
    });
    const invalidSequences = [
      [outputFrame(0), outputFrame(2)],
      [terminalFrame(0, "complete"), terminalFrame(1, "failed")],
      [
        terminalFrame(0, "complete"),
        { ...outputFrame(1), payload: { kind: "progress", value: 1 } },
      ],
    ];
    for (const frames of invalidSequences) {
      await harness.replaceRunFrames(record.id, frames);
      await expect(journal.listRunFrames(record.id)).rejects.toThrow();
    }

    await harness.replaceRunFrames(record.id, [outputFrame(0), outputFrame(2)]);
    await expect(
      journal.appendRunFrame({
        payload: { kind: "output", value: "must not append" },
        runId: record.id,
      })
    ).rejects.toThrow();
  });

  test(`${name} journal preserves terminal uniqueness while retaining concurrent outputs`, async () => {
    const { repository, journal } = (await makeHarness()).persistence;
    const record = run({ id: "rn-terminal-race" });
    await repository.ensureQueueRecord(queue("Contract"));
    await repository.putRun(record);

    const [terminal, output] = await Promise.allSettled([
      journal.appendRunFrame({
        at: 1,
        payload: { kind: "lifecycle", value: { event: "complete" } },
        runId: record.id,
      }),
      journal.appendRunFrame({
        at: 2,
        payload: { kind: "output", value: "concurrent" },
        runId: record.id,
      }),
    ]);

    expect(terminal.status).toBe("fulfilled");
    const frames = await journal.listRunFrames(record.id);
    expect(frames.map(({ cursor }) => cursor)).toEqual(
      frames.map((_, cursor) => cursor)
    );
    expect(
      frames.filter(
        (frame) =>
          frame.payload.kind === "lifecycle" &&
          typeof frame.payload.value === "object" &&
          frame.payload.value !== null &&
          !Array.isArray(frame.payload.value) &&
          (frame.payload.value as Readonly<Record<string, unknown>>).event ===
            "complete"
      )
    ).toHaveLength(1);
    expect(output.status).toBe("fulfilled");
    expect(frames).toHaveLength(2);
  });

  test(`${name} journal retains post-terminal receipts and claims without reopening execution`, async () => {
    const { repository, journal } = (await makeHarness()).persistence;
    const record = run({ id: "rn-terminal-evidence" });
    await repository.ensureQueueRecord(queue("Evidence"));
    await repository.putRun(record);
    const terminal = await journal.appendRunFrame({
      payload: { kind: "lifecycle", value: { event: "complete" } },
      runId: record.id,
    });
    const claims = await Promise.all(
      [0, 1].map(() =>
        journal.claimRunEffect({
          key: "settled-notification",
          runId: record.id,
        })
      )
    );
    expect(claims.filter((frame) => frame !== null)).toHaveLength(1);
    await journal.appendRunFrame({
      payload: { kind: "output", value: { receipt: "cleared" } },
      runId: record.id,
    });
    expect(
      await journal.appendRunFrame({
        payload: { kind: "lifecycle", value: { event: "failed" } },
        runId: record.id,
      })
    ).toEqual(terminal);
    const invalidActivity: RunFramePayload[] = [
      { kind: "lifecycle", value: { event: "running" } },
      { kind: "progress", value: 1 },
      { kind: "log", value: "late log" },
      { kind: "log", value: { event: "run-effect-claimed", key: " " } },
    ];
    for (const payload of invalidActivity) {
      await expect(
        journal.appendRunFrame({ payload, runId: record.id })
      ).rejects.toThrow();
    }
    expect(
      (await journal.listRunFrames(record.id)).map(
        (frame) => frame.payload.kind
      )
    ).toEqual(["lifecycle", "log", "output"]);
    expect(
      await journal.claimRunEffect({
        key: "settled-notification",
        runId: record.id,
      })
    ).toBeNull();
  });

  test(`${name} journal atomically keeps one effect claim`, async () => {
    const { repository, journal } = (await makeHarness()).persistence;
    const record = run({ id: "rn-effect-claim-race" });
    await repository.ensureQueueRecord(queue("Effect claim"));
    await repository.putRun(record);

    const claims = await Promise.all([
      journal.claimRunEffect({
        key: "model-segment-0",
        metadata: { process: "first" },
        runId: record.id,
      }),
      journal.claimRunEffect({
        key: "model-segment-0",
        metadata: { process: "second" },
        runId: record.id,
      }),
    ]);

    expect(claims.filter((frame) => frame !== null)).toHaveLength(1);
    expect(claims.filter((frame) => frame === null)).toHaveLength(1);
    const frames = await journal.listRunFrames(record.id);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      cursor: 0,
      payload: {
        kind: "log",
        value: {
          event: "run-effect-claimed",
          key: "model-segment-0",
        },
      },
    });
  });
}

function queue(name: string) {
  return {
    createdAt: name === "First" ? 1 : 2,
    extensions: {},
    id: "queue-contract",
    lastError: null,
    name,
    status: "active" as const,
  };
}

function job(): JobRecord {
  return {
    definition: { name: "documents.generate" },
    id: "jb-contract",
    input: null,
    links: {},
    status: "active",
    timestamps: {
      cancelledAt: null,
      completedAt: null,
      createdAt: 1,
      failedAt: null,
    },
  };
}

function run(
  options: { id?: string; status?: RunRecord["status"]; jobId?: string } = {}
): RunRecord {
  return {
    error: null,
    extensions: {},
    id: options.id ?? "rn-contract",
    input: null,
    metadata: {},
    output: null,
    queueId: "queue-contract",
    snapshot: { cursor: null, input: null, name: "", steps: [] },
    status: options.status ?? "queued",
    step: "documents.generate",
    tags: {},
    timestamps: {
      completedAt: options.status === "complete" ? 2 : null,
      createdAt: 1,
      failedAt: null,
      startedAt: null,
    },
    ...(options.jobId ? { links: { jobId: options.jobId } } : {}),
  };
}
