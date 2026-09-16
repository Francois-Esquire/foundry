/** Public, plain-TypeScript contract for the Workflow runtime handle. */

import { describe, expect, test } from "vitest";
import { bail } from "../types";
import type { WorkflowState } from "../workflow";
import { Workflow } from "../workflow";

async function firstValue<T>(stream: ReadableStream<T>): Promise<T> {
  const reader = stream.getReader();
  try {
    const result = await reader.read();
    if (result.done) {
      throw new Error("Stream ended before emitting a value");
    }
    return result.value;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

async function eventuallyState<I, O>(
  workflow: Workflow<I, O>,
  predicate: (state: WorkflowState) => boolean
): Promise<WorkflowState> {
  const reader = workflow.stateChanges.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        throw new Error("State stream ended unexpectedly");
      }
      if (predicate(next.value)) {
        return next.value;
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

describe("Workflow", () => {
  test("constructs synchronously with queued state", () => {
    const workflow = Workflow.create({
      execute: async () => "ok",
      input: { count: 7 },
      name: "inspectable",
    });

    expect(workflow.name).toBe("inspectable");
    expect(workflow.status).toBe("queued");
    expect(workflow.state.input).toEqual({ count: 7 });
    expect(workflow.state.attempt).toBe(1);
    expect(workflow.state.metadata).toEqual({ workflowName: "inspectable" });
  });

  test("runs with Promises and settles the synchronous state", async () => {
    const workflow = Workflow.create<void, "value">({
      execute: async () => "value" as const,
      input: undefined,
      name: "success",
    });

    await expect(workflow.run()).resolves.toBe("value");
    expect(workflow.status).toBe("complete");
    expect(workflow.state.output).toBe("value");
    expect(workflow.state.startedAt).toBeTypeOf("string");
    expect(workflow.state.completedAt).toBeTypeOf("string");
    await expect(workflow.result()).resolves.toEqual({
      status: "complete",
      value: "value",
    });
  });

  test("uses an explicit run input, including null", async () => {
    const workflow = Workflow.create<string | null, string | null>({
      execute: async (input) => input,
      input: "bound-input",
      name: "nullable-input",
    });

    await expect(workflow.run(null)).resolves.toBeNull();
    expect(workflow.state.input).toBeNull();
  });

  test("rejects runtime failures and records the same terminal failure", async () => {
    const workflow = Workflow.create<void, never>({
      execute: async () => {
        throw new Error("kaboom");
      },
      input: undefined,
      name: "failure",
    });

    await expect(workflow.run()).rejects.toThrow("kaboom");
    expect(workflow.status).toBe("failed");
    const result = await workflow.result();
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.message).toBe("kaboom");
    }
  });

  test("rejects bails while recording a failed result and bail metrics", async () => {
    const workflow = Workflow.create<void, "ok">({
      execute: async () => bail("nope"),
      input: undefined,
      name: "bail",
    });

    await expect(workflow.run()).rejects.toThrow(/bailed/);
    expect(workflow.status).toBe("failed");
    expect(workflow.state.telemetry.metrics.values["workflow.bails"]).toBe(1);
    expect(
      workflow.state.telemetry.metrics.values["workflow.status.failed"]
    ).toBe(1);
  });

  test("result remains pending until the workflow settles", async () => {
    const workflow = Workflow.create<void, "ok">({
      execute: async () => "ok" as const,
      input: undefined,
      name: "deferred-result",
    });
    const pending = workflow.result();

    await expect(
      Promise.race([
        pending.then(() => "settled"),
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve("pending");
          }, 10);
        }),
      ])
    ).resolves.toBe("pending");

    await workflow.run();
    await expect(pending).resolves.toEqual({ status: "complete", value: "ok" });
  });

  test("cancels an in-flight run and preserves the reason", async () => {
    const workflow = Workflow.create<void, "ok">({
      execute: (_input, context) =>
        new Promise<"ok">((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve("ok");
          }, 5000);
          context.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true }
          );
        }),
      input: undefined,
      name: "cancel",
    });

    const running = workflow.run().catch(() => undefined);
    await eventuallyState(workflow, (state) => state.status === "running");
    await workflow.cancel("user-stop");
    await running;

    expect(workflow.status).toBe("cancelled");
    await expect(workflow.result()).resolves.toEqual({
      reason: "user-stop",
      status: "cancelled",
    });
  });

  test("resumes a suspension and completes on the next run", async () => {
    const workflow = Workflow.create<void, string>({
      execute: async (_input, context) => {
        const value = await context.suspend<string>({
          name: "approval",
          reason: "external",
        });
        return `done:${value}`;
      },
      input: undefined,
      name: "resume",
    });

    await expect(workflow.run()).rejects.toThrow();
    expect(workflow.status).toBe("suspended");
    await workflow.resume("approval", "yes");
    expect(workflow.status).toBe("queued");
    await expect(workflow.run()).resolves.toBe("done:yes");
    expect(workflow.status).toBe("complete");
    expect(workflow.state.attempt).toBe(1);
  });

  test("native status and state streams replay their current values", async () => {
    const workflow = Workflow.create<void, "ok">({
      execute: async () => "ok" as const,
      input: undefined,
      name: "streams",
    });
    await workflow.run();

    await expect(firstValue(workflow.statusChanges)).resolves.toBe("complete");
    await expect(firstValue(workflow.stateChanges)).resolves.toMatchObject({
      output: "ok",
      status: "complete",
    });
  });

  test("lifecycle telemetry is visible through synchronous state", async () => {
    const workflow = Workflow.create<void, "ok">({
      execute: async (_input, context) => {
        context.log("info", "working", { phase: 1 });
        return "ok" as const;
      },
      input: undefined,
      name: "telemetry",
    });

    await workflow.run();
    const telemetry = workflow.state.telemetry;
    expect(telemetry.metrics.values["workflow.runs"]).toBe(1);
    expect(telemetry.metrics.values["workflow.completions"]).toBe(1);
    expect(telemetry.metrics.values["workflow.status.complete"]).toBe(1);
    expect(telemetry.logs).toEqual([
      expect.objectContaining({ message: "working", metadata: { phase: 1 } }),
    ]);
  });
});
