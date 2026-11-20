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
  if (rawMeta === null || rawMeta === undefined) {
    return null;
  }
  const parsed =
    typeof rawMeta === "string"
      ? (JSON.parse(rawMeta) as Record<string, unknown>)
      : (rawMeta as Record<string, unknown>);
  const wf = parsed.workflow as PersistedWorkflow | undefined;
  return wf ?? null;
}

describe("Queue — reactive persistence", () => {
  test("mid-execution row shows a child step as complete before the parent terminates", async () => {
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
          yield* Effect.sleep(120);
          const mid = requireRun(
            yield* Effect.promise(() => store.getRun(d.id))
          );
          const wfMeta = readWorkflowMeta(mid.metadata);
          expect(mid.status).toBe("running");
          expect(wfMeta?.steps?.["react-mid.fast-child"]?.status).toBe(
            "complete"
          );
          yield* Effect.promise(() => d.result());
          return d.id;
        })
      )
    );
    await queue.drain();
    const finalRow = requireRun(await store.getRun(id));
    expect(finalRow.status).toBe("complete");
  });

  test("suspension is persisted in the row before resume — not deferred to terminal", async () => {
    const store = makeInMemoryStore();
    const queue = new Queue({ concurrency: 1, store });

    await Effect.runPromise(
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
          while (d.status !== "suspended") {
            yield* Effect.sleep(20);
          }
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
  });

  test("after terminal, the row state is stable — no late reactive writes flicker the row", async () => {
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
    await new Promise<void>((r) => setTimeout(r, 500));
    const row2 = requireRun(await store.getRun(id));
    expect(row2.status).toBe("complete");
    expect(row2.timestamps.completedAt).toBe(row1.timestamps.completedAt);
    const meta1 = readWorkflowMeta(row1.metadata);
    const meta2 = readWorkflowMeta(row2.metadata);
    expect(meta2?.status).toBe("complete");
    expect(meta1?.status).toBe("complete");
  });

  test("the row reads 'running' (the synchronous boundary write) immediately after dispatch — not 'queued' from a re-emitted seed", async () => {
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

  test("cancel-mid-flight: terminal row reads run.status='cancelled', not the lagged snap.status='running'", async () => {
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
