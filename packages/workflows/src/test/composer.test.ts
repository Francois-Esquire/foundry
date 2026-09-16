/**
 * Composer — tree node for building and traversing a shared-scope step tree.
 *
 * Three layers under test:
 *   1. Tree (`Composer.root`, `fork`) — root allocation pulls name/path
 *      from the supplied executable; fork extends the path, shares the
 *      scope by reference, and forks the executable.
 *   2. Lifecycle (`mount`, `complete`, `fail`) — synthetic-wrapper seam:
 *      publishes step.started / step.complete / step.failed events under
 *      the node's path with the supplied attempt and ISO timestamp.
 *   3. Composition (`#invoke`, `#parallel`, `#race`, `#branch`,
 *      `#sequence`) — these are class-private and Effect-typed; they're
 *      exercised end-to-end by the Step / Workflow integration tests.
 *
 * Composer's scope is `BaseScope` ({ channels }). Tests build a minimal
 * `(Snapshot, Channels)` pair so events can be observed without spinning
 * up a full Step.
 */

import { Effect, Stream } from "effect";
import { describe, expect, test } from "vitest";

import type { ChannelEvent } from "../channels";

import { Channels } from "../channels";
import { Composer } from "../composer";
import { Executable } from "../executable";
import { Snapshot } from "../snapshot";
// ════════════════════════════════════════════════════════════════════════════
// 4. Synthetic-wrapper guard (Tier 1 #7)
// Wrapper frames (parallel / race / branch / sequence) publish step.started
// + step.complete (or step.failed) for the wrapper path EXACTLY ONCE per
// invocation. A regression that double-fired (e.g. routing the wrapper
// through `drive` *and* the synthetic mount/complete) would produce two
// events under the same path.
// ════════════════════════════════════════════════════════════════════════════

import { Step } from "../step";

// ════════════════════════════════════════════════════════════════════════════
// 1. Tree — root + fork
// ════════════════════════════════════════════════════════════════════════════

describe("Composer.root — root node allocation", () => {
  test("root mirrors the executable's name and path", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.make();
          const channels = yield* Channels.make(snapshot);
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          const c = Composer.root({ channels }, exe);
          expect(c.name).toBe("root");
          expect(c.path).toEqual(["root"]);
        })
      )
    );
  });

  test("root holds the supplied scope and executable by reference", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.make();
          const channels = yield* Channels.make(snapshot);
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          const c = Composer.root({ channels }, exe);
          expect(c.scope.channels).toBe(channels);
          expect(c.executable).toBe(exe);
        })
      )
    );
  });
});

describe("Composer.fork — child node", () => {
  test("path extends; child name overrides; scope.channels stays shared by reference", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.make();
          const channels = yield* Channels.make(snapshot);
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          const root = Composer.root({ channels }, exe);
          const child = root.fork("child");
          expect(child.name).toBe("child");
          expect(child.path).toEqual(["root", "child"]);
          // channels is shared by reference across the tree
          expect(child.scope.channels).toBe(root.scope.channels);
        })
      )
    );
  });

  test("fork(name, input) swaps the child executable's input", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.make();
          const channels = yield* Channels.make(snapshot);
          const exe = yield* Executable.make<{ a: number }>({
            input: { a: 1 },
            name: "root",
          });
          const root = Composer.root({ channels }, exe);
          const child = root.fork("child", { b: "two" });
          // Executable's per-frame input swaps for the child node.
          expect(child.executable.input).toEqual({ b: "two" });
          // Root frame is untouched.
          expect(root.executable.input).toEqual({ a: 1 });
        })
      )
    );
  });

  test("fork(name) without an input arg inherits the parent executable's input", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.make();
          const channels = yield* Channels.make(snapshot);
          const exe = yield* Executable.make<{ keep: true }>({
            input: { keep: true },
            name: "root",
          });
          const root = Composer.root({ channels }, exe);
          const child = root.fork("child");
          expect(child.executable.input).toEqual({ keep: true });
        })
      )
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Lifecycle — mount / complete / fail publish events through scope.channels
// ════════════════════════════════════════════════════════════════════════════

