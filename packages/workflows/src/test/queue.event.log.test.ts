/**
 * Queue — append-only `metadata.stream` event log.
 *
 * The reactive persistence loop captures `WorkflowState` snapshots on every
 * change. The event-log loop captures every `ChannelEvent` in a per-run
 * buffer; `#persistSnapshot` snapshots the buffer into `metadata.stream`
 * on each write. Together they let a replay UI reconstruct the full
 * chronological lifecycle from the row alone.
 *
 * Tests below verify:
 *   - Events accumulate in `metadata.stream` across a run's lifecycle
 *     (started/complete for each step, terminal for the workflow).
 *   - Cross-process: queueA's events survive queueA.shutdown and queueB's
 *     subsequent appends grow on top (monotonic event log).
 *   - Failed runs surface a `step.failed` event in the persisted log.
 *   - Suspended runs surface `step.suspended` in the persisted log.
 */

import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import type { ChannelEvent } from "../channels";

import { Queue } from "../queue";
import { Workflow } from "../workflow";
import { makeEchoSpec, makeSuspendingSpec } from "./fixtures/steps";
import { makeInMemoryStore } from "./helpers/store";

interface PersistedMeta {
  readonly stream?: ChannelEvent[];
  readonly workflow?: Record<string, unknown>;
}

function readMeta(rawMeta: unknown): PersistedMeta {
  if (rawMeta == null) {
    return {};
  }
  return typeof rawMeta === "string"
    ? (JSON.parse(rawMeta) as PersistedMeta)
    : rawMeta;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Basic accumulation across a successful run
// ════════════════════════════════════════════════════════════════════════════

describe("Queue event log — successful run", () => {
  test("metadata.stream captures step.started + step.complete for the workflow's step", async () => {
    const store = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store });
    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create(makeEchoSpec("ok", "log-success"));
          const d = queue.dispatch(wf);
          yield* Effect.promise(() => d.result());
          return d.id;
        })
      )
    );
    await queue.drain();
    const row = await store.getRun(id);
    if (!row) {
      throw new Error("expected persisted run");
    }
    const meta = readMeta(row.metadata);
    const tags = (meta.stream ?? []).map((e) => e._tag);
    expect(tags).toContain("step.started");
    expect(tags).toContain("step.complete");
  });

  test("a parent + child workflow surfaces lifecycle events for both", async () => {
    const store = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store });
    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create({
            children: [
              { execute: async () => "c-ok", input: undefined, name: "child" },
            ],
            execute: async (_input, ctx) => {
              await ctx.children[0]?.run();
              return "p-ok";
            },
            input: undefined,
            name: "log-parent",
          });
          const d = queue.dispatch(wf);
          yield* Effect.promise(() => d.result());
          return d.id;
        })
      )
    );
    await queue.drain();
    const row = await store.getRun(id);
    if (!row) {
      throw new Error("expected persisted run");
    }
    const meta = readMeta(row.metadata);
    const stream = meta.stream ?? [];
    // Both the parent's path and the child's path should appear in
    // `step.complete` events. The path encodes which step the event is
    // for; child events have a longer path than parent events.
    const completes = stream.filter((e) => e._tag === "step.complete");
    expect(completes.length).toBeGreaterThanOrEqual(2);
    const paths = completes.map((e) => (e as { path: readonly string[] }).path);
    expect(paths.some((p) => p.length === 1)).toBe(true); // parent
    expect(paths.some((p) => p.length === 2)).toBe(true); // child
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Failed run captures step.failed
// ════════════════════════════════════════════════════════════════════════════

describe("Queue event log — failed run", () => {
  test("metadata.stream captures step.failed with the error shape", async () => {
    const store = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store });
    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create({
            execute: async () => {
              throw new TypeError("planned");
            },
            input: undefined,
            name: "log-fail",
          });
          const d = queue.dispatch(wf);
          yield* Effect.promise(() => d.result());
          return d.id;
        })
      )
    );
    await queue.drain();
    const row = await store.getRun(id);
    if (!row) {
      throw new Error("expected persisted run");
    }
    const meta = readMeta(row.metadata);
    const failed = (meta.stream ?? []).find((e) => e._tag === "step.failed");
    expect(failed).toBeDefined();
    const err = (failed as { error?: { name: string; message: string } }).error;
    expect(err?.name).toBe("TypeError");
    expect(err?.message).toBe("planned");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Suspended run captures step.suspended in the persisted log
// ════════════════════════════════════════════════════════════════════════════

describe("Queue event log — suspended run", () => {
  test("metadata.stream captures step.suspended with the suspension state", async () => {
    const store = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store });
    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create(
            makeSuspendingSpec(
              { reason: "review-pending", suspendName: "wait-on-human" },
              "log-suspend"
            )
          );
          const d = queue.dispatch(wf);
          while (d.status !== "suspended") {
            yield* Effect.sleep(10);
          }
          // Allow the terminal write inside #runOne to flush the buffer.
          yield* Effect.sleep(50);
          return d.id;
        })
      )
    );
    const row = await store.getRun(id);
    if (!row) {
      throw new Error("expected persisted run");
    }
    const meta = readMeta(row.metadata);
    const suspended = (meta.stream ?? []).find(
      (e) => e._tag === "step.suspended"
    );
    expect(suspended).toBeDefined();
    const susp = (
      suspended as {
        suspension?: { name: string; reason: string };
      }
    ).suspension;
    expect(susp?.name).toBe("wait-on-human");
    expect(susp?.reason).toBe("review-pending");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Cross-process monotonicity — queueB's events grow on top of queueA's
