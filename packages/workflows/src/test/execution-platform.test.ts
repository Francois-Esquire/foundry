import { describe, expect, test } from "vitest";
import { JobAlreadySettledError } from "../errors";
import type { RunObservation } from "../orchestrator";
import { Orchestrator } from "../orchestrator";
import type { OrchestratorStore, RunFrame, SuspensionRecord } from "../store";
import { InMemoryOrchestratorStore } from "../store";
import { Workflow } from "../workflow";
import { makeOrchestratorConfig } from "./helpers/config";

interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function makeGate(): Gate {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function collect(observation: RunObservation): Promise<RunFrame[]> {
  const frames: RunFrame[] = [];
  for await (const frame of observation) {
    frames.push(frame);
  }
  return frames;
}

async function waitFor<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for execution-platform state");
}

function pendingSuspension(
  orchestrator: Orchestrator,
  runId: string
): Promise<SuspensionRecord> {
  return waitFor(async () => {
    const records = await orchestrator.listSuspensions({
      runId,
      status: "pending",
    });
    return records.items.at(-1) ?? null;
  });
}

function lifecycleEvent(frame: RunFrame): string | null {
  if (frame.payload.kind !== "lifecycle") {
    return null;
  }
  const value = frame.payload.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.event === "string" ? record.event : null;
}

function terminalFrames(frames: readonly RunFrame[]): RunFrame[] {
  return frames.filter((frame) =>
    ["complete", "failed", "cancelled"].includes(lifecycleEvent(frame) ?? "")
  );
}

async function expectSingleTerminal(
  store: OrchestratorStore,
  runId: string,
  expected: "complete" | "failed" | "cancelled"
): Promise<void> {
  const frames = await waitFor(async () => {
    const retained = await store.listRunFrames(runId);
    return terminalFrames(retained).length > 0 ? retained : null;
  });
  const terminals = terminalFrames(frames);
  expect(terminals).toHaveLength(1);
  const terminal = terminals[0];
  if (!terminal) {
    throw new Error(`missing terminal frame for ${runId}`);
  }
  expect(lifecycleEvent(terminal)).toBe(expected);
}

