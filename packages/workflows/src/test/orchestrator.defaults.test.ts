import { Config } from "@foundry/lib/config";
import { describe, expect, test } from "vitest";

import { Orchestrator } from "../orchestrator";
import { createInMemoryExecutionPersistence } from "../persistence";
import { InMemoryOrchestratorStore } from "../store";
import { Workflow } from "../workflow";

describe("Orchestrator defaults", () => {
  test("accepts composed persistence without exposing a Store escape hatch", () => {
    const persistence = createInMemoryExecutionPersistence();
    const config = new Config();
    const orchestrator = new Orchestrator({ config, persistence });

    expect("store" in persistence).toBe(false);
    expect(orchestrator.store).toBeDefined();
    expect(
      () =>
        new Orchestrator({
          config,
          persistence,
          store: new InMemoryOrchestratorStore(),
        })
    ).toThrow(/either persistence or store/);
  });
  test("uses an in-memory store that carries namespaced queue and run extensions", async () => {
    const extensions = {
      "engine.workspace": { id: "workspace-42" },
      "foundry.task": { attempt: 2, id: "task-17" },
    };
    const orchestrator = new Orchestrator({
      config: new Config(),
      queueExtensions: extensions,
    });

    expect(orchestrator.store).toBeInstanceOf(InMemoryOrchestratorStore);

    await orchestrator.setup();
    orchestrator.register("zero-config", (input: { message: string }) =>
      Workflow.create({
        execute: async () => null,
        input,
        name: "zero-config",
      })
    );
    await orchestrator.start();
    const dispatched = await orchestrator.run(
      "zero-config",
      { message: "hello" },
      { extensions }
    );
    const [queue] = await orchestrator.store.listQueues();
    const run = await orchestrator.store.getRun(dispatched.id);

    expect(queue?.extensions).toEqual(extensions);
    expect(run?.extensions).toEqual(extensions);
    await orchestrator.stop();
  });
});
