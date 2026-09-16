/**
 * Step progress — Stage 7 / P2-9: per-path independence in a tree.
 *
 * The whole point of P2-9's "no auto-aggregation" decision lives here:
 * each step's progress is keyed by `path.join(".")` and never rolled up.
 *
 * Three describe blocks:
 *   A. Sibling children — two children under one parent, independent values
 *   B. Path-keyed independence — same `name` at different depths
 *   C. Snapshot read parity — `step.progress` matches `state.steps[key].progress`
 */

import { describe, expect, it } from "vitest";

import type { Step as StepType } from "../step";

import { Step } from "../step";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════════
// A. Sibling children have independent progress
// ════════════════════════════════════════════════════════════════════════════

describe("step.progress — sibling children are independent", () => {
  it("auto-cascade runs each child to completion; each gets its own auto-100 (path-keyed independence)", async () => {
    const parent = await Step.make<void, "ok">({
      children: [
        {
          execute: async () => undefined,
          input: undefined,
          name: "child-a",
        },
        {
          execute: async () => undefined,
          input: undefined,
          name: "child-b",
        },
      ],
      execute: async (): Promise<"ok"> => "ok",
      input: undefined,
      name: "parent",
    });

    const [childA, childB] = parent.children;
    if (!(childA && childB)) {
      throw new Error("expected two children on the materialized parent");
    }

    expect(parent.progress).toBe(0);
    expect(childA.progress).toBe(0);
    expect(childB.progress).toBe(0);

    await parent.run();
    await sleep(10);

    expect(childA.progress).toBe(100);
    expect(childB.progress).toBe(100);
    expect(parent.progress).toBe(100);
  });

  it("eagerly-driven child also gets auto-100; cascade skip-on-complete avoids double-run", async () => {
    let aRunCount = 0;
    const parent = await Step.make<void, "ok">({
      children: [
        {
          execute: async () => {
            aRunCount++;
            return "a";
          },
          input: undefined,
          name: "child-a",
        },
        {
          execute: async () => undefined,
          input: undefined,
          name: "child-b",
        },
      ],
      execute: async (_input, ctx): Promise<"ok"> => {
        const a = ctx.children[0];
        if (!a) {
          throw new Error("expected child-a");
        }
        await a.run();
        return "ok";
      },
      input: undefined,
      name: "parent",
    });

    const [childA, childB] = parent.children;
    if (!(childA && childB)) {
      throw new Error("expected two children on the materialized parent");
    }

    await parent.run();
    await sleep(10);

    expect(aRunCount).toBe(1);
    expect(childA.progress).toBe(100);
    expect(childA.status).toBe("complete");
    expect(childB.progress).toBe(100);
    expect(childB.status).toBe("complete");
    expect(parent.progress).toBe(100);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. Path-keyed independence — same name at different depths
// ════════════════════════════════════════════════════════════════════════════

describe("step.progress — same name at different depths is path-keyed", () => {
  it("parent.gather and child.gather carry independent progress", async () => {
    const parent = await Step.make<void, "ok">({
      children: [
        {
          execute: async () => undefined,
          input: undefined,
          name: "gather",
        },
      ],
      execute: async (): Promise<"ok"> => "ok",
      input: undefined,
      name: "gather",
    });

    const child = parent.children[0];
    if (!child) {
      throw new Error("expected one child");
    }

    expect(parent.path).toEqual(["gather"]);
    expect(child.path).toEqual(["gather", "gather"]);

    parent.progress = 40;
    child.progress = 80;

    expect(parent.progress).toBe(40);
    expect(child.progress).toBe(80);

    const state = parent.state;
    expect(state.steps.gather?.progress).toBe(40);
    expect(state.steps["gather.gather"]?.progress).toBe(80);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. Snapshot read parity
// ════════════════════════════════════════════════════════════════════════════

describe("step.progress — snapshot read parity", () => {
  it("step.progress equals state.steps[path].progress on the snapshot", async () => {
    const step: StepType<void, undefined> = await Step.make<void, undefined>({
      execute: async () => undefined,
      input: undefined,
      name: "x",
    });
    step.progress = 55;
    const state = step.state;
    const key = step.path.join(".");
    expect(state.steps[key]?.progress).toBe(55);
    expect(step.progress).toBe(55);
  });
});
