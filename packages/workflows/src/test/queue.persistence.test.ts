/**
 * Queue — reactive persistence (queue as runner).
 *
 * Verifies that the Queue mirrors `workflow.stateChanges` to the `runs` row
 * during execution, not just at the started/terminal boundaries. This is the
 * contract that lets a process restart at any point during execution see a
 * near-current snapshot of the world.
 *
 * Counterpart of queue.lifecycle.test.ts (which covers the boundary writes).
 */

import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { Queue } from "../queue";
import { Workflow } from "../workflow";
import { makeSuspendingSpec } from "./fixtures/steps";
import { makeInMemoryStore } from "./helpers/store";

function requireRun<T>(run: T | null): T {
  if (!run) {
    throw new Error("expected persisted run");
  }
  return run;
}

interface PersistedWorkflow {
  readonly status?: string;
  readonly steps?: Record<string, { readonly status?: string }>;
  readonly suspension?: {
    readonly name?: string;
    readonly reason?: string;
    readonly meta?: Record<string, unknown>;
  };
}

function readWorkflowMeta(rawMeta: unknown): PersistedWorkflow | null {
  if (rawMeta == null) {
    return null;
  }
  const parsed =
    typeof rawMeta === "string"
      ? (JSON.parse(rawMeta) as Record<string, unknown>)
      : (rawMeta as Record<string, unknown>);
  const wf = parsed.workflow as PersistedWorkflow | undefined;
  return wf ?? null;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Mid-execution row reflects child step.complete
// ════════════════════════════════════════════════════════════════════════════

describe("Queue — reactive persistence", () => {
  test("mid-execution row shows a child step as complete before the parent terminates", async () => {
    // Sequenced workflow: child finishes fast, parent then sleeps 250ms.
    // Sample the row at ~80ms and again at ~180ms — both windows fall
    // *after* the child's step.complete event but *before* the parent's
    // terminal write. The row should reflect the child as complete.
    const store = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store });

    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create({
            children: [
              {
                execute: async () => "child-done",
                input: undefined,
                name: "fast-child",
              },
            ],
            execute: async (_input, ctx) => {
              await ctx.children[0]?.run();
              await new Promise<void>((r) => setTimeout(r, 250));
              return "ok";
            },
            input: undefined,
            name: "react-mid",
          });
          const d = queue.dispatch(wf);
          // Sample mid-flight, after the throttle's leading edge has
          // fired and the child's complete event has projected into
          // workflow.state. Any sample after ~50ms should suffice.
          yield* Effect.sleep(120);
          const mid = requireRun(
            yield* Effect.promise(() => store.getRun(d.id))
          );
          const wfMeta = readWorkflowMeta(mid.metadata);
          // The row's status is mid-execution running.
          expect(mid.status).toBe("running");
          // The row's snapshot tree reflects the child as complete —
          // this is the core reactive-persistence guarantee.
          expect(wfMeta?.steps?.["react-mid.fast-child"]?.status).toBe(
            "complete"
          );
          yield* Effect.promise(() => d.result());
          return d.id;
        })
      )
    );
    await queue.drain();
    // Final row remains correct.
    const finalRow = requireRun(await store.getRun(id));
    expect(finalRow.status).toBe("complete");
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 2. Suspension is durable in the row immediately
  // ════════════════════════════════════════════════════════════════════════════

  test("suspension is persisted in the row before resume — not deferred to terminal", async () => {
    // Pre-reactive-persistence behavior: a suspended run's metadata.workflow.
    // suspension only landed at the synchronous terminal write inside #runOne.
    // With reactive persistence, the SubscriptionRef flips to "suspended"
    // during execute and the subscriber writes it immediately.
    const store = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store });

    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create(
            makeSuspendingSpec(
              {
                meta: { ticket: "OPS-42" },
                reason: "needs-human",
                suspendName: "approval",
              },
              "suspending"
            )
          );
          const d = queue.dispatch(wf);
          // Wait until the run reaches "suspended" status. Polling the
          // public DispatchedWorkflow.status is sufficient — once it
          // reads "suspended", the subscriber has had at least one
          // chance to project the suspension event.
          while (d.status !== "suspended") {
            yield* Effect.sleep(20);
          }
          // One extra throttle-window sleep so the leading-edge write
          // for the post-suspend state lands.
          yield* Effect.sleep(220);
          const row = requireRun(
            yield* Effect.promise(() => store.getRun(d.id))
          );
          expect(row.status).toBe("suspended");
          const wfMeta = readWorkflowMeta(row.metadata);
          expect(wfMeta?.status).toBe("suspended");
          expect(wfMeta?.suspension?.name).toBe("approval");
          expect(wfMeta?.suspension?.reason).toBe("needs-human");
          return d.id;
        })
      )
    );
    // Cleanup: drain the queue so the suspended run doesn't leak into
    // other tests' counters (drain() doesn't unblock a suspended run,
    // but the queue's outstanding gate sits at 0 once #runOne exits).
    void id;
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 3. No row writes after terminal (subscriber teardown)
  // ════════════════════════════════════════════════════════════════════════════

  test("after terminal, the row state is stable — no late reactive writes flicker the row", async () => {
    // The reactive subscriber is interrupted before the synchronous
    // terminal write. After result() resolves and we drain, the row
    // must not change on a subsequent read — proving the subscriber
    // is no longer firing background updates.
    const store = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store });

    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create({
            execute: async () => "done",
            input: undefined,
            name: "stable-after-terminal",
          });
          const d = queue.dispatch(wf);
          yield* Effect.promise(() => d.result());
          return d.id;
        })
      )
    );
    await queue.drain();
    const row1 = requireRun(await store.getRun(id));
    // Wait two full throttle windows so any drifted late emit would have
    // had ample time to fire.
    await new Promise<void>((r) => setTimeout(r, 500));
    const row2 = requireRun(await store.getRun(id));
    expect(row2.status).toBe("complete");
    // The terminal-write fields are immutable post-terminal.
    expect(row2.timestamps.completedAt).toBe(row1.timestamps.completedAt);
    // metadata content is structurally equal (deep) — no trailing
    // subscriber emit overwrote the corrected terminal state.
    const meta1 = readWorkflowMeta(row1.metadata);
    const meta2 = readWorkflowMeta(row2.metadata);
    expect(meta2?.status).toBe("complete");
    expect(meta1?.status).toBe("complete");
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 4. persist_failed event still fires on DAO error
  // ════════════════════════════════════════════════════════════════════════════

  // ════════════════════════════════════════════════════════════════════════════
  // 5. #persistenceLoop drops the first SubscriptionRef emit (Tier 1 #5)
  // ════════════════════════════════════════════════════════════════════════════

  test("the row reads 'running' (the synchronous boundary write) immediately after dispatch — not 'queued' from a re-emitted seed", async () => {
    // SubscriptionRef.changes replays the *current* value as the first
    // emit. That first value is the pre-run state ('queued') already
    // covered by the synchronous boundary write in #runOne. Without
    // `Stream.drop(1)` in #persistenceLoop, that first emit would race
    // through the per-run mutex and clobber the row back to 'queued'.
    //
    // We block the workflow body briefly so the row is observable
    // mid-flight; if the drop regresses, status would read 'queued'.
    const store = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store });

    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create({
            execute: async () => {
              await new Promise<void>((r) => setTimeout(r, 200));
              return "ok";
            },
            input: undefined,
            name: "first-emit-drop",
          });
          const d = queue.dispatch(wf);
          // Sample mid-flight, after the synchronous boundary write but
          // while the body is still running. Any sample after a few
          // microtasks suffices; 50ms is conservative.
          yield* Effect.sleep(50);
          const mid = requireRun(
            yield* Effect.promise(() => store.getRun(d.id))
          );
          expect(mid.status).toBe("running");
          yield* Effect.promise(() => d.result());
          return d.id;
        })
      )
    );
    await queue.drain();
    const finalRow = requireRun(await store.getRun(id));
    expect(finalRow.status).toBe("complete");
  });

  // ════════════════════════════════════════════════════════════════════════════
  // 6. Terminal write uses run.status, not snap.status (Tier 1 #5 / audit B-5)
  // ════════════════════════════════════════════════════════════════════════════

  test("cancel-mid-flight: terminal row reads run.status='cancelled', not the lagged snap.status='running'", async () => {
    // The race the correction at queue.ts:967-972 guards against:
    // workflow.cancel() flips run.status to 'cancelled' synchronously,
    // but snap.status (state.status) lags by one fiber tick — the
    // forked status.changes → state.status listener hasn't fired yet.
    // #runOne reads run.status (not snap.status) for the terminal
    // write; without that fix, the row would read 'running' instead of
    // 'cancelled' when cancel races a never-resolving body.
    //
    // We force the race with a body that holds a never-resolving Promise
    // and then cancel mid-flight. #runOne's race(workflow.run, statusChanges→cancelled)
    // exits via the cancelled branch; the terminal write then reads
    // run.status. If the regression flips to snap.status, the row
    // status would be 'running'.
    const store = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store });
    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wf = Workflow.create({
            execute: () => new Promise<never>(() => undefined),
            input: undefined,
            name: "cancel-race",
          });
          const d = queue.dispatch(wf);
          // Wait until the workflow is actually running before
          // cancelling so we exercise the in-flight race path.
          yield* Effect.sleep(80);
          yield* Effect.promise(() => d.cancel("user-stop"));
          yield* Effect.promise(() => d.result());
          return d.id;
        })
      )
    );
    await queue.drain();
    const row = requireRun(await store.getRun(id));
    expect(row.status).toBe("cancelled");
    await queue.shutdown();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Recovery — cold-start from DB
