import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { isSuspendSignal } from "../executable";
import type { StepSnapshot } from "../snapshot";
import { withStepHooks } from "../step-hooks";

async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`Expected Error, received ${String(error)}`, {
      cause: error,
    });
  }
  throw new Error("Expected run to fail");
}

describe("withStepHooks — success composition", () => {
  test("runs ordered real Steps at stable reserved paths and preserves body output", async () => {
    const order: string[] = [];
    const step = withStepHooks(
      {
        execute: async (input) => {
          order.push("body");
          return input.value * 2;
        },
        id: "stable-root-id",
        input: { value: 4 },
        name: "publish",
      },
      {
        after: {
          success: [
            {
              execute: async ({ input, output }) => {
                order.push(`success:${input.value}:${output}`);
                return "ignored replacement";
              },
              name: "audit",
            },
          ],
        },
        before: [
          {
            execute: async (input) => {
              order.push(`before:${input.value}`);
            },
            name: "authorize",
          },
          {
            execute: async () => {
              order.push("before:reserve");
            },
            name: "reserve",
          },
        ],
      }
    );

    await expect(step.run()).resolves.toBe(8);
    expect(step.id).toBe("stable-root-id");
    expect(step.name).toBe("publish");
    expect(order).toEqual([
      "before:4",
      "before:reserve",
      "body",
      "success:4:8",
    ]);
    expect(Object.keys(step.steps).sort()).toEqual(
      [
        "publish",
        "publish.@after",
        "publish.@after.success",
        "publish.@after.success.audit",
        "publish.@before",
        "publish.@before.authorize",
        "publish.@before.reserve",
        "publish.@body",
      ].sort()
    );
  });

  test("omits empty phases while always retaining @body", async () => {
    const step = withStepHooks(
      {
        execute: async () => "done",
        input: undefined,
        name: "plain",
      },
      { after: { success: [] }, before: [] }
    );

    await expect(step.run()).resolves.toBe("done");
    expect(Object.keys(step.steps).sort()).toEqual(["plain", "plain.@body"]);
  });

  test("does not inherit hooks into target body children", async () => {
    let beforeCalls = 0;
    let afterCalls = 0;
    let childCalls = 0;
    const step = withStepHooks(
      {
        children: [
          {
            execute: async () => {
              childCalls++;
            },
            input: undefined,
            name: "body-child",
          },
        ],
        execute: async () => "done",
        input: undefined,
        name: "nested-target",
      },
      {
        after: {
          success: [
            {
              execute: async () => {
                afterCalls++;
              },
              name: "once-after",
            },
          ],
        },
        before: [
          {
            execute: async () => {
              beforeCalls++;
            },
            name: "once-before",
          },
        ],
      }
    );

    await expect(step.run()).resolves.toBe("done");
    expect({ afterCalls, beforeCalls, childCalls }).toEqual({
      afterCalls: 1,
      beforeCalls: 1,
      childCalls: 1,
    });
    expect(
      Object.keys(step.steps).some((path) =>
        path.includes("@body.body-child.@before")
      )
    ).toBe(false);
  });

  test("success recovery reuses the persisted body output without repeating effects", async () => {
    let bodyCalls = 0;
    let hookCalls = 0;
    const make = () =>
      withStepHooks(
        {
          execute: async (input) => {
            bodyCalls++;
            return input * 2;
          },
          input: 3,
          name: "success-recovery",
        },
        {
          after: {
            success: [
              {
                execute: async () => {
                  hookCalls++;
                },
                name: "notify",
              },
            ],
          },
        }
      );

    const first = make();
    await expect(first.run()).resolves.toBe(6);
    const recoveredRecords = { ...first.steps };
    delete recoveredRecords["success-recovery"];

    const recovered = make();
    await Effect.runPromise(recovered.snapshot.seed(recoveredRecords));
    await expect(recovered.run()).resolves.toBe(6);
    expect(bodyCalls).toBe(1);
    expect(hookCalls).toBe(1);
  });
});

