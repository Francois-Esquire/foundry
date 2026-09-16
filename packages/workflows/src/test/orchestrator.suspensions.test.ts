import { describe, expect, test } from "vitest";
import {
  StaleSuspensionRevisionError,
  SuspensionAlreadySettledError,
  SuspensionOccurrenceMismatchError,
} from "../errors";
import type { RunExecutionContext } from "../orchestrator";
import { Orchestrator } from "../orchestrator";
import { Step } from "../step";
import type {
  RunFrame,
  RunRecord,
  SuspensionRecord,
  UpdateRunInput,
} from "../store";
import { InMemoryOrchestratorStore } from "../store";
import { Workflow } from "../workflow";
import { makeOrchestratorConfig } from "./helpers/config";
import { makeInMemoryStore } from "./helpers/store";

class FailingParkingStore extends InMemoryOrchestratorStore {
  failParking = false;
  failTerminalUpdate = false;
  #terminalUpdateGate: Promise<void> | null = null;
  #releaseTerminalUpdate: (() => void) | null = null;
  #terminalUpdateStarted: (() => void) | null = null;

  delayTerminalUpdate(): {
    readonly started: Promise<void>;
    readonly release: () => void;
  } {
    const started = new Promise<void>((resolve) => {
      this.#terminalUpdateStarted = resolve;
    });
    this.#terminalUpdateGate = new Promise<void>((resolve) => {
      this.#releaseTerminalUpdate = resolve;
    });
    return {
      release: () => this.#releaseTerminalUpdate?.(),
      started,
    };
  }

  override async updateRun(
    id: string,
    patch: UpdateRunInput
  ): Promise<RunRecord | null> {
    if (patch.status === "failed") {
      this.#terminalUpdateStarted?.();
      if (this.#terminalUpdateGate) {
        await this.#terminalUpdateGate;
      }
      if (this.failTerminalUpdate) {
        throw new Error("injected terminal update failure");
      }
    }
    return super.updateRun(id, patch);
  }

  protected override writeSuspensionParking(input: {
    suspension: SuspensionRecord;
    run: RunRecord;
  }): Promise<void> {
    if (this.failParking) {
      return Promise.reject(new Error("injected parking failure"));
    }
    return super.writeSuspensionParking(input);
  }
}

class FailingCancellationStore extends InMemoryOrchestratorStore {
  failCancellation = false;

  protected override writeSuspensionCancellation(input: {
    previousRun: RunRecord;
    nextRun: RunRecord;
    previousSuspensions: readonly SuspensionRecord[];
    nextSuspensions: readonly SuspensionRecord[];
  }): Promise<void> {
    if (this.failCancellation) {
      return Promise.reject(new Error("injected cancellation failure"));
    }
    return super.writeSuspensionCancellation(input);
  }
}

class FailingResolvedFrameStore extends InMemoryOrchestratorStore {
  failResolvedFrame = false;

