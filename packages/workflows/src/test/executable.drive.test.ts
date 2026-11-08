import type { Scope } from "effect";

import { Effect, Stream } from "effect";
import { describe, expect, test } from "vitest";

import type { ChannelEvent } from "../channels";
import { Channels } from "../channels";
import type { Witness } from "../executable";
import { Executable } from "../executable";
import { Snapshot } from "../snapshot";
import { Step } from "../step";
import { bail } from "../types";

const UNPARSEABLE_DURATION_PATTERN = /Unparseable duration/;
const TIMED_OUT_PATTERN = /timed out/;

interface Harness {
  readonly channels: Channels;
  readonly events: ChannelEvent[];
  readonly exe: Executable;
  readonly snapshot: Snapshot;
  readonly witness: Witness;
}

function makeHarness(
  input?: unknown,
  name = "root"
): Effect.Effect<Harness, never, Scope.Scope> {
  return Effect.gen(function* () {
    const snapshot = yield* Snapshot.make();
    const channels = yield* Channels.make(snapshot);
    const exe = yield* Executable.make({ input, name });
    const events: ChannelEvent[] = [];
    yield* Effect.forkScoped(
      Stream.runForEach(channels.events.stream, (e) =>
        Effect.sync(() => {
          events.push(e);
        })
      )
    );
    yield* Effect.sleep(5); // let the subscriber attach
    const witness: Witness = { channels };
    return { channels, events, exe, snapshot, witness };
  });
}

describe("Executable.drive — lifecycle (success)", () => {
  test("publishes step.started then step.complete with the body's value", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const step = Step.create<unknown, string>({
            execute: async () => "ok",
            input: undefined,
            name: "root",
          });
          const out = yield* h.exe.drive(h.witness, step);
          expect(out).toBe("ok");
          // Allow the events to drain.
          yield* Effect.sleep(5);
          const tags = h.events.map((e) => e._tag);
          // drive does NOT emit step.progress=100 (that's Step.#run only).
          expect(tags).toEqual(["step.started", "step.complete"]);
          const [started] = h.events;
          const [, complete] = h.events;
          if (started?._tag === "step.started") {
            expect(started.path).toEqual(["root"]);
            expect(started.attempt).toBe(1);
          }
          if (complete?._tag === "step.complete") {
            expect(complete.value).toBe("ok");
            expect(complete.attempt).toBe(1);
          }
        })
      )
    );
  });

  test("a Bail<E> body publishes step.bailed and propagates the Bail value", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const step = Step.create<unknown, string>({
            execute: async () => bail({ code: "DENY" }),
            input: undefined,
            name: "root",
          });
          const out = yield* h.exe.drive(h.witness, step);
          expect(out).toEqual({ _bail: true, error: { code: "DENY" } });
          yield* Effect.sleep(5);
          const tags = h.events.map((e) => e._tag);
          expect(tags).toEqual(["step.started", "step.bailed"]);
          const [, bailed] = h.events;
          if (bailed?._tag === "step.bailed") {
            expect(bailed.bail).toEqual({ code: "DENY" });
          }
        })
      )
    );
  });
});

describe("Executable.drive — lifecycle (failure)", () => {
  test("a thrown body publishes step.failed with the error shape and rejects the Effect", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const step = Step.create<unknown, string>({
            execute: async () => {
              throw new TypeError("boom");
            },
            input: undefined,
            name: "root",
          });
          const result = yield* h.exe
            .drive(h.witness, step)
            .pipe(Effect.either);
          expect(result._tag).toBe("Left");
          if (result._tag === "Left") {
            expect(result.left.message).toBe("boom");
          }
          yield* Effect.sleep(5);
          const tags = h.events.map((e) => e._tag);
          expect(tags).toEqual(["step.started", "step.failed"]);
          const [, failed] = h.events;
          if (failed?._tag === "step.failed") {
            expect(failed.error.name).toBe("TypeError");
            expect(failed.error.message).toBe("boom");
          }
        })
      )
    );
  });
});