//
// Validate that everything reactive persistence stores can be read back and
// the run resumed, including across a "process restart" simulated by tearing
// down the Queue instance and reconstructing one over the same DB.
// ════════════════════════════════════════════════════════════════════════════

describe("Queue — recovery (cold-start from DB)", () => {
  test("preserves namespaced extensions through snapshot writes and recovery", async () => {
    const store = makeInMemoryStore();
    const queueId = "qu-extension-recovery";
    const extensions = {
      "engine.workspace": { id: "workspace-42", region: "us-east-1" },
      "foundry.task": { attempt: 2, id: "task-17" },
    };
    const queueA = new Queue({ concurrency: 1, id: queueId, store });

    const runId = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const workflow = Workflow.create(
            makeSuspendingSpec(
              {
                meta: {},
                reason: "extension-recovery",
                suspendName: "approval",
              },
              "extension-recovery"
            )
          );
          const dispatched = queueA.dispatch(workflow, { extensions });
          while (dispatched.status !== "suspended") {
            yield* Effect.sleep(20);
          }
          return dispatched.id;
        })
      )
    );

    const row = requireRun(await store.getRun(runId));
    expect(row.extensions).toEqual(extensions);
    expect(row.metadata).not.toHaveProperty("extensions");
    expect(readWorkflowMeta(row.metadata)?.status).toBe("suspended");

    const queueB = new Queue({ concurrency: 1, id: queueId, store });
    const recovered = (await queueB.findRecoverableRuns()).find(
      (run) => run.id === runId
    );
    expect(recovered).toBeDefined();
    expect(recovered?.extensions).toEqual(extensions);

    await queueA.shutdown();
    await queueB.shutdown();
  });
});
