/**
 * Channels payload — Stage 5 / P2-8: chunk envelope + projection at the
 * Channels layer (no Step involvement).
 *
 * Three describe blocks:
 *   A. ChannelMessage multiplexing — events + chunks share the merged stream
 *      with `_tag` discriminator and ordering preserved.
 *   B. chunksFor(stepId) returns ChunkPayload (value-only), not the envelope.
 *   C. chunksFor(stepId) filters strictly by stepId.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { ChannelMessage } from "../channels";

import { Channels, StepCompleteEvent, StepStartedEvent } from "../channels";
import { Snapshot } from "../snapshot";

const path = ["root"] as const;
const at = "2026-05-02T00:00:00.000Z";

// ════════════════════════════════════════════════════════════════════════════
// A. ChannelMessage multiplexing — events + chunks on one stream
// ════════════════════════════════════════════════════════════════════════════

describe("Channels.stream — multiplexed ChannelMessage", () => {
  it("preserves publish order and tags each value as 'event' or 'chunk'", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          const reader = channels.stream.getReader();
          // Allow the multiplexer fibers to attach before publishing.
          yield* Effect.sleep(5);

          channels.events.push(
            StepStartedEvent.make({ at, attempt: 1, name: "root", path })
          );
          channels.chunks.push({
            at,
            payload: { kind: "text", text: "hello" },
            stepId: "root",
          });
          channels.events.push(
            StepCompleteEvent.make({
              at,
              attempt: 1,
              name: "root",
              path,
              value: "ok",
            })
          );
          channels.chunks.push({
            at,
            payload: { data: { x: 1 }, kind: "data" },
            stepId: "root",
          });

          const collected: ChannelMessage[] = [];
          for (let i = 0; i < 4; i++) {
            const next = yield* Effect.promise(() => reader.read());
            if (next.done) {
              break;
            }
            collected.push(next.value);
          }
          reader.releaseLock();

          expect(collected).toHaveLength(4);
          // The multiplexer drives events and chunks on independent fibers,
          // so global interleaving across the two pubsubs is not guaranteed
          // — assert per-kind ordering and tag-discriminated narrowing.
          const eventTags: string[] = [];
          const chunkPayloads: { kind: string; value: unknown }[] = [];
          for (const m of collected) {
            if (m._tag === "event") {
              eventTags.push(m.event._tag);
            } else {
              const payload = m.chunk.payload;
              chunkPayloads.push(
                payload.kind === "text"
                  ? { kind: "text", value: payload.text }
                  : { kind: "data", value: payload.data }
              );
            }
          }
          expect(eventTags).toEqual(["step.started", "step.complete"]);
          expect(chunkPayloads).toEqual([
            { kind: "text", value: "hello" },
            { kind: "data", value: { x: 1 } },
          ]);
        })
      )
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. chunksFor returns ChunkPayload (no envelope)
// ════════════════════════════════════════════════════════════════════════════

describe("Channels.chunksFor — ChunkPayload (value-only)", () => {
  it("the consumer reads the payload, not the envelope", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          const stream = channels.chunksFor("alpha");
          const reader = stream.getReader();
          channels.chunks.push({
            at: new Date().toISOString(),
            payload: { kind: "text", text: "hi" },
            stepId: "alpha",
          });
          const result = yield* Effect.promise(() => reader.read());
          reader.releaseLock();
          yield* Effect.sync(() => {
            void stream.cancel();
          });

          expect(result.done).toBe(false);
          expect(result.value).toEqual({ kind: "text", text: "hi" });
          // Envelope-only fields must not be present.
          const asUnknown = result.value as unknown as Record<string, unknown>;
          expect(asUnknown.stepId).toBeUndefined();
          expect(asUnknown.at).toBeUndefined();
        })
      )
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. chunksFor filters by stepId
// ════════════════════════════════════════════════════════════════════════════

describe("Channels.chunksFor — filters by stepId", () => {
  it("a chunksFor('alpha') consumer sees only chunks tagged 'alpha'", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          const stream = channels.chunksFor("alpha");
          const reader = stream.getReader();

          channels.chunks.push({
            at: new Date().toISOString(),
            payload: { kind: "text", text: "alpha-1" },
            stepId: "alpha",
          });
          channels.chunks.push({
            at: new Date().toISOString(),
            payload: { kind: "text", text: "ignored" },
            stepId: "beta",
          });
          channels.chunks.push({
            at: new Date().toISOString(),
            payload: { kind: "text", text: "alpha-2" },
            stepId: "alpha",
          });

          const a = yield* Effect.promise(() => reader.read());
          const b = yield* Effect.promise(() => reader.read());
          reader.releaseLock();
          yield* Effect.sync(() => {
            void stream.cancel();
          });

          expect(a.done).toBe(false);
          expect(b.done).toBe(false);
          if (a.value?.kind === "text") {
            expect(a.value.text).toBe("alpha-1");
          }
          if (b.value?.kind === "text") {
            expect(b.value.text).toBe("alpha-2");
          }
        })
      )
    );
  });
});
