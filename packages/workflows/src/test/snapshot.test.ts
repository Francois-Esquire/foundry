/**
 * Snapshot — projected state machine.
 *
 * Live test home for the snapshot.ts contract. Replaces the all-todo
 * version that referenced helpers (`getStepRecord/setStepRecord/
 * mergeStepRecord`) which no longer exist on this file.
 *
 * Tests pin:
 *   - `Snapshot.apply` projection arms for all event variants
 *     (started, complete, failed, bailed, suspended, paused, resumed,
 *     skipped, aborted, resolved).
 *   - The **pure-replay invariant**: live channels-driven state ≡
 *     reduce(events, Snapshot.apply, empty). Cornerstone of recovery.
 *   - `clearCursorIf`: terminal events on the matching cursor path
 *     clear the cursor; non-matching paths leave the cursor alone.
 *   - `setWorkflow` leaf-only seeding: only leaves get pending entries;
 *     interior nodes don't appear until their `step.started` fires.
 *   - `step.resolved` clears suspension without flipping status.
 *   - Identity boundary: Snapshot has no `runId` / `queueId`.
 */

import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import type { ChannelEvent } from "../channels";
import { Channels } from "../channels";
import type { SnapshotState } from "../snapshot";
import { Snapshot } from "../snapshot";

const at = (msOffset = 0): string =>
  new Date(1_700_000_000_000 + msOffset).toISOString();

const emptyState = (): SnapshotState => ({
  results: {},
  steps: {},
  updatedAt: at(0),
  workflow: null,
});

/**
 * Compare two SnapshotStates ignoring `updatedAt`. The static
 * `Snapshot.apply` does not touch `updatedAt`; only the live
 * `applyEventEffect` injects `event.at` into the state on each push
 * (snapshot.ts:362-365). Pure-replay parity is therefore expressed
 * "modulo the freshness stamp."
 */
