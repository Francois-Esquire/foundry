import type { JsonValue } from "@foundry/lib/json";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import type { DefinitionGraphBuilder } from "../definitions";
import { workflowHandler } from "../queue-handler";
import { Step } from "../step";
import { Workflow } from "../workflow";
import { settledJob, withDurableQueue } from "./helpers/durable-queue";

const handler = { name: "replay" } as const;

const drainStream = async (stream: ReadableStream<unknown>) => {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
};

class DoubleStep extends Step<number, number> {
  readonly definitionKey = "disposable-double";

  protected async execute(input: number): Promise<number> {
    return input * 2;
  }
}

class DisposableWorkflow extends Workflow<number, number> {
  readonly definitionKey = "disposable-wf";
  readonly #double = new DoubleStep();

  protected define(
    graph: DefinitionGraphBuilder<number, number, Record<never, never>>
  ): void {
    graph
      .step("double", this.#double, ({ input }) => input)
      .output(({ double }) => double);
  }
}

describe("Workflow fiber lifecycle and disposal", () => {
  test("Workflow.dispose closes both workflow sync fibers and root step/channel fibers", async () => {
    const workflow = Workflow.create<void, string>({
      execute: async () => "ok",
      input: undefined,
      name: "clean-dispose",
    });

    await expect(workflow.run()).resolves.toBe("ok");
    await workflow.dispose();

    expect(workflow.root.aborted).toBe(true);
    await expect(drainStream(workflow.root.channelStream)).resolves.toBe(true);

    await workflow.root.setCursor("after-dispose");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(workflow.state.tree?.cursor).toBeNull();
  });

  test("Workflow.create().run disposes the materialized runtime after completion", async () => {
    const definition = new DisposableWorkflow();
    await expect(definition.create().run(21)).resolves.toBe(42);
  });

  test("workflowHandler disposes workflow fibers on completion, failure, and onStart throw", async () => {
    const captured: Workflow<null, JsonValue>[] = [];
    await withDurableQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register(
          "ok",
          workflowHandler(
            () =>
              Step.create<null, JsonValue>({
                execute: async () => "done",
                input: null,
                name: "ok-step",
              }),
            {
              onFinish: (_runId, workflow) => {
                captured.push(workflow);
              },
            }
          )
        );
        yield* queue.register(
          "fail",
          workflowHandler(
            () =>
              Step.create<null, JsonValue>({
                execute: async () => {
                  throw new Error("boom");
                },
                input: null,
                name: "fail-step",
              }),
            {
              onFinish: (_runId, workflow) => {
                captured.push(workflow);
              },
            }
          )
        );
        yield* queue.register(
          "throw-start",
          workflowHandler(
            () =>
              Step.create<null, JsonValue>({
                execute: async () => "unreachable",
                input: null,
                name: "start-step",
              }),
            {
              onStart: (_runId, workflow) => {
                captured.push(workflow);
                throw new Error("onStart boom");
              },
            }
          )
        );

        const okJob = yield* queue.submit({ handler: { name: "ok" } });
        const failJob = yield* queue.submit({ handler: { name: "fail" } });
        const startJob = yield* queue.submit({
          handler: { name: "throw-start" },
        });
        yield* settledJob(queue, okJob.id);
        yield* settledJob(queue, failJob.id);
        yield* settledJob(queue, startJob.id);
      })
    );

    expect(captured).toHaveLength(3);
    for (const workflow of captured) {
      expect(workflow.root.aborted).toBe(false);
      await expect(drainStream(workflow.root.channelStream)).resolves.toBe(
        true
      );
      await workflow.root.setCursor("after-handler");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(workflow.state.tree?.cursor).toBeNull();
    }
  });

  test("workflowHandler delivers root step.complete before disposal even when observer cancels on root.signal", async () => {
    const events: string[] = [];
    let observed: Promise<void> | undefined;

    await withDurableQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register(
          "observe",
          workflowHandler(
            () =>
              Step.create<null, JsonValue>({
                execute: async () => "done",
                input: null,
                name: "observed-root",
              }),
            {
              onStart: (_runId, workflow) => {
                const reader = workflow.root.subscribe().getReader();
                workflow.root.signal.addEventListener(
                  "abort",
                  () => {
                    reader.cancel().catch(() => undefined);
                  },
                  { once: true }
                );
                observed = (async () => {
                  for (;;) {
                    const next = await reader.read();
                    if (next.done) {
                      return;
                    }
                    if (next.value._tag === "event") {
                      events.push(next.value.event._tag);
                    }
                  }
                })();
              },
            }
          )
        );
        const job = yield* queue.submit({ handler: { name: "observe" } });
        yield* settledJob(queue, job.id);
      })
    );
    await observed;
    expect(events).toContain("step.complete");
  });
});

