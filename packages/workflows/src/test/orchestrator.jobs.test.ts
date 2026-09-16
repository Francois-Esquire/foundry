import { describe, expect, test } from "vitest";
import {
  DefinitionNotRegisteredError,
  JobAlreadySettledError,
  JobAttemptAlreadyActiveError,
  JobNotFoundError,
} from "../errors";
import type { RunLifecycleEvent } from "../logger";
import type { RunExecutionContext } from "../orchestrator";
import { Orchestrator } from "../orchestrator";
import { Workflow } from "../workflow";
import { makeOrchestratorConfig } from "./helpers/config";
import { makeInMemoryStore } from "./helpers/store";

function makeOrchestrator(events?: RunLifecycleEvent[]) {
  const store = makeInMemoryStore();
  const orchestrator = new Orchestrator({
    config: makeOrchestratorConfig(),
    store,
    ...(events === undefined
      ? {}
      : { logger: { on: (event: RunLifecycleEvent) => events.push(event) } }),
  });
  return { orchestrator, store };
}

describe("Orchestrator managed Jobs", () => {
  test("creates intent without dispatching a Run", async () => {
    const { orchestrator, store } = makeOrchestrator();
    const job = await orchestrator.createJob(
      "documents.generate",
      { prompt: "draft" },
      {
        links: { sessionId: "session-1", subjectId: "document-1" },
        version: "1",
      }
    );

    expect(job).toMatchObject({
      definition: { name: "documents.generate", version: "1" },
      links: { sessionId: "session-1", subjectId: "document-1" },
      status: "pending",
    });
    expect((await store.listRuns({ links: { jobId: job.id } })).items).toEqual(
      []
    );
  });

  test("executes one linked Run with preallocated identity and context", async () => {
    const events: RunLifecycleEvent[] = [];
    const { orchestrator, store } = makeOrchestrator(events);
    await orchestrator.setup();
    let observedContext: RunExecutionContext | null = null;
    orchestrator.register<{ prompt: string }, string>(
      "documents.generate",
      (input, context) => {
        if (!context) {
          throw new Error("expected execution context");
        }
        observedContext = context;
        return Workflow.create({
          execute: async ({ prompt }) => prompt,
          input,
          name: "document-workflow",
        });
      }
    );
    await orchestrator.start();
    const job = await orchestrator.createJob(
      "documents.generate",
      { prompt: "draft" },
      {
        links: { sessionId: "session-1", subjectId: "document-1" },
        version: "1",
      }
    );

    const dispatched = await orchestrator.execute(job.id);
    await dispatched.result();
    const runs = await store.listRuns({ links: { jobId: job.id } });

    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]).toMatchObject({
      definition: { name: "documents.generate", version: "1" },
      id: dispatched.id,
      input: { prompt: "draft" },
      links: {
        jobId: job.id,
        sessionId: "session-1",
        subjectId: "document-1",
      },
    });
    expect(observedContext).toMatchObject({
      definition: { name: "documents.generate", version: "1" },
      links: {
        jobId: job.id,
        sessionId: "session-1",
        subjectId: "document-1",
      },
      runId: dispatched.id,
    });
    await expect(orchestrator.getJob(job.id)).resolves.toMatchObject({
      status: "complete",
    });
    expect(events.map((event) => event.kind)).toEqual([
      "dispatched",
      "started",
      "completed",
    ]);
    await orchestrator.stop();
  });

  test("allows at most one active attempt", async () => {
    const { orchestrator, store } = makeOrchestrator();
    await orchestrator.setup();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    orchestrator.register("documents.generate", (input: null) =>
      Workflow.create({
        execute: async () => {
          await gate;
          return null;
        },
        input,
        name: "documents.generate",
      })
    );
    await orchestrator.start();
    const job = await orchestrator.createJob("documents.generate", null);

    const first = await orchestrator.execute(job.id);
    await expect(orchestrator.execute(job.id)).rejects.toBeInstanceOf(
      JobAttemptAlreadyActiveError
    );
    expect(
      (await store.listRuns({ links: { jobId: job.id } })).items
    ).toHaveLength(1);
    release();
    await first.result();
    await orchestrator.stop();
  });

  test("enforces one active attempt across Orchestrator instances", async () => {
    const store = makeInMemoryStore();
    const first = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    const second = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await first.setup();
    await second.setup();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory = (input: null) =>
      Workflow.create({
        execute: async () => {
          await gate;
          return null;
        },
        input,
        name: "documents.generate",
      });
    first.register("documents.generate", factory);
    second.register("documents.generate", factory);
    await first.start();
    await second.start();
    const job = await first.createJob("documents.generate", null);

    const results = await Promise.allSettled([
      first.execute(job.id),
      second.execute(job.id),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(
      rejected?.status === "rejected" ? rejected.reason : null
    ).toBeInstanceOf(JobAttemptAlreadyActiveError);
    expect(
      (await store.listRuns({ links: { jobId: job.id } })).items
    ).toHaveLength(1);
    release();
    const fulfilled = results.find((result) => result.status === "fulfilled");
    if (fulfilled?.status !== "fulfilled") {
      throw new Error("expected one accepted attempt");
    }
    await fulfilled.value.result();
    await first.stop();
    await second.stop();
  });

  test("permits a later explicit attempt after failure", async () => {
    const { orchestrator, store } = makeOrchestrator();
    await orchestrator.setup();
    let attempt = 0;
    orchestrator.register("documents.generate", (input: null) =>
      Workflow.create({
        execute: async () => {
          attempt += 1;
          if (attempt === 1) {
            throw new Error("first attempt failed");
          }
          return "done";
        },
        input,
        name: "documents.generate",
      })
    );
    await orchestrator.start();
    const job = await orchestrator.createJob("documents.generate", null);

    const first = await orchestrator.execute(job.id);
    await first.result();
    await expect(orchestrator.getJob(job.id)).resolves.toMatchObject({
      status: "pending",
    });
    const second = await orchestrator.execute(job.id);
    await second.result();

    expect(second.id).not.toBe(first.id);
    expect(
      (await store.listRuns({ links: { jobId: job.id } })).items
    ).toHaveLength(2);
    await expect(orchestrator.getJob(job.id)).resolves.toMatchObject({
      status: "complete",
    });
    await expect(orchestrator.execute(job.id)).rejects.toBeInstanceOf(
      JobAlreadySettledError
    );
    await orchestrator.stop();
  });

  test("permits a later explicit attempt after Run cancellation", async () => {
    const { orchestrator, store } = makeOrchestrator();
    await orchestrator.setup();
    orchestrator.register("documents.generate", (input: null) =>
      Workflow.create({
        execute: async () => "done",
        input,
        name: "documents.generate",
      })
    );
    await orchestrator.start();
    const job = await orchestrator.createJob("documents.generate", null);
    const prior = await store.claimJobRun(job.id, {
      input: null,
      queueId: "main",
      step: "documents.generate",
    });
    await store.updateRun(prior.run.id, { status: "cancelled" });

    await expect(orchestrator.getJob(job.id)).resolves.toMatchObject({
      status: "pending",
    });
    const next = await orchestrator.execute(job.id);
    await next.result();
    expect(next.id).not.toBe(prior.run.id);
    expect(
      (await store.listRuns({ links: { jobId: job.id } })).items
    ).toHaveLength(2);
    await orchestrator.stop();
  });

  test("projects Job status for get/list and filters after projection", async () => {
    const { orchestrator, store } = makeOrchestrator();
    const pending = await orchestrator.createJob("pending", null, {
      links: { sessionId: "session-1" },
    });
    const active = await orchestrator.createJob("active", null, {
      links: { sessionId: "session-1" },
    });
    const waiting = await orchestrator.createJob("waiting", null);
    const complete = await orchestrator.createJob("complete", null);
    const activeClaim = await store.claimJobRun(active.id, {
      input: null,
      queueId: "main",
      step: "active",
    });
    const waitingClaim = await store.claimJobRun(waiting.id, {
      input: null,
      queueId: "main",
      step: "waiting",
    });
    const completeClaim = await store.claimJobRun(complete.id, {
      input: null,
      queueId: "main",
      step: "complete",
    });
    await store.updateRun(activeClaim.run.id, { status: "running" });
    await store.updateRun(waitingClaim.run.id, { status: "suspended" });
    await store.updateRun(completeClaim.run.id, { status: "complete" });

    await expect(orchestrator.getJob(waiting.id)).resolves.toMatchObject({
      status: "waiting",
    });
    expect((await orchestrator.listJobs({ status: "active" })).items).toEqual([
      expect.objectContaining({ id: active.id, status: "active" }),
    ]);
    expect(
      (
        await orchestrator.listJobs({
          links: { sessionId: "session-1" },
          status: "pending",
        })
      ).items
    ).toEqual([expect.objectContaining({ id: pending.id, status: "pending" })]);
    await expect(orchestrator.getJob(complete.id)).resolves.toMatchObject({
      status: "complete",
    });
  });

  test("rejects missing and sticky settled Jobs without orphan Runs", async () => {
    const { orchestrator, store } = makeOrchestrator();
    await orchestrator.setup();
    orchestrator.register("documents.generate", (input: null) =>
      Workflow.create({
        execute: async () => null,
        input,
        name: "documents.generate",
      })
    );
    await orchestrator.start();

    await expect(orchestrator.execute("jb-missing")).rejects.toBeInstanceOf(
      JobNotFoundError
    );
    const waiting = await orchestrator.createJob("documents.generate", null);
    const waitingClaim = await store.claimJobRun(waiting.id, {
      input: null,
      queueId: "main",
      step: "documents.generate",
    });
    await store.updateRun(waitingClaim.run.id, { status: "suspended" });
    await expect(orchestrator.execute(waiting.id)).rejects.toBeInstanceOf(
      JobAttemptAlreadyActiveError
    );
    expect(
      (await store.listRuns({ links: { jobId: waiting.id } })).items
    ).toHaveLength(1);
    for (const status of ["complete", "failed", "cancelled"] as const) {
      const job = await orchestrator.createJob("documents.generate", null);
      await store.updateJob(job.id, { status });
      await expect(orchestrator.execute(job.id)).rejects.toBeInstanceOf(
        JobAlreadySettledError
      );
      expect(
        (await store.listRuns({ links: { jobId: job.id } })).items
      ).toEqual([]);
    }
    await orchestrator.stop();
  });

  test("definition and factory failures leave the Job pending and Run-free", async () => {
    const { orchestrator, store } = makeOrchestrator();
    await orchestrator.setup();
    await orchestrator.start();
    const missing = await orchestrator.createJob("missing", null);
    await expect(orchestrator.execute(missing.id)).rejects.toBeInstanceOf(
      DefinitionNotRegisteredError
    );
    expect(
      (await store.listRuns({ links: { jobId: missing.id } })).items
    ).toEqual([]);

    orchestrator.register("broken", () => {
      throw new Error("factory failed");
    });
    const broken = await orchestrator.createJob("broken", null);
    await expect(orchestrator.execute(broken.id)).rejects.toThrow(
      "factory failed"
    );
    expect(
      (await store.listRuns({ links: { jobId: broken.id } })).items
    ).toEqual([]);
    await expect(orchestrator.getJob(broken.id)).resolves.toMatchObject({
      status: "pending",
    });
    await orchestrator.stop();
  });
});
