import { Config } from "@foundry/lib/config";
import { describe, expect, test } from "vitest";
import { ExecutionCoordinator } from "../index";
import { Orchestrator } from "../orchestrator";
import { Queue } from "../queue";
import type { WorkflowStore } from "../store/index";
import { MemoryWorkflowStore } from "../store/memory";
import { SqliteWorkflowStore } from "../store/sqlite";
import { Workflow } from "../workflow";
import { libsqlDatabases } from "./helpers/sqlite";
import { withoutTransaction } from "./helpers/workflow-stores";

const memory = libsqlDatabases("memory");

const HOST_REFUSAL =
  /cannot run over a store whose commits a host transaction may roll back \(durability "host"\)/;

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
  test("refuses a store whose commits a host transaction may roll back", async () => {
    const config = new Config();
    const hostStores: WorkflowStore[] = [
      new SqliteWorkflowStore({
        database: await memory.open(),
        durability: "host",
        scope: "s",
      }),
    ];
    await new MemoryWorkflowStore().transaction((view) => {
      hostStores.push(view);
      return Promise.resolve();
    });
    for (const workflowStore of hostStores) {
      const store = new ExecutionCoordinator({ store: workflowStore });
      expect(store.durability).toBe("host");
      expect(() => new Orchestrator({ config, store })).toThrow(HOST_REFUSAL);
      expect(() => new Queue({ concurrency: 1, store })).toThrow(HOST_REFUSAL);
    }
    const durable = new ExecutionCoordinator({
      store: new SqliteWorkflowStore({
        database: await memory.open(),
        scope: "s",
      }),
    });
    expect(new Orchestrator({ config, store: durable }).store).toBe(durable);
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
