/**
 * channels.ts — streaming + event broadcast hub.
 *
 * The general/load-bearing test home for `Channels`. The two existing
 * namespaced files cover schema round-trip (channels.events.test.ts)
 * and chunk payload semantics (channels.payload.test.ts); this file
 * pins the **synchronous Snapshot bridge** and the **race-free
 * eager-subscribe variants** that don't have direct coverage.
 *
 * Tests pin (Tier 1 #3):
 *   - `events.push(e)` / `events.publish(e)` apply the event to
 *     Snapshot synchronously **before** broadcasting — by the time
 *     the call returns, `snapshot.current` reflects the event.
 *   - `chunks.push(...)` does NOT touch the Snapshot.
 *   - `subscribeStatus` / `subscribeOutput` capture events published
 *     immediately after construction (Tier 4 #30 — the race the eager
 *     variants exist to fix); the lazy `statusFor` / `outputFor` would
 *     drop those.
 */

import { Effect, Stream } from "effect";
import { describe, expect, test } from "vitest";
import { Channels } from "../channels";
import type { StepStatus } from "../snapshot";
import { Snapshot } from "../snapshot";

const at = (msOffset = 0): string =>
  new Date(1_700_000_000_000 + msOffset).toISOString();

// ════════════════════════════════════════════════════════════════════════════
// 1. Snapshot bridge — publish-then-read-snapshot synchronous ordering
// ════════════════════════════════════════════════════════════════════════════

describe("Channels — Snapshot bridge (publish-then-read-snapshot ordering)", () => {
  test("events.push applies the event to Snapshot synchronously before returning", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          // Push an event; immediately read snapshot. The synchronous
          // bridge guarantees the read sees the projected state — no
          // microtask, no fiber yield. This is the contract authors
          // depend on when they `step.write(...)` then `step.progress`.
          channels.events.push({
            _tag: "step.started",
            at: at(0),
            attempt: 1,
            name: "root",
            path: ["root"],
          });
          const state = yield* snap.current;
          expect(state.steps.root?.status).toBe("running");
        })
      )
    );
  });

  test("events.publish (Effect) applies the event before publishing on the PubSub", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          yield* channels.events.publish({
            _tag: "step.complete",
            at: at(10),
            attempt: 1,
            name: "root",
            path: ["root"],
            value: 99,
          });
          const state = yield* snap.current;
          expect(state.steps.root?.status).toBe("complete");
          expect(state.steps.root?.output).toBe(99);
          expect(state.results.root).toBe(99);
        })
      )
    );
  });

  test("chunks.push does NOT touch the Snapshot — chunks are pure broadcast", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          channels.chunks.push({
            at: at(0),
            payload: { kind: "text", text: "hello" },
            stepId: "id-1",
          });
          const state = yield* snap.current;
          // Snapshot is unchanged.
          expect(state.steps).toEqual({});
          expect(state.results).toEqual({});
          expect(state.workflow).toBeNull();
        })
      )
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Race-free eager subscribers — subscribeStatus / subscribeOutput
// ════════════════════════════════════════════════════════════════════════════