describe("withStepHooks — before outcome", () => {
  test("a failed before hook never starts the body or an after branch", async () => {
    let bodyCalls = 0;
    let afterCalls = 0;
    const step = withStepHooks(
      {
        execute: async () => {
          bodyCalls++;
          return "never";
        },
        input: undefined,
        name: "before-fails",
      },
      {
        after: {
          failure: [
            {
              execute: async () => {
                afterCalls++;
              },
              name: "report",
            },
          ],
        },
        before: [
          {
            execute: async () => {
              throw new Error("denied");
            },
            name: "guard",
          },
        ],
      }
    );

    await expect(step.run()).rejects.toThrow("denied");
    expect(bodyCalls).toBe(0);
    expect(afterCalls).toBe(0);
    expect(step.steps["before-fails.@body"]).toBeUndefined();
  });

  test("a suspended before hook propagates unchanged without starting body", async () => {
    let bodyCalls = 0;
    const step = withStepHooks(
      {
        execute: async () => {
          bodyCalls++;
          return "never";
        },
        input: undefined,
        name: "before-suspends",
      },
      {
        before: [
          {
            execute: async (_input, ctx) => {
              await ctx.suspend({ name: "before-wait", reason: "external" });
            },
            name: "approval",
          },
        ],
      }
    );

    const error = await captureError(() => step.run());
    expect(isSuspendSignal(error)).toBe(true);
    if (isSuspendSignal(error)) {
      expect(error.suspension.name).toBe("before-wait");
      expect(error.originPath).toEqual([
        "before-suspends",
        "@before",
        "approval",
      ]);
    }
    expect(bodyCalls).toBe(0);
  });
});

describe("withStepHooks — body failure", () => {
  test("selects failure only after body retries exhaust and rethrows the body error", async () => {
    let bodyAttempts = 0;
    const seen: Error[] = [];
    const step = withStepHooks(
      {
        config: { retry: { maxAttempts: 3 } },
        execute: async () => {
          bodyAttempts++;
          throw new Error("body terminal");
        },
        input: "payload",
        name: "terminal-failure",
      },
      {
        after: {
          failure: [
            {
              execute: async ({ input, error }) => {
                expect(input).toBe("payload");
                seen.push(error);
              },
              name: "record",
            },
          ],
          success: [
            {
              execute: async () => {
                throw new Error("wrong branch");
              },
              name: "not-success",
            },
          ],
        },
      }
    );

    const error = await captureError(() => step.run());
    expect(error.message).toBe("body terminal");
    expect(bodyAttempts).toBe(3);
    expect(seen).toEqual([error]);
    expect(step.steps["terminal-failure.@after.failure.record"]?.status).toBe(
      "complete"
    );
  });

  test("a failure hook error wins while retaining the body error as cause", async () => {
    const step = withStepHooks(
      {
        execute: async () => {
          throw new Error("body error");
        },
        input: undefined,
        name: "failure-hook-fails",
      },
      {
        after: {
          failure: [
            {
              execute: async () => {
                throw new Error("hook error");
              },
              name: "broken-reporter",
            },
          ],
        },
      }
    );

    const error = await captureError(() => step.run());
    expect(error.message).toBe("hook error");
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe("body error");
    expect(step.steps["failure-hook-fails.@body"]?.status).toBe("failed");
  });

  test("failure recovery reconstructs the terminal error and skips completed phases", async () => {
    let bodyAttempts = 0;
    let failureHookCalls = 0;
    const make = () =>
      withStepHooks(
        {
          config: { retry: { maxAttempts: 2 } },
          execute: async () => {
            bodyAttempts++;
            throw new TypeError("persist me");
          },
          input: undefined,
          name: "failure-recovery",
        },
        {
          after: {
            failure: [
              {
                execute: async () => {
                  failureHookCalls++;
                },
                name: "persisted-report",
              },
            ],
          },
        }
      );

    const first = make();
    await expect(first.run()).rejects.toThrow("persist me");
    const recoveredRecords = { ...first.steps };
    delete recoveredRecords["failure-recovery"];

    const recovered = make();
    await Effect.runPromise(recovered.snapshot.seed(recoveredRecords));
    const error = await captureError(() => recovered.run());
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe("persist me");
    expect(bodyAttempts).toBe(2);
    expect(failureHookCalls).toBe(1);
  });
});

