/**
 * Step — pass-3 lazy substrate initialization.
 *
 * Pass-3 makes Step's substrate (snapshot/channels/executable/composer/
 * scope/status/output) lazy. A Step constructed via `Step.make` is
 * **unbound** until either:
 *
 *   - Attached to a parent's `spec.children` — the parent's
 *     `#initialize` recursively binds the child under its substrate.
 *   - Touched via any substrate accessor (`step.snapshot`,
 *     `step.channels`, `step.run()`, etc.) — auto-binds as a root.
 *
 * Three states matter:
 *
 *   - **Unclaimed-unbound** — fresh `Step.make`, never claimed by a
 *     parent. Substrate access auto-binds as a root (matches pass-2
 *     ergonomics for stand-alone Steps).
 *   - **Claimed-unbound** — passed into a parent's `spec.children`,
 *     parent hasn't initialized yet. Substrate access THROWS — the
 *     parent owns the binding moment, and a self-bind here would
 *     produce a root substrate that conflicts with the parent's fork.
 *   - **Bound** — substrate allocated; works.
 *
 * This file pins the four pass-3 invariants:
 *   1. Claimed-unbound substrate access throws "not bound".
 *   2. Standalone `step.run()` auto-binds and runs.
 *   3. Pre-built Step instances passed via `spec.children` get bound
 *      under the parent's substrate (snapshot is shared).
 *   4. `(StepSpec | Step)[]` mixed children both end up bound under the
 *      parent.
 *   5. A Step claimed by one parent throws "already bound" if passed to
 *      a second parent.
 *   6. `dispose()` on unbound Step is a no-op.
 *   7. `dispose()` on bound Step closes substrate scope.
 *   8. Step-instance child + `ctx.next()` integrates with pass-2.
 */

import { describe, expect, it } from "vitest";

import type { StepSpec } from "../step";

import { Step } from "../step";

// ════════════════════════════════════════════════════════════════════════════
// 1. Claimed-unbound — substrate access throws
// ════════════════════════════════════════════════════════════════════════════

