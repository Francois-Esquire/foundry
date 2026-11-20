import { describe, expect, test } from "vitest";
import { Orchestrator } from "../orchestrator";
import type { SuspensionRecord } from "../schema";
import { Workflow } from "../workflow";
import { makeOrchestratorConfig } from "./helpers/config";
import { makeInMemoryStore } from "./helpers/store";

const NOT_PARKED = /not parked/;

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const found = await read();
    if (found !== undefined) {
      return found;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

function pendingSuspension(
  orchestrator: Orchestrator,
  runId: string
): Promise<SuspensionRecord> {
  return until(async () => {
    const records = await orchestrator.listSuspensions({
      runId,
      status: "pending",
    });
    return records.items.at(-1);
  });
}

async function started(
  store: ReturnType<typeof makeInMemoryStore>,
  queue: string,
  executed: string[]
): Promise<Orchestrator> {
  const orchestrator = new Orchestrator({
    config: makeOrchestratorConfig({ defaultName: queue }),
    store,
  });
  await orchestrator.setup();
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
  orchestrator.register("running", (input: null) =>
    Workflow.create({
      execute: () => new Promise<never>(() => undefined),
      input,
      name: "running",
    })
  );
  await orchestrator.start();
  return orchestrator;
}

describe("Orchestrator.forget", () => {
  test("drops a parked Run it took on, so it takes the Run on again and resumes it once", async () => {
    const store = makeInMemoryStore();
    const queue = `test-${crypto.randomUUID()}`;
    const firstSteps: string[] = [];
    const secondSteps: string[] = [];
    const first = await started(store, queue, firstSteps);
    const second = await started(store, queue, secondSteps);

    const run = await first.run("approval", "ship");
    await pendingSuspension(first, run.id);
    const dropped = await second.adopt(run.id);
    expect(dropped?.id).toBe(run.id);

    expect(await second.forget(run.id)).toBe(true);
    expect(await second.get(run.id)).toBeNull();
    expect(await second.forget(run.id)).toBe(false);
    expect((await store.getRun(run.id))?.status).toBe("suspended");

    const adopted = await second.adopt(run.id);
    expect(adopted).not.toBe(dropped);
    const suspension = await pendingSuspension(second, run.id);
    await second.resolve(suspension.id, "yes");
    await expect(adopted?.result()).resolves.toMatchObject({
      status: "complete",
      value: "ship: yes",
    });
    expect(secondSteps.filter((each) => each === "after yes")).toHaveLength(1);
    expect(firstSteps).not.toContain("after yes");
    expect(dropped?.status).toBe("suspended");
    expect((await store.getRun(run.id))?.status).toBe("complete");
    await first.stop();
    await second.stop();
  });

  test("answers false for a Run it does not hold, and refuses one that is not parked", async () => {
    const store = makeInMemoryStore();
    const queue = `test-${crypto.randomUUID()}`;
    const orchestrator = await started(store, queue, []);
    expect(await orchestrator.forget("rn-none")).toBe(false);

    const run = await orchestrator.run("running", null);
    await until(async () =>
      (await store.getRun(run.id))?.status === "running" ? true : undefined
    );
    await expect(orchestrator.forget(run.id)).rejects.toThrow(NOT_PARKED);
    expect(await orchestrator.get(run.id)).not.toBeNull();
    await orchestrator.cancelRun(run.id);
    await orchestrator.stop();
  });
});
