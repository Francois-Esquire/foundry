import { describe, expect, test } from "vitest";

import type { RunLifecycleEvent } from "../logger";

import { Orchestrator } from "../orchestrator";
import { Workflow } from "../workflow";
import { makeOrchestratorConfig } from "./helpers/config";

describe("Orchestrator lifecycle logger", () => {
  test("emits ordered lifecycle events without affecting a run", async () => {
    const events: RunLifecycleEvent[] = [];
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
      logger: { on: (event) => events.push(event) },
    });
    await orchestrator.setup();
    orchestrator.register<string, string>("echo", (input) =>
      Workflow.create({ execute: async (value) => value, input, name: "echo" })
    );
    await orchestrator.start();

    const dispatched = await orchestrator.run("echo", "done");
    await dispatched.result();

    expect(events.map((event) => event.kind)).toEqual([
      "dispatched",
      "started",
      "completed",
    ]);
    expect(events[0]).toMatchObject({ step: "echo", tags: {} });
    expect(events[2]).toMatchObject({ output: "done" });
    await orchestrator.stop();
  });

  test("swallows logger failures", async () => {
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
      logger: {
        on: () => {
          throw new Error("logger failed");
        },
      },
    });
    await orchestrator.setup();
    orchestrator.register<undefined, string>("ok", () =>
      Workflow.create({
        execute: async () => "ok",
        input: undefined,
        name: "ok",
      })
    );
    await orchestrator.start();

    const dispatched = await orchestrator.run("ok", undefined);
    await expect(dispatched.result()).resolves.toMatchObject({
      status: "complete",
      value: "ok",
    });
    await orchestrator.stop();
  });
});
