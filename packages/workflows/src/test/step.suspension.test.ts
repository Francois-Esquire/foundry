/**
 * Step suspension — step.suspend({name, reason, meta?}) throws SuspendSignal,
 * parking the enclosing Workflow at status=suspended. workflow.resume(name, value)
 * records the resolution; the next run() short-circuits suspend(name) with the
 * stored value.
 */

import { describe, expect, it, test } from "vitest";

import { isSuspendSignal, SuspendSignal } from "../executable";
import { Step } from "../step";
import { Workflow } from "../workflow";
import { collectEvents } from "./helpers/streams";

// ════════════════════════════════════════════════════════════════════════════
// A. Basic flow
// ════════════════════════════════════════════════════════════════════════════

describe("Suspension — basic flow", () => {
  test("step.suspend({name, reason}) throws a SuspendSignal", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    let captured: unknown = null;
    try {
      await step.suspend({ name: "approval", reason: "external-review" });
    } catch (e) {
      captured = e;
    }
    expect(isSuspendSignal(captured)).toBe(true);
    if (isSuspendSignal(captured)) {
      expect(captured.suspension.name).toBe("approval");
      expect(captured.suspension.reason).toBe("external-review");
    }
  });

  test("workflow status transitions to 'suspended' when execute throws SuspendSignal", async () => {
    const wf = Workflow.create({
      execute: async (_input, ctx) => {
        await ctx.suspend({ name: "wait", reason: "external" });
        return "ok";
      },
      input: undefined,
      name: "wf-suspend",
    });
    await wf.run().catch(() => undefined);
    const status = wf.status;
    expect(status).toBe("suspended");
  });

  test("workflow.state.suspension carries the suspend args (name, reason, meta)", async () => {
    const wf = Workflow.create({
      execute: async (_input, ctx) => {
        await ctx.suspend({
          meta: { ticket: "TKT-42" },
          name: "approval",
          reason: "needs-review",
        });
        return "ok";
      },
      input: undefined,
      name: "wf-state",
    });
    await wf.run().catch(() => undefined);
    const state = wf.state;
    expect(state.suspension?.name).toBe("approval");
    expect(state.suspension?.reason).toBe("needs-review");
    expect(state.suspension?.meta).toEqual({ ticket: "TKT-42" });
  });

  test("snapshot records a step.suspended event for the suspending step", async () => {
    const step = await Step.make({
      execute: async (_input, ctx) => {
        await ctx.suspend({ name: "wait", reason: "external" });
        return "ok";
      },
      input: undefined,
      name: "needs-approval",
    });
    const handle = collectEvents(step);
    await step.run().catch(() => undefined);
    handle.stop();
    const suspended = handle.events.filter((e) => e._tag === "step.suspended");
    expect(suspended.length).toBe(1);
    if (suspended[0]?._tag === "step.suspended") {
      expect(suspended[0].name).toBe("needs-approval");
      expect(suspended[0].suspension.name).toBe("wait");
    }
  });

  test("a SuspendSignal never consumes the Step retry policy", async () => {
    let attempts = 0;
    const wf = Workflow.create({
      config: { retry: { maxAttempts: 4 } },
      execute: async (_input, context) => {
        attempts += 1;
        await context.suspend({ name: "approval", reason: "external" });
        return "done";
      },
      input: undefined,
      name: "suspend-with-retry",
    });

    await wf.run().catch(() => undefined);
    expect(attempts).toBe(1);
    expect(wf.status).toBe("suspended");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. Resume
// ════════════════════════════════════════════════════════════════════════════

describe("Suspension — resume", () => {
  test("workflow.resume(name, value) records the resolution", async () => {
    // After resume, calling step.suspend(name) again returns the value
    // synchronously instead of throwing — that's what 'records the
    // resolution' means.
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "resolver",
    });
    await step.resolve("approval", "approved");
    const value = await step.suspend<string>({
      name: "approval",
      reason: "external-review",
    });
    expect(value).toBe("approved");
  });

  test("after resume(), workflow status transitions back to 'queued'", async () => {
    const wf = Workflow.create({
      execute: async (_input, ctx) => {
        await ctx.suspend({ name: "wait", reason: "ext" });
        return "ok";
      },
      input: undefined,
      name: "wf-resume",
    });
    await wf.run().catch(() => undefined);
    expect(wf.status).toBe("suspended");
    await wf.resume("wait", "go");
    expect(wf.status).toBe("queued");
  });

  test("the next run() short-circuits the matching suspend() with the recorded value", async () => {
    let observed: string | null = null;
    const wf = Workflow.create<void, string>({
      execute: async (_input, ctx) => {
        observed = await ctx.suspend<string>({
          name: "approval",
          reason: "ext",
        });
        return observed;
      },
      input: undefined,
      name: "wf-shortcircuit",
    });
    // First run parks the workflow.
    await wf.run().catch(() => undefined);
    expect(observed).toBe(null);
    // Resume with a value, then re-run.
    await wf.resume("approval", "approved");
    const result = await wf.run();
    expect(observed).toBe("approved");
    expect(result).toBe("approved");
  });

  test("the workflow then runs to terminal status (complete or failed)", async () => {
    const wf = Workflow.create({
      execute: async (_input, ctx) => {
        await ctx.suspend({ name: "wait", reason: "ext" });
        return "done";
      },
      input: undefined,
      name: "wf-terminal",
    });
    await wf.run().catch(() => undefined);
    await wf.resume("wait", undefined);
    await wf.run();
    expect(wf.status).toBe("complete");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. Multiple suspensions per run
// ════════════════════════════════════════════════════════════════════════════

describe("Suspension — multiple suspensions per run", () => {
  test("two suspends with different names park sequentially across multiple resume cycles", async () => {
    const observed: string[] = [];
    const wf = Workflow.create<void, string>({
      execute: async (_input, ctx) => {
        const a = await ctx.suspend<string>({
          name: "first",
          reason: "ext",
        });
        observed.push(a);
        const b = await ctx.suspend<string>({
          name: "second",
          reason: "ext",
        });
        observed.push(b);
        return `${a}-${b}`;
      },
      input: undefined,
      name: "wf-multi",
    });

    // Park 1 — at "first".
    await wf.run().catch(() => undefined);
    expect(wf.status).toBe("suspended");
    expect(observed).toEqual([]);

    // Resolve "first", re-run; should park at "second". The body
    // replays from the top, so suspend("first") returns the resolution
    // and "A" is pushed before suspend("second") parks.
    await wf.resume("first", "A");
    await wf.run().catch(() => undefined);
    expect(wf.status).toBe("suspended");
    expect(observed).toEqual(["A"]);

    // Resolve "second", re-run; should complete. The body replays a
    // third time — both suspends are now resolved — so "A" is pushed
    // again, then "B".
    await wf.resume("second", "B");
    const result = await wf.run();
    expect(result).toBe("A-B");
    expect(observed).toEqual(["A", "A", "B"]);
  });

  test("snapshot.changes accumulates a suspended event for every park", async () => {
    const step = await Step.make({
      execute: async (_input, ctx) => {
        await ctx.suspend({ name: "first", reason: "ext" });
        await ctx.suspend({ name: "second", reason: "ext" });
        return "done";
      },
      input: undefined,
      name: "multi",
    });
    const handle = collectEvents(step);
    // First run parks at "first".
    await step.run().catch(() => undefined);
    // Resolve "first", re-run; parks at "second".
    await step.resolve("first", undefined);
    await step.run().catch(() => undefined);
    handle.stop();
    const suspended = handle.events.filter((e) => e._tag === "step.suspended");
    expect(suspended.length).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D. Edge cases
// ════════════════════════════════════════════════════════════════════════════

describe("Suspension — edge cases", () => {
  test("double resume of the same name: second resume is a no-op (first value sticks)", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "double-resume",
    });
    await step.resolve("approval", "first");
    await step.resolve("approval", "second");
    const value = await step.suspend<string>({
      name: "approval",
      reason: "ext",
    });
    expect(value).toBe("second");
  });

  test("suspend inside a forked child propagates to the workflow", async () => {
    const wf = Workflow.create({
      children: [
        {
          execute: async (_input, ctx) => {
            await ctx.suspend({ name: "wait-in-child", reason: "ext" });
          },
          input: undefined,
          name: "child",
        },
      ],
      execute: async (_input, ctx) => {
        const child = ctx.children[0];
        if (!child) {
          throw new Error("expected child");
        }
        await child.run();
        return "ok";
      },
      input: undefined,
      name: "wf-child-suspend",
    });
    await wf.run().catch(() => undefined);
    const status = wf.status;
    expect(status).toBe("suspended");
    const state = wf.state;
    expect(state.suspension?.name).toBe("wait-in-child");
  });

  test("workflow.cancel() on a suspended workflow resolves the result as cancelled", async () => {
    const wf = Workflow.create({
      execute: async (_input, ctx) => {
        await ctx.suspend({ name: "wait", reason: "ext" });
        return "ok";
      },
      input: undefined,
      name: "wf-cancel-suspended",
    });
    await wf.run().catch(() => undefined);
    expect(wf.status).toBe("suspended");
    await wf.cancel("user-stop");
    expect(wf.status).toBe("cancelled");
    const result = await wf.result();
    expect(result.status).toBe("cancelled");
    if (result.status === "cancelled") {
      expect(result.reason).toBe("user-stop");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// E. Sentinel-class sanity
// ════════════════════════════════════════════════════════════════════════════

describe("Suspension — SuspendSignal sentinel", () => {
  it("exposes name, reason, meta on the SuspendSignal", () => {
    const sig = new SuspendSignal(
      {
        meta: { foo: 1 },
        name: "x",
        reason: "y",
        suspendedAt: new Date().toISOString(),
      },
      ["x"]
    );
    expect(sig.name).toBe("SuspendSignal");
    expect(sig.suspension.name).toBe("x");
    expect(sig.suspension.reason).toBe("y");
    expect(sig.suspension.meta).toEqual({ foo: 1 });
    expect(isSuspendSignal(sig)).toBe(true);
  });
});