describe("Channels — race-free eager subscribers", () => {
  test("subscribeStatus captures an event published immediately after subscription is acquired", async () => {
    const collected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          // Acquire the eager subscription under the current scope —
          // the PubSub subscription is live as soon as this returns.
          const stream = yield* channels.subscribeStatus(["root"]);
          // Synchronously publish; if subscribe were lazy, this event
          // would race the first pull and be dropped.
          channels.events.push({
            _tag: "step.started",
            at: at(0),
            attempt: 1,
            name: "root",
            path: ["root"],
          });
          channels.events.push({
            _tag: "step.complete",
            at: at(1),
            attempt: 1,
            name: "root",
            path: ["root"],
            value: undefined,
          });
          // Drain the first 2 mapped statuses.
          return yield* Stream.runCollect(Stream.take(stream, 2));
        })
      )
    );
    expect(Array.from(collected)).toEqual<StepStatus[]>([
      "running",
      "complete",
    ]);
  });

  test("subscribeOutput captures a step.complete value published immediately after subscription", async () => {
    const collected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          const stream = yield* channels.subscribeOutput<number>(["root"]);
          channels.events.push({
            _tag: "step.complete",
            at: at(0),
            attempt: 1,
            name: "root",
            path: ["root"],
            value: 42,
          });
          return yield* Stream.runCollect(Stream.take(stream, 1));
        })
      )
    );
    expect(Array.from(collected)).toEqual([42]);
  });

  test("subscribeStatus filters by exact path (siblings don't bleed through)", async () => {
    const collected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          const stream = yield* channels.subscribeStatus(["a"]);
          // Sibling event should be filtered.
          channels.events.push({
            _tag: "step.started",
            at: at(0),
            attempt: 1,
            name: "b",
            path: ["b"],
          });
          channels.events.push({
            _tag: "step.started",
            at: at(1),
            attempt: 1,
            name: "a",
            path: ["a"],
          });
          return yield* Stream.runCollect(Stream.take(stream, 1));
        })
      )
    );
    expect(Array.from(collected)).toEqual<StepStatus[]>(["running"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. statusFor — custom and step.resolved are excluded
// ════════════════════════════════════════════════════════════════════════════

describe("Channels.statusFor — custom + step.resolved excluded from path projections", () => {
  test("statusFor skips `custom` events and `step.resolved` (transient marker)", async () => {
    const collected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          // Eagerly bind a subscription so we don't race the publishes.
          const stream = yield* channels.subscribeStatus(["root"]);
          channels.events.push({
            _tag: "step.started",
            at: at(0),
            attempt: 1,
            name: "root",
            path: ["root"],
          });
          channels.events.push({
            _tag: "custom",
            at: at(1),
            path: ["root"],
            stepId: "x",
            type: "user.click",
          });
          channels.events.push({
            _tag: "step.resolved",
            at: at(2),
            attempt: 1,
            name: "root",
            path: ["root"],
            suspensionName: "n",
            value: 1,
          });
          channels.events.push({
            _tag: "step.complete",
            at: at(3),
            attempt: 1,
            name: "root",
            path: ["root"],
            value: undefined,
          });
          // Take 2 — only `step.started` (running) + `step.complete`
          // (complete) should land. If `step.resolved` or `custom`
          // mapped to a status, we'd get an extra emission and Take(2)
          // would short-circuit early on the wrong values.
          return yield* Stream.runCollect(Stream.take(stream, 2));
        })
      )
    );
    expect(Array.from(collected)).toEqual<StepStatus[]>([
      "running",
      "complete",
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. chunksFor — stepId filter + signal close
// ════════════════════════════════════════════════════════════════════════════

describe("Channels.chunksFor — stepId filter + signal close", () => {
  test("chunksFor returns only payloads matching the requested stepId", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          const reader = channels.chunksFor("step-A").getReader();

          channels.chunks.push({
            at: at(0),
            payload: { kind: "text", text: "wrong-step" },
            stepId: "step-B",
          });
          channels.chunks.push({
            at: at(1),
            payload: { kind: "text", text: "right-step" },
            stepId: "step-A",
          });
          const next = yield* Effect.promise(() => reader.read());
          expect(next.done).toBe(false);
          expect(next.value).toEqual({ kind: "text", text: "right-step" });
          // Cancel so the test's scope finalizers shut down cleanly.
          yield* Effect.promise(() => reader.cancel());
        })
      )
    );
  });

  test("chunksFor closes when the supplied AbortSignal aborts", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          const ctl = new AbortController();
          const stream = channels.chunksFor("step-A", ctl.signal);
          ctl.abort("test-cancel");
          const reader = stream.getReader();
          const next = yield* Effect.promise(() => reader.read());
          expect(next.done).toBe(true);
        })
      )
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. fork — Channels is shared per Run (fork returns this)
// ════════════════════════════════════════════════════════════════════════════

describe("Channels.fork — identity (shared per Run)", () => {
  test("fork returns the same instance — channels is broadcast-shared", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          expect(channels.fork()).toBe(channels);
        })
      )
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Multiplexed `stream` — order-preserving + buffer-until-start
// ════════════════════════════════════════════════════════════════════════════

describe("Channels.stream — multiplexed events + chunks", () => {
  test("multiplexed stream tags events as 'event' and chunks as 'chunk' and preserves publish order", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          const reader = channels.stream.getReader();
          // The PubSub→ReadableStream multiplexer is two forked Effect
          // fibers; allow them to attach before publishing.
          yield* Effect.sleep(5);
          channels.events.push({
            _tag: "step.started",
            at: at(0),
            attempt: 1,
            name: "root",
            path: ["root"],
          });
          channels.chunks.push({
            at: at(1),
            payload: { kind: "text", text: "x" },
            stepId: "id",
          });
          const first = yield* Effect.promise(() => reader.read());
          const second = yield* Effect.promise(() => reader.read());
          expect(first.value?._tag).toBe("event");
          expect(second.value?._tag).toBe("chunk");
          yield* Effect.sync(() => {
            void reader.cancel();
          });
        })
      )
    );
  });
});
