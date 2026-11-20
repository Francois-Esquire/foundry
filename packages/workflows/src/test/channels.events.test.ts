import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Channels } from "../channels";
import {
  ChannelEventSchema,
  StepAbortedEvent,
  StepPausedEvent,
  StepResolvedEvent,
  StepSkippedEvent,
} from "../schema";
import { Snapshot } from "../snapshot";

const path = ["root"] as const;
const at = "2026-05-02T00:00:00.000Z";

describe("Schema round-trip — new variants decode and tag-discriminate", () => {
  it("step.paused with optional reason", () => {
    const decoded = ChannelEventSchema.parse({
      _tag: "step.paused",
      at,
      attempt: 1,
      name: "root",
      path,
      reason: "operator paused",
    });
    expect(decoded._tag).toBe("step.paused");
    if (decoded._tag === "step.paused") {
      expect(decoded.reason).toBe("operator paused");
    }
  });

  it("step.paused without reason", () => {
    const decoded = ChannelEventSchema.parse({
      _tag: "step.paused",
      at,
      attempt: 1,
      name: "root",
      path,
    });
    expect(decoded._tag).toBe("step.paused");
  });

  it("step.resumed", () => {
    const decoded = ChannelEventSchema.parse({
      _tag: "step.resumed",
      at,
      attempt: 1,
      name: "root",
      path,
    });
    expect(decoded._tag).toBe("step.resumed");
  });

  it("step.skipped with optional reason", () => {
    const decoded = ChannelEventSchema.parse({
      _tag: "step.skipped",
      at,
      attempt: 0,
      name: "root",
      path,
      reason: "branch arm not taken",
    });
    expect(decoded._tag).toBe("step.skipped");
  });

  it("step.aborted with opaque reason", () => {
    const decoded = ChannelEventSchema.parse({
      _tag: "step.aborted",
      at,
      attempt: 1,
      name: "root",
      path,
      reason: { code: 42, msg: "user-cancelled" },
    });
    expect(decoded._tag).toBe("step.aborted");
  });

  it("step.resolved carries suspension name + value", () => {
    const decoded = ChannelEventSchema.parse({
      _tag: "step.resolved",
      at,
      attempt: 1,
      name: "root",
      path,
      suspensionName: "human-review",
      value: { approved: true },
    });
    expect(decoded._tag).toBe("step.resolved");
    if (decoded._tag === "step.resolved") {
      expect(decoded.suspensionName).toBe("human-review");
      expect(decoded.value).toEqual({ approved: true });
    }
  });

  it("variant constructors auto-apply _tag (TaggedStruct.make)", () => {
    const e = StepPausedEvent.parse({
      _tag: "step.paused",
      at,
      attempt: 1,
      name: "root",
      path,
    });
    expect(e._tag).toBe("step.paused");
  });
});

describe("Channels.statusFor — status mapping for new variants", () => {
  it("step.paused → 'paused'", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          const fiber = yield* Effect.fork(
            channels.statusFor(path).pipe(Stream.take(1), Stream.runCollect)
          );
          yield* Effect.sleep(5);
          channels.events.push(
            StepPausedEvent.parse({
              _tag: "step.paused",
              at,
              attempt: 1,
              name: "root",
              path,
            })
          );
          const out = yield* fiber.await;
          expect(out._tag).toBe("Success");
          if (out._tag === "Success") {
            expect([...out.value]).toEqual(["paused"]);
          }
        })
      )
    );
  });

  it("step.skipped → 'skipped'", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          const fiber = yield* Effect.fork(
            channels.statusFor(path).pipe(Stream.take(1), Stream.runCollect)
          );
          yield* Effect.sleep(5);
          channels.events.push(
            StepSkippedEvent.parse({
              _tag: "step.skipped",
              at,
              attempt: 0,
              name: "root",
              path,
            })
          );
          const out = yield* fiber.await;
          expect(out._tag).toBe("Success");
          if (out._tag === "Success") {
            expect([...out.value]).toEqual(["skipped"]);
          }
        })
      )
    );
  });

  it("step.aborted → 'aborted'", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          const fiber = yield* Effect.fork(
            channels.statusFor(path).pipe(Stream.take(1), Stream.runCollect)
          );
          yield* Effect.sleep(5);
          channels.events.push(
            StepAbortedEvent.parse({
              _tag: "step.aborted",
              at,
              attempt: 1,
              name: "root",
              path,
              reason: "x",
            })
          );
          const out = yield* fiber.await;
          expect(out._tag).toBe("Success");
          if (out._tag === "Success") {
            expect([...out.value]).toEqual(["aborted"]);
          }
        })
      )
    );
  });

  it("step.resolved is filtered out (transient marker, no status)", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          const fiber = yield* Effect.fork(
            channels.statusFor(path).pipe(Stream.take(1), Stream.runCollect)
          );
          yield* Effect.sleep(5);
          channels.events.push(
            StepResolvedEvent.parse({
              _tag: "step.resolved",
              at,
              attempt: 1,
              name: "root",
              path,
              suspensionName: "x",
              value: undefined,
            })
          );
          channels.events.push(
            StepSkippedEvent.parse({
              _tag: "step.skipped",
              at,
              attempt: 0,
              name: "root",
              path,
            })
          );
          const out = yield* fiber.await;
          expect(out._tag).toBe("Success");
          if (out._tag === "Success") {
            expect([...out.value]).toEqual(["skipped"]);
          }
        })
      )
    );
  });
});
