import { Deferred, Effect, TestClock, TestContext } from "effect";
import { describe, expect, test } from "vitest";
import { createQueueClient } from "../client";
import type { RunOutcome } from "../domain";
import type { RunContext } from "../queue";
import {
  awaitJob,
  flush,
  handler,
  sharedStore,
  testQueue,
  withQueue,
} from "./helpers/queue";

const approval = (context: RunContext): Effect.Effect<RunOutcome> =>
  Effect.gen(function* () {
    const answer = context.resolvedWaits.get("approval");
    if (answer === undefined) {
      yield* Effect.orDie(context.saveCheckpoint({ step: "asked" }));
      return {
        kind: "parked",
        wait: {
          key: "approval",
          kind: "human",
          reason: "needs sign-off",
          request: { question: "ship?" },
        },
      };
    }
    return {
      kind: "completed",
      output: { answer, checkpoint: context.checkpoint ?? null },
    };
  });

const dead = { pid: 1, started: "gone" } as const;
const alive = { pid: 2, started: "here" } as const;

describe("Queue lifecycle", () => {
  test("a parked run frees its slot and resumes with its checkpoint and resolved wait", async () => {
    const result = await testQueue(
      (queue) =>
        Effect.gen(function* () {
          yield* queue.register("work", approval);
          const parked = yield* queue.submit({ handler });
          const waiting = yield* awaitJob(queue, parked.id, ["waiting"]);
          const other = yield* queue.submit({ handler });
          yield* awaitJob(queue, other.id, ["waiting"]);
          const [wait] = yield* queue.listWaits({ state: "pending" });
          if (wait === undefined) {
            return yield* Effect.dieMessage("no pending wait");
          }
          const resolved = yield* queue.resolveWait(wait.id, "yes");
          const job = yield* awaitJob(queue, parked.id);
          const again = yield* Effect.flip(queue.resolveWait(wait.id, "no"));
          const [otherWait] = yield* queue.listWaits({ state: "pending" });
          const cancelled = otherWait
            ? yield* queue.cancelWait(otherWait.id, "withdrawn")
            : undefined;
          return {
            again,
            cancelled,
            job,
            other: yield* queue.getJob(other.id),
            resolved,
            runs: yield* queue.listRuns({ jobId: parked.id }),
            waiting,
          };
        }),
      { defaultLimit: 1 }
    );
    expect(result.waiting.state.kind).toBe("waiting");
    expect(result.resolved.state).toMatchObject({
      kind: "resolved",
      value: "yes",
    });
    expect(result.job.state).toMatchObject({
      kind: "completed",
      output: { answer: "yes", checkpoint: { step: "asked" } },
    });
    expect(result.runs.map((run) => [run.attempt, run.state.kind])).toEqual([
      [1, "completed"],
    ]);
    expect(result.again._tag).toBe("WaitAlreadySettledError");
    expect(result.cancelled?.state).toMatchObject({
      kind: "cancelled",
      reason: "withdrawn",
    });
    expect(result.other?.state.kind).toBe("cancelled");
  });

  test("recovery interrupts runs whose owner is gone, retries them, and re-admits their queued runs", async () => {
    const store = await sharedStore();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const before = yield* withQueue(store, { identity: dead }, (queue) =>
          Effect.gen(function* () {
            yield* queue.register("work", () => Effect.never);
            const retried = yield* queue.submit({
              handler,
              policy: { retry: { maxAttempts: 2 } },
            });
            const failed = yield* queue.submit({ handler });
            const delayed = yield* queue.submit({ delayMs: 60_000, handler });
            yield* flush;
            return { delayed, failed, retried };
          })
        );
        return yield* withQueue(store, { identity: alive }, (queue) =>
          Effect.gen(function* () {
            yield* queue.register("work", () =>
              Effect.succeed<RunOutcome>({
                kind: "completed",
                output: "redone",
              })
            );
            const summary = yield* queue.recover({
              isOwnerGone: (owner) => owner.started === dead.started,
            });
            yield* TestClock.adjust(60_000);
            return {
              delayed: yield* awaitJob(queue, before.delayed.id),
              failed: yield* awaitJob(queue, before.failed.id),
              retried: yield* awaitJob(queue, before.retried.id),
              retriedRuns: yield* queue.listRuns({ jobId: before.retried.id }),
              summary,
            };
          })
        );
      }).pipe(Effect.provide(TestContext.TestContext))
    );
    expect(result.summary.interrupted).toHaveLength(2);
    expect(result.summary.readmitted).toHaveLength(2);
    expect(result.retriedRuns.map((run) => run.state.kind)).toEqual([
      "interrupted",
      "completed",
    ]);
    expect(result.retried.state).toMatchObject({ output: "redone" });
    expect(result.failed.state).toMatchObject({
      error: { code: "interrupted" },
      kind: "failed",
    });
    expect(result.delayed.state.kind).toBe("completed");
  });

  test("retiring refuses new top-level work, admits children of running parents, and hands queued runs to a successor", async () => {
    const result = await testQueue(
      (queue) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          yield* queue.register("work", (context) =>
            Effect.gen(function* () {
              if (context.job.input !== "parent") {
                return { kind: "completed", output: null } as const;
              }
              yield* Deferred.await(gate);
              const child = yield* Effect.orDie(
                queue.submit({
                  handler,
                  links: { parentRunId: context.run.id },
                })
              );
              return { kind: "completed", output: child.id } as const;
            })
          );
          const parent = yield* queue.submit({ handler, input: "parent" });
          const queued = yield* queue.submit({ handler, input: "later" });
          const handedOver = yield* queue.retire(alive);
          const refused = yield* Effect.flip(queue.submit({ handler }));
          yield* Deferred.succeed(gate, undefined);
          const settled = yield* awaitJob(queue, parent.id);
          yield* flush;
          return {
            child:
              settled.state.kind === "completed" ? settled.state.output : null,
            handedOver,
            queued: yield* queue.listRuns({ jobId: queued.id }),
            refused,
          };
        }),
      { defaultLimit: 1 }
    );
    expect(result.refused._tag).toBe("QueueRetiringError");
    expect(typeof result.child).toBe("string");
    expect(result.handedOver).toEqual(result.queued.map((run) => run.id));
    expect(result.queued[0]?.state).toMatchObject({
      kind: "queued",
      owner: alive,
    });
  });

  test("the promise client runs plain handlers at the edge", async () => {
    const client = createQueueClient();
    try {
      await client.register("work", (context) => ({
        kind: "completed",
        output: { echoed: context.job.input },
      }));
      const job = await client.submit({ handler, input: "hi" });
      let settled = await client.getJob(job.id);
      for (
        let poll = 0;
        poll < 50 && settled?.state.kind !== "completed";
        poll += 1
      ) {
        settled = await client.getJob(job.id);
      }
      expect(settled?.state).toMatchObject({ output: { echoed: "hi" } });
      await expect(
        client.submit({ handler: { name: "missing" } })
      ).rejects.toMatchObject({
        _tag: "HandlerNotRegisteredError",
      });
    } finally {
      await client.dispose();
    }
  });
});