describe("Composer.mount — publishes step.started", () => {
  test("mount() publishes step.started under this node's path with attempt=1", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.make();
          const channels = yield* Channels.make(snapshot);
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          const root = Composer.root({ channels }, exe);

          const fiber = yield* Effect.fork(
            channels.events.stream.pipe(Stream.take(1), Stream.runCollect)
          );
          // Yield to the runtime so the subscriber subscribes before the publish.
          yield* Effect.sleep(5);

          const returned = root.mount();
          expect(returned).toBe(root);

          const collected = yield* fiber.await;
          expect(collected._tag).toBe("Success");
          if (collected._tag === "Success") {
            const events = [...collected.value] as readonly ChannelEvent[];
            expect(events).toHaveLength(1);
            const ev = events[0];
            expect(ev?._tag).toBe("step.started");
            if (ev?._tag === "step.started") {
              expect(ev.path).toEqual(["root"]);
              expect(ev.name).toBe("root");
              expect(ev.attempt).toBe(1);
              expect(typeof ev.at).toBe("string");
            }
          }
        })
      )
    );
  });

  test("mount(attempt) stamps the attempt verbatim", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.make();
          const channels = yield* Channels.make(snapshot);
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          const root = Composer.root({ channels }, exe);
          const fiber = yield* Effect.fork(
            channels.events.stream.pipe(Stream.take(1), Stream.runCollect)
          );
          yield* Effect.sleep(5);
          root.mount(3);
          const collected = yield* fiber.await;
          if (collected._tag === "Success") {
            const ev = [...collected.value][0];
            if (ev?._tag === "step.started") {
              expect(ev.attempt).toBe(3);
            }
          }
        })
      )
    );
  });
});

describe("Composer.complete — publishes step.complete", () => {
  test("complete(value) publishes step.complete under this node's path with the value", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.make();
          const channels = yield* Channels.make(snapshot);
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          const root = Composer.root({ channels }, exe);
          const fiber = yield* Effect.fork(
            channels.events.stream.pipe(Stream.take(1), Stream.runCollect)
          );
          yield* Effect.sleep(5);
          root.complete({ ok: true });
          const collected = yield* fiber.await;
          if (collected._tag === "Success") {
            const ev = [...collected.value][0];
            expect(ev?._tag).toBe("step.complete");
            if (ev?._tag === "step.complete") {
              expect(ev.path).toEqual(["root"]);
              expect(ev.name).toBe("root");
              expect(ev.attempt).toBe(1);
              expect(ev.value).toEqual({ ok: true });
            }
          }
        })
      )
    );
  });
});

describe("Composer.fail — publishes step.failed with error shape", () => {
  test("fail(err) publishes step.failed carrying the error's message", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.make();
          const channels = yield* Channels.make(snapshot);
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          const root = Composer.root({ channels }, exe);
          const fiber = yield* Effect.fork(
            channels.events.stream.pipe(Stream.take(1), Stream.runCollect)
          );
          yield* Effect.sleep(5);
          root.fail(new Error("boom"));
          const collected = yield* fiber.await;
          if (collected._tag === "Success") {
            const ev = [...collected.value][0];
            expect(ev?._tag).toBe("step.failed");
            if (ev?._tag === "step.failed") {
              expect(ev.path).toEqual(["root"]);
              expect(ev.name).toBe("root");
              expect(ev.error.message).toBe("boom");
            }
          }
        })
      )
    );
  });
});

