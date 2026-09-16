/**
 * Queue telemetry — counters track the lifecycle events the Queue
 * already emits, and the optional `logger` option receives the same
 * events the in-memory ring buffer does.
 */

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { Queue } from "../queue";
import { Workflow } from "../workflow";
import { makeInMemoryStore } from "./helpers/store";

async function dispatchAndAwait<O>(
  spec: Parameters<typeof Workflow.create<unknown, O>>[0],
  queue: Queue
): Promise<unknown> {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const wf = Workflow.create(spec);
        const run = queue.dispatch(wf);
        return yield* Effect.promise(() => run.result());
      })
    )
  );
  // Wait for the queue to finish settling lifecycle counters before
  // tests inspect telemetry.
  await queue.drain();
  return result;
}

describe("Queue telemetry", () => {
  describe("counters", () => {
    it("dispatch increments queue.runs.dispatched", async () => {
      const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
      await dispatchAndAwait(
        {
          execute: async () => "ok",
          input: undefined,
          name: "one",
        },
        queue
      );
      const { values } = queue.telemetry.metrics;
      expect(values["queue.runs.dispatched"]).toBe(1);
    });

    it("a successful run bumps started + complete", async () => {
      const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
      await dispatchAndAwait(
        {
          execute: async () => 42,
          input: undefined,
          name: "happy",
        },
        queue
      );
      const { values } = queue.telemetry.metrics;
      expect(values["queue.runs.started"]).toBe(1);
      expect(values["queue.runs.complete"]).toBe(1);
      expect(values["queue.runs.failed"]).toBeUndefined();
    });

    it("a failing run bumps queue.runs.failed", async () => {
      const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
      try {
        await dispatchAndAwait(
          {
            execute: async () => {
              throw new Error("boom");
            },
            input: undefined,
            name: "boom",
          },
          queue
        );
      } catch {
        /* expected */
      }
      const { values } = queue.telemetry.metrics;
      expect(values["queue.runs.failed"]).toBe(1);
      expect(values["queue.runs.complete"]).toBeUndefined();
    });

    it("counters accumulate across multiple dispatches", async () => {
      const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
      await dispatchAndAwait(
        { execute: async () => 1, input: undefined, name: "a" },
        queue
      );
      await dispatchAndAwait(
        { execute: async () => 2, input: undefined, name: "b" },
        queue
      );
      const { values } = queue.telemetry.metrics;
      expect(values["queue.runs.dispatched"]).toBe(2);
      expect(values["queue.runs.complete"]).toBe(2);
    });
  });

  describe("logs", () => {
    it("appends an info entry per lifecycle event", async () => {
      const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
      await dispatchAndAwait(
        {
          execute: async () => "done",
          input: undefined,
          name: "logged",
        },
        queue
      );
      const messages = queue.telemetry.logs.map((l) => l.message);
      expect(messages).toContain("Run dispatched");
      expect(messages).toContain("Run started");
      expect(messages).toContain("Run complete");
    });
  });

  describe("lifecycle logging", () => {
    it("forwards lifecycle events to the user-supplied logger", async () => {
      const logger = {
        on: vi.fn(),
      };
      const queue = new Queue({
        concurrency: 1,
        logger,
        store: makeInMemoryStore(),
      });
      await dispatchAndAwait(
        {
          execute: async () => "ok",
          input: undefined,
          name: "forwarded",
        },
        queue
      );
      const kinds = logger.on.mock.calls.map(
        ([event]) => (event as { kind: string }).kind
      );
      expect(kinds).toEqual(["dispatched", "started", "completed"]);
    });
  });
});
