/**
 * Step — core primitive.
 *
 * Spec for Step.make(spec) + step.run() / step.run().
 * No Queue, no Workflow handle. Composition concerns live in step.depth /
 * step.execution; retry/timeout in step.retry / step.timeout.
 */

import { describe, expect, it } from "vitest";

import { Step } from "../step";
import { makeEchoSpec } from "./fixtures/steps";

describe("Step.make — construction", () => {
  it("allocates a Step", async () => {
    const step = await Step.make(makeEchoSpec("hello"));
    expect(step).toBeInstanceOf(Step);
  });

  it("step.name reflects the spec's name", async () => {
    const step = await Step.make(makeEchoSpec("x", "my-step"));
    expect(step.name).toBe("my-step");
  });

  it("step.path starts as [name] for a root step", async () => {
    const step = await Step.make(makeEchoSpec("x", "root"));
    expect(step.path).toEqual(["root"]);
  });

  it("step.input echoes the spec input by reference", async () => {
    const obj = { a: 1 };
    const step = await Step.make(makeEchoSpec(obj));
    expect(step.input).toBe(obj);
  });

  it("step.signal is a non-aborted AbortSignal at creation", async () => {
    const step = await Step.make(makeEchoSpec("x"));
    expect(step.signal).toBeInstanceOf(AbortSignal);
    expect(step.signal.aborted).toBe(false);
  });

  it("step.aborted is false at creation", async () => {
    const step = await Step.make(makeEchoSpec("x"));
    expect(step.aborted).toBe(false);
  });

  it("two Step.make calls on the same spec produce distinct instances", async () => {
    const spec = makeEchoSpec("x");
    const a = await Step.make(spec);
    const b = await Step.make(spec);
    expect(a).not.toBe(b);
    expect(a.signal).not.toBe(b.signal);
  });
});

describe("Step.run — execution", () => {
  it("returns the value produced by execute", async () => {
    const step = await Step.make<void, number>({
      execute: async () => 42,
      input: undefined,
      name: "answer",
    });
    const result = await step.run();
    expect(result).toBe(42);
  });

  it("execute receives step.input as its first argument", async () => {
    const step = await Step.make<{ n: number }, number>({
      execute: async (input) => input.n * 2,
      input: { n: 21 },
      name: "double",
    });
    const result = await step.run();
    expect(result).toBe(42);
  });

  it("step.run(override) feeds the override into execute, not spec.input", async () => {
    const step = await Step.make<{ n: number }, number>({
      execute: async (input) => input.n * 2,
      input: { n: 1 },
      name: "double",
    });
    const result = await step.run({ n: 100 });
    expect(result).toBe(200);
  });

  it("preserves an explicit null input override", async () => {
    const step = await Step.make<string | null, string | null>({
      execute: async (input) => input,
      input: "bound-input",
      name: "nullable-input",
    });

    await expect(step.run(null)).resolves.toBeNull();
  });

  it("two runs on freshly constructed steps produce equal outputs", async () => {
    const a = await Step.make<void, string>({
      execute: async () => "hello",
      input: undefined,
      name: "x",
    });
    const b = await Step.make<void, string>({
      execute: async () => "hello",
      input: undefined,
      name: "x",
    });
    expect(await a.run()).toBe(await b.run());
  });

  it("execute may transform input to a different type", async () => {
    const step = await Step.make<number, string>({
      execute: async (n) => `value-${n}`,
      input: 7,
      name: "stringify",
    });
    const result = await step.run();
    expect(result).toBe("value-7");
  });

  it("a thrown Error inside execute propagates as a rejection", async () => {
    const step = await Step.make<void, never>({
      execute: async () => {
        throw new Error("kaboom");
      },
      input: undefined,
      name: "throw",
    });
    await expect(step.run()).rejects.toThrow("kaboom");
  });

  it("a non-Error throw is wrapped to an Error before propagating", async () => {
    const step = await Step.make<void, never>({
      execute: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- test fixture: asserts non-Error throws are wrapped
        throw "plain string";
      },
      input: undefined,
      name: "throw-string",
    });
    await expect(step.run()).rejects.toThrow("plain string");
    await expect(step.run()).rejects.toBeInstanceOf(Error);
  });
});

