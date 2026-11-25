import type { JsonValue } from "@foundry/lib/json";
import type { Run, RunOutcome } from "@foundry/queue";
import { Effect, TestClock } from "effect";
import { describe, expect, test } from "vitest";
import type { ChannelMessage } from "../channels";
import {
  parseSuspensionOccurrenceKey,
  suspensionOccurrenceKey,
} from "../executable";
import {
  runResultOf,
  WorkflowCheckpointSchema,
  workflowHandler,
} from "../queue-handler";
import { Step, type StepContext } from "../step";
import { bail } from "../types";
import { Workflow } from "../workflow";
import {
  eventually,
  settledJob,
  turn,
  withDurableQueue,
} from "./helpers/durable-queue";

type Body = (ctx: StepContext<null, JsonValue>) => Promise<JsonValue>;

const handler = { name: "pipeline" } as const;

const pipeline = (calls: string[], second: Body) =>
  Step.create<null, JsonValue>({
    execute: async (_input, ctx) => {
      await ctx.next();
      return {
        fetched: ctx.resultOf<JsonValue>("fetch") ?? null,
        second: ctx.resultOf<JsonValue>("second") ?? null,
      };
    },
    input: null,
    name: "pipeline",
  })
    .step<null, JsonValue>({
      execute: async () => {
        calls.push("fetch");
        return 21;
      },
      input: null,
      name: "fetch",
    })
    .step<null, JsonValue>({
      execute: async (_input, ctx) => {
        calls.push("second");
        return await second(ctx);
      },
      input: null,
      name: "second",
    });

const collect = async (
  stream: ReadableStream<ChannelMessage>,
  into: ChannelMessage[]
) => {
  for await (const message of stream) {
    into.push(message);
  }
};

const echo = () =>
  Effect.succeed<RunOutcome>({ kind: "complete", output: "echoed" });