  protected override writeFrame(frame: RunFrame): Promise<void> {
    if (
      this.failResolvedFrame &&
      frame.payload.kind === "suspension" &&
      frame.payload.value.status === "resolved"
    ) {
      return Promise.reject(new Error("injected frame failure"));
    }
    return super.writeFrame(frame);
  }
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

describe("Orchestrator first-class Suspensions", () => {
  test("assigns distinct IDs to sequential same-name occurrences and replays values", async () => {
    const store = makeInMemoryStore();
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orchestrator.setup();
    orchestrator.register("two-approvals", (input: null) =>
      Workflow.create({
        execute: async (_value, context) => {
          const first = await context.suspend<string>({
            kind: "approval",
            name: "approval",
            reason: "first",
            request: { position: 0 },
          });
          const second = await context.suspend<string>({
            kind: "approval",
            name: "approval",
            reason: "second",
            request: { position: 1 },
          });
          return [first, second];
        },
        input,
        name: "two-approvals",
      })
    );
    orchestrator.register("quick", (input: string) =>
      Workflow.create({
        execute: async (value) => value,
        input,
        name: "quick",
      })
    );
    await orchestrator.start();

    const run = await orchestrator.run("two-approvals", null);
    const first = await pendingSuspension(orchestrator, run.id);
    expect(first).toMatchObject({
      kind: "approval",
      name: "approval",
      occurrence: 0,
      request: { position: 0 },
      stepPath: ["two-approvals"],
    });
    const quick = await orchestrator.run("quick", "capacity-released");
    await expect(quick.result()).resolves.toMatchObject({
      status: "complete",
      value: "capacity-released",
    });
    await orchestrator.resolve(first.id, "first-value");

    const second = await waitFor(async () => {
      const records = await orchestrator.listSuspensions({ runId: run.id });
      return (
        records.items.find(
          (record) => record.occurrence === 1 && record.status === "pending"
        ) ?? null
      );
    });
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({
      name: "approval",
      occurrence: 1,
      reason: "second",
      request: { position: 1 },
      stepPath: ["two-approvals"],
    });
    await orchestrator.resolve(second.id, "second-value");

    await expect(run.result()).resolves.toMatchObject({
      status: "complete",
      value: ["first-value", "second-value"],
    });
    expect(
      (
        await orchestrator.listSuspensions({
          name: "approval",
          runId: run.id,
          stepPath: ["two-approvals"],
        })
      ).items
    ).toMatchObject([
      { id: first.id, occurrence: 0, status: "resolved" },
      { id: second.id, occurrence: 1, status: "resolved" },
    ]);
    const suspensionFrames = (await store.listRunFrames(run.id)).filter(
      (frame) => frame.payload.kind === "suspension"
    );
    expect(
      suspensionFrames.map((frame) =>
        frame.payload.kind === "suspension"
          ? [frame.payload.value.id, frame.payload.value.status]
          : null
      )
    ).toEqual([
      [first.id, "pending"],
      [first.id, "resolved"],
      [second.id, "pending"],
      [second.id, "resolved"],
    ]);
    await orchestrator.stop();
  });

  test("distinguishes the same suspension name at nested Step paths", async () => {
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
    });
    await orchestrator.setup();
    orchestrator.register("nested-approvals", (input: null) => {
      const alpha = Step.create({
        execute: async (_value, context) =>
          context.suspend<string>({
            name: "approval",
            reason: "alpha review",
            request: null,
          }),
        input,
        name: "alpha",
      });
      const beta = Step.create({
        execute: async (_value, context) =>
          context.suspend<string>({
            name: "approval",
            reason: "beta review",
            request: null,
          }),
        input,
        name: "beta",
      });
      return Workflow.create({
        execute: async (_value, context) => {
          const first = await context.invoke(alpha, null);
          const second = await context.invoke(beta, null);
          return [first, second];
        },
        input,
        name: "nested-approvals",
      });
    });
    await orchestrator.start();
    const run = await orchestrator.run("nested-approvals", null);
    const alpha = await pendingSuspension(orchestrator, run.id);
    expect(alpha.stepPath).toEqual(["nested-approvals", "alpha"]);
    await orchestrator.resolve(alpha.id, "alpha-value");
    const beta = await waitFor(async () => {
      const records = await orchestrator.listSuspensions({
        runId: run.id,
        status: "pending",
      });
      return (
        records.items.find((record) => record.stepPath.at(-1) === "beta") ??
        null
      );
    });
    expect(beta.stepPath).toEqual(["nested-approvals", "beta"]);
    expect(beta.id).not.toBe(alpha.id);
    expect(beta.occurrence).toBe(0);
    await orchestrator.resolve(beta.id, "beta-value");
    await expect(run.result()).resolves.toMatchObject({
      status: "complete",
      value: ["alpha-value", "beta-value"],
    });
    await orchestrator.stop();
  });

