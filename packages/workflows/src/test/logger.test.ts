import { describe, expect, test } from "vitest";

import type { RunLifecycleEvent } from "../logger";

import { BaseOrchestratorLogger } from "../logger";

const events: RunLifecycleEvent[] = [
  { kind: "dispatched", runId: "run-1", step: "publish", tags: {} },
  { kind: "started", runId: "run-1" },
  { at: "wait", kind: "suspended", runId: "run-1" },
  { at: "wait", kind: "resumed", runId: "run-1" },
  { kind: "completed", output: "done", runId: "run-1" },
  { error: { message: "nope", name: "Error" }, kind: "failed", runId: "run-1" },
  { kind: "cancelled", runId: "run-1" },
  { kind: "recovered", runId: "run-1" },
];

describe("BaseOrchestratorLogger", () => {
  test("is a no-op for every lifecycle event", () => {
    const logger = new BaseOrchestratorLogger();

    for (const event of events) {
      expect(() => {
        logger.on(event);
      }).not.toThrow();
    }
  });

  test("fans out only to the overridden event hook", () => {
    class CompletedLogger extends BaseOrchestratorLogger {
      readonly completedEvents: Extract<
        RunLifecycleEvent,
        { kind: "completed" }
      >[] = [];

      protected override completed(
        event: Extract<RunLifecycleEvent, { kind: "completed" }>
      ): void {
        this.completedEvents.push(event);
      }
    }

    const logger = new CompletedLogger();
    for (const event of events) {
      logger.on(event);
    }

    expect(logger.completedEvents).toEqual([
      { kind: "completed", output: "done", runId: "run-1" },
    ]);
  });
});
