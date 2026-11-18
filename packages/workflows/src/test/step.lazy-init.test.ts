import { describe, expect, it } from "vitest";

import type { StepSpec } from "../step";

import { Step } from "../step";

const NOT_BOUND_PATTERN = /not bound/;
const ALREADY_BOUND_PATTERN = /already bound/;

describe("Step.make — claimed-unbound substrate access", () => {
  it("a child Step claimed by a parent's spec.children throws on substrate access before bind", async () => {
    const child = await Step.make({
      execute: async () => "child-out",
      input: undefined,
      name: "child",
    });

    await Step.make({
      children: [child] as readonly (StepSpec | Step)[],
      execute: async () => "parent-out",
      input: undefined,
      name: "parent",
    });

    expect(() => child.snapshot).toThrow(NOT_BOUND_PATTERN);
  });
});

describe("Step.make — standalone run lazy-binds", () => {
  it("Step.make then immediate .run() auto-binds (no explicit init) and resolves", async () => {
    const step = await Step.make<void, "ok">({
      execute: async (): Promise<"ok"> => "ok",
      input: undefined,
      name: "standalone",
    });

    const result = await step.run();
    expect(result).toBe("ok");
    expect(step.snapshot).toBeDefined();
    expect(step.status).toBe("complete");
  });
});

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

    expect(child.snapshot).toBe(parent.snapshot);
    expect(child.channels).toBe(parent.channels);
    expect(child.path).toEqual(["parent", "child"]);
    expect(parent.steps["parent.child"]?.status).toBe("complete");
    expect(parent.steps["parent.child"]?.output).toBe("child-out");
  });
});

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
    const [a, b] = parent.children;
    expect(a?.snapshot).toBe(parent.snapshot);
    expect(b?.snapshot).toBe(parent.snapshot);
    expect(a).toBe(stepChild);
  });
});

describe("Step.make — double-claim", () => {
  it("a Step instance claimed by one parent throws when passed to a second parent", async () => {
    const child = await Step.make({
      execute: async () => "child-out",
      input: undefined,
      name: "doubly-claimed",
    });

    await Step.make({
      children: [child] as readonly (StepSpec | Step)[],
      execute: async () => "first-out",
      input: undefined,
      name: "first-parent",
    });

    expect(() => {
      Step.make({
        children: [child] as readonly (StepSpec | Step)[],
        execute: async () => "second-out",
        input: undefined,
        name: "second-parent",
      });
    }).toThrow(ALREADY_BOUND_PATTERN);
  });
});

describe("Step.dispose — unbound", () => {
  it("dispose() on a never-bound Step resolves without throwing", async () => {
    const step = await Step.make({
      execute: async () => "ok",
      input: undefined,
      name: "never-run",
    });

    await expect(step.dispose()).resolves.toBeUndefined();
  });
});

describe("Step.dispose — bound", () => {
  it("dispose() on a Step that ran resolves and the underlying scope closes (idempotent re-dispose still resolves)", async () => {
    const step = await Step.make<void, "ok">({
      execute: async (): Promise<"ok"> => "ok",
      input: undefined,
      name: "to-dispose",
    });

    await step.run();
    await expect(step.dispose()).resolves.toBeUndefined();
    await expect(step.dispose()).resolves.toBeUndefined();
  });
});

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
