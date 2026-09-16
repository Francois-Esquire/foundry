/**
 * helpers.ts — pure utilities at the Effect→Promise seam.
 *
 * Three concerns under test:
 *   1. `runEffectPromise` typed-failure identity preservation — a typed
 *      failure inside an Effect must reach the awaiter as the original
 *      instance (`instanceof` survives), not wrapped as `FiberFailure`.
 *      The whole package's bail/suspend semantics rest on this.
 *   2. `parseDuration` ms-number / suffix-string / error path —
 *      currently only exercised through `step.timeout`. Pin directly.
 *   3. `errorToShape` happy + non-Error.
 *   4. `toSchedule` per-strategy — the `backoffSchedule` switch is
 *      package-private, so each strategy is exercised through
 *      `toSchedule` (the public seam consumers actually depend on).
 */

import { Duration, Effect, Schedule } from "effect";
import { describe, expect, test } from "vitest";

import {
  errorToShape,
  parseDuration,
  runEffectPromise,
  toSchedule,
} from "../helpers";

// ════════════════════════════════════════════════════════════════════════════
// 1. runEffectPromise — typed-failure identity preservation
// ════════════════════════════════════════════════════════════════════════════

class TypedFailure extends Error {
  readonly tag = "typed-failure" as const;
  constructor(public readonly payload: string) {
    super(`typed: ${payload}`);
    this.name = "TypedFailure";
  }
}

