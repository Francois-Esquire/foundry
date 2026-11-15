import { describe, expect, test } from "vitest";
import { StaleSuspensionRevisionError } from "../errors";
import { Orchestrator } from "../orchestrator";
import type { SuspensionRecord } from "../schema";
import { Workflow } from "../workflow";
import { makeOrchestratorConfig } from "./helpers/config";
import { makeInMemoryStore } from "./helpers/store";

/**
 * A started Orchestrator taking on a parked Run another Orchestrator over
 * the same store let go: the handover a host makes when the process that
 * parked a Run makes way for another that is already running.
 */

const NOT_SUSPENDED = /not suspended/;
const NOT_STARTED = /only once it has started/;

async function pendingSuspension(
  orchestrator: Orchestrator,
  runId: string
): Promise<SuspensionRecord> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const records = await orchestrator.listSuspensions({
      runId,
      status: "pending",
    });
    const found = records.items.at(-1);
    if (found !== undefined) {
      return found;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for a pending suspension");
}

function register(orchestrator: Orchestrator, executed: string[]): void {
  orchestrator.register("approval", (input: string) =>
    Workflow.create({
      execute: async (value, step) => {
        executed.push(`before ${value}`);
        const answer = await step.suspend<string>({
          name: "approval",
          reason: "review",
          request: null,
        });
        executed.push(`after ${answer}`);
        return `${value}: ${answer}`;
      },
      input,
      name: "approval",
    })
  );
}

describe("Orchestrator.adopt", () => {
  test("takes on a Run another Orchestrator parked, and resumes it here once answered", async () => {
    const store = makeInMemoryStore();
    // One queue name, as two hosts of one workspace keep.
    const queue = `test-${crypto.randomUUID()}`;
    const first = new Orchestrator({
      config: makeOrchestratorConfig({ defaultName: queue }),
      store,
    });
    const firstSteps: string[] = [];
    await first.setup();
    register(first, firstSteps);
    await first.start();
    // Already running before the Run exists: its start recovers nothing.
    const second = new Orchestrator({
      config: makeOrchestratorConfig({ defaultName: queue }),
      store,
    });
    const secondSteps: string[] = [];
    await second.setup();
    register(second, secondSteps);
    await second.start();

    const run = await first.run("approval", "ship");
    const suspension = await pendingSuspension(first, run.id);
    const adopted = await second.adopt(run.id);
    expect(adopted?.id).toBe(run.id);
    await second.resolve(suspension.id, "yes");
    await expect(adopted?.result()).resolves.toMatchObject({
      status: "complete",
      value: "ship: yes",
    });
    // It finished here: the first Orchestrator never resumed it.
    expect(secondSteps).toContain("after yes");
    expect(firstSteps).not.toContain("after yes");
    expect((await store.getRun(run.id))?.status).toBe("complete");
    await first.stop();
    await second.stop();
  });

  test("answers null for a Run it does not find, and refuses one not parked or before start", async () => {
    const store = makeInMemoryStore();
    const queue = `test-${crypto.randomUUID()}`;
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig({ defaultName: queue }),
      store,
    });
    await orchestrator.setup();
    orchestrator.register("running", (input: null) =>
      Workflow.create({
        execute: () => new Promise<never>(() => undefined),
        input,
        name: "running",
      })
    );
    await expect(orchestrator.adopt("rn-none")).rejects.toThrow(NOT_STARTED);
    await orchestrator.start();
    expect(await orchestrator.adopt("rn-none")).toBeNull();
    const other = new Orchestrator({
      config: makeOrchestratorConfig({ defaultName: queue }),
      store,
    });
    await other.setup();
    other.register("running", (input: null) =>
      Workflow.create({
        execute: () => new Promise<never>(() => undefined),
        input,
        name: "running",
      })
    );
    await other.start();
    const run = await other.run("running", null);
    const deadline = Date.now() + 10_000;
    while (
      (await store.getRun(run.id))?.status !== "running" &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await expect(orchestrator.adopt(run.id)).rejects.toThrow(NOT_SUSPENDED);
    await other.cancelRun(run.id);
    await orchestrator.stop();
    await other.stop();
  });

  test("refuses as stale an answer the old Orchestrator read before the Run was taken over, and the new one resumes it once", async () => {
    const store = makeInMemoryStore();
    const queue = `test-${crypto.randomUUID()}`;
    const first = new Orchestrator({
      config: makeOrchestratorConfig({ defaultName: queue }),
      store,
    });
    const second = new Orchestrator({
      config: makeOrchestratorConfig({ defaultName: queue }),
      store,
    });
    const firstSteps: string[] = [];
    const secondSteps: string[] = [];
    await first.setup();
    register(first, firstSteps);
    await first.start();
    await second.setup();
    register(second, secondSteps);
    await second.start();

    const run = await first.run("approval", "ship");
    // Read by the old one before the handover; applied after it.
    const read = await pendingSuspension(first, run.id);
    const adopted = await second.adopt(run.id);
    await expect(
      first.resolve(read.id, "late", { expectedRevision: read.revision })
    ).rejects.toThrow(StaleSuspensionRevisionError);
    expect(firstSteps).not.toContain("after late");
    const current = await pendingSuspension(second, run.id);
    await second.resolve(current.id, "yes", {
      expectedRevision: current.revision,
    });
    await expect(adopted?.result()).resolves.toMatchObject({
      status: "complete",
      value: "ship: yes",
    });
    expect(secondSteps.filter((line) => line.startsWith("after"))).toEqual([
      "after yes",
    ]);
    await first.stop();
    await second.stop();
  });
});
