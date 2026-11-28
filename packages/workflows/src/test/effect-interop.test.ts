import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { errorToShape, runEffectPromise } from "../effect-interop";

class TypedFailure extends Error {
  readonly tag = "typed-failure" as const;
  readonly payload: string;

  constructor(payload: string) {
    super(`typed: ${payload}`);
    this.payload = payload;
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
    Object.defineProperty(err, "stack", { value: undefined });
    const shape = errorToShape(err);
    expect("stack" in shape).toBe(false);
  });

  test("a non-Error stringifies under name=Error", () => {
    expect(errorToShape("oops")).toEqual({ message: "oops", name: "Error" });
    expect(errorToShape(42)).toEqual({ message: "42", name: "Error" });
    expect(errorToShape(null)).toEqual({ message: "null", name: "Error" });
  });
});