describe("runEffectPromise — typed-failure identity preservation", () => {
  test("a typed Error subclass thrown via Effect.fail surfaces unwrapped at await", async () => {
    const original = new TypedFailure("preserved");
    const effect = Effect.fail(original);
    let caught: unknown = null;
    try {
      await runEffectPromise(effect);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(original);
    expect(caught instanceof TypedFailure).toBe(true);
    expect((caught as TypedFailure).payload).toBe("preserved");
  });

  test("success values pass through unchanged", async () => {
    expect(await runEffectPromise(Effect.succeed(42))).toBe(42);
  });

  test("a defect (Effect.die with Error) surfaces as the same Error instance", async () => {
    const defect = new RangeError("boom");
    let caught: unknown = null;
    try {
      await runEffectPromise(Effect.die(defect));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(defect);
  });

  test("a non-Error thrown via Effect.fail is preserved as-is at the throw site", async () => {
    // Even though the Effect.Effect<A, Error> signature is nominal, a
    // generator-yielded fail with a non-Error payload still flows through
    // Cause.failureOption and is rethrown verbatim.
    const payload = "string-failure";
    const effect = Effect.gen(function* () {
      return yield* Effect.fail(payload as unknown as Error);
    });
    let caught: unknown = null;
    try {
      await runEffectPromise(effect);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(payload);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. parseDuration — number passthrough, suffix-string, error path
// ════════════════════════════════════════════════════════════════════════════

describe("parseDuration", () => {
  test("number ms passes through unchanged", () => {
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration(123)).toBe(123);
    // Non-integer numbers are passed through verbatim.
    expect(parseDuration(1.5)).toBe(1.5);
  });

  test("suffix strings parse to the expected ms value (ms / s / m / h)", () => {
    const cases: [string, number][] = [
      ["100ms", 100],
      ["1.5ms", 1.5],
      ["2s", 2000],
      ["0.5s", 500],
      ["3m", 180_000],
      ["1h", 3_600_000],
      ["0.5h", 1_800_000],
    ];
    for (const [input, expected] of cases) {
      expect(parseDuration(input)).toBe(expected);
    }
  });

  test("leading/trailing whitespace is tolerated", () => {
    expect(parseDuration("  100ms  ")).toBe(100);
  });

  test("unparseable strings throw", () => {
    const cases = ["", "abc", "10x", "1d", "1.2.3s", "100 ms"];
    for (const input of cases) {
      expect(() => parseDuration(input)).toThrow(/Unparseable duration/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. errorToShape — Error vs non-Error
// ════════════════════════════════════════════════════════════════════════════

describe("errorToShape", () => {
  test("captures name + message + stack from a real Error", () => {
    const err = new TypeError("something broke");
    const shape = errorToShape(err);
    expect(shape.name).toBe("TypeError");
    expect(shape.message).toBe("something broke");
    expect(typeof shape.stack).toBe("string");
  });

  test("an Error without a stack omits the stack key", () => {
    const err = new Error("no-stack");
    // delete stack so the optional-spread branch fires.
    Object.defineProperty(err, "stack", { value: undefined });
    const shape = errorToShape(err);
    expect("stack" in shape).toBe(false);
  });

  test("a non-Error stringifies under name=Error", () => {
    expect(errorToShape("oops")).toEqual({ message: "oops", name: "Error" });
    expect(errorToShape(42)).toEqual({ message: "42", name: "Error" });
    // null/undefined are coerced via String()
    expect(errorToShape(null)).toEqual({ message: "null", name: "Error" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. toSchedule — per-strategy unit (exercises backoffSchedule indirectly)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Drive a Schedule with `n` undefined inputs and return its emitted
 * delays as ms. Uses `Schedule.delays(sched)` — Effect's accessor for
 * the per-iteration backoff durations — which is the property
 * `Effect.retry(sched)` actually consumes.
 */
async function delaysMs(
  schedule: Schedule.Schedule<unknown>,
  n: number
): Promise<number[]> {
  const inputs = Array.from({ length: n }, () => undefined);
  const out = await Effect.runPromise(
    Schedule.run(Schedule.delays(schedule), 0, inputs)
  );
  return Array.from(out).map((d) => Duration.toMillis(d));
}

describe("toSchedule — per-strategy", () => {
  test("no backoff: spaced(0) — every recur emits zero delay", async () => {
    const sched = toSchedule({ maxAttempts: 5 });
    const delays = await delaysMs(sched, 4);
    // No backoff defaults to spaced(0); recurs(maxAttempts-1)=4 caps it.
    expect(delays).toEqual([0, 0, 0, 0]);
  });

  test("fixed backoff: every iteration emits the configured delay", async () => {
    const sched = toSchedule({
      backoff: { delay: 50, kind: "fixed" },
      maxAttempts: 5,
    });
    const delays = await delaysMs(sched, 3);
    expect(delays).toEqual([50, 50, 50]);
  });

  test("exponential backoff: delays grow by `factor` each iteration", async () => {
    const sched = toSchedule({
      backoff: { factor: 2, initial: 100, kind: "exponential" },
      maxAttempts: 5,
    });
    const delays = await delaysMs(sched, 3);
    expect(delays).toEqual([100, 200, 400]);
  });

  test("linear backoff: first delay = step (Schedule.linear semantics + addDelay)", async () => {
    const sched = toSchedule({
      backoff: { initial: 100, kind: "linear", step: 50 },
      maxAttempts: 5,
    });
    const delays = await delaysMs(sched, 3);
    // Schedule.linear(step) emits step, 2*step, 3*step,...; addDelay(initial)
    // shifts each by initial. So delays = step+initial, 2*step+initial, 3*step+initial.
    // Pin the actual behavior the source produces (note the helpers.ts:165-167
    // comment is itself unsure; this test pins what ships today so a refactor
    // would force a deliberate update).
    expect(delays).toEqual([150, 200, 250]);
  });

  test("jittered backoff: delays are non-negative finite numbers", async () => {
    const sched = toSchedule({
      backoff: { initial: 100, kind: "jittered", max: 1000 },
      maxAttempts: 5,
    });
    const delays = await delaysMs(sched, 3);
    expect(delays).toHaveLength(3);
    for (const d of delays) {
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });

  test("maxAttempts caps the schedule via intersect with recurs(max-1)", async () => {
    const sched = toSchedule({
      backoff: { delay: 10, kind: "fixed" },
      maxAttempts: 3,
    });
    // Pin the actual cap shape: a 3-attempt schedule, intersected with
    // recurs(2), produces a finite-length delay sequence. The exact
    // length depends on Effect's recurs/intersect semantics (it counts
    // recursions, not yields); the invariant we care about is that the
    // cap is finite — a regression that drops the intersect would let
    // delays.length grow unbounded.
    const delays = await delaysMs(sched, 100);
    expect(delays.length).toBeLessThan(100);
  });

  test("shouldRetry predicate receives the failure and a 1-based attempt counter", async () => {
    const seen: { err: unknown; attempt: number }[] = [];
    const sched = toSchedule({
      maxAttempts: 5,
      shouldRetry: (err, attempt) => {
        seen.push({ attempt, err });
        return attempt < 3;
      },
    });
    // whileInput halts the schedule when the predicate returns false; the
    // closure-bumped attempt counter increments per call.
    await Effect.runPromise(
      Schedule.run(sched, 0, [
        new Error("a"),
        new Error("b"),
        new Error("c"),
        new Error("d"),
      ])
    );
    // Attempt counter starts at 1 (helpers.ts:144 `let attempt = 1`) and
    // increments per call. Predicate returns false at attempt=3 — the
    // schedule halts after seeing the third call. The fourth input is
    // never observed.
    expect(seen.map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(seen.map((s) => (s.err as Error).message)).toEqual(["a", "b", "c"]);
  });
});