  test("commits resolution before replay and accepts only one resolver", async () => {
    const store = makeInMemoryStore();
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orchestrator.setup();
    let contextRunId = "";
    let observedAtReplay: SuspensionRecord | null = null;
    orchestrator.register("single-approval", (input: null, context) => {
      if (!context) {
        throw new Error("expected Run context");
      }
      contextRunId = context.runId;
      return Workflow.create({
        execute: async (_value, step) => {
          const resolution = await step.suspend<string>({
            name: "approval",
            reason: "review",
            request: null,
          });
          const records = await store.listSuspensions({ runId: contextRunId });
          observedAtReplay = records.items[0] ?? null;
          return resolution;
        },
        input,
        name: "single-approval",
      });
    });
    await orchestrator.start();
    const run = await orchestrator.run("single-approval", null);
    const suspension = await pendingSuspension(orchestrator, run.id);

    await expect(
      orchestrator.resolve(suspension.id, "stale", { expectedRevision: 1 })
    ).rejects.toBeInstanceOf(StaleSuspensionRevisionError);
    await expect(
      orchestrator.resolve(suspension.id, new Map() as never)
    ).rejects.toThrow(/JSON value/);
    await expect(
      orchestrator.getSuspension(suspension.id)
    ).resolves.toMatchObject({ revision: 0, status: "pending" });

    const results = await Promise.allSettled([
      orchestrator.resolve(suspension.id, "first"),
      orchestrator.resolve(suspension.id, "second"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(
      rejected?.status === "rejected" ? rejected.reason : null
    ).toBeInstanceOf(SuspensionAlreadySettledError);
    await run.result();
    expect(observedAtReplay).toMatchObject({
      id: suspension.id,
      revision: 1,
      status: "resolved",
    });
    await orchestrator.stop();
  });

  test("cancels a pending occurrence with its Run", async () => {
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
    });
    await orchestrator.setup();
    orchestrator.register("cancel-suspended", (input: null) =>
      Workflow.create({
        execute: async (_value, context) =>
          context.suspend({
            name: "input",
            reason: "waiting",
            request: null,
          }),
        input,
        name: "cancel-suspended",
      })
    );
    await orchestrator.start();
    const run = await orchestrator.run("cancel-suspended", null);
    const suspension = await pendingSuspension(orchestrator, run.id);

    await run.cancel("operator cancelled");
    await waitFor(async () => {
      const record = await orchestrator.getSuspension(suspension.id);
      return record?.status === "cancelled" ? record : null;
    });
    await expect(
      orchestrator.resolve(suspension.id, "too-late")
    ).rejects.toBeInstanceOf(SuspensionAlreadySettledError);
    await orchestrator.stop();
  });

  test("rejects legacy name-wide resume on authority-managed handles", async () => {
    const store = makeInMemoryStore();
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orchestrator.setup();
    orchestrator.register("authority-only", (input: null) =>
      Workflow.create({
        execute: async (_value, context) =>
          context.suspend<string>({
            name: "approval",
            reason: "review",
            request: null,
          }),
        input,
        name: "authority-only",
      })
    );
    await orchestrator.start();
    const run = await orchestrator.run("authority-only", null);
    const suspension = await pendingSuspension(orchestrator, run.id);

    await expect(run.resume("approval", "bypass")).rejects.toThrow(
      /Orchestrator\.resolve/
    );
    await expect(store.getRun(run.id)).resolves.toMatchObject({
      status: "suspended",
    });
    await expect(
      orchestrator.getSuspension(suspension.id)
    ).resolves.toMatchObject({ revision: 0, status: "pending" });

    await orchestrator.resolve(suspension.id, "approved");
    await expect(run.result()).resolves.toMatchObject({
      status: "complete",
      value: "approved",
    });
    await orchestrator.stop();
  });

  test("does not expose a suspended Run when authority parking fails", async () => {
    const store = new FailingParkingStore();
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orchestrator.setup();
    orchestrator.register("parking-fails", (input: null) =>
      Workflow.create({
        execute: async (_value, context) =>
          context.suspend({
            name: "approval",
            reason: "review",
            request: null,
          }),
        input,
        name: "parking-fails",
      })
    );
    let suspendedEvents = 0;
    orchestrator.on("suspended", () => {
      suspendedEvents += 1;
    });
    store.failParking = true;
    const terminalUpdate = store.delayTerminalUpdate();
    await orchestrator.start();
    const run = await orchestrator.run("parking-fails", null);

    const result = run.result();
    await terminalUpdate.started;
    await expect(
      Promise.race([
        result.then(() => "settled"),
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve("pending");
          }, 15);
        }),
      ])
    ).resolves.toBe("pending");
    terminalUpdate.release();
    await waitFor(async () => {
      const record = await store.getRun(run.id);
      return record?.status === "failed" ? record : null;
    });
    await expect(result).resolves.toMatchObject({
      error: { message: "injected parking failure" },
      status: "failed",
    });
    await expect(orchestrator.drain()).resolves.toBeUndefined();
    expect(
      (await orchestrator.listSuspensions({ runId: run.id })).items
    ).toEqual([]);
    expect(suspendedEvents).toBe(0);
    await orchestrator.stop();
  });

  test("stops the Queue without settling a Run when parking and terminal persistence both fail", async () => {
    const store = new FailingParkingStore();
    const defaultName = "fatal-persistence-recovery";
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig({ defaultName }),
      store,
    });
    await orchestrator.setup();
    orchestrator.register("store-offline", (input: null) =>
      Workflow.create({
        execute: async (_value, context) =>
          context.suspend({
            name: "approval",
            reason: "review",
            request: null,
          }),
        input,
        name: "store-offline",
      })
    );
    const queueFailure = new Promise<void>((resolve) => {
      orchestrator.on("queue_failed", () => {
        resolve();
      });
    });
    store.failParking = true;
    store.failTerminalUpdate = true;
    await orchestrator.start();
    const run = await orchestrator.run("store-offline", null);

    await queueFailure;
    const durable = await store.getRun(run.id);
    expect(["queued", "running"]).toContain(durable?.status);
    expect(
      (await orchestrator.listSuspensions({ runId: run.id })).items
    ).toEqual([]);
    expect(run.status).toBe("suspended");
    await expect(
      Promise.race([
        run.result().then(() => "settled"),
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve("pending");
          }, 15);
        }),
      ])
    ).resolves.toBe("pending");

    await expect(orchestrator.resume()).rejects.toThrow(/restart recovery/);
    await expect(orchestrator.run("store-offline", null)).rejects.toThrow(
      /restart recovery/
    );

    store.failParking = false;
    store.failTerminalUpdate = false;
    await orchestrator.stop({ graceMs: 25 });

    const recoveredOrchestrator = new Orchestrator({
      config: makeOrchestratorConfig({ defaultName }),
      store,
    });
    await recoveredOrchestrator.setup();
    recoveredOrchestrator.register("store-offline", (input: null) =>
      Workflow.create({
        execute: async (_value, context) =>
          context.suspend<string>({
            name: "approval",
            reason: "review",
            request: null,
          }),
        input,
        name: "store-offline",
      })
    );
    await recoveredOrchestrator.start();
    const recovered = await recoveredOrchestrator.get(run.id);
    if (!recovered) {
      throw new Error("expected recovered Run");
    }
    const suspension = await pendingSuspension(recoveredOrchestrator, run.id);
    await recoveredOrchestrator.resolve(suspension.id, "recovered");
    await expect(recovered.result()).resolves.toMatchObject({
      status: "complete",
      value: "recovered",
    });
    await recoveredOrchestrator.stop();
  });

  test("keeps Run and Suspension authority intact when atomic cancellation fails", async () => {
    const store = new FailingCancellationStore();
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orchestrator.setup();
    orchestrator.register("cancel-fails", (input: null) =>
      Workflow.create({
        execute: async (_value, context) =>
          context.suspend({
            name: "approval",
            reason: "review",
            request: null,
          }),
        input,
        name: "cancel-fails",
      })
    );
    await orchestrator.start();
    const run = await orchestrator.run("cancel-fails", null);
    const suspension = await pendingSuspension(orchestrator, run.id);
    store.failCancellation = true;

    await expect(run.cancel("operator cancelled")).rejects.toThrow(
      "injected cancellation failure"
    );
    await expect(store.getRun(run.id)).resolves.toMatchObject({
      status: "suspended",
    });
    await expect(
      orchestrator.getSuspension(suspension.id)
    ).resolves.toMatchObject({ revision: 0, status: "pending" });
    expect(run.status).toBe("suspended");

    store.failCancellation = false;
    await orchestrator.resolve(suspension.id, "approved after retry");
    await expect(run.result()).resolves.toMatchObject({
      status: "complete",
      value: "approved after retry",
    });
    await orchestrator.stop();
  });

  test("replays a committed resolution even when its observation frame fails", async () => {
    const store = new FailingResolvedFrameStore();
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orchestrator.setup();
    orchestrator.register("frame-fails", (input: null) =>
      Workflow.create({
        execute: async (_value, context) =>
          context.suspend<string>({
            name: "approval",
            reason: "review",
            request: null,
          }),
        input,
        name: "frame-fails",
      })
    );
    await orchestrator.start();
    const run = await orchestrator.run("frame-fails", null);
    const suspension = await pendingSuspension(orchestrator, run.id);
    store.failResolvedFrame = true;

    await expect(
      orchestrator.resolve(suspension.id, "approved")
    ).resolves.toMatchObject({ status: "resolved" });
    await expect(run.result()).resolves.toMatchObject({
      status: "complete",
      value: "approved",
    });
    await expect(store.getRun(run.id)).resolves.toMatchObject({
      status: "complete",
    });
    await orchestrator.stop();
  });

  test("serializes concurrent resolution and Run cancellation", async () => {
    const store = makeInMemoryStore();
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
      store,
    });
    await orchestrator.setup();
    orchestrator.register("cancel-race", (input: null) =>
      Workflow.create({
        execute: async (_value, context) =>
          context.suspend({
            name: "input",
            reason: "waiting",
            request: null,
          }),
        input,
        name: "cancel-race",
      })
    );
    await orchestrator.start();
    const run = await orchestrator.run("cancel-race", null);
    const suspension = await pendingSuspension(orchestrator, run.id);

    const [resolution, cancellation] = await Promise.allSettled([
      orchestrator.resolve(suspension.id, "resolved"),
      run.cancel("cancel won or followed resolution"),
    ]);
    expect(cancellation.status).toBe("fulfilled");
    if (resolution.status === "rejected") {
      expect(resolution.reason).toBeInstanceOf(SuspensionAlreadySettledError);
    }
    await expect(store.getRun(run.id)).resolves.toMatchObject({
      status: "cancelled",
    });
    const settled = await orchestrator.getSuspension(suspension.id);
    expect(["resolved", "cancelled"]).toContain(settled?.status);
    await orchestrator.stop();
  });

  test("rejects malformed requests without creating Suspension authority", async () => {
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
    });
    await orchestrator.setup();
    orchestrator.register("malformed", (input: null) =>
      Workflow.create({
        execute: async (_value, context) => {
          await context.suspend({
            name: "bad",
            reason: "bad request",
            request: new Map() as never,
          });
          return null;
        },
        input,
        name: "malformed",
      })
    );
    await orchestrator.start();

    const run = await orchestrator.run("malformed", null);
    await expect(run.result()).resolves.toMatchObject({ status: "failed" });
    expect(
      (await orchestrator.listSuspensions({ runId: run.id })).items
    ).toEqual([]);
    await orchestrator.stop();
  });

  test("parks pending recovery without executing and resumes the same occurrence", async () => {
    const store = makeInMemoryStore();
    let executions = 0;
    const register = (orchestrator: Orchestrator): void => {
      orchestrator.register("recover-pending", (input: null) =>
        Workflow.create({
          execute: async (_value, context) => {
            executions += 1;
            return context.suspend<string>({
              name: "callback",
              reason: "external callback",
              request: { token: "one" },
            });
          },
          input,
          name: "recover-pending",
        })
      );
    };
    const first = new Orchestrator({
      config: makeOrchestratorConfig({ defaultName: "recovery-pending" }),
      store,
    });
    await first.setup();
    register(first);
    await first.start();
    const run = await first.run("recover-pending", null);
    const suspension = await pendingSuspension(first, run.id);
    expect(executions).toBe(1);
    await first.stop();

    const second = new Orchestrator({
      config: makeOrchestratorConfig({ defaultName: "recovery-pending" }),
      store,
    });
    await second.setup();
    register(second);
    await second.start();
    expect(executions).toBe(1);
    await expect(second.getSuspension(suspension.id)).resolves.toMatchObject({
      status: "pending",
    });

    await second.resolve(suspension.id, "continued");
    const recovered = await second.get(run.id);
    if (!recovered) {
      throw new Error("expected recovered Run");
    }
    await expect(recovered.result()).resolves.toMatchObject({
      status: "complete",
      value: "continued",
    });
    expect(executions).toBe(2);
    expect(
      (await second.listSuspensions({ runId: run.id })).items
    ).toHaveLength(1);
    await second.stop();
  });

  test("seeds a resolved occurrence after a crash before live requeue", async () => {
    const store = makeInMemoryStore();
    let executions = 0;
    let contextSeen: RunExecutionContext | null = null;
    const register = (orchestrator: Orchestrator): void => {
      orchestrator.register("recover-resolved", (input: null, context) => {
        contextSeen = context ?? null;
        return Workflow.create({
          execute: async (_value, step) => {
            executions += 1;
            return step.suspend<string>({
              name: "callback",
              reason: "external callback",
              request: null,
            });
          },
          input,
          name: "recover-resolved",
        });
      });
    };
    const first = new Orchestrator({
      config: makeOrchestratorConfig({ defaultName: "recovery-resolved" }),
      store,
    });
    await first.setup();
    register(first);
    await first.start();
    const run = await first.run("recover-resolved", null);
    const suspension = await pendingSuspension(first, run.id);
    await first.stop();

    await store.settleSuspension(suspension.id, {
      expectedRevision: 0,
      outcome: { resolution: "stored", status: "resolved" },
    });
    const second = new Orchestrator({
      config: makeOrchestratorConfig({ defaultName: "recovery-resolved" }),
      store,
    });
    await second.setup();
    register(second);
    await second.start();
    const recovered = await second.get(run.id);
    if (!recovered) {
      throw new Error("expected recovered Run");
    }
    await expect(recovered.result()).resolves.toMatchObject({
      status: "complete",
      value: "stored",
    });
    expect(contextSeen).toMatchObject({ runId: run.id });
    expect(executions).toBe(2);
    expect(
      (await second.listSuspensions({ runId: run.id })).items
    ).toHaveLength(1);
    await second.stop();
  });

  test("refuses to rebind one occurrence address to different request data", async () => {
    const store = makeInMemoryStore();
    const run = await store.createRun({
      input: null,
      queueId: "main",
      step: "approval",
    });
    await store.parkSuspension({
      kind: "approval",
      name: "review",
      occurrence: 0,
      reason: "review",
      request: { revision: 1 },
      runId: run.id,
      stepPath: ["approval"],
    });

    await expect(
      store.parkSuspension({
        kind: "approval",
        name: "review",
        occurrence: 0,
        reason: "review",
        request: { revision: 2 },
        runId: run.id,
        stepPath: ["approval"],
      })
    ).rejects.toBeInstanceOf(SuspensionOccurrenceMismatchError);
  });
});
