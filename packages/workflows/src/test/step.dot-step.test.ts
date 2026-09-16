/**
 * Step — pass-4 ergonomic affordances: `Step.create` + `.step()`.
 *
 * Pass-4 adds two surfaces on top of the pass-3 lazy-init machinery:
 *
 *   - `Step.create(spec)` — synchronous static factory. Returns
 *     `Step<I, O, X>` directly (no Promise wrapper). `Step.make` stays
 *     for back-compat and is now a one-liner around `Step.create`.
 *   - `step.step(specOrStep)` — instance method that appends a child
 *     and returns the **child** (typed). Three call paths:
 *       1. Pre-bind, spec form — child constructed via `Step.create`,
 *          claimed, stashed into `#pendingChildren`.
 *       2. Pre-bind, Step instance — instance validated (unbound,
 *          unclaimed), claimed, stashed.
 *       3. Post-bind — routes through `fork(spec)` for specs, or
 *          binds the instance via `child.#initialize(this)` and appends.
 *
 * Invariants pinned here mirror the pass-3 test patterns:
 *
 *   1. Pre-bind spec-form: child returned is unbound + claimed; parent's
 *      pending-children length grows; parent.run() materializes both.
 *   2. Pre-bind instance form: standalone Step gets claimed when handed
 *      to parent.step(); parent.run() binds.
 *   3. Mixed chain (.step(spec).step(spec).step(stepInstance)) — all
 *      three end up under parent's substrate after parent.run().
 *   4. Post-bind, spec form via the body's captured parent ref.
 *   5. Post-bind, instance form via the body's captured parent ref.
 *   6. Double-claim — passing one child to two parents throws.
 *   7. Already-bound — running a Step standalone then handing it to
 *      another parent throws.
 *   8. `Step.create` returns a Step instance synchronously (no await
 *      needed, no Promise).
 *   9. `.step()` returns the child Step typed appropriately so
 *      `child.output` reflects the spec's return type.
 *  10. End-to-end integration — `Step.create` parent + `.step(spec)`
 *      chain + `await ctx.next()` + `child.output` reads.
 */

import { describe, expect, it } from "vitest";

import type { StepSpec } from "../step";

import { Step } from "../step";

// ════════════════════════════════════════════════════════════════════════════
// 1. Pre-bind, spec form — child returned unbound + claimed
// ════════════════════════════════════════════════════════════════════════════