describe("workflowHandler", () => {
  test("a multi-step workflow completes with its output and checkpoints every step", async () => {
    const calls: string[] = [];
    const result = await withDurableQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register(
          "pipeline",
          workflowHandler(() =>
            pipeline(
              calls,
              async (ctx) => (ctx.resultOf<number>("fetch") ?? 0) * 2
            )
          )
        );
        const job = yield* queue.submit({ handler });
        return {
          job: yield* settledJob(queue, job.id),
          runs: yield* queue.listRuns({ jobId: job.id }),
        };
      })
    );
    expect(result.job?.state).toMatchObject({
      kind: "complete",
      output: { fetched: 21, second: 42 },
    });
    const checkpoint = WorkflowCheckpointSchema.parse(
      result.runs[0]?.checkpoint
    );
    expect(checkpoint.tree?.name).toBe("pipeline");
    expect(checkpoint.steps["pipeline.fetch"]).toMatchObject({
      output: 21,
      status: "complete",
    });
    expect(checkpoint.steps["pipeline.second"]).toMatchObject({
      output: 42,
      status: "complete",
    });
  });

  test("a suspended step suspends the run, frees its slot, and resumes without repeating completed steps", async () => {
    const calls: string[] = [];
    const result = await withDurableQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register(
          "pipeline",
          workflowHandler(() =>
            pipeline(calls, (ctx) =>
              ctx.suspend<JsonValue>({
                kind: "human",
                name: "approval",
                reason: "sign-off",
                request: { question: "ship?" },
              })
            )
          )
        );
        yield* queue.register("echo", echo);
        const job = yield* queue.submit({ handler });
        yield* settledJob(queue, job.id, ["suspended"]);
        const other = yield* queue.submit({ handler: { name: "echo" } });
        const meanwhile = yield* settledJob(queue, other.id);
        const [suspension] = yield* queue.listSuspensions({ state: "pending" });
        if (suspension === undefined) {
          return yield* Effect.dieMessage("no pending suspension");
        }
        yield* queue.resolveSuspension(suspension.id, "approved", {
          expectedRevision: suspension.revision,
        });
        return {
          job: yield* settledJob(queue, job.id),
          meanwhile,
          runs: yield* queue.listRuns({ jobId: job.id }),
          suspension,
        };
      })
    );
    expect(result.suspension).toMatchObject({
      key: suspensionOccurrenceKey(["pipeline", "second"], "approval", 0),
      kind: "human",
      reason: "sign-off",
      request: { question: "ship?" },
    });
    expect(parseSuspensionOccurrenceKey(result.suspension.key)).toEqual({
      name: "approval",
      occurrence: 0,
      stepPath: ["pipeline", "second"],
    });
    expect(parseSuspensionOccurrenceKey("not a key")).toBeUndefined();
    expect(parseSuspensionOccurrenceKey('[["a"],"b",-1]')).toBeUndefined();
    expect(result.meanwhile?.state.kind).toBe("complete");
    expect(result.job?.state).toMatchObject({
      kind: "complete",
      output: { fetched: 21, second: "approved" },
    });
    expect(
      WorkflowCheckpointSchema.parse(result.runs[0]?.checkpoint).telemetry
        ?.metrics.values["workflow.completions"]
    ).toBe(1);
    expect(calls).toEqual(["fetch", "second", "second"]);
    expect(result.runs.map((run) => run.state.kind)).toEqual(["complete"]);
  });

  test("telemetry logged before a suspension survives the resume", async () => {
    const result = await withDurableQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register(
          "pipeline",
          workflowHandler(() =>
            pipeline([], async (ctx) => {
              ctx.log("info", "asking");
              const answer = await ctx.suspend<JsonValue>({
                kind: "human",
                name: "approval",
                reason: "sign-off",
              });
              ctx.log("info", "approved");
              return answer;
            }).step<null, JsonValue>({
              execute: async (_input, ctx) => {
                ctx.log("info", "after");
                return null;
              },
              input: null,
              name: "after",
            })
          )
        );
        const job = yield* queue.submit({ handler });
        yield* settledJob(queue, job.id, ["suspended"]);
        const [suspension] = yield* queue.listSuspensions({ state: "pending" });
        if (suspension === undefined) {
          return yield* Effect.dieMessage("no pending suspension");
        }
        yield* queue.resolveSuspension(suspension.id, "yes");
        yield* settledJob(queue, job.id);
        return yield* queue.listRuns({ jobId: job.id });
      })
    );
    const { telemetry } = WorkflowCheckpointSchema.parse(result[0]?.checkpoint);
    expect(telemetry?.metrics.values["workflow.status.suspended"]).toBe(1);
    expect(
      telemetry?.logs
        .map((entry) => entry.message)
        .filter((message) => message !== "after")
    ).toEqual(["asking", "asking", "approved"]);
  });

  test("a workflow whose output is not JSON bails instead of retrying", async () => {
    const result = await withDurableQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register(
          "pipeline",
          workflowHandler(() =>
            Workflow.create<null, unknown>({
              execute: async () => new Map([["key", "value"]]),
              input: null,
              name: "mapped",
            })
          )
        );
        const job = yield* queue.submit({
          handler,
          policy: { retry: { maxAttempts: 3 } },
        });
        return {
          job: yield* settledJob(queue, job.id),
          runs: yield* queue.listRuns({ jobId: job.id }),
        };
      })
    );
    expect(result.job?.state).toMatchObject({
      error: { name: "not-json" },
      kind: "failed",
    });
    expect(result.runs).toHaveLength(1);
  });

  test("a step returning a cyclic plain object bails with not-json instead of overflowing", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const result = await withDurableQueue((queue) =>
        Effect.gen(function* () {
          yield* queue.register(
            "pipeline",
            workflowHandler(() =>
              Workflow.create<null, unknown>({
                execute: async () => {
                  const cycle: Record<string, unknown> = {};
                  cycle.self = cycle;
                  return cycle;
                },
                input: null,
                name: "cyclic",
              })
            )
          );
          const job = yield* queue.submit({
            handler,
            policy: { retry: { maxAttempts: 3 } },
          });
          return {
            job: yield* settledJob(queue, job.id),
            runs: yield* queue.listRuns({ jobId: job.id }),
          };
        })
      );
      expect(result.job?.state).toMatchObject({
        error: { name: "not-json" },
        kind: "failed",
      });
      expect(result.runs).toHaveLength(1);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  test("a bailed workflow fails its job without retrying", async () => {
    const result = await withDurableQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register(
          "pipeline",
          workflowHandler(() =>
            Workflow.create<null, JsonValue>({
              execute: async () => bail({ reason: "rejected" }),
              input: null,
              name: "review",
            })
          )
        );
        const job = yield* queue.submit({
          handler,
          policy: { retry: { maxAttempts: 3 } },
        });
        return {
          job: yield* settledJob(queue, job.id),
          runs: yield* queue.listRuns({ jobId: job.id }),
        };
      })
    );
    expect(result.job?.state).toMatchObject({
      error: { message: '{"reason":"rejected"}', name: "bailed" },
      kind: "failed",
    });
    expect(result.runs).toHaveLength(1);
  });

  test("a thrown error retries under the queue's policy and resumes after the completed steps", async () => {
    const calls: string[] = [];
    let failures = 0;
    const result = await withDurableQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register(
          "pipeline",
          workflowHandler(() =>
            pipeline(calls, async () => {
              if (failures === 0) {
                failures += 1;
                throw new Error("flaky");
              }
              return "recovered";
            })
          )
        );
        const job = yield* queue.submit({
          handler,
          policy: {
            retry: {
              backoff: { delayMs: 1000, kind: "fixed" },
              maxAttempts: 2,
            },
          },
        });
        const first = yield* eventually(
          queue.listRuns({ jobId: job.id }),
          (runs) => runs.length === 2
        );
        yield* TestClock.adjust(1000);
        return {
          first,
          job: yield* settledJob(queue, job.id),
          runs: yield* queue.listRuns({ jobId: job.id }),
        };
      })
    );
    expect(result.first[0]?.state).toMatchObject({
      error: { message: "flaky" },
      kind: "failed",
      retryable: true,
    });
    expect(result.job?.state).toMatchObject({
      kind: "complete",
      output: { fetched: 21, second: "recovered" },
    });
    expect(result.runs.map((run) => [run.attempt, run.state.kind])).toEqual([
      [1, "failed"],
      [2, "complete"],
    ]);
    expect(calls).toEqual(["fetch", "second", "second"]);
  });

  test("cancelling the job interrupts the running step and aborts its signal", async () => {
    const signals: AbortSignal[] = [];
    const result = await withDurableQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register(
          "pipeline",
          workflowHandler(() =>
            Step.create<null, JsonValue>({
              execute: (_input, ctx) =>
                new Promise((resolve) => {
                  signals.push(ctx.signal);
                  ctx.signal.addEventListener("abort", () => resolve(null));
                }),
              input: null,
              name: "long",
            })
          )
        );
        const job = yield* queue.submit({ handler });
        yield* eventually(
          Effect.sync(() => signals.length),
          (count) => count === 1
        );
        yield* queue.cancel(job.id, "stop");
        return {
          job: yield* queue.getJob(job.id),
          runs: yield* queue.listRuns({ jobId: job.id }),
        };
      })
    );
    expect(signals[0]?.aborted).toBe(true);
    expect(result.job?.state).toMatchObject({
      kind: "cancelled",
      reason: "stop",
    });
    expect(result.runs.map((run) => run.state.kind)).toEqual(["cancelled"]);
  });

  test("onStart hands the live workflow to the host, which streams its messages until onFinish", async () => {
    const messages: ChannelMessage[] = [];
    const lifecycle: string[] = [];
    const reading = new AbortController();
    const result = await withDurableQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register(
          "pipeline",
          workflowHandler(
            () =>
              Step.create<null, JsonValue>({
                execute: async (_input, ctx) => {
                  ctx.write({ token: "hello" });
                  return "said";
                },
                input: null,
                name: "speaker",
              }),
            {
              onFinish: (_runId, workflow) => {
                lifecycle.push(`finish:${workflow.status}`);
              },
              onStart: (runId, workflow) => {
                lifecycle.push(`start:${runId.slice(0, 3)}`);
                collect(workflow.root.subscribe(reading.signal), messages);
              },
            }
          )
        );
        const job = yield* queue.submit({ handler });
        const settled = yield* settledJob(queue, job.id);
        yield* eventually(
          Effect.sync(() => messages),
          (seen) =>
            seen.some(
              (message) =>
                message._tag === "event" &&
                message.event._tag === "step.complete"
            )
        );
        reading.abort();
        yield* turn;
        return settled;
      })
    );
    expect(result?.state).toMatchObject({ kind: "complete", output: "said" });
    expect(lifecycle).toEqual(["start:rn-", "finish:complete"]);
    expect(messages).toContainEqual(
      expect.objectContaining({
        _tag: "chunk",
        chunk: expect.objectContaining({
          payload: { data: { token: "hello" }, kind: "data" },
        }),
      })
    );
  });
});

describe("runResultOf", () => {
  test("maps each terminal run state onto the workflow result it ended with", () => {
    const run = (state: Run["state"]): Run => ({
      attempt: 1,
      id: "rn-1",
      jobId: "jb-1",
      pool: "default",
      revision: 1,
      state,
    });
    const lease = { claimedAt: 0, owner: { pid: 1, started: null } };
    expect(
      [
        run({ completedAt: 1, kind: "complete", output: { ok: true } }),
        run({
          error: { message: "boom", name: "Error" },
          failedAt: 1,
          kind: "failed",
          retryable: false,
        }),
        run({
          interruptedAt: 1,
          kind: "interrupted",
          lease,
          reason: "drained",
        }),
        run({ cancelledAt: 1, kind: "cancelled", reason: "stop" }),
        run({ cancelledAt: 1, kind: "cancelled" }),
      ].map(runResultOf)
    ).toEqual([
      { status: "complete", value: { ok: true } },
      { error: new Error("boom"), status: "failed" },
      { error: new Error("drained"), status: "failed" },
      { reason: "stop", status: "cancelled" },
      { status: "cancelled" },
    ]);
  });
});
