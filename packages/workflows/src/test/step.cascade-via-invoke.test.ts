/**
 * Cascade-via-invoke — regression lock for the engine-unification fix.
 *
 * Before Phase 1, `Executable.drive` (the engine behind `ctx.invoke` /
 * `ctx.parallel` / `ctx.race`) lacked the post-body child cascade that
 * `Step.#run` had. A step with declared children, when driven through a
 * composition primitive, never drained those children — the same step
 * via `.run()` did. Once the cascade moved into the single engine,
 * invoke/parallel paths drain children too.
 *
 * These tests pin: a step with declared children, invoked via
 * `ctx.invoke` (and `ctx.parallel`), runs those children to completion.
 */

import { describe, expect, it } from "vitest";

import { Step } from "../step";

// ════════════════════════════════════════════════════════════════════════════
// 1. ctx.invoke drains the invoked step's declared children
// ════════════════════════════════════════════════════════════════════════════

describe("cascade via ctx.invoke", () => {
  it("an invoked step with declared children drains them (post-body cascade)", async () => {
    const ran: string[] = [];

    // A standalone step that declares its own children. When invoked, its
    // body returns its own value; the declared children must still drain.
    const invoked = Step.create<void, "invoked-out">({
      children: [
        {
          execute: async () => {
            ran.push("leaf-a");
            return "a-out";
          },
          input: undefined,
          name: "leaf-a",
        },
        {
          execute: async () => {
            ran.push("leaf-b");
            return "b-out";
          },
          input: undefined,
          name: "leaf-b",
        },
      ],
      execute: async (): Promise<"invoked-out"> => {
        ran.push("invoked-body");
        return "invoked-out";
      },
      input: undefined,
      name: "invoked",
    });

    const root = Step.create<void, "ok">({
      execute: async (_input, ctx): Promise<"ok"> => {
        const out = await ctx.invoke(invoked, undefined);
        expect(out).toBe("invoked-out");
        return "ok";
      },
      input: undefined,
      name: "root",
    });

    await root.run();

    // Body ran, and BOTH declared children were drained (the bug fix).
    expect(ran).toEqual(["invoked-body", "leaf-a", "leaf-b"]);

    // The children's completion is recorded on the invoked step's snapshot.
    const steps = invoked.steps;
    expect(steps["invoked.leaf-a"]?.status).toBe("complete");
    expect(steps["invoked.leaf-b"]?.status).toBe("complete");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. ctx.parallel drains each entry's declared children
// ════════════════════════════════════════════════════════════════════════════

describe("cascade via ctx.parallel", () => {
  it("a parallel entry with declared children drains them", async () => {
    const ran: string[] = [];

    const worker = Step.create<unknown, unknown>({
      children: [
        {
          execute: async () => {
            ran.push("sub");
            return "sub-out";
          },
          input: undefined,
          name: "sub",
        },
      ],
      execute: async () => {
        ran.push("worker-body");
        return "worker-out";
      },
      input: undefined,
      name: "worker",
    });

    const root = Step.create<void, "ok">({
      execute: async (_input, ctx): Promise<"ok"> => {
        const out = await ctx.parallel({
          w: { input: undefined, step: worker },
        });
        expect(out.w).toBe("worker-out");
        return "ok";
      },
      input: undefined,
      name: "root",
    });

    await root.run();

    expect(ran).toEqual(["worker-body", "sub"]);
    expect(worker.steps["worker.sub"]?.status).toBe("complete");
  });
});