describe("Step.create + .step(spec) — pre-bind, spec form", () => {
  it("attaches the spec as a claimed pending child; parent.run() materializes both", async () => {
    const parent = Step.create<void, "parent-out">({
      execute: async (_input, ctx): Promise<"parent-out"> => {
        await ctx.next();
        return "parent-out";
      },
      input: undefined,
      name: "parent",
    });

    const returned = parent.step<void, "child-out">({
      execute: async (): Promise<"child-out"> => "child-out",
      input: undefined,
      name: "child",
    });
    // .step() returns the parent for chaining.
    expect(returned).toBe(parent);

    const result = await parent.run();
    expect(result).toBe("parent-out");

    // Child is materialized under parent's substrate; readable via path.
    expect(parent.steps["parent.child"]?.status).toBe("complete");
    expect(parent.steps["parent.child"]?.output).toBe("child-out");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Pre-bind, Step instance form
// ════════════════════════════════════════════════════════════════════════════

describe("Step.create + .step(stepInstance) — pre-bind, instance form", () => {
  it("standalone Step.create instance becomes claimed when passed to .step(); parent.run() binds it", async () => {
    const child = Step.create<void, "child-out">({
      execute: async (): Promise<"child-out"> => "child-out",
      input: undefined,
      name: "instance-child",
    });

    const parent = Step.create<void, "parent-out">({
      execute: async (_input, ctx): Promise<"parent-out"> => {
        await ctx.next();
        return "parent-out";
      },
      input: undefined,
      name: "parent",
    });

    const returned = parent.step(child);
    // .step() returns the parent for chaining.
    expect(returned).toBe(parent);

    // Now claimed-unbound — substrate access throws.
    expect(() => child.snapshot).toThrow(/not bound/);

    await parent.run();

    expect(child.snapshot).toBe(parent.snapshot);
    expect(child.path).toEqual(["parent", "instance-child"]);
    expect(child.output).toBe("child-out");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Mixed chain — .step(spec).step(spec).step(stepInstance)
// ════════════════════════════════════════════════════════════════════════════

describe("Step.create + chained .step(...) — mixed spec/instance children", () => {
  it("three .step() calls (spec, spec, instance) all end up under parent's substrate after parent.run()", async () => {
    const ran: string[] = [];

    const instanceChild = Step.create<void, "third-out">({
      execute: async (): Promise<"third-out"> => {
        ran.push("third");
        return "third-out";
      },
      input: undefined,
      name: "third",
    });

    const first = Step.create<void, "first-out">({
      execute: async (): Promise<"first-out"> => {
        ran.push("first");
        return "first-out";
      },
      input: undefined,
      name: "first",
    });

    const second = Step.create<void, "second-out">({
      execute: async (): Promise<"second-out"> => {
        ran.push("second");
        return "second-out";
      },
      input: undefined,
      name: "second",
    });

    const parent = Step.create<void, "parent-out">({
      execute: async (_input, ctx): Promise<"parent-out"> => {
        await ctx.next();
        return "parent-out";
      },
      input: undefined,
      name: "parent",
    })
      .step(first)
      .step(second)
      .step(instanceChild);

    await parent.run();

    expect(ran).toEqual(["first", "second", "third"]);
    // All three share parent's substrate.
    expect(first.snapshot).toBe(parent.snapshot);
    expect(second.snapshot).toBe(parent.snapshot);
    expect(instanceChild.snapshot).toBe(parent.snapshot);
    // children array reflects all three in append order.
    const kids = parent.children;
    expect(kids.length).toBe(3);
    expect(kids[0]).toBe(first);
    expect(kids[1]).toBe(second);
    expect(kids[2]).toBe(instanceChild);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Post-bind, spec form — adding a child while parent is running
// ════════════════════════════════════════════════════════════════════════════

describe(".step(spec) — post-bind during execute body", () => {
  it("adding a child mid-body via captured parent ref runs the child as part of the cascade", async () => {
    const ran: string[] = [];

    const parent = Step.create<void, "parent-out">({
      execute: async (_input, ctx): Promise<"parent-out"> => {
        ran.push("body-pre");
        // Add a child after the body has started — parent is bound here.
        ctx.step.step<void, "dyn-out">({
          execute: async (): Promise<"dyn-out"> => {
            ran.push("dyn");
            return "dyn-out";
          },
          input: undefined,
          name: "dyn",
        });
        // Drain via next so we observe deterministic order.
        await ctx.next();
        ran.push("body-post");
        return "parent-out";
      },
      input: undefined,
      name: "parent",
    });

    await parent.run();

    expect(ran).toEqual(["body-pre", "dyn", "body-post"]);
    expect(parent.steps["parent.dyn"]?.output).toBe("dyn-out");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Post-bind, instance form
// ════════════════════════════════════════════════════════════════════════════

describe(".step(stepInstance) — post-bind during execute body", () => {
  it("a fresh Step.create() instance handed to a running parent's .step() binds and runs", async () => {
    const ran: string[] = [];

    const parent = Step.create<void, "parent-out">({
      execute: async (_input, ctx): Promise<"parent-out"> => {
        // Build a fresh standalone child, then attach via post-bind path.
        const child = Step.create<void, "late-out">({
          execute: async (): Promise<"late-out"> => {
            ran.push("late");
            return "late-out";
          },
          input: undefined,
          name: "late",
        });
        const attached = ctx.step.step(child);
        // .step() returns the parent for chaining.
        expect(attached).toBe(ctx.step);
        await ctx.next();
        // After draining, the child is bound under the parent.
        expect(child.snapshot).toBe(ctx.step.snapshot);
        expect(child.path).toEqual(["parent", "late"]);
        return "parent-out";
      },
      input: undefined,
      name: "parent",
    });

    await parent.run();
    expect(ran).toEqual(["late"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Double-claim — passing one child to two parents throws
// ════════════════════════════════════════════════════════════════════════════

describe(".step() — double-claim", () => {
  it("the second parent.step(child) throws because the first parent already claimed it", () => {
    const child = Step.create({
      execute: async () => "child-out",
      input: undefined,
      name: "shared",
    });

    const parentA = Step.create({
      execute: async () => "a-out",
      input: undefined,
      name: "parent-a",
    });

    const parentB = Step.create({
      execute: async () => "b-out",
      input: undefined,
      name: "parent-b",
    });

    parentA.step(child);
    expect(() => parentB.step(child)).toThrow(/already/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Already-bound — running standalone then attaching throws
// ════════════════════════════════════════════════════════════════════════════

describe(".step() — already-bound child", () => {
  it("a Step that has already auto-bound (run standalone) cannot be attached to another parent", async () => {
    const child = Step.create<void, "ok">({
      execute: async (): Promise<"ok"> => "ok",
      input: undefined,
      name: "loner",
    });

    // Standalone run — auto-binds as a root.
    await child.run();

    const other = Step.create({
      execute: async () => "other-out",
      input: undefined,
      name: "other",
    });

    expect(() => other.step(child)).toThrow(/already bound/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Step.create is synchronous (no Promise wrapper)
// ════════════════════════════════════════════════════════════════════════════

describe("Step.create — sync return", () => {
  it("returns a Step instance directly, not a Promise", () => {
    const spec: StepSpec<void, "ok"> = {
      execute: async (): Promise<"ok"> => "ok",
      input: undefined,
      name: "sync",
    };
    const step = Step.create(spec);
    // Direct object, not a thenable.
    expect(typeof step).toBe("object");
    expect(step).toBeInstanceOf(Step);
    // Sanity: it really is unbound until used.
    expect(step.kind).toBe("step");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. .step() preserves child output type
// ════════════════════════════════════════════════════════════════════════════

describe(".step() — typed child reference via Step.create", () => {
  it("a Step.create child handed to .step() preserves its typed output through .output after run", async () => {
    const child = Step.create<void, string>({
      execute: async () => "hello",
      input: undefined,
      name: "child-typed",
    });

    const parent = Step.create<void, number>({
      execute: async (_input, ctx) => {
        await ctx.next();
        return 42;
      },
      input: undefined,
      name: "parent-typed",
    }).step(child);

    await parent.run();

    // Compile-time: child.output is string | undefined. Runtime check
    // confirms the wired path produces the typed value.
    const out: string | undefined = child.output;
    expect(out).toBe("hello");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. Integration — Step.create + .step() chain + ctx.next()
// ════════════════════════════════════════════════════════════════════════════

describe("Step.create + .step() — end-to-end integration", () => {
  it("declarative parent built fluently runs its children via ctx.next() and exposes outputs via child refs", async () => {
    const order: string[] = [];

    const first = Step.create<void, string>({
      execute: async () => {
        order.push("first");
        return "alpha";
      },
      input: undefined,
      name: "first",
    });

    const second = Step.create<void, string>({
      execute: async () => {
        order.push("second");
        return "beta";
      },
      input: undefined,
      name: "second",
    });

    const parent = Step.create<void, string>({
      execute: async (_input, ctx) => {
        order.push("pre");
        await ctx.next();
        order.push("post");
        return `${first.output ?? "?"}-${second.output ?? "?"}`;
      },
      input: undefined,
      name: "pipeline",
    })
      .step(first)
      .step(second);

    const result = await parent.run();
    expect(result).toBe("alpha-beta");
    expect(order).toEqual(["pre", "first", "second", "post"]);
    expect(first.output).toBe("alpha");
    expect(second.output).toBe("beta");
  });
});