describe("withStepHooks — suspension outcomes", () => {
  test("selects deterministic branches for repeated body suspension occurrences", async () => {
    const occurrences: number[] = [];
    const step = withStepHooks(
      {
        execute: async (_input, ctx) => {
          await ctx.suspend({ name: "wait", reason: "first" });
          await ctx.suspend({ name: "wait", reason: "second" });
          return "done";
        },
        input: undefined,
        name: "body-occurrences",
      },
      {
        after: {
          suspension: [
            {
              execute: async ({ occurrence }) => {
                occurrences.push(occurrence);
              },
              name: "checkpoint",
            },
          ],
        },
      }
    );

    const first = await captureError(() => step.run());
    expect(isSuspendSignal(first) && first.suspension.occurrence).toBe(0);
    await step.resolveOccurrence(
      ["body-occurrences", "@body"],
      "wait",
      0,
      "first"
    );

    const second = await captureError(() => step.run());
    expect(isSuspendSignal(second) && second.suspension.occurrence).toBe(1);
    expect(occurrences).toEqual([0, 1]);
    expect(
      step.steps["body-occurrences.@after.suspension:0.checkpoint"]?.status
    ).toBe("complete");
    expect(
      step.steps["body-occurrences.@after.suspension:1.checkpoint"]?.status
    ).toBe("complete");
  });

  test("a suspending suspension hook resolves before the original body suspension is exposed", async () => {
    let hookCalls = 0;
    const step = withStepHooks(
      {
        execute: async (_input, ctx) => {
          await ctx.suspend({ name: "body-wait", reason: "external" });
          return "done";
        },
        input: undefined,
        name: "hook-checkpoint",
      },
      {
        after: {
          suspension: [
            {
              execute: async (_input, ctx) => {
                hookCalls++;
                await ctx.suspend({
                  name: "hook-wait",
                  reason: "persist checkpoint",
                });
              },
              name: "durable-hook",
            },
          ],
        },
      }
    );

    const hookSuspension = await captureError(() => step.run());
    expect(
      isSuspendSignal(hookSuspension) && hookSuspension.suspension.name
    ).toBe("hook-wait");

    await step.resolveOccurrence(
      ["hook-checkpoint", "@after", "suspension:0", "durable-hook"],
      "hook-wait",
      0,
      "stored"
    );
    const bodySuspension = await captureError(() => step.run());
    expect(
      isSuspendSignal(bodySuspension) && bodySuspension.suspension.name
    ).toBe("body-wait");

    const replay = await captureError(() => step.run());
    expect(isSuspendSignal(replay) && replay.suspension.name).toBe("body-wait");
    expect(hookCalls).toBe(2);
  });

  test("a failed suspension hook wins with the original suspension as cause", async () => {
    const step = withStepHooks(
      {
        execute: async (_input, ctx) => {
          await ctx.suspend({ name: "body-wait", reason: "external" });
          return "done";
        },
        input: undefined,
        name: "suspension-hook-fails",
      },
      {
        after: {
          suspension: [
            {
              execute: async () => {
                throw new Error("checkpoint failed");
              },
              name: "broken-checkpoint",
            },
          ],
        },
      }
    );

    const error = await captureError(() => step.run());
    expect(error.message).toBe("checkpoint failed");
    expect(isSuspendSignal(error.cause)).toBe(true);
    if (isSuspendSignal(error.cause)) {
      expect(error.cause.suspension.name).toBe("body-wait");
    }
    expect(step.steps["suspension-hook-fails.@body"]?.status).toBe("suspended");
  });

  test("suspension recovery replays only the body and skips completed phases", async () => {
    let beforeCalls = 0;
    let bodyCalls = 0;
    let suspensionHookCalls = 0;
    const make = () =>
      withStepHooks(
        {
          execute: async (_input, ctx) => {
            bodyCalls++;
            await ctx.suspend({ name: "wait", reason: "external" });
            return "done";
          },
          input: undefined,
          name: "suspension-recovery",
        },
        {
          after: {
            suspension: [
              {
                execute: async () => {
                  suspensionHookCalls++;
                },
                name: "parked",
              },
            ],
          },
          before: [
            {
              execute: async () => {
                beforeCalls++;
              },
              name: "prepare",
            },
          ],
        }
      );

    const first = make();
    const firstError = await captureError(() => first.run());
    expect(isSuspendSignal(firstError)).toBe(true);
    const records: Record<string, StepSnapshot> = { ...first.steps };
    delete records["suspension-recovery"];

    const recovered = make();
    await Effect.runPromise(recovered.snapshot.seed(records));
    const recoveredError = await captureError(() => recovered.run());
    expect(
      isSuspendSignal(recoveredError) && recoveredError.suspension.occurrence
    ).toBe(0);
    expect(beforeCalls).toBe(1);
    expect(bodyCalls).toBe(2);
    expect(suspensionHookCalls).toBe(1);
  });
});

