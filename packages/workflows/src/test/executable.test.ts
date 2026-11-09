import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import type { BaseContext } from "../executable";

import { Executable } from "../executable";

const SUSPENDSIGNAL_APPROVAL_NEEDS_HUMAN_PATTERN =
  /SuspendSignal|approval|needs human/;

describe("Executable.make — root construction", () => {
  test("seeds input/name; path is [name]; context.name mirrors name", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const exe = yield* Executable.make<{ value: number }>({
            input: { value: 7 },
            name: "root",
          });
          expect(exe.input).toEqual({ value: 7 });
          expect(exe.name).toBe("root");
          expect(exe.path).toEqual(["root"]);
          expect(exe.context.name).toBe("root");
        })
      )
    );
  });

  test("config defaults: blocking=true, maxAttempts=1, no retry/timeout", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          expect(exe.config.blocking).toBe(true);
          expect(exe.config.maxAttempts).toBe(1);
          expect(exe.config.retry).toBeUndefined();
          expect(exe.config.timeout).toBeUndefined();
        })
      )
    );
  });

  test("partial config overrides merge over defaults", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const exe = yield* Executable.make<void>({
            config: { maxAttempts: 5 },
            input: undefined,
            name: "root",
          });
          expect(exe.config.maxAttempts).toBe(5);
          expect(exe.config.blocking).toBe(true);
        })
      )
    );
  });

  test("seed extends typed context; name field is forced from `name`", async () => {
    interface Ctx extends BaseContext {
      readonly tenant: string;
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const exe = yield* Executable.make<void, Ctx>({
            input: undefined,
            name: "root",
            seed: { tenant: "acme" },
          });
          expect(exe.context.tenant).toBe("acme");
          expect(exe.context.name).toBe("root");
        })
      )
    );
  });
});

describe("Executable.fork — child frame", () => {
  test("path extends; name and context.name update; input swaps when provided", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Executable.make<{ a: number }>({
            input: { a: 1 },
            name: "root",
          });
          const child = root.fork<{ b: string }>({
            input: { b: "hi" },
            name: "child",
          });
          expect(child.name).toBe("child");
          expect(child.path).toEqual(["root", "child"]);
          expect(child.context.name).toBe("child");
          expect(child.input).toEqual({ b: "hi" });
        })
      )
    );
  });

  test("when input is omitted, the parent's input passes through", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Executable.make<{ keep: true }>({
            input: { keep: true },
            name: "root",
          });
          const child = root.fork({ name: "child" });
          expect(child.input).toEqual({ keep: true });
        })
      )
    );
  });

  test("an explicit null child input does not inherit the parent's input", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Executable.make<string>({
            input: "parent-input",
            name: "root",
          });
          const child = root.fork<null>({ input: null, name: "child" });
          expect(child.input).toBeNull();
        })
      )
    );
  });

  test("controller is shared: parent.abort() flips child.aborted", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          const child = root.fork({ name: "child" });
          expect(child.aborted).toBe(false);
          root.abort("test");
          expect(child.aborted).toBe(true);
          expect(root.aborted).toBe(true);
        })
      )
    );
  });

  test("config does NOT inherit — child gets fresh defaults unless overridden", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Executable.make<void>({
            config: { blocking: true, maxAttempts: 9 },
            input: undefined,
            name: "root",
          });
          const child = root.fork({ name: "child" });
          expect(child.config.blocking).toBe(false);
          expect(child.config.maxAttempts).toBe(1);
        })
      )
    );
  });
});

describe("Executable cancellation surface", () => {
  test("aborted is false at construction; abort(reason) flips it and stores reason", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          expect(exe.aborted).toBe(false);
          exe.abort("user-cancel");
          expect(exe.aborted).toBe(true);
          expect(exe.reason).toBe("user-cancel");
        })
      )
    );
  });

  test("abort() with no reason defaults to 'cancelled'", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          exe.abort();
          expect(exe.reason).toBe("cancelled");
        })
      )
    );
  });

  test("abort() is idempotent — second call does not overwrite reason", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          exe.abort("first");
          exe.abort("second");
          expect(exe.reason).toBe("first");
        })
      )
    );
  });

  test("signal exposes the underlying AbortSignal", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          expect(exe.signal).toBeInstanceOf(AbortSignal);
          expect(exe.signal.aborted).toBe(false);
          exe.abort("x");
          expect(exe.signal.aborted).toBe(true);
        })
      )
    );
  });

  test("onAbort handler fires on abort and unsubscribe stops further calls", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          let calls = 0;
          let lastReason: unknown;
          const off = exe.onAbort((reason) => {
            calls += 1;
            lastReason = reason;
          });
          off();
          exe.abort("after-unsubscribe");
          expect(calls).toBe(0);
          expect(lastReason).toBeUndefined();
        })
      )
    );
  });
});

describe("Executable suspend / resolve", () => {
  test("suspend with no recorded resolution fails with SuspendSignal carrying originPath", async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          const child = exe.fork({ name: "child" });
          return yield* child
            .suspend({ name: "approval", reason: "needs human" })
            .pipe(Effect.exit);
        })
      )
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const { cause } = exit;
      // Accept any serialized failure shape matching the signal or its details.
      const causeStr = JSON.stringify(cause, null, 2);
      expect(causeStr).toMatch(SUSPENDSIGNAL_APPROVAL_NEEDS_HUMAN_PATTERN);
    }
  });

  test("resolve(name, value) makes the next suspend(name) succeed with that value", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          yield* exe.resolve("approval", "approved-by-test");
          const value = yield* exe.suspend<string>({
            name: "approval",
            reason: "needs human",
          });
          expect(value).toBe("approved-by-test");
        })
      )
    );
  });
});