// ════════════════════════════════════════════════════════════════════════════

describe("Queue event log — cross-process monotonicity", () => {
  test("hydrated run's first persisted log contains queueA's events; subsequent appends grow on top", async () => {
    // queueA: dispatch and suspend. queueA's terminal write captures
    // step.started + step.suspended in metadata.stream.
    const store = makeInMemoryStore();
    const queueA = new Queue({ concurrency: 1, store });
    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create(
            makeSuspendingSpec(
              { reason: "for-monotonic-test", suspendName: "approve" },
              "log-monotonic"
            )
          );
          const d = queueA.dispatch(wf);
          while (d.status !== "suspended") {
            yield* Effect.sleep(10);
          }
          yield* Effect.sleep(50);
          return d.id;
        })
      )
    );
    const rowAfterA = await store.getRun(id);
    if (!rowAfterA) {
      throw new Error("expected persisted run");
    }
    const aStream = readMeta(rowAfterA.metadata).stream ?? [];
    expect(aStream.some((e) => e._tag === "step.suspended")).toBe(true);
    const aLength = aStream.length;
    await queueA.shutdown();

    // queueB: hydrate the run; the buffer is seeded from queueA's stream.
    // Resume; queueB's #runOne appends the next round of events on top.
    const queueB = new Queue({ concurrency: 1, store });
    const dispatched = await queueB.hydrate(id, () =>
      Workflow.create(
        makeSuspendingSpec(
          { reason: "for-monotonic-test", suspendName: "approve" },
          "log-monotonic"
        )
      )
    );
    expect(dispatched).not.toBeNull();
    expect(dispatched?.status).toBe("suspended");

    await new Promise<void>((r) => setTimeout(r, 20));
    if (!dispatched) {
      throw new Error("expected hydrated handle");
    }
    await dispatched.resume("approve", "approved-by-test");
    // Wait for queueB's #runOne to land its terminal write.
    await new Promise<void>((r) => setTimeout(r, 200));

    const rowAfterB = await store.getRun(id);
    if (!rowAfterB) {
      throw new Error("expected persisted run");
    }
    const bStream = readMeta(rowAfterB.metadata).stream ?? [];
    // Monotonic: bStream is at least as long as aStream, and the leading
    // entries in bStream match aStream entry-for-entry.
    expect(bStream.length).toBeGreaterThanOrEqual(aLength);
    for (let i = 0; i < aLength; i++) {
      expect(bStream[i]?._tag).toBe(aStream[i]?._tag);
    }
    // queueB's appends include the second `step.started` for the
    // resumed pass through the body.
    const startedCount = bStream.filter(
      (e) => e._tag === "step.started"
    ).length;
    expect(startedCount).toBeGreaterThanOrEqual(2);
    await queueB.shutdown();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Stream is structured — each entry parses against the discriminated union
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// 4b. #eventLogLoop filter — step.progress and custom are EXCLUDED (Tier 1 #4)
// Without this filter, streaming workflows bloat metadata.stream
// quadratically (each reactive write copies the whole buffer). The filter
// has no observable effect besides "the stream column doesn't blow up";
// this test exists exclusively to keep that filter in place.
// ════════════════════════════════════════════════════════════════════════════

describe("Queue event log — #eventLogLoop filter", () => {
  test("step.progress and custom events are NOT persisted into metadata.stream; lifecycle events are", async () => {
    const store = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store });
    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create({
            execute: async (_input, ctx) => {
              // Many progress ticks + a custom emit; the filter must
              // drop both from the persisted log.
              for (let i = 0; i < 25; i++) {
                ctx.step.progress = i * 4;
              }
              ctx.emit("user.click", { x: 1 });
              return "ok";
            },
            input: undefined,
            name: "log-filter",
          });
          const d = queue.dispatch(wf);
          yield* Effect.promise(() => d.result());
          return d.id;
        })
      )
    );
    await queue.drain();
    const row = await store.getRun(id);
    if (!row) {
      throw new Error("expected persisted run");
    }
    const stream = readMeta(row.metadata).stream ?? [];
    // Lifecycle events are present.
    expect(stream.some((e) => e._tag === "step.started")).toBe(true);
    expect(stream.some((e) => e._tag === "step.complete")).toBe(true);
    // Filtered tags must be absent from persistence even though they
    // fired live on the PubSub.
    expect(stream.some((e) => e._tag === "step.progress")).toBe(false);
    expect(stream.some((e) => e._tag === "custom")).toBe(false);
    await queue.shutdown();
  });
});

describe("Queue event log — entry structure", () => {
  test("each persisted entry has a string `_tag` and a path array", async () => {
    const store = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store });
    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create(makeEchoSpec("payload", "log-shape"));
          const d = queue.dispatch(wf);
          yield* Effect.promise(() => d.result());
          return d.id;
        })
      )
    );
    await queue.drain();
    const row = await store.getRun(id);
    if (!row) {
      throw new Error("expected persisted run");
    }
    const stream = readMeta(row.metadata).stream ?? [];
    expect(stream.length).toBeGreaterThan(0);
    for (const event of stream) {
      expect(typeof event._tag).toBe("string");
      // Lifecycle entries carry a path; custom emits do too. Both are
      // non-empty arrays of strings.
      const path = (event as { path?: unknown }).path;
      expect(Array.isArray(path)).toBe(true);
    }
  });
});
