import { Config } from "@foundry/lib/config";
import { describe, expect, test } from "vitest";
import { ExecutionCoordinator } from "../index";
import { Orchestrator } from "../orchestrator";
import { MemoryWorkflowStore } from "../store/memory";
import { Workflow } from "../workflow";
import { withoutTransaction } from "./helpers/workflow-stores";

const TRANSACTIONS_PATTERN = /store that offers transactions/;

describe("Orchestrator defaults", () => {
  test("refuses participants over a store without transactions", () => {
    const config = new Config();
    const store = new ExecutionCoordinator({
      store: withoutTransaction(new MemoryWorkflowStore()),
    });

    expect(store.transaction).toBeUndefined();
    expect(
      () =>
        new Orchestrator({
          cancellationParticipant: () => Promise.resolve(null),
          config,
          store,
        })
    ).toThrow(TRANSACTIONS_PATTERN);
    expect(new Orchestrator({ config, store }).store).toBe(store);
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

    expect(orchestrator.store).toBeInstanceOf(ExecutionCoordinator);

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
