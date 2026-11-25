import { thisProcess } from "@foundry/lib/process-identity";
import { Deferred, Effect, TestClock, TestContext } from "effect";
import { describe, expect, test } from "vitest";
import { createQueueClient } from "../client";
import type { JobId, RunOutcome } from "../domain";
import type { RunContext } from "../service";
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
    const answer = context.resolutions.get("approval");
    if (answer === undefined) {
      yield* Effect.orDie(context.saveCheckpoint({ step: "asked" }));
      return {
        kind: "suspended",
        suspension: {
          key: "approval",
          kind: "human",
          reason: "needs sign-off",
          request: { question: "ship?" },
        },
      };
    }
    return {
      kind: "complete",
      output: { answer, checkpoint: context.checkpoint ?? null },
    };
  });

const dead = { pid: 1, started: "gone" } as const;
const alive = { pid: 2, started: "here" } as const;

describe("Queue lifecycle", () => {
  test("a suspended run frees its slot and resumes with its checkpoint and resolved suspension", async () => {
    const result = await testQueue(
      (queue) =>
        Effect.gen(function* () {
          yield* queue.register("work", approval);
          const suspended = yield* queue.submit({ handler });
          const held = yield* awaitJob(queue, suspended.id, ["suspended"]);
          const other = yield* queue.submit({ handler });
          yield* awaitJob(queue, other.id, ["suspended"]);
          const [suspension] = yield* queue.listSuspensions({
            state: "pending",
          });
          if (suspension === undefined) {
            return yield* Effect.dieMessage("no pending suspension");
          }
          yield* TestClock.adjust(1000);
          const resolved = yield* queue.resolveSuspension(suspension.id, "yes");
          const job = yield* awaitJob(queue, suspended.id);
          const again = yield* Effect.flip(
            queue.resolveSuspension(suspension.id, "no")
          );
          const [otherSuspension] = yield* queue.listSuspensions({
            state: "pending",
          });
          const cancelled = otherSuspension
            ? yield* queue.cancelSuspension(otherSuspension.id, "withdrawn")
            : undefined;
          return {
            again,
            cancelled,
            held,
            job,
            other: yield* queue.getJob(other.id),
            resolved,
            runs: yield* queue.listRuns({ jobId: suspended.id }),
          };
        }),
      { defaultLimit: 1 }
    );
    expect(result.held.state.kind).toBe("suspended");
    expect(result.resolved.state).toMatchObject({
      kind: "resolved",
      value: "yes",
    });
    expect(result.job.state).toMatchObject({
      kind: "complete",
      output: { answer: "yes", checkpoint: { step: "asked" } },
    });
    expect(result.runs.map((run) => [run.attempt, run.state.kind])).toEqual([
      [1, "complete"],
    ]);
    expect(result.runs[0]?.startedAt).toBe(0);
    expect(result.runs[0]?.state).toMatchObject({ completedAt: 1000 });
    expect(result.again._tag).toBe("SuspensionAlreadySettledError");
    expect(result.cancelled?.state).toMatchObject({
      kind: "cancelled",
      reason: "withdrawn",
    });
    expect(result.other?.state.kind).toBe("cancelled");
  });

  test("resolving a suspension checks its expected revision, and only a settled job can be removed with its runs and suspensions", async () => {
    const result = await testQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register("work", approval);
        const job = yield* queue.submit({ handler });
        yield* awaitJob(queue, job.id, ["suspended"]);
        const [suspension] = yield* queue.listSuspensions({ state: "pending" });
        if (suspension === undefined) {
          return yield* Effect.dieMessage("no pending suspension");
        }
        const stale = yield* Effect.flip(
          queue.resolveSuspension(suspension.id, "yes", {
            expectedRevision: suspension.revision + 1,
          })
        );
        const open = yield* Effect.flip(queue.removeJob(job.id));
        yield* queue.resolveSuspension(suspension.id, "yes", {
          expectedRevision: suspension.revision,
        });
        yield* awaitJob(queue, job.id);
        yield* queue.removeJob(job.id);
        return {
          job: yield* queue.getJob(job.id),
          open,
          runs: yield* queue.listRuns({ jobId: job.id }),
          stale,
          suspension: yield* queue.getSuspension(suspension.id),
        };
      })
    );
    expect(result.stale._tag).toBe("StaleSuspensionRevisionError");
    expect(result.open._tag).toBe("JobNotSettledError");
    expect(result.job).toBeUndefined();
    expect(result.runs).toEqual([]);
    expect(result.suspension).toBeUndefined();
  });

  test("cancelling a pending suspension its run is not suspended on cancels that suspension alone", async () => {
    const store = await sharedStore();
    await Effect.runPromise(
      store.commit({
        jobs: [
          {
            createdAt: 0,
            handler,
            id: "jb-1",
            input: null,
            links: {},
            policy: {},
            pool: "default",
            state: { kind: "pending" },
          },
        ],
        runs: [
          {
            attempt: 1,
            id: "rn-1",
            jobId: "jb-1",
            pool: "default",
            revision: 0,
            state: { availableAt: 0, kind: "queued", queuedAt: 0 },
          },
        ],
        suspensions: [
          {
            id: "su-1",
            key: "approval",
            kind: "human",
            reason: "stale",
            request: null,
            revision: 0,
            runId: "rn-1",
            state: { createdAt: 0, kind: "pending" },
          },
        ],
      })
    );
    const result = await Effect.runPromise(
      withQueue(store, {}, (queue) =>
        Effect.gen(function* () {
          const cancelled = yield* queue.cancelSuspension("su-1", "withdrawn");
          return { cancelled, run: yield* queue.getRun("rn-1") };
        })
      ).pipe(Effect.provide(TestContext.TestContext))
    );
    expect(result.cancelled.state).toMatchObject({
      kind: "cancelled",
      reason: "withdrawn",
    });
    expect(result.run?.state.kind).toBe("queued");
  });

  test("closing the queue starts none of its queued runs", async () => {
    const store = await sharedStore();
    const started: unknown[] = [];
    await Effect.runPromise(
      withQueue(store, {}, (queue) =>
        Effect.gen(function* () {
          yield* queue.register("work", (context) =>
            Effect.zipRight(
              Effect.sync(() => started.push(context.job.input)),
              Effect.never
            )
          );
          yield* queue.submit({ handler, input: "first" });
          yield* queue.submit({ handler, input: "second" });
          yield* flush;
        })
      ).pipe(Effect.provide(TestContext.TestContext))
    );
    const runs = await Effect.runPromise(store.listRuns());
    expect(started).toEqual(["first"]);
    expect(runs.map((run) => run.state.kind).sort()).toEqual([
      "queued",
      "running",
    ]);
  });

  test("recovery interrupts runs whose owner is gone, retries them, and adopts their queued runs", async () => {
    const store = await sharedStore();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const before = yield* withQueue(
          store,
          { defaultLimit: Number.POSITIVE_INFINITY, identity: dead },
          (queue) =>
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
                kind: "complete",
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
    expect(result.summary.adopted).toHaveLength(2);
    expect(result.retriedRuns.map((run) => run.state.kind)).toEqual([
      "interrupted",
      "complete",
    ]);
    expect(result.retried.state).toMatchObject({ output: "redone" });
    expect(result.failed.state).toMatchObject({
      error: { name: "interrupted" },
      kind: "failed",
    });
    expect(result.delayed.state.kind).toBe("complete");
  });

  test("a submission keeps the run id it names, and abandoning fails an open run no fiber here drives, without retry", async () => {
    const store = await sharedStore();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const left = yield* withQueue(
          store,
          { defaultLimit: Number.POSITIVE_INFINITY, identity: dead },
          (queue) =>
            Effect.gen(function* () {
              yield* queue.register("work", () => Effect.never);
              const job = yield* queue.submit({
                handler,
                policy: { retry: { maxAttempts: 3 } },
                runId: "rn-chosen",
              });
              const taken = yield* Effect.flip(
                queue.submit({ handler, runId: "rn-chosen" })
              );
              yield* flush;
              return { job, taken };
            })
        );
        return yield* withQueue(store, { identity: alive }, (queue) =>
          Effect.gen(function* () {
            const error = {
              message: "its process exited",
              name: "Interrupted",
            };
            const abandoned = yield* queue.abandon("rn-chosen", error);
            const again = yield* queue.abandon("rn-chosen", {
              message: "ignored",
              name: "other",
            });
            return {
              abandoned,
              again,
              job: yield* queue.getJob(left.job.id),
              runs: yield* queue.listRuns({ jobId: left.job.id }),
              taken: left.taken,
            };
          })
        );
      }).pipe(Effect.provide(TestContext.TestContext))
    );
    expect(result.taken._tag).toBe("RunAlreadyExistsError");
    expect(result.runs.map((run) => run.id)).toEqual(["rn-chosen"]);
    expect(result.abandoned.state).toMatchObject({
      error: { message: "its process exited", name: "Interrupted" },
      kind: "failed",
      retryable: false,
    });
    expect(result.again).toEqual(result.abandoned);
    expect(result.job?.state).toMatchObject({
      kind: "failed",
      lastRunId: "rn-chosen",
    });
  });

  test("retiring refuses new top-level work, runs the children of its running parents itself, and hands queued runs to a successor", async () => {
    const result = await testQueue(
      (queue) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          yield* queue.register("work", (context) =>
            Effect.gen(function* () {
              if (context.job.input !== "parent") {
                return { kind: "complete", output: null } as const;
              }
              yield* Deferred.await(gate);
              const child = yield* Effect.orDie(
                queue.submit({
                  handler,
                  links: { parentRunId: context.run.id },
                })
              );
              return { kind: "complete", output: child.id } as const;
            })
          );
          const parent = yield* queue.submit({ handler, input: "parent" });
          const queued = yield* queue.submit({ handler, input: "later" });
          const handedOver = yield* queue.retire(alive);
          const refused = yield* Effect.flip(queue.submit({ handler }));
          yield* Deferred.succeed(gate, undefined);
          const settled = yield* awaitJob(queue, parent.id);
          const child =
            settled.state.kind === "complete" ? settled.state.output : null;
          const childJob =
            typeof child === "string"
              ? yield* queue.awaitJob(child as JobId)
              : undefined;
          yield* flush;
          return {
            child,
            childJob,
            handedOver,
            queued: yield* queue.listRuns({ jobId: queued.id }),
            refused,
          };
        }),
      { defaultLimit: 1 }
    );
    expect(result.refused._tag).toBe("QueueRetiringError");
    expect(typeof result.child).toBe("string");
    expect(result.childJob?.state.kind).toBe("complete");
    expect(result.handedOver).toEqual(result.queued.map((run) => run.id));
    expect(result.queued[0]?.state).toMatchObject({
      kind: "queued",
      owner: alive,
    });
  });

  test("retiring keeps the queued children of a running parent and finishes them, handing over only other queued runs", async () => {
    const result = await testQueue((queue) =>
      Effect.gen(function* () {
        const spawned = yield* Deferred.make<readonly JobId[]>();
        const childGate = yield* Deferred.make<void>();
        yield* queue.configurePool({ limit: 1, name: "b", state: "active" });
        yield* queue.register("work", (context) =>
          Effect.gen(function* () {
            if (context.job.input === "child") {
              yield* Deferred.await(childGate);
              return { kind: "complete", output: null } as const;
            }
            if (context.job.input !== "parent") {
              return { kind: "complete", output: null } as const;
            }
            const children = yield* Effect.all(
              [0, 1].map(() =>
                Effect.orDie(
                  queue.submit({
                    handler,
                    input: "child",
                    links: { parentRunId: context.run.id },
                    pool: "b",
                  })
                )
              )
            );
            yield* Deferred.succeed(
              spawned,
              children.map((child) => child.id)
            );
            for (const child of children) {
              yield* Effect.orDie(queue.awaitJob(child.id));
            }
            return { kind: "complete", output: null } as const;
          })
        );
        const parent = yield* queue.submit({
          handler,
          input: "parent",
          pool: "a",
        });
        const children = yield* Deferred.await(spawned);
        const later = yield* queue.submit({
          handler,
          input: "later",
          pool: "b",
        });
        const handedOver = yield* queue.retire(alive);
        yield* Deferred.succeed(childGate, undefined);
        const settled = yield* awaitJob(queue, parent.id);
        const childJobs = yield* Effect.all(
          children.map((id) => awaitJob(queue, id))
        );
        return {
          childJobs,
          handedOver,
          later: yield* queue.listRuns({ jobId: later.id }),
          settled,
        };
      })
    );
    expect(result.settled.state.kind).toBe("complete");
    expect(result.childJobs.map((job) => job.state.kind)).toEqual([
      "complete",
      "complete",
    ]);
    expect(result.handedOver).toEqual(result.later.map((run) => run.id));
  });

  test("a retiring queue starts none of the runs it hands to its own process", async () => {
    const self = thisProcess();
    const runs = await testQueue(
      (queue) =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          yield* queue.register("work", (context) =>
            context.job.input === "first"
              ? Effect.as(Deferred.await(gate), {
                  kind: "complete",
                  output: null,
                } as const)
              : Effect.succeed({ kind: "complete", output: null } as const)
          );
          const first = yield* queue.submit({ handler, input: "first" });
          const later = yield* queue.submit({ handler, input: "later" });
          yield* queue.retire(self);
          yield* Deferred.succeed(gate, undefined);
          yield* awaitJob(queue, first.id);
          yield* flush;
          return yield* queue.listRuns({ jobId: later.id });
        }),
      { defaultLimit: 1 }
    );
    expect(runs.map((run) => run.state)).toMatchObject([
      { kind: "queued", owner: self },
    ]);
  });

  test("the promise client runs plain and Effect handlers through one register", async () => {
    const client = createQueueClient();
    try {
      await client.register("work", (context) => ({
        kind: "complete",
        output: { echoed: context.job.input },
      }));
      await client.register("effect", (context) =>
        Effect.as(context.saveCheckpoint("saved"), {
          kind: "complete",
          output: { effect: context.job.input },
        } satisfies RunOutcome)
      );
      const settledJob = async (id: JobId) => {
        let settled = await client.getJob(id);
        for (
          let poll = 0;
          poll < 50 && settled?.state.kind !== "complete";
          poll += 1
        ) {
          settled = await client.getJob(id);
        }
        return settled;
      };
      const job = await client.submit({ handler, input: "hi" });
      const effect = await client.submit({
        handler: { name: "effect" },
        input: "yo",
      });
      expect((await settledJob(job.id))?.state).toMatchObject({
        output: { echoed: "hi" },
      });
      expect((await settledJob(effect.id))?.state).toMatchObject({
        output: { effect: "yo" },
      });
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