describe("withStepHooks — execution policy and validation", () => {
  test("uses hook-local retry without inheriting it into another hook or the body", async () => {
    let retriedHookCalls = 0;
    let nextHookCalls = 0;
    let bodyCalls = 0;
    const step = withStepHooks(
      {
        execute: async () => {
          bodyCalls++;
          return "done";
        },
        input: undefined,
        name: "local-retry",
      },
      {
        before: [
          {
            config: { retry: { maxAttempts: 2 } },
            execute: async () => {
              retriedHookCalls++;
              if (retriedHookCalls === 1) {
                throw new Error("retry me");
              }
            },
            name: "retried",
          },
          {
            execute: async () => {
              nextHookCalls++;
            },
            name: "single",
          },
        ],
      }
    );

    await expect(step.run()).resolves.toBe("done");
    expect(retriedHookCalls).toBe(2);
    expect(nextHookCalls).toBe(1);
    expect(bodyCalls).toBe(1);
  });

  test.each([
    ["reserved", "@internal", /reserved/],
    ["blank", "", /non-empty/],
    ["whitespace", " spaced", /whitespace/],
  ])("rejects %s hook names", (_case, name, expected) => {
    expect(() =>
      withStepHooks(
        {
          execute: async () => undefined,
          input: undefined,
          name: "invalid",
        },
        {
          before: [{ execute: async () => undefined, name }],
        }
      )
    ).toThrow(expected);
  });

  test("rejects duplicates within one branch but permits the same name across branches", async () => {
    expect(() =>
      withStepHooks(
        {
          execute: async () => undefined,
          input: undefined,
          name: "duplicate",
        },
        {
          after: {
            failure: [
              { execute: async () => undefined, name: "same" },
              { execute: async () => undefined, name: "same" },
            ],
          },
        }
      )
    ).toThrow(/Duplicate.*after\.failure/);

    const valid = withStepHooks(
      {
        execute: async () => "ok",
        input: undefined,
        name: "cross-branch",
      },
      {
        after: {
          failure: [{ execute: async () => undefined, name: "same" }],
          success: [{ execute: async () => undefined, name: "same" }],
        },
        before: [{ execute: async () => undefined, name: "same" }],
      }
    );
    await expect(valid.run()).resolves.toBe("ok");
  });
});
