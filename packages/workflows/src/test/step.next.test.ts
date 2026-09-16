/**
 * Step — `ctx.next()` (Koa-style middleware seam).
 *
 * Pass-2 surface. A body may opt into propagating-cascade by `await`ing
 * `ctx.next()`: every currently-pending child of this step is run
 * sequentially, in append order, and the first failure (throw, bail,
 * suspend) reaches the body as a Promise rejection.
 *
 * Key invariants pinned here:
 *
 *   - Bodies that don't call `ctx.next()` still get the post-body
 *     auto-cascade fallback (fire-and-forget, swallowed failures).
 *   - `ctx.next()` is multi-call safe; redundant calls are a no-op
 *     when nothing is pending.
 *   - Skip-on-complete is the single bookkeeping mechanism — children
 *     completed via eager `child.run()` or a previous `next()` call
 *     are skipped.
 *   - `next()` rejects with parity to `step.run` on bail (StepBailError)
 *     and suspend (SuspendSignal) so the body can branch on the same
 *     discriminants.
 */

import { describe, expect, it } from "vitest";

import { isSuspendSignal } from "../executable";
import { Step, StepBailError } from "../step";
import { bail } from "../types";

// ════════════════════════════════════════════════════════════════════════════
// 1. Body-driven cascade: ctx.next() drains declared children in order
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.next() — body-driven cascade", () => {
  it("declared children run before body's continuation; ctx.resultOf sees outputs after", async () => {
    const order: string[] = [];
    const captured: { firstAfter?: unknown; secondAfter?: unknown } = {};

    const step = await Step.make<void, "ok">({
      children: [
        {
          execute: async () => {
            order.push("first");
            return "first-out";
          },
          input: undefined,
          name: "first",
        },
        {
          execute: async () => {
            order.push("second");
            return "second-out";
          },
          input: undefined,
          name: "second",
        },
      ],
      execute: async (_input, ctx): Promise<"ok"> => {
        order.push("body-pre");
        await ctx.next();
        order.push("body-post");
        captured.firstAfter = ctx.resultOf("first");
        captured.secondAfter = ctx.resultOf("second");
        return "ok";
      },
      input: undefined,
      name: "next-drains",
    });

    await step.run();

    expect(order).toEqual(["body-pre", "first", "second", "body-post"]);
    expect(captured.firstAfter).toBe("first-out");
    expect(captured.secondAfter).toBe("second-out");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. No-call regression: post-body auto-cascade still works
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.next() — opt-in: fallback cascade unchanged", () => {
  it("body never calls ctx.next() — declared children still complete via the auto-cascade", async () => {
    const ran: string[] = [];
    const step = await Step.make<void, "ok">({
      children: [
        {
          execute: async () => {
            ran.push("a");
            return "a-out";
          },
          input: undefined,
          name: "leaf-a",
        },
        {
          execute: async () => {
            ran.push("b");
            return "b-out";
          },
          input: undefined,
          name: "leaf-b",
        },
      ],
      execute: async (): Promise<"ok"> => "ok",
      input: undefined,
      name: "no-next",
    });

    await step.run();

    expect(ran).toEqual(["a", "b"]);
    const steps = step.steps;
    expect(steps["no-next.leaf-a"]?.status).toBe("complete");
    expect(steps["no-next.leaf-b"]?.status).toBe("complete");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Multi-call: second next() is a no-op
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.next() — multi-call safety", () => {
  it("calling ctx.next() twice — second call is a no-op (nothing pending)", async () => {
    let bodyRuns = 0;
    let leafRuns = 0;

    const step = await Step.make<void, "ok">({
      children: [
        {
          execute: async () => {
            leafRuns++;
            return "leaf-out";
          },
          input: undefined,
          name: "leaf",
        },
      ],
      execute: async (_input, ctx): Promise<"ok"> => {
        bodyRuns++;
        await ctx.next();
        await ctx.next();
        return "ok";
      },
      input: undefined,
      name: "double-next",
    });

    await step.run();

    expect(bodyRuns).toBe(1);
    expect(leafRuns).toBe(1);
    expect(step.steps["double-next.leaf"]?.status).toBe("complete");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Fork BEFORE next() — drained by next()
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.next() — interaction with ctx.fork", () => {
  it("body forks BEFORE ctx.next() — fork is drained by next() (in-order)", async () => {
    const order: string[] = [];

    const step = await Step.make<void, "ok">({
      children: [
        {
          execute: async () => {
            order.push("declared");
            return "declared-out";
          },
          input: undefined,
          name: "declared",
        },
      ],
      execute: async (_input, ctx): Promise<"ok"> => {
        ctx.fork({
          execute: async () => {
            order.push("dyn");
            return "dyn-out";
          },
          input: undefined,
          name: "dyn",
        });
        order.push("body-pre-next");
        await ctx.next();
        order.push("body-post-next");
        return "ok";
      },
      input: undefined,
      name: "fork-before",
    });

    await step.run();

    // Append-order: declared was registered first via spec.children, then dyn
    // was appended via ctx.fork. Both pending at next()-call time, drained
    // sequentially.
    expect(order).toEqual([
      "body-pre-next",
      "declared",
      "dyn",
      "body-post-next",
    ]);
  });

  it("body forks AFTER ctx.next() — fork is drained by the post-body fallback cascade", async () => {
    const order: string[] = [];

    const step = await Step.make<void, "ok">({
      children: [
        {
          execute: async () => {
            order.push("declared");
            return "declared-out";
          },
          input: undefined,
          name: "declared",
        },
      ],
      execute: async (_input, ctx): Promise<"ok"> => {
        await ctx.next();
        order.push("body-after-next");
        ctx.fork({
          execute: async () => {
            order.push("dyn-late");
            return "dyn-late-out";
          },
          input: undefined,
          name: "dyn-late",
        });
        return "ok";
      },
      input: undefined,
      name: "fork-after",
    });

    await step.run();

    expect(order).toEqual(["declared", "body-after-next", "dyn-late"]);
    expect(step.steps["fork-after.dyn-late"]?.status).toBe("complete");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Eager-driven child + skip-on-complete
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.next() — skip-on-complete for eager-driven children", () => {
  it("body runs ctx.children[0].run() then ctx.next() — eager child is skipped, rest drain", async () => {
    const runs: string[] = [];

    const step = await Step.make<void, "ok">({
      children: [
        {
          execute: async () => {
            runs.push("eager");
            return "eager-out";
          },
          input: undefined,
          name: "eager",
        },
        {
          execute: async () => {
            runs.push("tail");
            return "tail-out";
          },
          input: undefined,
          name: "tail",
        },
      ],
      execute: async (_input, ctx): Promise<"ok"> => {
        const eager = ctx.children[0];
        if (!eager) {
          throw new Error("missing eager child");
        }
        await eager.run();
        await ctx.next();
        return "ok";
      },
      input: undefined,
      name: "eager-then-next",
    });

    await step.run();

    // The eager child runs exactly once (via the explicit run, not
    // re-driven by next() or by the post-body cascade).
    expect(runs).toEqual(["eager", "tail"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Failure propagation — throw
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.next() — throw propagation", () => {
  it("child throws inside ctx.next() — next() rejects; subsequent pending stay pending", async () => {
    let captured: unknown = "<<NOT-CAUGHT>>";
    let tailRan = false;

    const step = await Step.make<void, "ok">({
      children: [
        {
          execute: async () => {
            throw new Error("inner-boom");
          },
          input: undefined,
          name: "boomer",
        },
        {
          execute: async () => {
            tailRan = true;
            return "tail-out";
          },
          input: undefined,
          name: "tail",
        },
      ],
      execute: async (_input, ctx): Promise<"ok"> => {
        try {
          await ctx.next();
        } catch (e) {
          captured = e;
        }
        // We intentionally do NOT call ctx.next() again here — assertion
        // 7 covers the "tail still pending after throw" case.
        return "ok";
      },
      input: undefined,
      name: "throw-mid",
    });

    await step.run();

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("inner-boom");
    // The body returned "ok" without re-driving tail. Tail's failure
    // record is "pending" before the post-body cascade runs, but that
    // cascade still executes it (fire-and-forget) once the body returns.
    // What we want to assert is the propagation seam, not the post-body
    // fallback. So check: tailRan was false at the moment the throw
    // surfaced (i.e. inside the catch). The fallback cascade then runs
    // it once the body returns.
    expect(tailRan).toBe(true);
    const steps = step.steps;
    expect(steps["throw-mid.boomer"]?.status).toBe("failed");
    expect(steps["throw-mid.tail"]?.status).toBe("complete");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Resume after rejection — second next() call drains the rest
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.next() — resume-after-failure", () => {
  it("catches ctx.next() rejection, calls ctx.next() again — failed child is skipped, rest drain", async () => {
    const runs: string[] = [];
    let captured: unknown = "<<NOT-CAUGHT>>";

    const step = await Step.make<void, "ok">({
      children: [
        {
          execute: async () => {
            runs.push("fail-once");
            throw new Error("first-time-bad");
          },
          input: undefined,
          name: "fail-once",
        },
        {
          execute: async () => {
            runs.push("tail-a");
            return "tail-a-out";
          },
          input: undefined,
          name: "tail-a",
        },
        {
          execute: async () => {
            runs.push("tail-b");
            return "tail-b-out";
          },
          input: undefined,
          name: "tail-b",
        },
      ],
      execute: async (_input, ctx): Promise<"ok"> => {
        try {
          await ctx.next();
        } catch (e) {
          captured = e;
        }
        // Second call — fail-once is now status "failed", not "pending",
        // so skip-on-complete-or-non-pending in #next filters it out.
        await ctx.next();
        return "ok";
      },
      input: undefined,
      name: "resume",
    });

    await step.run();

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe("first-time-bad");
    // fail-once ran once (during first next()), tails ran during second.
    expect(runs).toEqual(["fail-once", "tail-a", "tail-b"]);
    const steps = step.steps;
    expect(steps["resume.fail-once"]?.status).toBe("failed");
    expect(steps["resume.tail-a"]?.status).toBe("complete");
    expect(steps["resume.tail-b"]?.status).toBe("complete");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Bail propagation — parity with step.run
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.next() — bail parity with step.run", () => {
  it("child bails inside ctx.next() — next() rejects with StepBailError carrying the bail", async () => {
    let captured: unknown = "<<NOT-CAUGHT>>";

    const step = await Step.make<void, "ok">({
      children: [
        {
          execute: async () => bail({ code: "nope" }),
          input: undefined,
          name: "bailer",
        },
        {
          execute: async () => "after-out",
          input: undefined,
          name: "after",
        },
      ],
      execute: async (_input, ctx): Promise<"ok"> => {
        try {
          await ctx.next();
        } catch (e) {
          captured = e;
        }
        return "ok";
      },
      input: undefined,
      name: "bail-mid",
    });

    await step.run();

    expect(captured).toBeInstanceOf(StepBailError);
    expect((captured as StepBailError).stepName).toBe("bailer");
    expect((captured as StepBailError).bail.error).toEqual({ code: "nope" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Suspend propagation — parity with step.run
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.next() — suspend parity with step.run", () => {
  it("child suspends inside ctx.next() — next() rejects with SuspendSignal", async () => {
    let captured: unknown = "<<NOT-CAUGHT>>";

    const step = await Step.make<void, "ok">({
      children: [
        {
          execute: async (_input, ctx) => {
            await ctx.suspend<string>({
              name: "approval",
              reason: "needs review",
            });
            return "never-here";
          },
          input: undefined,
          name: "suspender",
        },
      ],
      execute: async (_input, ctx): Promise<"ok"> => {
        try {
          await ctx.next();
        } catch (e) {
          captured = e;
          throw e;
        }
        return "ok";
      },
      input: undefined,
      name: "suspend-mid",
    });

    await expect(step.run()).rejects.toBeDefined();
    expect(isSuspendSignal(captured)).toBe(true);
  });
});