describe("Composer synthetic-wrapper guard — exactly once per primitive", () => {
  test("parallel publishes step.started + step.complete for the wrapper path exactly once", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.make();
          const channels = yield* Channels.make(snapshot);
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          const root = Composer.root({ channels }, exe);

          // Drain into an array eagerly under our scope.
          const captured: ChannelEvent[] = [];
          yield* Effect.forkScoped(
            Stream.runForEach(channels.events.stream, (e) =>
              Effect.sync(() => {
                captured.push(e);
              })
            )
          );
          yield* Effect.sleep(5);

          const a = Step.create<unknown, unknown>({
            execute: async () => "A",
            input: undefined,
            name: "a",
          });
          const b = Step.create<unknown, unknown>({
            execute: async () => "B",
            input: undefined,
            name: "b",
          });
          const out = yield* Effect.promise(() =>
            root.parallel({
              a: { input: undefined, step: a },
              b: { input: undefined, step: b },
            })
          );
          expect(out).toEqual({ a: "A", b: "B" });
          // The wrapper's path: root.parallel (default name).
          const wrapperPath = ["root", "parallel"];
          const onWrapper = (e: ChannelEvent): boolean =>
            "path" in e &&
            e.path.length === wrapperPath.length &&
            e.path.every((p, i) => p === wrapperPath[i]);
          const startedOnWrapper = captured.filter(
            (e) => e._tag === "step.started" && onWrapper(e)
          );
          const completeOnWrapper = captured.filter(
            (e) => e._tag === "step.complete" && onWrapper(e)
          );
          expect(startedOnWrapper).toHaveLength(1);
          expect(completeOnWrapper).toHaveLength(1);
        })
      )
    );
  });

  test("branch publishes step.started + step.complete for the branch wrapper path exactly once", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.make();
          const channels = yield* Channels.make(snapshot);
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          const root = Composer.root({ channels }, exe);
          const captured: ChannelEvent[] = [];
          yield* Effect.forkScoped(
            Stream.runForEach(channels.events.stream, (e) =>
              Effect.sync(() => {
                captured.push(e);
              })
            )
          );
          yield* Effect.sleep(5);
          const yes = Step.create<unknown, string>({
            execute: async () => "yes",
            input: undefined,
            name: "yes",
          });
          const no = Step.create<unknown, string>({
            execute: async () => "no",
            input: undefined,
            name: "no",
          });
          const out = yield* Effect.promise(() =>
            root.branch(() => true, yes, no, undefined)
          );
          expect(out).toBe("yes");
          const wrapperPath = ["root", "branch"];
          const onWrapper = (e: ChannelEvent): boolean =>
            "path" in e &&
            e.path.length === wrapperPath.length &&
            e.path.every((p, i) => p === wrapperPath[i]);
          const started = captured.filter(
            (e) => e._tag === "step.started" && onWrapper(e)
          );
          const complete = captured.filter(
            (e) => e._tag === "step.complete" && onWrapper(e)
          );
          expect(started).toHaveLength(1);
          expect(complete).toHaveLength(1);
        })
      )
    );
  });

  test("sequence publishes step.started + step.complete for the sequence wrapper path exactly once", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.make();
          const channels = yield* Channels.make(snapshot);
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          const root = Composer.root({ channels }, exe);
          const captured: ChannelEvent[] = [];
          yield* Effect.forkScoped(
            Stream.runForEach(channels.events.stream, (e) =>
              Effect.sync(() => {
                captured.push(e);
              })
            )
          );
          yield* Effect.sleep(5);
          const a = Step.create<unknown, unknown>({
            execute: async () => 1,
            input: undefined,
            name: "a",
          });
          const b = Step.create<unknown, unknown>({
            execute: async (input) => (input as number) + 1,
            input: undefined,
            name: "b",
          });
          const out = yield* Effect.promise(() =>
            root.sequence<number>([a, b], 0)
          );
          expect(out).toBe(2);
          const wrapperPath = ["root", "sequence"];
          const onWrapper = (e: ChannelEvent): boolean =>
            "path" in e &&
            e.path.length === wrapperPath.length &&
            e.path.every((p, i) => p === wrapperPath[i]);
          const started = captured.filter(
            (e) => e._tag === "step.started" && onWrapper(e)
          );
          const complete = captured.filter(
            (e) => e._tag === "step.complete" && onWrapper(e)
          );
          expect(started).toHaveLength(1);
          expect(complete).toHaveLength(1);
        })
      )
    );
  });

  test("a failing parallel arm publishes step.failed on the wrapper exactly once (not started+complete and started+failed)", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.make();
          const channels = yield* Channels.make(snapshot);
          const exe = yield* Executable.make<void>({
            input: undefined,
            name: "root",
          });
          const root = Composer.root({ channels }, exe);
          const captured: ChannelEvent[] = [];
          yield* Effect.forkScoped(
            Stream.runForEach(channels.events.stream, (e) =>
              Effect.sync(() => {
                captured.push(e);
              })
            )
          );
          yield* Effect.sleep(5);
          const ok = Step.create<unknown, unknown>({
            execute: async () => "ok",
            input: undefined,
            name: "ok",
          });
          const bad = Step.create<unknown, unknown>({
            execute: async () => {
              throw new Error("nope");
            },
            input: undefined,
            name: "bad",
          });
          // Use tryPromise so a Promise rejection becomes an Effect failure
          // we can recover from. Effect.promise treats rejections as defects.
          const result = yield* Effect.tryPromise({
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
            try: () =>
              root.parallel({
                bad: { input: undefined, step: bad },
                ok: { input: undefined, step: ok },
              }),
          }).pipe(Effect.either);
          expect(result._tag).toBe("Left");
          const wrapperPath = ["root", "parallel"];
          const onWrapper = (e: ChannelEvent): boolean =>
            "path" in e &&
            e.path.length === wrapperPath.length &&
            e.path.every((p, i) => p === wrapperPath[i]);
          const started = captured.filter(
            (e) => e._tag === "step.started" && onWrapper(e)
          );
          const failed = captured.filter(
            (e) => e._tag === "step.failed" && onWrapper(e)
          );
          const complete = captured.filter(
            (e) => e._tag === "step.complete" && onWrapper(e)
          );
          expect(started).toHaveLength(1);
          expect(failed).toHaveLength(1);
          // No `step.complete` on the wrapper — the body failed; only fail() fired.
          expect(complete).toHaveLength(0);
        })
      )
    );
  });
});