describe("Workflows execution platform", () => {
  test("proves live Run observation, Suspension, Job attempts, and explicit Job cancellation", async () => {
    const store = new InMemoryOrchestratorStore();
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig({ concurrency: 1 }),
      store,
    });
    const streamGate = makeGate();
    const cancellationEntered = makeGate();
    const neverFinish = makeGate();
    let attempt = 0;

    await orchestrator.setup();
    orchestrator.register<string, string>(
      "platform.stream",
      (input, context) => {
        if (!context) {
          throw new Error("expected Run execution context");
        }
        return Workflow.create({
          execute: async () => {
            await context.emitOutput({ sequence: 1, text: "first" });
            await streamGate.promise;
            await context.emitOutput({ sequence: 2, text: "second" });
            return "stream-complete";
          },
          input,
          name: "platform.stream",
        });
      }
    );
    orchestrator.register("platform.approval", (input: null) =>
      Workflow.create({
        execute: async (_value, context) =>
          context.suspend<string>({
            name: "approval",
            reason: "operator review",
            request: { documentId: "doc-phase-1" },
          }),
        input,
        name: "platform.approval",
      })
    );
    orchestrator.register("platform.capacity", (input: null) =>
      Workflow.create({
        execute: async () => "capacity released",
        input,
        name: "platform.capacity",
      })
    );
    orchestrator.register("platform.retry", (input: null) =>
      Workflow.create({
        execute: async () => {
          attempt += 1;
          if (attempt === 1) {
            throw new Error("first attempt failed");
          }
          return "second attempt succeeded";
        },
        input,
        name: "platform.retry",
      })
    );
    orchestrator.register("platform.cancel", (input: null) =>
      Workflow.create({
        execute: async () => {
          cancellationEntered.release();
          await neverFinish.promise;
          return "unreachable";
        },
        input,
        name: "platform.cancel",
      })
    );
    try {
      await orchestrator.start();
      const direct = await orchestrator.run("platform.stream", "prompt", {
        links: {
          invocationId: "invocation-phase-1",
          sessionId: "session-phase-1",
          subjectId: "document-phase-1",
        },
      });
      const initial = await orchestrator.observe(direct.id);
      const iterator = initial[Symbol.asyncIterator]();
      let firstOutput: RunFrame | null = null;
      while (firstOutput === null) {
        const next = await iterator.next();
        if (next.done) {
          throw new Error("Run ended before its first output");
        }
        if (next.value.payload.kind === "output") {
          firstOutput = next.value;
        }
      }
      initial.close();

      streamGate.release();
      await expect(direct.result()).resolves.toMatchObject({
        status: "complete",
        value: "stream-complete",
      });
      const replay = await collect(
        await orchestrator.observe(direct.id, { after: firstOutput.cursor })
      );
      const allDirectFrames = await store.listRunFrames(direct.id);
      expect(
        replay.filter((frame) => frame.payload.kind === "output")
      ).toMatchObject([
        { payload: { value: { sequence: 2, text: "second" } } },
      ]);
      expect(terminalFrames(replay)).toHaveLength(1);
      expect(
        allDirectFrames
          .filter((frame) => frame.payload.kind === "output")
          .map((frame) => frame.payload.value)
      ).toEqual([
        { sequence: 1, text: "first" },
        { sequence: 2, text: "second" },
      ]);
      expect(allDirectFrames.map((frame) => frame.cursor)).toEqual(
        allDirectFrames.map((_, cursor) => cursor)
      );
      expect(terminalFrames(allDirectFrames)).toHaveLength(1);
      await expect(store.getRun(direct.id)).resolves.toMatchObject({
        links: {
          invocationId: "invocation-phase-1",
          sessionId: "session-phase-1",
          subjectId: "document-phase-1",
        },
        status: "complete",
      });
      expect((await orchestrator.listJobs()).items).toEqual([]);

      const suspended = await orchestrator.run("platform.approval", null);
      const suspension = await pendingSuspension(orchestrator, suspended.id);
      expect(suspension).toMatchObject({
        revision: 0,
        runId: suspended.id,
        status: "pending",
      });
      const capacityProof = await orchestrator.run("platform.capacity", null);
      await expect(capacityProof.result()).resolves.toMatchObject({
        status: "complete",
        value: "capacity released",
      });
      await expectSingleTerminal(store, capacityProof.id, "complete");
      const resolved = await orchestrator.resolve(suspension.id, "approved", {
        expectedRevision: 0,
      });
      expect(resolved).toMatchObject({
        id: suspension.id,
        resolution: "approved",
        revision: 1,
        runId: suspended.id,
        status: "resolved",
      });
      await expect(suspended.result()).resolves.toMatchObject({
        status: "complete",
        value: "approved",
      });
      await expect(store.getRun(suspended.id)).resolves.toMatchObject({
        id: suspended.id,
        status: "complete",
      });
      await expectSingleTerminal(store, suspended.id, "complete");

      const retryJob = await orchestrator.createJob("platform.retry", null, {
        links: { sessionId: "session-phase-1", taskId: "task-phase-1" },
      });
      const firstAttempt = await orchestrator.execute(retryJob.id);
      await expect(firstAttempt.result()).resolves.toMatchObject({
        status: "failed",
      });
      await expectSingleTerminal(store, firstAttempt.id, "failed");
      await expect(orchestrator.getJob(retryJob.id)).resolves.toMatchObject({
        id: retryJob.id,
        status: "pending",
      });
      const secondAttempt = await orchestrator.execute(retryJob.id);
      await expect(secondAttempt.result()).resolves.toMatchObject({
        status: "complete",
        value: "second attempt succeeded",
      });
      await expectSingleTerminal(store, secondAttempt.id, "complete");
      const attempts = await store.listRuns({
        links: { jobId: retryJob.id },
        order: "oldest",
      });
      expect(attempts.items.map((run) => run.id)).toEqual([
        firstAttempt.id,
        secondAttempt.id,
      ]);
      expect(attempts.items.map((run) => run.status)).toEqual([
        "failed",
        "complete",
      ]);
      await expect(orchestrator.getJob(retryJob.id)).resolves.toMatchObject({
        id: retryJob.id,
        status: "complete",
      });

      const cancelledJob = await orchestrator.createJob(
        "platform.cancel",
        null,
        { links: { taskId: "task-cancelled" } }
      );
      const cancelledAttempt = await orchestrator.execute(cancelledJob.id);
      await cancellationEntered.promise;
      await expect(
        orchestrator.cancelJob(cancelledJob.id)
      ).resolves.toMatchObject({ id: cancelledJob.id, status: "cancelled" });
      await expect(cancelledAttempt.result()).resolves.toMatchObject({
        status: "cancelled",
      });
      await expect(store.getRun(cancelledAttempt.id)).resolves.toMatchObject({
        id: cancelledAttempt.id,
        links: { jobId: cancelledJob.id },
        status: "cancelled",
      });
      await expectSingleTerminal(store, cancelledAttempt.id, "cancelled");
      await expect(
        orchestrator.execute(cancelledJob.id)
      ).rejects.toBeInstanceOf(JobAlreadySettledError);
    } finally {
      await orchestrator.stop({ graceMs: 25 });
    }
  });

  test("round-trips the full store and recovers only non-terminal Runs exactly once", async () => {
    const defaultName = "execution-platform-recovery";
    const source = new InMemoryOrchestratorStore();
    const queue = await source.ensureQueue({
      extensions: { "host.queue": { region: "test" } },
      id: "qu-execution-platform",
      name: defaultName,
    });

    const terminalRun = await source.createRun({
      definition: { name: "platform.history" },
      id: "rn-terminal-history",
      input: { prompt: "already finished" },
      links: {
        sessionId: "session-history",
        subjectId: "document-history",
      },
      queueId: queue.id,
      step: "platform.history",
    });
    await source.updateRun(terminalRun.id, {
      output: { answer: "preserved" },
      status: "complete",
    });
    await source.appendRunFrame({
      payload: { kind: "output", value: { answer: "preserved" } },
      runId: terminalRun.id,
    });
    await source.appendRunFrame({
      payload: {
        kind: "lifecycle",
        value: { event: "complete", status: "complete" },
      },
      runId: terminalRun.id,
    });

    const directRun = await source.createRun({
      definition: { name: "platform.recover-direct" },
      id: "rn-recover-direct",
      input: { prompt: "resume direct" },
      links: {
        invocationId: "invocation-direct",
        sessionId: "session-recovery",
        subjectId: "document-recovery",
      },
      queueId: queue.id,
      step: "platform.recover-direct",
    });
    const parked = await source.parkSuspension({
      id: "su-recover-direct",
      kind: "external",
      name: "checkpoint",
      occurrence: 0,
      reason: "reconstructable boundary",
      request: { checkpoint: "ready" },
      runId: directRun.id,
      stepPath: ["platform.recover-direct"],
    });
    const settled = await source.settleSuspension(parked.suspension.id, {
      expectedRevision: 0,
      outcome: { resolution: { approved: true }, status: "resolved" },
    });
    await source.appendRunFrame({
      payload: { kind: "suspension", value: settled.suspension },
      runId: directRun.id,
    });

    const recoveryJob = await source.createJob({
      definition: { name: "platform.recover-job" },
      id: "jb-recover-platform",
      input: { prompt: "resume job attempt" },
      links: {
        invocationId: "invocation-job",
        principalId: "principal-recovery",
        sessionId: "session-recovery",
        subjectId: "document-recovery",
        taskId: "task-recovery",
      },
    });
    const jobClaim = await source.claimJobRun(recoveryJob.id, {
      definition: { name: "platform.recover-job" },
      id: "rn-recover-job",
      input: recoveryJob.input,
      links: {
        invocationId: recoveryJob.links.invocationId,
        principalId: recoveryJob.links.principalId,
        sessionId: recoveryJob.links.sessionId,
        subjectId: recoveryJob.links.subjectId,
      },
      queueId: queue.id,
      step: "platform.recover-job",
    });

    const captured = source.snapshot();
    const restored = new InMemoryOrchestratorStore({
      snapshot: JSON.parse(JSON.stringify(captured)) as unknown,
    });
    expect(restored.snapshot()).toEqual(captured);
    expect(captured).toMatchObject({
      jobs: [{ id: recoveryJob.id }],
      queues: [{ id: queue.id }],
      suspensions: [{ id: settled.suspension.id, status: "resolved" }],
      version: 1,
    });
    expect(captured.runs).toHaveLength(3);
    expect(captured.frames).toHaveLength(3);

    let terminalExecutions = 0;
    let directExecutions = 0;
    let jobExecutions = 0;
    const recovered = new Orchestrator({
      config: makeOrchestratorConfig({ concurrency: 1, defaultName }),
      store: restored,
    });
    await recovered.setup();
    recovered.register("platform.history", (input: unknown) =>
      Workflow.create({
        execute: async () => {
          terminalExecutions += 1;
          return "must not execute";
        },
        input,
        name: "platform.history",
      })
    );
    recovered.register("platform.recover-direct", (input: unknown, context) =>
      Workflow.create({
        execute: async () => {
          directExecutions += 1;
          await context?.emitOutput({ recovered: "direct" });
          return "direct recovered";
        },
        input,
        name: "platform.recover-direct",
      })
    );
    recovered.register("platform.recover-job", (input: unknown, context) =>
      Workflow.create({
        execute: async () => {
          jobExecutions += 1;
          await context?.emitOutput({ recovered: "job" });
          return "job recovered";
        },
        input,
        name: "platform.recover-job",
      })
    );

    try {
      await recovered.start();
      const directHandle = await recovered.get(directRun.id);
      const jobHandle = await recovered.get(jobClaim.run.id);
      if (!(directHandle && jobHandle)) {
        throw new Error("expected both non-terminal Runs to be recovered");
      }
      await expect(directHandle.result()).resolves.toMatchObject({
        status: "complete",
        value: "direct recovered",
      });
      await expect(jobHandle.result()).resolves.toMatchObject({
        status: "complete",
        value: "job recovered",
      });
      await collect(await recovered.observe(directRun.id));
      await collect(await recovered.observe(jobClaim.run.id));

      expect({ directExecutions, jobExecutions, terminalExecutions }).toEqual({
        directExecutions: 1,
        jobExecutions: 1,
        terminalExecutions: 0,
      });
      await expect(restored.getRun(terminalRun.id)).resolves.toMatchObject({
        id: terminalRun.id,
        links: {
          sessionId: "session-history",
          subjectId: "document-history",
        },
        output: { answer: "preserved" },
        status: "complete",
      });
      expect(await restored.listRunFrames(terminalRun.id)).toEqual(
        captured.frames.filter((frame) => frame.runId === terminalRun.id)
      );
      await expect(restored.getRun(directRun.id)).resolves.toMatchObject({
        links: {
          invocationId: "invocation-direct",
          sessionId: "session-recovery",
          subjectId: "document-recovery",
        },
        status: "complete",
      });
      await expect(restored.getRun(jobClaim.run.id)).resolves.toMatchObject({
        links: {
          invocationId: "invocation-job",
          jobId: recoveryJob.id,
          principalId: "principal-recovery",
          sessionId: "session-recovery",
          subjectId: "document-recovery",
        },
        status: "complete",
      });
      await expect(recovered.getJob(recoveryJob.id)).resolves.toMatchObject({
        id: recoveryJob.id,
        links: { sessionId: "session-recovery", taskId: "task-recovery" },
        status: "complete",
      });
      await expect(
        recovered.getSuspension(settled.suspension.id)
      ).resolves.toEqual(settled.suspension);

      for (const runId of [terminalRun.id, directRun.id, jobClaim.run.id]) {
        expect(
          terminalFrames(await restored.listRunFrames(runId))
        ).toHaveLength(1);
      }
    } finally {
      await recovered.stop({ graceMs: 25 });
    }
  });
});