describe("Step.make — claimed-unbound substrate access", () => {
  it("a child Step claimed by a parent's spec.children throws on substrate access before bind", async () => {
    const child = await Step.make({
      execute: async () => "child-out",
      input: undefined,
      name: "child",
    });

    // Claim the child by stashing it into a parent (parent is itself
    // unbound — it just records the claim in its constructor).
    await Step.make({
      children: [child] as readonly (StepSpec | Step)[],
      execute: async () => "parent-out",
      input: undefined,
      name: "parent",
    });

    // The child is now claimed-unbound. Touching substrate must throw —
    // a parent.run() will bind it; doing it now would create a root
    // substrate that conflicts with the parent's fork.
    expect(() => child.snapshot).toThrow(/not bound/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Standalone run() — auto-binds and runs
// ════════════════════════════════════════════════════════════════════════════

describe("Step.make — standalone run lazy-binds", () => {
  it("Step.make then immediate .run() auto-binds (no explicit init) and resolves", async () => {
    const step = await Step.make<void, "ok">({
      execute: async (): Promise<"ok"> => "ok",
      input: undefined,
      name: "standalone",
    });

    const result = await step.run();
    expect(result).toBe("ok");
    // Post-run, substrate is bound — public getters work.
    expect(step.snapshot).toBeDefined();
    expect(step.status).toBe("complete");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Step instance attached to spec.children — substrate sharing
// ════════════════════════════════════════════════════════════════════════════

describe("Step.make — pre-built Step in spec.children shares parent substrate", () => {
  it("child built via Step.make is bound under parent.run(); snapshot is shared by reference", async () => {
    const child = await Step.make<void, "child-out">({
      execute: async (): Promise<"child-out"> => "child-out",
      input: undefined,
      name: "child",
    });

    const parent = await Step.make<void, "parent-out">({
      children: [child] as readonly (StepSpec | Step)[],
      execute: async (_input, ctx): Promise<"parent-out"> => {
        await ctx.next();
        return "parent-out";
      },
      input: undefined,
      name: "parent",
    });

    await parent.run();

    // After parent.run() the child is bound. Snapshot is shared by
    // reference — pass-2's Snapshot.fork() returns `this`, so the
    // pass-3 substrate-sharing path produces the same identity.
    expect(child.snapshot).toBe(parent.snapshot);
    expect(child.channels).toBe(parent.channels);
    // The child's path is nested under the parent's name.
    expect(child.path).toEqual(["parent", "child"]);
    // Status records both.
    expect(parent.steps["parent.child"]?.status).toBe("complete");
    expect(parent.steps["parent.child"]?.output).toBe("child-out");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Mixed (StepSpec | Step)[] children
// ════════════════════════════════════════════════════════════════════════════

describe("Step.make — mixed StepSpec | Step children", () => {
  it("a parent with one Step instance child and one StepSpec child binds both under itself", async () => {
    const ran: string[] = [];

    const stepChild = await Step.make<void, "instance-out">({
      execute: async (): Promise<"instance-out"> => {
        ran.push("instance-child");
        return "instance-out";
      },
      input: undefined,
      name: "instance-child",
    });

    const parent = await Step.make<void, "parent-out">({
      children: [
        stepChild,
        {
          execute: async () => {
            ran.push("spec-child");
            return "spec-out";
          },
          input: undefined,
          name: "spec-child",
        },
      ] as readonly (StepSpec | Step)[],
      execute: async (_input, ctx): Promise<"parent-out"> => {
        await ctx.next();
        return "parent-out";
      },
      input: undefined,
      name: "parent-mix",
    });

    await parent.run();

    expect(ran).toEqual(["instance-child", "spec-child"]);
    // Both children share the parent's snapshot.
    const [a, b] = parent.children;
    expect(a?.snapshot).toBe(parent.snapshot);
    expect(b?.snapshot).toBe(parent.snapshot);
    // The pre-built Step is the same instance we passed in.
    expect(a).toBe(stepChild);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Already-claimed Step passed to a second parent
// ════════════════════════════════════════════════════════════════════════════

describe("Step.make — double-claim", () => {
  it("a Step instance claimed by one parent throws when passed to a second parent", async () => {
    const child = await Step.make({
      execute: async () => "child-out",
      input: undefined,
      name: "doubly-claimed",
    });

    // First parent claims the child.
    await Step.make({
      children: [child] as readonly (StepSpec | Step)[],
      execute: async () => "first-out",
      input: undefined,
      name: "first-parent",
    });

    // Second parent tries to claim the same child — throws synchronously
    // from the second parent's constructor (the claim flag is already
    // set on the child). `Step.make` wraps `new Step(...)` in
    // `Promise.resolve`, so a constructor throw surfaces synchronously
    // before any Promise is returned.
    expect(() => {
      void Step.make({
        children: [child] as readonly (StepSpec | Step)[],
        execute: async () => "second-out",
        input: undefined,
        name: "second-parent",
      });
    }).toThrow(/already bound/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. dispose() on unbound Step is a no-op
// ════════════════════════════════════════════════════════════════════════════

describe("Step.dispose — unbound", () => {
  it("dispose() on a never-bound Step resolves without throwing", async () => {
    const step = await Step.make({
      execute: async () => "ok",
      input: undefined,
      name: "never-run",
    });

    // Don't trigger any substrate access. dispose() must be a no-op.
    await expect(step.dispose()).resolves.toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. dispose() on bound Step closes substrate scope
// ════════════════════════════════════════════════════════════════════════════

describe("Step.dispose — bound", () => {
  it("dispose() on a Step that ran resolves and the underlying scope closes (idempotent re-dispose still resolves)", async () => {
    const step = await Step.make<void, "ok">({
      execute: async (): Promise<"ok"> => "ok",
      input: undefined,
      name: "to-dispose",
    });

    await step.run();
    await expect(step.dispose()).resolves.toBeUndefined();
    // Effect's Scope.close is idempotent — a second close is a no-op.
    await expect(step.dispose()).resolves.toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Integration — Step instance child + ctx.next()
// ════════════════════════════════════════════════════════════════════════════

describe("Step.make — Step-instance child integrates with ctx.next() from parent", () => {
  it("body's ctx.next() drives the pre-built Step child; ctx.resultOf reads its output", async () => {
    const captured: { value?: unknown } = {};

    const child = await Step.make<void, "child-value">({
      execute: async (): Promise<"child-value"> => "child-value",
      input: undefined,
      name: "child-value",
    });

    const parent = await Step.make<void, "ok">({
      children: [child] as readonly (StepSpec | Step)[],
      execute: async (_input, ctx): Promise<"ok"> => {
        await ctx.next();
        captured.value = ctx.resultOf("child-value");
        return "ok";
      },
      input: undefined,
      name: "parent-with-next",
    });

    const result = await parent.run();
    expect(result).toBe("ok");
    expect(captured.value).toBe("child-value");
  });
});
