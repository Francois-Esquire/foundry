import { describe, expect, test, vi } from "vitest";

import { ExecutionCoordinator } from "../execution-coordinator";
import { Orchestrator } from "../orchestrator";
import { createInMemoryExecutionPersistence } from "../persistence";
import { Workflow } from "../workflow";
import { makeOrchestratorConfig } from "./helpers/config";

describe("transactional admission", () => {
  test("admission returns an indexed handle before behavior on a later host turn", async () => {
    const runtime = new Orchestrator({
      admissionParticipant: async () => null,
      config: makeOrchestratorConfig(),
      persistence: createInMemoryExecutionPersistence(),
    });
    let executed = false;
    runtime.register("ordered", (input) =>
      Workflow.create({
        execute: async () => {
          executed = true;
          return null;
        },
        input,
        name: "ordered",
      })
    );
    await runtime.setup();
    await runtime.start();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const job = await runtime.createJob("ordered", null);
      const run = await runtime.execute(job.id);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(executed).toBe(false);
      expect(await runtime.get(run.id)).not.toBeNull();
      await vi.advanceTimersByTimeAsync(0);
      await run.result();
      expect(executed).toBe(true);
    } finally {
      vi.useRealTimers();
      await runtime.stop();
    }
  });
  test("cancellation records its decision with participant effects before abort", async () => {
    const persistence = createInMemoryExecutionPersistence();
    let executed = false;
    const runtime = new Orchestrator({
      cancellationParticipant: async ({ run, persistence: bound }) => {
        if (run.status === "cancelled") {
          return run;
        }
        await bound.journal.claimRunEffect({
          key: "cancel-decision",
          runId: run.id,
        });
        const store = new ExecutionCoordinator(bound.repository, bound.journal);
        return (await store.cancelRun(run.id)).run;
      },
      config: makeOrchestratorConfig(),
      persistence: { ...persistence, afterCommit: (operation) => operation() },
    });
    runtime.register("cancel", (input) =>
      Workflow.create({
        execute: async () => {
          executed = true;
          return null;
        },
        input,
        name: "cancel",
      })
    );
    await runtime.setup();
    await runtime.start();
    await runtime.pause();
    try {
      const job = await runtime.createJob("cancel", null);
      const run = await runtime.execute(job.id);
      expect((await runtime.cancelRun(run.id)).status).toBe("cancelled");
      expect(run.status).toBe("cancelled");
      expect((await persistence.repository.getRun(run.id))?.status).toBe(
        "cancelled"
      );
      expect(
        (await persistence.journal.listRunFrames(run.id)).some(
          (frame) => frame.payload.kind === "log"
        )
      ).toBe(true);
      expect(executed).toBe(false);
    } finally {
      await runtime.stop();
    }
  });
  test("cold dispatch invokes the participant before executing a retained Run", async () => {
    const persistence = createInMemoryExecutionPersistence();
    const config = makeOrchestratorConfig();
    const first = new Orchestrator({ config, persistence });
    await first.setup();
    await first.start();
    const job = await first.createJob("cold", null);
    const queue = (await first.listQueueDiagnostics())[0];
    if (!queue) {
      throw new Error("Expected queue");
    }
    const claimed = await first.store.claimJobRun(job.id, {
      definition: { name: "cold" },
      input: null,
      queueId: queue.id,
      step: "cold",
    });
    await first.stop();
    const events: string[] = [];
    const second = new Orchestrator({
      admissionParticipant: async ({ run, persistence: bound }) => {
        events.push("admit");
        await bound.journal.claimRunEffect({
          key: "cold-admit",
          runId: run.id,
        });
        return run.id;
      },
      config,
      persistence,
    });
    second.register("cold", (input) =>
      Workflow.create({
        execute: async () => {
          events.push("execute");
          return null;
        },
        input,
        name: "cold",
      })
    );
    await second.setup();
    try {
      await second.start();
      const recovered = await second.get(claimed.run.id);
      if (!recovered) {
        throw new Error("Expected recovered Run");
      }
      await recovered.result();
      expect(events).toEqual(["admit", "execute"]);
    } finally {
      await second.stop();
    }
  });
  test("participant failure rolls back claim and receipt before dispatch; retry admits", async () => {
    const persistence = createInMemoryExecutionPersistence();
    let refuse = true;
    let executed = 0;
    const runtime = new Orchestrator({
      admissionParticipant: async ({ run, persistence: transaction }) => {
        await transaction.journal.claimRunEffect({
          key: "admit",
          runId: run.id,
        });
        await transaction.journal.appendRunFrame({
          payload: { kind: "output", value: { receipt: run.id } },
          runId: run.id,
        });
        if (refuse) {
          throw new Error("admission fault");
        }
        return run.id;
      },
      config: makeOrchestratorConfig(),
      persistence,
    });
    runtime.register("example", (input) =>
      Workflow.create({
        execute: async () => {
          executed += 1;
          return "done";
        },
        input,
        name: "example",
      })
    );
    await runtime.setup();
    await runtime.start();
    try {
      const job = await runtime.createJob("example", null);
      await expect(runtime.execute(job.id)).rejects.toThrow("admission fault");
      expect(persistence.snapshot().runs).toEqual([]);
      expect(persistence.snapshot().frames).toEqual([]);
      expect(executed).toBe(0);
      refuse = false;
      const run = await runtime.execute(job.id);
      expect(executed).toBe(0);
      await Promise.resolve();
      expect(executed).toBe(0);
      expect(await runtime.get(run.id)).not.toBeNull();
      await expect(run.result()).resolves.toEqual({
        status: "complete",
        value: "done",
      });
      expect(executed).toBe(1);
      expect(
        (await persistence.journal.listRunFrames(run.id))[0]?.payload
      ).toMatchObject({
        kind: "log",
        value: { event: "run-effect-claimed", key: "admit" },
      });
    } finally {
      await runtime.stop();
    }
  });
});