describe("Step — input identity", () => {
  it("step.run() with no override uses the spec input verbatim", async () => {
    const sentinel = { tag: "spec" };
    let observed: unknown = null;
    const step = await Step.make<{ tag: string }, void>({
      execute: async (input) => {
        observed = input;
      },
      input: sentinel,
      name: "x",
    });
    await step.run();
    expect(observed).toBe(sentinel);
  });

  it("step.run(value) override does not mutate spec.input on the instance", async () => {
    const specInput = { n: 1 };
    const step = await Step.make<{ n: number }, number>({
      execute: async (input) => input.n,
      input: specInput,
      name: "x",
    });
    const overrideResult = await step.run({ n: 99 });
    expect(overrideResult).toBe(99);
    expect(step.input).toBe(specInput);
    expect(step.input.n).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Identity surface — id, path, context exposure
// ════════════════════════════════════════════════════════════════════════════

describe("Step — identity surface", () => {
  it("step.id is a non-empty string and unique across constructions", async () => {
    const a = await Step.make(makeEchoSpec("x"));
    const b = await Step.make(makeEchoSpec("x"));
    expect(typeof a.id).toBe("string");
    expect(a.id.length).toBeGreaterThan(0);
    expect(a.id).not.toBe(b.id);
  });

  it("spec.id override is honored verbatim", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      id: "step_abc123",
      input: undefined,
      name: "x",
    });
    expect(step.id).toBe("step_abc123");
  });

  it("step.path on a forked child is parent.path + [child.name]", async () => {
    const parent = await Step.make({
      children: [
        {
          execute: async () => undefined,
          input: undefined,
          name: "child",
        },
      ],
      execute: async () => undefined,
      input: undefined,
      name: "parent",
    });
    const child = parent.children[0];
    expect(child).toBeDefined();
    expect(child?.path).toEqual(["parent", "child"]);
  });

  it("step.context is defined and exposes the step name", async () => {
    const step = await Step.make({
      execute: async () => undefined,
      input: undefined,
      name: "with-ctx",
    });
    expect(step.context).toBeDefined();
    expect(step.context.name).toBe("with-ctx");
  });

  it("execute can read step.name / step.path / step.context off the instance", async () => {
    let captured: {
      name: string;
      path: readonly string[];
      ctx: string;
    } | null = null;
    const step: Step = await Step.make<unknown, unknown>({
      execute: async () => {
        captured = {
          ctx: step.context.name,
          name: step.name,
          path: step.path,
        };
      },
      input: undefined,
      name: "introspect",
    });
    await step.run();
    expect(captured).toEqual({
      ctx: "introspect",
      name: "introspect",
      path: ["introspect"],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Output / terminal projection from snapshot state
// ════════════════════════════════════════════════════════════════════════════

describe("Step.output / Step.isTerminal", () => {
  it("output is undefined and isTerminal=false before run()", async () => {
    const step = await Step.make<void, number>({
      execute: async () => 42,
      input: undefined,
      name: "x",
    });
    expect(step.output).toBeUndefined();
    expect(step.isTerminal).toBe(false);
  });

  it("after a successful run output equals the value and isTerminal=true / status=complete", async () => {
    const step = await Step.make<void, number>({
      execute: async () => 42,
      input: undefined,
      name: "x",
    });
    await step.run();
    expect(step.output).toBe(42);
    expect(step.isTerminal).toBe(true);
    expect(step.status).toBe("complete");
  });

  it("after a failing run output stays undefined and isTerminal=true / status=failed", async () => {
    const step = await Step.make<void, number>({
      execute: async () => {
        throw new Error("nope");
      },
      input: undefined,
      name: "x",
    });
    await step.run().catch(() => undefined);
    expect(step.output).toBeUndefined();
    expect(step.isTerminal).toBe(true);
    expect(step.status).toBe("failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Snapshot — per-step identity (state.steps keyed by path)
// ════════════════════════════════════════════════════════════════════════════

describe("Step — snapshot identity", () => {
  it("each step appears in snapshot.steps keyed by its path with name + status", async () => {
    const step = await Step.make({
      execute: async () => "ok",
      input: undefined,
      name: "completed",
    });
    await step.run();
    const state = step.state;
    expect(Object.keys(state.steps)).toContain("completed");
    const record = state.steps.completed;
    expect(record?.name).toBe("completed");
    expect(record?.status).toBe("complete");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Step.from — convenience constructor for void-input bodies
// ════════════════════════════════════════════════════════════════════════════

describe("Step.from", () => {
  it("constructs an equivalent Step<void, O> with name and undefined input", async () => {
    const step = await Step.from("greet", async () => "hello");
    expect(step.name).toBe("greet");
    expect(step.input).toBeUndefined();
  });

  it("run() returns the body's value", async () => {
    const step = await Step.from("answer", async () => 42);
    expect(await step.run()).toBe(42);
  });
});
