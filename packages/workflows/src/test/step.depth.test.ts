/**
 * Step depth — nested forks via step.fork(spec). Path composition, context
 * propagation, and snapshot tree shape under recursion and N-ary fanout.
 */

import { describe, expect, test } from "vitest";

import { Step } from "../step";

describe("Linear recursion via fork", () => {
  test("fork(spec) at depth N produces a step whose path has N + 1 segments", async () => {
    const step = await Step.make({
      children: [
        {
          children: [
            {
              execute: async () => "ok",
              input: undefined,
              name: "child2",
            },
          ],
          execute: async (_, ctx) => {
            const child = ctx.children[0];
            if (!child) {
              return;
            }
            return child.run();
          },
          input: undefined,
          name: "child1",
        },
      ],
      execute: async (_, ctx) => {
        const child = ctx.children[0];
        if (!child) {
          return;
        }
        return child.run();
      },
      input: undefined,
      name: "root",
    });

    await step.run();

    const state = step.state;
    const steps = state.steps;

    expect(steps.root).toBeDefined();
    expect(steps["root.child1"]).toBeDefined();
    expect(steps["root.child1.child2"]).toBeDefined();

    expect(steps.root?.attempt).toBe(1);
    expect(steps["root.child1"]?.attempt).toBe(1);
    expect(steps["root.child1.child2"]?.attempt).toBe(1);
  });

  test("recursion to a configured depth completes and reports the reached depth", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeDeep = (depth: number, maxDepth: number): any => {
      if (depth === maxDepth) {
        return {
          execute: async () => depth,
          input: undefined,
          name: `node${depth}`,
        };
      }
      return {
        children: [makeDeep(depth + 1, maxDepth)],

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (_: unknown, ctx: any) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          const child = ctx.children[0];
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
          return child.run();
        },
        input: undefined,
        name: `node${depth}`,
      };
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const step = await Step.make(makeDeep(0, 10));
    const result = await step.run();
    expect(result).toBe(10);
  });

  test("target depth = 0 resolves immediately at depth 0", async () => {
    const step = await Step.make({
      execute: async () => 0,
      input: undefined,
      name: "root",
    });
    const result = await step.run();
    expect(result).toBe(0);
  });

  test("deep nesting (e.g. 50 levels) completes without stack issues", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeDeep = (depth: number, maxDepth: number): any => {
      if (depth === maxDepth) {
        return {
          execute: async () => "reached bottom",
          input: undefined,
          name: `node${depth}`,
        };
      }
      return {
        children: [makeDeep(depth + 1, maxDepth)],

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (_: unknown, ctx: any) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          const child = ctx.children[0];
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
          return child.run();
        },
        input: undefined,
        name: `node${depth}`,
      };
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const step = await Step.make(makeDeep(0, 50));
    const result = await step.run();
    expect(result).toBe("reached bottom");
  });
});

describe("N-ary fanout via fork", () => {
  test("fanout=K depth=D produces K^D leaf executions", async () => {
    let leafCalls = 0;
    // K=3, D=2. Number of leaves should be 3^2 = 9
    const K = 3;
    const D = 2;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeTree = (depth: number): any => {
      if (depth === D) {
        return {
          execute: async () => {
            leafCalls++;
            return "leaf";
          },
          input: undefined,
          name: "leaf",
        };
      }
      return {
        children: Array.from({ length: K }, (): unknown => makeTree(depth + 1)),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        execute: async (_: unknown, ctx: any) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any
          await Promise.all(ctx.children.map((c: any) => c.run()));
          return "branch";
        },
        input: undefined,
        name: `branch_${depth}`,
      };
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const step = await Step.make(makeTree(0));
    await step.run();
    expect(leafCalls).toBe(9);
  });

  test("each leaf observes its own correct path in step.path", async () => {
    const paths: string[][] = [];
    const step = await Step.make({
      children: [
        {
          async execute(this: Step) {
            paths.push([...this.path]);
            return "ok";
          },
          input: undefined,
          name: "A",
        },
        {
          async execute(this: Step) {
            paths.push([...this.path]);
            return "ok";
          },
          input: undefined,
          name: "B",
        },
      ],
      execute: async (_, ctx) => {
        await Promise.all(ctx.children.map((c) => c.run()));
        return "ok";
      },
      input: undefined,
      name: "root",
    });
    await step.run();

    expect(paths).toContainEqual(["root", "A"]);
    expect(paths).toContainEqual(["root", "B"]);
  });

  test("siblings at the same depth execute concurrently", async () => {
    let concurrency = 0;
    let maxConcurrency = 0;

    const step = await Step.make({
      children: Array.from({ length: 5 }, (_, i) => ({
        execute: async () => {
          concurrency++;
          maxConcurrency = Math.max(maxConcurrency, concurrency);
          await new Promise((r) => setTimeout(r, 20));
          concurrency--;
          return "ok";
        },
        input: undefined,
        name: `child${i}`,
      })),
      execute: async (_, ctx) => {
        await Promise.all(ctx.children.map((c) => c.run()));
        return "ok";
      },
      input: undefined,
      name: "root",
    });
    await step.run();

    expect(maxConcurrency).toBe(5);
  });
});