describe("Executable.drive — retry", () => {
  test("retries up to maxAttempts, succeeding on the Nth attempt; final step.complete carries the final attempt count", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness();
          let attempts = 0;
          const step = Step.create<unknown, number>({
            config: { retry: { maxAttempts: 3 } },
            execute: async () => {
              attempts += 1;
              if (attempts < 3) {
                throw new Error(`a${attempts}`);
              }
              return attempts;
            },
            input: undefined,
            name: "root",
          });
          const out = yield* h.exe.drive(h.witness, step);
          expect(out).toBe(3);
          expect(attempts).toBe(3);
          yield* Effect.sleep(5);
          const startedCount = h.events.filter(
            (e) => e._tag === "step.started"
          ).length;
          expect(startedCount).toBe(3);
          const complete = h.events.find((e) => e._tag === "step.complete");
          if (complete?._tag === "step.complete") {
            expect(complete.attempt).toBe(3);
            expect(complete.value).toBe(3);
          }
        })
      )
    );
  });

  test("a body that always fails publishes step.failed once after exhausting maxAttempts", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness();
          let attempts = 0;
          const step = Step.create<unknown, number>({
            config: { retry: { maxAttempts: 2 } },
            execute: async () => {
              attempts += 1;
              throw new Error("never");
            },
            input: undefined,
            name: "root",
          });
          const result = yield* h.exe
            .drive(h.witness, step)
            .pipe(Effect.either);
          expect(result._tag).toBe("Left");
          expect(attempts).toBe(2);
          yield* Effect.sleep(5);
          const startedCount = h.events.filter(
            (e) => e._tag === "step.started"
          ).length;
          const failedCount = h.events.filter(
            (e) => e._tag === "step.failed"
          ).length;
          expect(startedCount).toBe(2);
          expect(failedCount).toBe(1);
        })
      )
    );
  });

  test("a Bail short-circuits retry: only one attempt fires even with maxAttempts > 1", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness();
          let attempts = 0;
          const step = Step.create<unknown, number>({
            config: { retry: { maxAttempts: 5 } },
            execute: async () => {
              attempts += 1;
              return bail("nope");
            },
            input: undefined,
            name: "root",
          });
          yield* h.exe.drive(h.witness, step);
          expect(attempts).toBe(1);
          yield* Effect.sleep(5);
          const tags = h.events.map((e) => e._tag);
          expect(tags).toEqual(["step.started", "step.bailed"]);
        })
      )
    );
  });
});

describe("Executable.drive — timeout", () => {
  test("body exceeding the configured timeout is interrupted; step.failed carries a timeout error", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const step = Step.create<unknown, "done">({
            config: { timeout: 30 },
            execute: async (): Promise<"done"> => {
              await new Promise<void>((r) => setTimeout(r, 200));
              return "done";
            },
            input: undefined,
            name: "root",
          });
          const result = yield* h.exe
            .drive(h.witness, step)
            .pipe(Effect.either);
          expect(result._tag).toBe("Left");
          if (result._tag === "Left") {
            expect(result.left.message).toMatch(TIMED_OUT_PATTERN);
          }
          yield* Effect.sleep(5);
          const tags = h.events.map((e) => e._tag);
          expect(tags).toEqual(["step.started", "step.failed"]);
        })
      )
    );
  });

  test("an unparseable timeout duration surfaces as a step failure (not a defect)", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const step = Step.create<unknown, "done">({
            config: { timeout: "not-a-duration" },
            execute: async (): Promise<"done"> => "done",
            input: undefined,
            name: "root",
          });
          const result = yield* h.exe
            .drive(h.witness, step)
            .pipe(Effect.either);
          expect(result._tag).toBe("Left");
          if (result._tag === "Left") {
            expect(result.left.message).toMatch(UNPARSEABLE_DURATION_PATTERN);
          }
        })
      )
    );
  });
});
