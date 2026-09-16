import { describe, expect, test } from "vitest";
import {
  JobAlreadySettledError,
  JobNotFoundError,
  RunAlreadySettledError,
  RunNotFoundError,
  SuspensionAlreadySettledError,
} from "../errors";
import { Orchestrator } from "../orchestrator";
import type {
  CreateJobRunInput,
  JobRecord,
  JobRunClaim,
  RunRecord,
  SuspensionRecord,
  UpdateJobInput,
  UpdateRunInput,
} from "../store";
import { InMemoryOrchestratorStore } from "../store";
import { Workflow } from "../workflow";
import { makeOrchestratorConfig } from "./helpers/config";
import { makeInMemoryStore } from "./helpers/store";

interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function gate(): Gate {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
  throw new Error("timed out waiting for value");
}

async function pendingSuspension(
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

async function startedOrchestrator(store = makeInMemoryStore()) {
  const orchestrator = new Orchestrator({
    config: makeOrchestratorConfig(),
    store,
  });
  await orchestrator.setup();
  return { orchestrator, store };
}

class DelayedCompletionStore extends InMemoryOrchestratorStore {
  readonly completionWriteStarted: Promise<void>;
  readonly #completionWriteGate: Gate;
  #announceCompletionWrite = (): void => undefined;

  constructor() {
    super();
    this.completionWriteStarted = new Promise<void>((resolve) => {
      this.#announceCompletionWrite = resolve;
    });
    this.#completionWriteGate = gate();
  }

  releaseCompletionWrite(): void {
    this.#completionWriteGate.release();
  }

  override async updateRun(
    id: string,
    patch: UpdateRunInput
  ): Promise<RunRecord | null> {
    if (patch.status === "complete") {
      this.#announceCompletionWrite();
      await this.#completionWriteGate.promise;
    }
    return super.updateRun(id, patch);
  }
}

class DelayedRunCancellationStore extends InMemoryOrchestratorStore {
  readonly cancellationStarted: Promise<void>;
  readonly #cancellationGate: Gate;
  #announceCancellation = (): void => undefined;

  constructor() {
    super();
    this.cancellationStarted = new Promise<void>((resolve) => {
      this.#announceCancellation = resolve;
    });
    this.#cancellationGate = gate();
  }

  releaseCancellation(): void {
    this.#cancellationGate.release();
  }

  override async cancelRun(runId: string) {
    this.#announceCancellation();
    await this.#cancellationGate.promise;
    return super.cancelRun(runId);
  }
}

class DelayedJobClaimStore extends InMemoryOrchestratorStore {
  readonly claimStarted: Promise<void>;
  readonly #claimGate: Gate;
  #announceClaim = (): void => undefined;

  constructor() {
    super();
    this.claimStarted = new Promise<void>((resolve) => {
      this.#announceClaim = resolve;
    });
    this.#claimGate = gate();
  }

  releaseClaim(): void {
    this.#claimGate.release();
  }

  override async claimJobRun(
    jobId: string,
    input: CreateJobRunInput
  ): Promise<JobRunClaim> {
    this.#announceClaim();
    await this.#claimGate.promise;
    return super.claimJobRun(jobId, input);
  }
}

class DelayedPendingProjectionStore extends InMemoryOrchestratorStore {
  readonly pendingProjectionStarted: Promise<void>;
  readonly #projectionGate: Gate;
  #announceProjection = (): void => undefined;

  constructor() {
    super();
    this.pendingProjectionStarted = new Promise<void>((resolve) => {
      this.#announceProjection = resolve;
    });
    this.#projectionGate = gate();
  }

  releaseProjection(): void {
    this.#projectionGate.release();
  }

  override async updateJob(
    id: string,
    patch: UpdateJobInput
  ): Promise<JobRecord | null> {
    if (patch.status === "pending") {
      this.#announceProjection();
      await this.#projectionGate.promise;
    }
    return super.updateJob(id, patch);
  }
}

describe("Orchestrator explicit controls", () => {
  test("observer detach does not cancel its Run", async () => {
    const { orchestrator, store } = await startedOrchestrator();
    const runGate = gate();
    orchestrator.register("detach-only", () =>
      Workflow.create({
        execute: async () => {
          await runGate.promise;
          return "complete";
        },
        input: null,
        name: "detach-only",
      })
    );
    await orchestrator.start();

    const run = await orchestrator.run("detach-only", null);
    const observation = await orchestrator.observe(run.id);
    observation.close();
    runGate.release();

    await expect(run.result()).resolves.toMatchObject({
      status: "complete",
      value: "complete",
    });
    await expect(store.getRun(run.id)).resolves.toMatchObject({
      status: "complete",
    });
    await orchestrator.stop();
  });

  test("cancels an active direct Run through the public control", async () => {
    const { orchestrator, store } = await startedOrchestrator();
    let announceExecution = (): void => undefined;
    const executionStarted = new Promise<void>((resolve) => {
      announceExecution = resolve;
    });
    orchestrator.register("active-direct", () =>
      Workflow.create({
        execute: () => {
          announceExecution();
          return new Promise<never>(() => undefined);
        },
        input: null,
        name: "active-direct",
      })
    );
    await orchestrator.start();
    const run = await orchestrator.run("active-direct", null);
    await executionStarted;

    await expect(orchestrator.cancelRun(run.id)).resolves.toMatchObject({
      id: run.id,
      status: "cancelled",
    });
    await expect(run.result()).resolves.toMatchObject({ status: "cancelled" });
    await expect(orchestrator.drain()).resolves.toBeUndefined();
    await expect(store.getRun(run.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    const observation = await orchestrator.observe(run.id);
    const frames = [];
    for await (const frame of observation) {
      frames.push(frame);
    }
    const terminalFrames = frames.filter((frame) => {
      if (frame.payload.kind !== "lifecycle") {
        return false;
      }
      const value = frame.payload.value;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
      }
      return ["complete", "failed", "cancelled"].includes(
        String((value as Readonly<Record<string, unknown>>).event)
      );
    });
    expect(terminalFrames).toHaveLength(1);
    expect(terminalFrames[0]).toMatchObject({
      payload: { value: { event: "cancelled", status: "cancelled" } },
    });
    await orchestrator.stop();
  });

  test("cancels a queued Run while paused without starting it or stranding drain", async () => {
    const { orchestrator, store } = await startedOrchestrator();
    let executions = 0;
    orchestrator.register("queued-direct", () =>
      Workflow.create({
        execute: async () => {
          executions += 1;
          return "unexpected";
        },
        input: null,
        name: "queued-direct",
      })
    );
    await orchestrator.start();
    await orchestrator.pause();
    const run = await orchestrator.run("queued-direct", null);

    await expect(orchestrator.cancelRun(run.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(run.result()).resolves.toMatchObject({ status: "cancelled" });
    await expect(orchestrator.drain()).resolves.toBeUndefined();
    await orchestrator.resume();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(executions).toBe(0);
    await expect(store.getRun(run.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await orchestrator.stop();
  });

  test("cancels a suspended Run and its pending Suspension atomically", async () => {
    const { orchestrator } = await startedOrchestrator();
    orchestrator.register("suspended-direct", (input: null) =>
      Workflow.create({
        execute: async (_value, context) =>
          context.suspend({
            name: "approval",
            reason: "review",
            request: null,
          }),
        input,
        name: "suspended-direct",
      })
    );
    await orchestrator.start();
    const run = await orchestrator.run("suspended-direct", null);
    const suspension = await pendingSuspension(orchestrator, run.id);

    await expect(orchestrator.cancelRun(run.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(
      orchestrator.getSuspension(suspension.id)
    ).resolves.toMatchObject({ revision: 1, status: "cancelled" });
    await expect(
      orchestrator.resolve(suspension.id, "too late")
    ).rejects.toBeInstanceOf(SuspensionAlreadySettledError);
    await expect(run.result()).resolves.toMatchObject({ status: "cancelled" });
    await orchestrator.stop();
  });

  test("returns typed missing and settled Run errors", async () => {
    const { orchestrator } = await startedOrchestrator();
    orchestrator.register("complete-run", () =>
      Workflow.create({
        execute: async () => "done",
        input: null,
        name: "complete-run",
      })
    );
    orchestrator.register("failed-run", () =>
      Workflow.create({
        execute: async () => {
          throw new Error("failed");
        },
        input: null,
        name: "failed-run",
      })
    );
    orchestrator.register("cancelled-run", () =>
      Workflow.create({
        execute: () => new Promise<never>(() => undefined),
        input: null,
        name: "cancelled-run",
      })
    );
    await orchestrator.start();

    await expect(orchestrator.cancelRun("rn-missing")).rejects.toBeInstanceOf(
      RunNotFoundError
    );
    const complete = await orchestrator.run("complete-run", null);
    await complete.result();
    const failed = await orchestrator.run("failed-run", null);
    await failed.result();
    const cancelled = await orchestrator.run("cancelled-run", null);
    await orchestrator.cancelRun(cancelled.id);

    for (const runId of [complete.id, failed.id, cancelled.id]) {
      await expect(orchestrator.cancelRun(runId)).rejects.toBeInstanceOf(
        RunAlreadySettledError
      );
    }
    await orchestrator.stop();
  });

  test("pending Job cancellation permanently rejects execute", async () => {
    const { orchestrator } = await startedOrchestrator();
    orchestrator.register("pending-job", () =>
      Workflow.create({
        execute: async () => "unexpected",
        input: null,
        name: "pending-job",
      })
    );
    await orchestrator.start();
    const job = await orchestrator.createJob("pending-job", null);

    await expect(orchestrator.cancelJob(job.id)).resolves.toMatchObject({
      id: job.id,
      status: "cancelled",
    });
    await expect(orchestrator.execute(job.id)).rejects.toBeInstanceOf(
      JobAlreadySettledError
    );
    await orchestrator.stop();
  });

  test("active Job cancellation reaches its live Run", async () => {
    const { orchestrator, store } = await startedOrchestrator();
    orchestrator.register("active-job", () =>
      Workflow.create({
        execute: () => new Promise<never>(() => undefined),
        input: null,
        name: "active-job",
      })
    );
    await orchestrator.start();
    const job = await orchestrator.createJob("active-job", null);
    const run = await orchestrator.execute(job.id);
    await waitFor(async () => {
      const record = await store.getRun(run.id);
      return record?.status === "running" ? record : null;
    });

    await expect(orchestrator.cancelJob(job.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(run.result()).resolves.toMatchObject({ status: "cancelled" });
    await expect(store.getRun(run.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(orchestrator.execute(job.id)).rejects.toBeInstanceOf(
      JobAlreadySettledError
    );
    await orchestrator.stop();
  });

  test("suspended Job cancellation cascades to its Run and Suspension", async () => {
    const { orchestrator } = await startedOrchestrator();
    orchestrator.register("suspended-job", (input: null) =>
      Workflow.create({
        execute: async (_value, context) =>
          context.suspend({
            name: "approval",
            reason: "review",
            request: null,
          }),
        input,
        name: "suspended-job",
      })
    );
    await orchestrator.start();
    const job = await orchestrator.createJob("suspended-job", null);
    const run = await orchestrator.execute(job.id);
    const suspension = await pendingSuspension(orchestrator, run.id);

    await expect(orchestrator.cancelJob(job.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(run.result()).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      orchestrator.getSuspension(suspension.id)
    ).resolves.toMatchObject({ revision: 1, status: "cancelled" });
    await expect(
      orchestrator.resolve(suspension.id, "too late")
    ).rejects.toBeInstanceOf(SuspensionAlreadySettledError);
    await orchestrator.stop();
  });

  test("a Job with a failed attempt remains cancellable", async () => {
    const { orchestrator } = await startedOrchestrator();
    orchestrator.register("failed-attempt", () =>
      Workflow.create({
        execute: async () => {
          throw new Error("attempt failed");
        },
        input: null,
        name: "failed-attempt",
      })
    );
    await orchestrator.start();
    const job = await orchestrator.createJob("failed-attempt", null);
    const run = await orchestrator.execute(job.id);
    await expect(run.result()).resolves.toMatchObject({ status: "failed" });
    await expect(orchestrator.getJob(job.id)).resolves.toMatchObject({
      status: "pending",
    });

    await expect(orchestrator.cancelJob(job.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(orchestrator.execute(job.id)).rejects.toBeInstanceOf(
      JobAlreadySettledError
    );
    await orchestrator.stop();
  });

  test("a stale failed-attempt projection cannot reopen a cancelled Job", async () => {
    const store = new DelayedPendingProjectionStore();
    const { orchestrator } = await startedOrchestrator(store);
    orchestrator.register("failed-projection-race", () =>
      Workflow.create({
        execute: async () => {
          throw new Error("attempt failed");
        },
        input: null,
        name: "failed-projection-race",
      })
    );
    await orchestrator.start();
    const job = await orchestrator.createJob("failed-projection-race", null);
    const run = await orchestrator.execute(job.id);
    await expect(run.result()).resolves.toMatchObject({ status: "failed" });
    await store.pendingProjectionStarted;

    await expect(orchestrator.cancelJob(job.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    store.releaseProjection();

    await expect(orchestrator.getJob(job.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(orchestrator.execute(job.id)).rejects.toBeInstanceOf(
      JobAlreadySettledError
    );
    await orchestrator.stop();
  });

  test("returns typed missing and settled Job errors", async () => {
    const { orchestrator, store } = await startedOrchestrator();
    orchestrator.register("complete-job", () =>
      Workflow.create({
        execute: async () => "done",
        input: null,
        name: "complete-job",
      })
    );
    await orchestrator.start();

    await expect(orchestrator.cancelJob("jb-missing")).rejects.toBeInstanceOf(
      JobNotFoundError
    );
    const complete = await orchestrator.createJob("complete-job", null);
    const completeRun = await orchestrator.execute(complete.id);
    await completeRun.result();
    await orchestrator.getJob(complete.id);
    const failed = await orchestrator.createJob("complete-job", null);
    await store.updateJob(failed.id, { status: "failed" });
    const cancelled = await orchestrator.createJob("complete-job", null);
    await orchestrator.cancelJob(cancelled.id);

    for (const jobId of [complete.id, failed.id, cancelled.id]) {
      await expect(orchestrator.cancelJob(jobId)).rejects.toBeInstanceOf(
        JobAlreadySettledError
      );
    }
    await orchestrator.stop();
  });

  test("cancel wins a deterministic race with completion at durable authority", async () => {
    const store = new DelayedCompletionStore();
    const { orchestrator } = await startedOrchestrator(store);
    orchestrator.register("completion-race", () =>
      Workflow.create({
        execute: async () => "body complete",
        input: null,
        name: "completion-race",
      })
    );
    await orchestrator.start();
    const run = await orchestrator.run("completion-race", null);
    await store.completionWriteStarted;

    const cancellation = await orchestrator.cancelRun(run.id);
    store.releaseCompletionWrite();

    expect(cancellation.status).toBe("cancelled");
    await expect(run.result()).resolves.toMatchObject({ status: "cancelled" });
    await expect(store.getRun(run.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    await orchestrator.stop();
  });

  test("resolution wins its barrier before Run cancellation", async () => {
    const store = new DelayedRunCancellationStore();
    const { orchestrator } = await startedOrchestrator(store);
    const afterResolution = gate();
    orchestrator.register("resolution-race", (input: null) =>
      Workflow.create({
        execute: async (_value, context) => {
          await context.suspend({
            name: "approval",
            reason: "review",
            request: null,
          });
          await afterResolution.promise;
          return "unexpected";
        },
        input,
        name: "resolution-race",
      })
    );
    await orchestrator.start();
    const run = await orchestrator.run("resolution-race", null);
    const suspension = await pendingSuspension(orchestrator, run.id);

    const cancellation = orchestrator.cancelRun(run.id);
    await store.cancellationStarted;
    await expect(
      orchestrator.resolve(suspension.id, "approved")
    ).resolves.toMatchObject({ status: "resolved" });
    store.releaseCancellation();

    await expect(cancellation).resolves.toMatchObject({ status: "cancelled" });
    await expect(run.result()).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      orchestrator.getSuspension(suspension.id)
    ).resolves.toMatchObject({ revision: 1, status: "resolved" });
    afterResolution.release();
    await orchestrator.stop();
  });

  test("execute claim wins its barrier before cancelJob and no future attempt leaks", async () => {
    const store = new DelayedJobClaimStore();
    const { orchestrator } = await startedOrchestrator(store);
    orchestrator.register("execute-cancel-race", () =>
      Workflow.create({
        execute: () => new Promise<never>(() => undefined),
        input: null,
        name: "execute-cancel-race",
      })
    );
    await orchestrator.start();
    const job = await orchestrator.createJob("execute-cancel-race", null);

    const execution = orchestrator.execute(job.id);
    await store.claimStarted;
    const cancellation = orchestrator.cancelJob(job.id);
    store.releaseClaim();
    const run = await execution;

    await expect(cancellation).resolves.toMatchObject({ status: "cancelled" });
    await expect(run.result()).resolves.toMatchObject({ status: "cancelled" });
    await expect(orchestrator.execute(job.id)).rejects.toBeInstanceOf(
      JobAlreadySettledError
    );
    await orchestrator.stop();
  });
});