describe("Context propagation through depth", () => {
  test("step.context inherits from the parent's context at fork time", async () => {
    let childContext: { name: string } | undefined;
    const step = await Step.make({
      children: [
        {
          async execute(this: Step) {
            childContext = this.context;
            return "ok";
          },
          input: undefined,
          name: "child",
        },
      ],
      execute: async (_, ctx) => {
        const child = ctx.children[0];
        return child?.run();
      },
      input: undefined,
      name: "root",
    });
    await step.run();
    expect(childContext?.name).toBe("child");
  });

  test("a child's context modification does not leak upward to the parent", async () => {
    let rootContext: { name: string } | undefined;
    let childContext: { name: string } | undefined;

    const step = await Step.make({
      children: [
        {
          async execute(this: Step) {
            childContext = this.context;
            return "ok";
          },
          input: undefined,
          name: "child",
        },
      ],
      async execute(this: Step, _, ctx) {
        rootContext = this.context;
        const child = ctx.children[0];
        await child?.run();
        return "ok";
      },
      input: undefined,
      name: "root",
    });
    await step.run();

    expect(rootContext).not.toBe(childContext);
    expect(rootContext?.name).toBe("root");
    expect(childContext?.name).toBe("child");
  });
});

describe("Snapshot tree under depth", () => {
  test("each forked child appears in snapshot.steps under its parent's path", async () => {
    const step = await Step.make({
      children: [
        {
          children: [
            {
              execute: async () => "ok",
              input: undefined,
              name: "grandchild",
            },
          ],
          execute: async (_, ctx) => ctx.children[0]?.run(),
          input: undefined,
          name: "child",
        },
      ],
      execute: async (_, ctx) => ctx.children[0]?.run(),
      input: undefined,
      name: "root",
    });
    await step.run();

    const state = step.state;
    const keys = Object.keys(state.steps).sort();
    expect(keys).toEqual(["root", "root.child", "root.child.grandchild"]);
  });

  test("attempt counter is 1 at every fresh child frame", async () => {
    const step = await Step.make({
      children: [
        {
          execute: async () => "ok",
          input: undefined,
          name: "child",
        },
      ],
      execute: async (_, ctx) => ctx.children[0]?.run(),
      input: undefined,
      name: "root",
    });
    await step.run();

    const state = step.state;
    expect(state.steps.root?.attempt).toBe(1);
    expect(state.steps["root.child"]?.attempt).toBe(1);
  });

  test("walking snapshot from root reaches every leaf via the recorded paths", async () => {
    const step = await Step.make({
      children: [
        { execute: async () => "A", input: undefined, name: "A" },
        { execute: async () => "B", input: undefined, name: "B" },
      ],
      execute: async (_, ctx) => Promise.all(ctx.children.map((c) => c.run())),
      input: undefined,
      name: "root",
    });
    await step.run();

    const state = step.state;
    expect(state.steps["root.A"]?.output).toBe("A");
    expect(state.steps["root.B"]?.output).toBe("B");
  });
});
