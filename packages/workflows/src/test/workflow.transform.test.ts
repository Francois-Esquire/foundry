/**
 * Composer composition primitives — invoke / parallel / race / branch / sequence.
 *
 * Surfaced on `StepContext` so step bodies can express tree-shaped composition
 * inline. Each primitive forks a synthetic Composer wrapper (or sub-frame),
 * drives the supplied Step(s) via `Executable.drive`, and threads the result
 * back through the body's Promise.
 */

import { describe, expect, test } from "vitest";

import { Step } from "../step";
import { bail, StepBailError } from "../types";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════════
// A. invoke — single child invocation
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.invoke — single child invocation", () => {
  test("invoke(child, input) runs the child to completion and returns its output", async () => {
    const child = await Step.make<number, number>({
      execute: async (n) => n * 2,
      input: 0,
      name: "doubler",
    });
    const parent = await Step.make<void, number>({
      execute: async (_input, ctx) => ctx.invoke<number, number>(child, 21),
      input: undefined,
      name: "parent",
    });
    const result = await parent.run();
    expect(result).toBe(42);
  });

  test("invoke records the child frame in snapshot.steps under the parent's path", async () => {
    const child = await Step.make<void, "ok">({
      execute: async (): Promise<"ok"> => "ok",
      input: undefined,
      name: "child-frame",
    });
    const parent = await Step.make<void, "ok">({
      execute: async (_input, ctx): Promise<"ok"> => {
        await ctx.invoke<void, "ok">(child, undefined);
        return "ok";
      },
      input: undefined,
      name: "outer",
    });
    await parent.run();
    await sleep(10);
    const state = parent.state;
    // The composer forks a sub-frame named after the child step under
    // the parent's path: "outer.child-frame".
    expect(state.steps["outer.child-frame"]).toBeDefined();
    expect(state.steps["outer.child-frame"]?.status).toBe("complete");
  });

  test("invoke propagates a thrown error from the child to the parent", async () => {
    const child = await Step.make<void, never>({
      execute: async () => {
        throw new Error("child-error");
      },
      input: undefined,
      name: "thrower",
    });
    const parent = await Step.make<void, "ok">({
      execute: async (_input, ctx): Promise<"ok"> => {
        await ctx.invoke<void, never>(child, undefined);
        return "ok";
      },
      input: undefined,
      name: "outer",
    });
    await expect(parent.run()).rejects.toThrow("child-error");
  });

  test("invoke propagates a Bail return from the child as StepBailError", async () => {
    const child = await Step.make<void, "never">({
      execute: async () => bail({ reason: "policy" }),
      input: undefined,
      name: "bailer",
    });
    const parent = await Step.make<void, "ok">({
      execute: async (_input, ctx): Promise<"ok"> => {
        await ctx.invoke<void, "never">(child, undefined);
        return "ok";
      },
      input: undefined,
      name: "outer",
    });
    let captured: unknown = null;
    try {
      await parent.run();
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(StepBailError);
    if (captured instanceof StepBailError) {
      expect(captured.bail).toEqual(bail({ reason: "policy" }));
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. parallel — fan-out, all-or-nothing
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.parallel — fan-out, all-or-nothing", () => {
  test("parallel({a, b, c}) executes all entries concurrently", async () => {
    // Barrier latch: each step increments `started` then awaits
    // `allStarted`. Parallel dispatch → all 3 reach the barrier,
    // release fires, all proceed. Sequential dispatch → step 1
    // blocks on the barrier forever (siblings can't start), the
    // 1s timeout rejects the race and the test fails with a clear
    // "not parallel" error. No wall-clock thresholds.
    let started = 0;
    let release!: () => void;
    const allStarted = new Promise<void>((r) => {
      release = r;
    });
    const make = (name: string, ms: number): Promise<Step> =>
      Step.make<unknown, unknown>({
        execute: async () => {
          started++;
          if (started === 3) {
            release();
          }
          await Promise.race([
            allStarted,
            new Promise((_, reject) =>
              setTimeout(() => {
                reject(new Error("not parallel"));
              }, 1000)
            ),
          ]);
          await sleep(ms);
          return name;
        },
        input: undefined,
        name,
      });
    const stepA = await make("a", 30);
    const stepB = await make("b", 10);
    const stepC = await make("c", 20);

    const parent = await Step.make<void, Record<string, unknown>>({
      execute: async (_input, ctx) =>
        ctx.parallel({
          a: { input: undefined, step: stepA },
          b: { input: undefined, step: stepB },
          c: { input: undefined, step: stepC },
        }),
      input: undefined,
      name: "fanout",
    });

    const out = await parent.run();

    expect(out).toEqual({ a: "a", b: "b", c: "c" });
    expect(started).toBe(3);
  });

  test("parallel returns a record keyed by entry name with each entry's output", async () => {
    const num = await Step.make<unknown, unknown>({
      execute: async () => 7,
      input: undefined,
      name: "num",
    });
    const str = await Step.make<unknown, unknown>({
      execute: async () => "hello",
      input: undefined,
      name: "str",
    });
    const parent = await Step.make<
      void,
      { readonly first: number; readonly second: string }
    >({
      execute: async (_input, ctx) =>
        ctx.parallel({
          first: { input: undefined, step: num },
          second: { input: undefined, step: str },
        }) as Promise<{ readonly first: number; readonly second: string }>,
      input: undefined,
      name: "root",
    });
    const out = await parent.run();
    expect(out.first).toBe(7);
    expect(out.second).toBe("hello");
  });

  test("any entry failing fails the whole parallel", async () => {
    const ok = await Step.make<unknown, unknown>({
      execute: async () => "ok",
      input: undefined,
      name: "ok",
    });
    const bad = await Step.make<unknown, unknown>({
      execute: async () => {
        throw new Error("bad-arm");
      },
      input: undefined,
      name: "bad",
    });
    const parent = await Step.make<void, unknown>({
      execute: async (_input, ctx) =>
        ctx.parallel({
          a: { input: undefined, step: ok },
          b: { input: undefined, step: bad },
        }),
      input: undefined,
      name: "root",
    });
    await expect(parent.run()).rejects.toThrow("bad-arm");
  });

  test("each entry appears in snapshot.steps under its entry name", async () => {
    const a = await Step.make<unknown, unknown>({
      execute: async () => "a",
      input: undefined,
      name: "step-a",
    });
    const b = await Step.make<unknown, unknown>({
      execute: async () => "b",
      input: undefined,
      name: "step-b",
    });
    const parent = await Step.make<void, unknown>({
      execute: async (_input, ctx) =>
        ctx.parallel(
          {
            entryA: { input: undefined, step: a },
            entryB: { input: undefined, step: b },
          },
          "fan"
        ),
      input: undefined,
      name: "root",
    });
    await parent.run();
    await sleep(10);
    const keys = Object.keys(parent.state.steps);
    // The wrapper frame and each entry frame should appear under the
    // parent's path.
    expect(keys).toContain("root.fan");
    expect(keys).toContain("root.fan.entryA");
    expect(keys).toContain("root.fan.entryB");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. race — first-wins
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.race — first-wins", () => {
  test("race({fast, slow}) returns as soon as the first entry completes", async () => {
    const fast = await Step.make<unknown, unknown>({
      execute: async () => {
        await sleep(10);
        return "fast";
      },
      input: undefined,
      name: "fast",
    });
    const slow = await Step.make<unknown, unknown>({
      execute: async () => {
        await sleep(200);
        return "slow";
      },
      input: undefined,
      name: "slow",
    });
    const parent = await Step.make<void, { winner: string; value: unknown }>({
      execute: async (_input, ctx) =>
        ctx.race({
          fast: { input: undefined, step: fast },
          slow: { input: undefined, step: slow },
        }),
      input: undefined,
      name: "racer",
    });
    const start = Date.now();
    const out = await parent.run();
    const elapsed = Date.now() - start;
    expect(out.winner).toBe("fast");
    expect(out.value).toBe("fast");
    expect(elapsed).toBeLessThan(150);
  });

  test("the result identifies the winner (entry name + value)", async () => {
    const a = await Step.make<unknown, unknown>({
      execute: async () => {
        await sleep(5);
        return 1;
      },
      input: undefined,
      name: "a",
    });
    const b = await Step.make<unknown, unknown>({
      execute: async () => {
        await sleep(50);
        return 2;
      },
      input: undefined,
      name: "b",
    });
    const parent = await Step.make<void, { winner: string; value: number }>({
      execute: async (_input, ctx) =>
        ctx.race({
          a: { input: undefined, step: a },
          b: { input: undefined, step: b },
        }) as Promise<{ winner: string; value: number }>,
      input: undefined,
      name: "id-race",
    });
    const out = await parent.run();
    expect(out).toEqual({ value: 1, winner: "a" });
  });

  test("losing entries' Effect fiber is interrupted — parent returns before loser's body finishes", async () => {
    // Effect.race interrupts the loser's executable.drive fiber. The
    // underlying JS body cannot be forcibly stopped (Promises aren't
    // interruptible), but the parent observes the winner immediately
    // and does not wait for the loser to settle. Pin the timing
    // contract — parent.run() returns long before the loser's body
    // would have completed.
    const fast = await Step.make<unknown, unknown>({
      execute: async () => {
        await sleep(5);
        return "fast";
      },
      input: undefined,
      name: "fast",
    });
    const slow = await Step.make<unknown, unknown>({
      execute: async () => {
        await sleep(300);
        return "slow";
      },
      input: undefined,
      name: "slow",
    });
    const parent = await Step.make<void, { winner: string; value: unknown }>({
      execute: async (_input, ctx) =>
        ctx.race({
          fast: { input: undefined, step: fast },
          slow: { input: undefined, step: slow },
        }),
      input: undefined,
      name: "race-loser-interrupt",
    });
    const t0 = Date.now();
    const out = await parent.run();
    const elapsed = Date.now() - t0;
    expect(out.winner).toBe("fast");
    // Race must not block on the loser's still-running body — parent
    // returns when the winner settles, well under the loser's 300ms.
    expect(elapsed).toBeLessThan(150);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D. branch — conditional
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.branch — conditional composition", () => {
  test("branch(predicate, ifTrue, ifFalse) executes the ifTrue arm when predicate is true", async () => {
    const yes = await Step.make<unknown, string>({
      execute: async () => "yes",
      input: undefined,
      name: "yes",
    });
    const no = await Step.make<unknown, string>({
      execute: async () => "no",
      input: undefined,
      name: "no",
    });
    const parent = await Step.make<boolean, string>({
      execute: (input, ctx) => ctx.branch<string>(() => input, yes, no, input),
      input: true,
      name: "decider",
    });
    const result = await parent.run(true);
    expect(result).toBe("yes");
  });

  test("branch executes the ifFalse arm when predicate is false", async () => {
    const yes = await Step.make<unknown, string>({
      execute: async () => "yes",
      input: undefined,
      name: "yes",
    });
    const no = await Step.make<unknown, string>({
      execute: async () => "no",
      input: undefined,
      name: "no",
    });
    const parent = await Step.make<boolean, string>({
      execute: (input, ctx) => ctx.branch<string>(() => input, yes, no, input),
      input: false,
      name: "decider",
    });
    const result = await parent.run(false);
    expect(result).toBe("no");
  });

  test("only the chosen arm appears in the snapshot tree", async () => {
    let yesCalls = 0;
    let noCalls = 0;
    const yes = await Step.make<unknown, string>({
      execute: async () => {
        yesCalls++;
        return "yes";
      },
      input: undefined,
      name: "yes",
    });
    const no = await Step.make<unknown, string>({
      execute: async () => {
        noCalls++;
        return "no";
      },
      input: undefined,
      name: "no",
    });
    const parent = await Step.make<boolean, string>({
      execute: (input, ctx) =>
        ctx.branch<string>(() => input, yes, no, input, "branchpoint"),
      input: true,
      name: "decider",
    });
    await parent.run(true);
    await sleep(10);
    expect(yesCalls).toBe(1);
    expect(noCalls).toBe(0);
    const keys = Object.keys(parent.state.steps);
    expect(keys).toContain("decider.branchpoint.ifTrue");
    expect(keys.some((k) => k.endsWith("ifFalse"))).toBe(false);
  });

  test("the chosen arm's output threads back as the branch's output", async () => {
    const adder = await Step.make<number, number>({
      execute: async (n) => n + 100,
      input: 0,
      name: "add",
    });
    const subber = await Step.make<number, number>({
      execute: async (n) => n - 100,
      input: 0,
      name: "sub",
    });
    const parent = await Step.make<number, number>({
      execute: (input, ctx) =>
        ctx.branch<number>(
          () => input >= 0,
          adder as Step<unknown, number>,
          subber as Step<unknown, number>,
          input
        ),
      input: 0,
      name: "decider",
    });
    expect(await parent.run(5)).toBe(105);
    // Re-run with a negative — but since each Step instance carries its
    // own state, build a fresh parent for the second run.
    const parent2 = await Step.make<number, number>({
      execute: (input, ctx) =>
        ctx.branch<number>(
          () => input >= 0,
          adder as Step<unknown, number>,
          subber as Step<unknown, number>,
          input
        ),
      input: 0,
      name: "decider2",
    });
    expect(await parent2.run(-5)).toBe(-105);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// E. sequence — left-to-right with short-circuit
// ════════════════════════════════════════════════════════════════════════════

describe("ctx.sequence — left-to-right with short-circuit", () => {
  test("sequence([a, b, c]) runs entries in declaration order", async () => {
    const order: string[] = [];
    const make = (name: string): Promise<Step> =>
      Step.make<unknown, unknown>({
        execute: async (input) => {
          order.push(name);
          return input;
        },
        input: undefined,
        name,
      });
    const a = await make("a");
    const b = await make("b");
    const c = await make("c");
    const parent = await Step.make<void, unknown>({
      execute: async (_input, ctx) => ctx.sequence([a, b, c], "seed"),
      input: undefined,
      name: "pipe",
    });
    await parent.run();
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("each entry receives the prior entry's output as input", async () => {
    const inputs: unknown[] = [];
    const append = (suffix: string): Promise<Step> =>
      Step.make<unknown, unknown>({
        execute: async (input) => {
          inputs.push(input);
          return `${String(input)}-${suffix}`;
        },
        input: undefined,
        name: `step-${suffix}`,
      });
    const a = await append("a");
    const b = await append("b");
    const c = await append("c");
    const parent = await Step.make<void, unknown>({
      execute: async (_input, ctx) => ctx.sequence([a, b, c], "seed"),
      input: undefined,
      name: "pipe",
    });
    const out = await parent.run();
    expect(inputs).toEqual(["seed", "seed-a", "seed-a-b"]);
    expect(out).toBe("seed-a-b-c");
  });

  test("a thrown error short-circuits and prevents downstream entries from running", async () => {
    const order: string[] = [];
    const a = await Step.make<unknown, unknown>({
      execute: async () => {
        order.push("a");
        return "a";
      },
      input: undefined,
      name: "a",
    });
    const b = await Step.make<unknown, unknown>({
      execute: async () => {
        order.push("b");
        throw new Error("b-failed");
      },
      input: undefined,
      name: "b",
    });
    const c = await Step.make<unknown, unknown>({
      execute: async () => {
        order.push("c");
        return "c";
      },
      input: undefined,
      name: "c",
    });
    const parent = await Step.make<void, unknown>({
      execute: async (_input, ctx) => ctx.sequence([a, b, c], undefined),
      input: undefined,
      name: "pipe",
    });
    await expect(parent.run()).rejects.toThrow("b-failed");
    expect(order).toEqual(["a", "b"]);
  });

  test("a Bail return short-circuits and rejects with a sequence-bailed error", async () => {
    const order: string[] = [];
    const a = await Step.make<unknown, unknown>({
      execute: async () => {
        order.push("a");
        return "a";
      },
      input: undefined,
      name: "a",
    });
    const b = await Step.make<unknown, unknown>({
      execute: async () => {
        order.push("b");
        return bail({ reason: "stop" });
      },
      input: undefined,
      name: "b",
    });
    const c = await Step.make<unknown, unknown>({
      execute: async () => {
        order.push("c");
        return "c";
      },
      input: undefined,
      name: "c",
    });
    const parent = await Step.make<void, unknown>({
      execute: async (_input, ctx) => ctx.sequence([a, b, c], undefined),
      input: undefined,
      name: "pipe",
    });
    await expect(parent.run()).rejects.toThrow(/bailed at "b"/);
    expect(order).toEqual(["a", "b"]);
  });
});