function withoutUpdatedAt(
  state: SnapshotState
): Omit<SnapshotState, "updatedAt"> {
  const { updatedAt: _omit, ...rest } = state;
  return rest;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Snapshot.apply — projection arms for the old variants
// ════════════════════════════════════════════════════════════════════════════

describe("Snapshot.apply — projection (old variants)", () => {
  test("step.started seeds the leaf record at path with status=running", () => {
    const next = Snapshot.apply(emptyState(), {
      _tag: "step.started",
      at: at(1),
      attempt: 1,
      name: "root",
      path: ["root"],
    });
    expect(next.steps.root).toMatchObject({
      attempt: 1,
      name: "root",
      namespace: "",
      startedAt: at(1),
      status: "running",
    });
  });

  test("step.complete merges value + status without losing startedAt; updates results store", () => {
    const started = Snapshot.apply(emptyState(), {
      _tag: "step.started",
      at: at(1),
      attempt: 1,
      name: "root",
      path: ["root"],
    });
    const complete = Snapshot.apply(started, {
      _tag: "step.complete",
      at: at(101),
      attempt: 1,
      name: "root",
      path: ["root"],
      value: 42,
    });
    expect(complete.steps.root).toMatchObject({
      completedAt: at(101),
      durationMs: 100,
      output: 42,
      startedAt: at(1),
      status: "complete",
    });
    expect(complete.results.root).toBe(42);
  });

  test("step.failed records the error shape and status=failed", () => {
    const next = Snapshot.apply(emptyState(), {
      _tag: "step.failed",
      at: at(50),
      attempt: 2,
      error: { message: "boom", name: "TypeError" },
      name: "root",
      path: ["root"],
    });
    expect(next.steps.root).toMatchObject({
      attempt: 2,
      error: { message: "boom", name: "TypeError" },
      status: "failed",
    });
  });

  test("step.bailed records the bail payload and status=failed", () => {
    const next = Snapshot.apply(emptyState(), {
      _tag: "step.bailed",
      at: at(50),
      attempt: 1,
      bail: { code: "VALIDATION", detail: "x missing" },
      name: "root",
      path: ["root"],
    });
    expect(next.steps.root).toMatchObject({
      bail: { code: "VALIDATION", detail: "x missing" },
      status: "failed",
    });
  });

  test("step.suspended flips status without dropping startedAt", () => {
    const started = Snapshot.apply(emptyState(), {
      _tag: "step.started",
      at: at(0),
      attempt: 1,
      name: "root",
      path: ["root"],
    });
    const suspended = Snapshot.apply(started, {
      _tag: "step.suspended",
      at: at(20),
      attempt: 1,
      name: "root",
      path: ["root"],
      suspension: {
        name: "wait-on-human",
        reason: "review",
        suspendedAt: at(20),
      },
    });
    expect(suspended.steps.root).toMatchObject({
      startedAt: at(0),
      status: "suspended",
      suspendedAt: at(20),
      suspension: { name: "wait-on-human", reason: "review" },
    });
  });

  test("step.progress updates progress without changing status", () => {
    const started = Snapshot.apply(emptyState(), {
      _tag: "step.started",
      at: at(0),
      attempt: 1,
      name: "root",
      path: ["root"],
    });
    const progressed = Snapshot.apply(started, {
      _tag: "step.progress",
      at: at(10),
      attempt: 1,
      name: "root",
      path: ["root"],
      value: 75,
    });
    expect(progressed.steps.root).toMatchObject({
      progress: 75,
      status: "running",
    });
  });

  test("custom events are a no-op for state", () => {
    const before = emptyState();
    const next = Snapshot.apply(before, {
      _tag: "custom",
      at: at(5),
      path: ["root"],
      stepId: "id-1",
      type: "user.click",
    });
    expect(next).toBe(before);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 1b. Snapshot.apply — projection arms for the new variants
// (moved from channels.events.test.ts: these are snapshot tests wearing a
// channels label.)
// ════════════════════════════════════════════════════════════════════════════

describe("Snapshot.apply — projection (new variants)", () => {
  test("step.paused transitions status to 'paused'", () => {
    const next = Snapshot.apply(emptyState(), {
      _tag: "step.paused",
      at: at(0),
      attempt: 1,
      name: "root",
      path: ["root"],
    });
    expect(next.steps.root?.status).toBe("paused");
  });

  test("step.resumed transitions a paused step back to 'running'", () => {
    let state = Snapshot.apply(emptyState(), {
      _tag: "step.paused",
      at: at(0),
      attempt: 1,
      name: "root",
      path: ["root"],
    });
    state = Snapshot.apply(state, {
      _tag: "step.resumed",
      at: at(1),
      attempt: 1,
      name: "root",
      path: ["root"],
    });
    expect(state.steps.root?.status).toBe("running");
  });

  test("step.skipped is terminal — sets status='skipped' + completedAt", () => {
    const next = Snapshot.apply(emptyState(), {
      _tag: "step.skipped",
      at: at(5),
      attempt: 0,
      name: "root",
      path: ["root"],
    });
    expect(next.steps.root?.status).toBe("skipped");
    expect(next.steps.root?.completedAt).toBe(at(5));
  });

  test("step.aborted is terminal — sets status='aborted' + completedAt", () => {
    const next = Snapshot.apply(emptyState(), {
      _tag: "step.aborted",
      at: at(7),
      attempt: 1,
      name: "root",
      path: ["root"],
      reason: "user cancelled",
    });
    expect(next.steps.root?.status).toBe("aborted");
    expect(next.steps.root?.completedAt).toBe(at(7));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. clearCursorIf rule — cursor clearing on terminal events
// ════════════════════════════════════════════════════════════════════════════

describe("clearCursorIf — cursor clears on terminal events for the matching path", () => {
  const seedWithCursor = (cursor: string): SnapshotState => ({
    ...emptyState(),
    workflow: {
      cursor,
      input: undefined,
      name: "wf",
      steps: [{ index: 0, key: "a", name: "a" }],
    },
  });

  test("step.complete clears the cursor when its path matches", () => {
    const next = Snapshot.apply(seedWithCursor("a"), {
      _tag: "step.complete",
      at: at(10),
      attempt: 1,
      name: "a",
      path: ["a"],
      value: 1,
    });
    expect(next.workflow?.cursor).toBeNull();
  });

  test.each([
    "step.failed",
    "step.bailed",
    "step.skipped",
    "step.aborted",
  ] as const)("%s clears the cursor when its path matches", (tag) => {
    const event = ((): ChannelEvent => {
      const base = {
        at: at(10),
        attempt: 1,
        name: "a",
        path: ["a"],
      } as const;
      switch (tag) {
        case "step.failed":
          return {
            _tag: "step.failed",
            ...base,
            error: { message: "m", name: "E" },
          };
        case "step.bailed":
          return { _tag: "step.bailed", ...base, bail: "x" };
        case "step.skipped":
          return { _tag: "step.skipped", ...base };
        case "step.aborted":
          return { _tag: "step.aborted", ...base };
      }
    })();
    const next = Snapshot.apply(seedWithCursor("a"), event);
    expect(next.workflow?.cursor).toBeNull();
  });

  test("a terminal event on a non-matching path leaves the cursor alone", () => {
    const seeded = seedWithCursor("a.b");
    const next = Snapshot.apply(seeded, {
      _tag: "step.complete",
      at: at(10),
      attempt: 1,
      name: "a",
      path: ["a"],
      value: 0,
    });
    expect(next.workflow?.cursor).toBe("a.b");
  });

  test("a non-terminal event (started, suspended, progress) does not touch the cursor", () => {
    const seeded = seedWithCursor("a");
    const started = Snapshot.apply(seeded, {
      _tag: "step.started",
      at: at(0),
      attempt: 1,
      name: "a",
      path: ["a"],
    });
    expect(started.workflow?.cursor).toBe("a");
    const suspended = Snapshot.apply(seeded, {
      _tag: "step.suspended",
      at: at(0),
      attempt: 1,
      name: "a",
      path: ["a"],
      suspension: { name: "n", reason: "r", suspendedAt: at(0) },
    });
    expect(suspended.workflow?.cursor).toBe("a");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. setWorkflow leaf-only seeding
// ════════════════════════════════════════════════════════════════════════════

describe("Snapshot.setWorkflow — leaf-only seeding", () => {
  test("seeds pending entries for leaf nodes only; interior nodes are absent until step.started fires", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          // Tree:
          //   root
          //   ├── a   (leaf)
          //   └── b
          //       └── b.c  (leaf)
          // setWorkflow must seed `a` and `b.c` as pending; `b` (interior)
          // does NOT get a pending entry.
          yield* snap.setWorkflow({
            cursor: null,
            input: undefined,
            name: "wf",
            steps: [
              { index: 0, key: "a", name: "a" },
              {
                children: [{ index: 0, key: "b.c", name: "c" }],
                index: 1,
                key: "b",
                name: "b",
              },
            ],
          });
          const state = yield* snap.current;
          expect(state.steps.a).toMatchObject({
            attempt: 0,
            status: "pending",
          });
          expect(state.steps["b.c"]).toMatchObject({
            attempt: 0,
            status: "pending",
          });
          // Interior node `b` is not seeded.
          expect(state.steps.b).toBeUndefined();
        })
      )
    );
  });

  test("does not overwrite an existing entry — re-seeding is additive", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          // Manually seed a step record via an event projection.
          const channels = yield* Channels.make(snap);
          channels.events.push({
            _tag: "step.started",
            at: at(0),
            attempt: 3,
            name: "a",
            path: ["a"],
          });
          yield* snap.setWorkflow({
            cursor: null,
            input: undefined,
            name: "wf",
            steps: [{ index: 0, key: "a", name: "a" }],
          });
          const state = yield* snap.current;
          // The previously-running record is preserved; setWorkflow's
          // leaf-seed only fills in entries that don't already exist.
          expect(state.steps.a?.status).toBe("running");
          expect(state.steps.a?.attempt).toBe(3);
        })
      )
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. step.resolved — clears suspension without flipping status
// ════════════════════════════════════════════════════════════════════════════

describe("Snapshot.apply — step.resolved", () => {
  test("clears the suspension marker without changing status", () => {
    let state = Snapshot.apply(emptyState(), {
      _tag: "step.started",
      at: at(0),
      attempt: 1,
      name: "root",
      path: ["root"],
    });
    state = Snapshot.apply(state, {
      _tag: "step.suspended",
      at: at(10),
      attempt: 1,
      name: "root",
      path: ["root"],
      suspension: { name: "n", reason: "r", suspendedAt: at(10) },
    });
    expect(state.steps.root?.status).toBe("suspended");
    expect(state.steps.root?.suspension).toBeDefined();
    state = Snapshot.apply(state, {
      _tag: "step.resolved",
      at: at(20),
      attempt: 1,
      name: "root",
      path: ["root"],
      suspensionName: "n",
      value: "answered",
    });
    // Status is unchanged — the replay's next `step.started` flips it.
    expect(state.steps.root?.status).toBe("suspended");
    expect(state.steps.root?.suspension).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Pure-replay invariant — live ≡ reduce(events, apply, empty)
// ════════════════════════════════════════════════════════════════════════════

describe("Pure-replay invariant", () => {
  test("apply over a captured event log yields a state structurally equal to the live snapshot (modulo updatedAt)", async () => {
    const capturedEvents: ChannelEvent[] = [];
    const liveState = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          const channels = yield* Channels.make(snap);
          // Tap the events PubSub through a synchronous push wrapper —
          // capture every event we publish before it lands on the bus.
          const push = (e: ChannelEvent): void => {
            capturedEvents.push(e);
            channels.events.push(e);
          };
          // Drive a parent + two children through a realistic lifecycle:
          // started, child progress, child complete, parent complete.
          push({
            _tag: "step.started",
            at: at(0),
            attempt: 1,
            name: "p",
            path: ["p"],
          });
          push({
            _tag: "step.started",
            at: at(1),
            attempt: 1,
            name: "c1",
            path: ["p", "c1"],
          });
          push({
            _tag: "step.progress",
            at: at(2),
            attempt: 1,
            name: "c1",
            path: ["p", "c1"],
            value: 50,
          });
          push({
            _tag: "step.complete",
            at: at(10),
            attempt: 1,
            name: "c1",
            path: ["p", "c1"],
            value: "c1-out",
          });
          push({
            _tag: "step.started",
            at: at(11),
            attempt: 1,
            name: "c2",
            path: ["p", "c2"],
          });
          push({
            _tag: "step.failed",
            at: at(15),
            attempt: 1,
            error: { message: "no", name: "Error" },
            name: "c2",
            path: ["p", "c2"],
          });
          push({
            _tag: "step.complete",
            at: at(20),
            attempt: 1,
            name: "p",
            path: ["p"],
            value: { ok: true },
          });
          return yield* snap.current;
        })
      )
    );

    // Pure replay: fold the captured events through the static apply.
    const replayed = capturedEvents.reduce<SnapshotState>(
      (acc, e) => Snapshot.apply(acc, e),
      emptyState()
    );

    expect(withoutUpdatedAt(replayed)).toEqual(withoutUpdatedAt(liveState));
  });

  test("replay is deterministic: two reduces of the same log produce equal state", () => {
    const events: ChannelEvent[] = [
      {
        _tag: "step.started",
        at: at(0),
        attempt: 1,
        name: "a",
        path: ["a"],
      },
      {
        _tag: "step.complete",
        at: at(5),
        attempt: 1,
        name: "a",
        path: ["a"],
        value: 1,
      },
    ];
    const r1 = events.reduce<SnapshotState>(
      (acc, e) => Snapshot.apply(acc, e),
      emptyState()
    );
    const r2 = events.reduce<SnapshotState>(
      (acc, e) => Snapshot.apply(acc, e),
      emptyState()
    );
    expect(r1).toEqual(r2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Identity boundary — Snapshot is run-identity-free
// ════════════════════════════════════════════════════════════════════════════

describe("Snapshot — identity boundary", () => {
  test("a Snapshot instance has no runId or queueId field", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snap = yield* Snapshot.make();
          // Sanity: instance is opaque (everything Effect-typed is `#`-private).
          // The seam-level guarantee is that the *state* shape carries no
          // identity — runId/queueId belong to the queue persistence layer.
          const state = yield* snap.current;
          expect("runId" in state).toBe(false);
          expect("queueId" in state).toBe(false);
          // And the live instance exposes no public identity getter either.
          const keys = Object.keys(snap);
          expect(keys).not.toContain("runId");
          expect(keys).not.toContain("queueId");
        })
      )
    );
  });

  test("two independent Snapshots fed identical event logs reach equal state", async () => {
    const events: ChannelEvent[] = [
      {
        _tag: "step.started",
        at: at(0),
        attempt: 1,
        name: "a",
        path: ["a"],
      },
      {
        _tag: "step.complete",
        at: at(5),
        attempt: 1,
        name: "a",
        path: ["a"],
        value: 1,
      },
    ];

    async function feedAndRead(): Promise<SnapshotState> {
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const snap = yield* Snapshot.make();
            const channels = yield* Channels.make(snap);
            for (const e of events) {
              channels.events.push(e);
            }
            return yield* snap.current;
          })
        )
      );
    }
    const a = await feedAndRead();
    const b = await feedAndRead();
    expect(withoutUpdatedAt(a)).toEqual(withoutUpdatedAt(b));
  });
});