describe("Composer checkpoint replay memoization", () => {
  test("resuming after completed sequence, parallel, branch, and invoke skips all completed composed blocks", async () => {
    const calls: string[] = [];

    const makeWorkflow = () =>
      Step.create<null, JsonValue>({
        execute: async (_input, ctx) => {
          const seq = await ctx.sequence<number>(
            [
              Step.create<unknown, unknown>({
                execute: async (value) => {
                  calls.push("seq.a");
                  return (value as number) + 1;
                },
                input: undefined,
                name: "a",
              }),
              Step.create<unknown, unknown>({
                execute: async (value) => {
                  calls.push("seq.b");
                  return (value as number) * 10;
                },
                input: undefined,
                name: "b",
              }),
            ],
            1
          );
          const par = await ctx.parallel({
            left: {
              input: seq,
              step: Step.create<unknown, unknown>({
                execute: async (value) => {
                  calls.push("par.left");
                  return (value as number) + 1;
                },
                input: undefined,
                name: "left",
              }),
            },
            right: {
              input: seq,
              step: Step.create<unknown, unknown>({
                execute: async (value) => {
                  calls.push("par.right");
                  return (value as number) + 2;
                },
                input: undefined,
                name: "right",
              }),
            },
          });
          const picked = await ctx.branch<string>(
            () => {
              calls.push("branch.pred");
              return true;
            },
            Step.create<unknown, string>({
              execute: async () => {
                calls.push("branch.true");
                return "yes";
              },
              input: undefined,
              name: "yes",
            }),
            Step.create<unknown, string>({
              execute: async () => {
                calls.push("branch.false");
                return "no";
              },
              input: undefined,
              name: "no",
            }),
            par
          );
          const invoked = await ctx.invoke(
            Step.create<string, string>({
              execute: async (input) => {
                calls.push("invoke.child");
                return `${input}!`;
              },
              input: "",
              name: "child",
            }),
            picked
          );
          const parJson = par as Record<string, JsonValue>;
          const approval = await ctx.suspend<string>({
            kind: "human",
            name: "gate",
            reason: "continue",
          });
          return { approval, invoked, par: parJson, seq };
        },
        input: null,
        name: "root",
      });

    const job = await withDurableQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register("replay", workflowHandler(makeWorkflow));
        const submitted = yield* queue.submit({ handler });
        yield* settledJob(queue, submitted.id, ["suspended"]);
        const [suspension] = yield* queue.listSuspensions({ state: "pending" });
        if (suspension === undefined) {
          return yield* Effect.dieMessage("no pending suspension");
        }
        yield* queue.resolveSuspension(suspension.id, "go");
        return yield* settledJob(queue, submitted.id);
      })
    );

    expect(job?.state).toMatchObject({
      kind: "complete",
      output: {
        approval: "go",
        invoked: "yes!",
        par: { left: 21, right: 22 },
        seq: 20,
      },
    });
    expect(calls).toEqual([
      "seq.a",
      "seq.b",
      "par.left",
      "par.right",
      "branch.pred",
      "branch.true",
      "invoke.child",
    ]);
  });

  test("resuming a suspension inside a sequence skips already-completed earlier steps in the sequence", async () => {
    const calls: string[] = [];

    const makeWorkflow = () =>
      Step.create<null, JsonValue>({
        execute: async (_input, ctx) =>
          ctx.sequence<string>(
            [
              Step.create<unknown, unknown>({
                execute: async () => {
                  calls.push("first");
                  return "from-first";
                },
                input: undefined,
                name: "first",
              }),
              Step.create<unknown, unknown>({
                execute: async (input, stepCtx) => {
                  calls.push("second");
                  const answer = await stepCtx.suspend<string>({
                    kind: "human",
                    name: "mid",
                    reason: "pause",
                  });
                  return `${String(input)}:${answer}`;
                },
                input: undefined,
                name: "second",
              }),
            ],
            null
          ),
        input: null,
        name: "root",
      });

    const job = await withDurableQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register("replay", workflowHandler(makeWorkflow));
        const submitted = yield* queue.submit({ handler });
        yield* settledJob(queue, submitted.id, ["suspended"]);
        const [suspension] = yield* queue.listSuspensions({ state: "pending" });
        if (suspension === undefined) {
          return yield* Effect.dieMessage("no pending suspension");
        }
        yield* queue.resolveSuspension(suspension.id, "resumed");
        return yield* settledJob(queue, submitted.id);
      })
    );

    expect(job?.state).toMatchObject({
      kind: "complete",
      output: "from-first:resumed",
    });
    expect(calls).toEqual(["first", "second", "second"]);
  });

  test("repeated invoke and default-named parallel calls in one normal run execute with distinct inputs", async () => {
    const double = Step.create<number, number>({
      execute: async (input) => input * 2,
      input: 0,
      name: "double",
    });
    const wf = Workflow.create<null, JsonValue>({
      execute: async (_input, ctx) => {
        const a = await ctx.invoke(double, 2);
        const b = await ctx.invoke(double, 3);
        const p1 = await ctx.parallel({
          x: {
            input: 1,
            step: Step.create<unknown, unknown>({
              execute: async (value) => `first:${String(value)}`,
              input: undefined,
              name: "x",
            }),
          },
        });
        const p2 = await ctx.parallel({
          y: {
            input: 2,
            step: Step.create<unknown, unknown>({
              execute: async (value) => `second:${String(value)}`,
              input: undefined,
              name: "y",
            }),
          },
        });
        return { a, b, p1: p1 as JsonValue, p2: p2 as JsonValue };
      },
      input: null,
      name: "repeat",
    });
    try {
      await expect(wf.run()).resolves.toEqual({
        a: 4,
        b: 6,
        p1: { x: "first:1" },
        p2: { y: "second:2" },
      });
    } finally {
      await wf.dispose();
    }
  });

  test("transient workflows re-execute composed steps on resume instead of replaying undefined", async () => {
    let calls = 0;
    const makeTransient = () =>
      Workflow.attach(
        Step.create<null, JsonValue>({
          execute: async (_input, ctx) => {
            const value = await ctx.invoke(
              Step.create<string, string>({
                execute: async (input) => {
                  calls += 1;
                  return `${input}:${calls}`;
                },
                input: "",
                name: "compute",
              }),
              "hi"
            );
            const ok = await ctx.suspend<string>({
              kind: "human",
              name: "gate",
              reason: "wait",
            });
            return `${value}:${ok}`;
          },
          input: null,
          name: "transient-root",
        }),
        null,
        { results: "transient" }
      );

    const job = await withDurableQueue((queue) =>
      Effect.gen(function* () {
        yield* queue.register("replay", workflowHandler(makeTransient));
        const submitted = yield* queue.submit({ handler });
        yield* settledJob(queue, submitted.id, ["suspended"]);
        const [suspension] = yield* queue.listSuspensions({ state: "pending" });
        if (suspension === undefined) {
          return yield* Effect.dieMessage("no pending suspension");
        }
        yield* queue.resolveSuspension(suspension.id, "go");
        return yield* settledJob(queue, submitted.id);
      })
    );

    expect(job?.state.kind).toBe("complete");
    expect(calls).toBe(2);
  });
});
