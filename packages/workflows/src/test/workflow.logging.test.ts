/** Workflow logging and audit behavior through the public Promise API. */

import { describe, expect, test } from "vitest";
import { createEvlogSink } from "../evlog-sink";
import type { StepContext } from "../step-types";
import type { AuditOutcome, LogSink, TelemetryLogEntry } from "../telemetry";
import { Workflow } from "../workflow";

describe("Workflow logging", () => {
  test("ctx.log lands path-scoped in state telemetry", async () => {
    const workflow = Workflow.create<void, "ok">({
      execute: (_input, context: StepContext<void, "ok">) => {
        context.log("info", "starting work", { phase: "begin" });
        context.log("warn", "heads up");
        return Promise.resolve("ok" as const);
      },
      input: undefined,
      name: "logger",
    });

    await workflow.run();

    const logs = workflow.state.telemetry.logs;
    const info = logs.find((entry) => entry.message === "starting work");
    expect(logs).toHaveLength(2);
    expect(info).toMatchObject({
      level: "info",
      metadata: { phase: "begin" },
      path: ["logger"],
    });
    expect(info?.stepId).toBeTypeOf("string");
  });

  test("the swappable sink records lines and settles exactly once", async () => {
    const recorded: TelemetryLogEntry[] = [];
    const settled: AuditOutcome[] = [];
    const sink: LogSink = {
      record: (entry) => recorded.push(entry),
      settle: (outcome) => settled.push(outcome),
    };
    const workflow = Workflow.create<void, "ok">({
      execute: (_input, context: StepContext<void, "ok">) => {
        context.log("info", "one");
        context.log("error", "two");
        return Promise.resolve("ok" as const);
      },
      input: undefined,
      name: "audited",
    });
    workflow.setAuditSink(sink);
    workflow.setRunId("rn_durable_123");

    await workflow.run();

    expect(recorded.map((entry) => entry.message)).toEqual(["one", "two"]);
    expect(settled).toEqual([
      expect.objectContaining({
        runId: "rn_durable_123",
        status: "complete",
      }),
    ]);
  });

  test("the evlog sink can be installed without changing execution", async () => {
    const workflow = Workflow.create<void, "ok">({
      execute: (_input, context: StepContext<void, "ok">) => {
        context.log("info", "audited line", { user: "u1" });
        return Promise.resolve("ok" as const);
      },
      input: undefined,
      name: "evlog-run",
    });
    workflow.setAuditSink(
      createEvlogSink({ name: workflow.name, runId: workflow.root.id })
    );

    await expect(workflow.run()).resolves.toBe("ok");
  });
});
