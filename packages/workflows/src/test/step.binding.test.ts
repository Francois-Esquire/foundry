import { describe, expect, it } from "vitest";

import type { StepSpec } from "../step";

import { Step } from "../step";

const NOT_BOUND_PATTERN = /not bound/;
const ALREADY_PATTERN = /already/;
const ALREADY_BOUND_PATTERN = /already bound/;

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
    expect(returned).toBe(parent);

    const result = await parent.run();
    expect(result).toBe("parent-out");

    expect(parent.steps["parent.child"]?.status).toBe("complete");
    expect(parent.steps["parent.child"]?.output).toBe("child-out");
  });
});

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
    expect(returned).toBe(parent);

    expect(() => child.snapshot).toThrow(NOT_BOUND_PATTERN);

    await parent.run();

    expect(child.snapshot).toBe(parent.snapshot);
    expect(child.path).toEqual(["parent", "instance-child"]);
    expect(child.output).toBe("child-out");
  });
});

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
    expect(first.snapshot).toBe(parent.snapshot);
    expect(second.snapshot).toBe(parent.snapshot);
    expect(instanceChild.snapshot).toBe(parent.snapshot);
    const kids = parent.children;
    expect(kids.length).toBe(3);
    expect(kids[0]).toBe(first);
    expect(kids[1]).toBe(second);
    expect(kids[2]).toBe(instanceChild);
  });
});

describe(".step(spec) — post-bind during execute body", () => {
  it("adding a child mid-body via captured parent ref runs the child as part of the cascade", async () => {
    const ran: string[] = [];

    const parent = Step.create<void, "parent-out">({
      execute: async (_input, ctx): Promise<"parent-out"> => {
        ran.push("body-pre");
        ctx.step.step<void, "dyn-out">({
          execute: async (): Promise<"dyn-out"> => {
            ran.push("dyn");
            return "dyn-out";
          },
          input: undefined,
          name: "dyn",
        });
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

describe(".step(stepInstance) — post-bind during execute body", () => {
  it("a fresh Step.create() instance handed to a running parent's .step() binds and runs", async () => {
    const ran: string[] = [];

    const parent = Step.create<void, "parent-out">({
      execute: async (_input, ctx): Promise<"parent-out"> => {
        const child = Step.create<void, "late-out">({
          execute: async (): Promise<"late-out"> => {
            ran.push("late");
            return "late-out";
          },
          input: undefined,
          name: "late",
        });
        const attached = ctx.step.step(child);
        expect(attached).toBe(ctx.step);
        await ctx.next();
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
    expect(() => parentB.step(child)).toThrow(ALREADY_PATTERN);
  });
});

describe(".step() — already-bound child", () => {
  it("a Step that has already auto-bound (run standalone) cannot be attached to another parent", async () => {
    const child = Step.create<void, "ok">({
      execute: async (): Promise<"ok"> => "ok",
      input: undefined,
      name: "loner",
    });

    await child.run();

    const other = Step.create({
      execute: async () => "other-out",
      input: undefined,
      name: "other",
    });

    expect(() => other.step(child)).toThrow(ALREADY_BOUND_PATTERN);
  });
});

describe("Step.create — sync return", () => {
  it("returns a Step instance directly, not a Promise", () => {
    const spec: StepSpec<void, "ok"> = {
      execute: async (): Promise<"ok"> => "ok",
      input: undefined,
      name: "sync",
    };
    const step = Step.create(spec);
    expect(typeof step).toBe("object");
    expect(step).toBeInstanceOf(Step);
    expect(step.kind).toBe("step");
  });
});

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

    const out: string | undefined = child.output;
    expect(out).toBe("hello");
  });
});

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
