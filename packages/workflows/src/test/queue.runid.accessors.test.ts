/**
 * Queue — runId-keyed accessors with DB fallthrough, and the
 * DispatchedWorkflow getters they wrap.
 *
 * The JS-first surface: callers hold only a runId and read state without
 * needing to keep the DispatchedWorkflow handle. Live runs read sync
 * from the in-memory snapshot; persisted runs read from the row's
 * metadata. No factory required — these are read-only.
 *
 * Each accessor has two code paths:
 *   - In-memory hit: `#all.get(runId)` returns the live handle, accessor
 *     reads off its sync getter.
 *   - DB fallthrough: row read + metadata parse, derive the requested
 *     concern from the persisted blob.
 *
 * The DispatchedWorkflow getters (`d.output`, `d.error`, `d.snapshot`,
 * `d.results`) are the underlying public surface for the in-memory path
 * — `queue.snapshot(runId)`, `queue.error(runId)`, etc. wrap them and
 * add DB fallthrough. `d.output` is unique to the handle (there is no
 * `queue.output(runId)` accessor).
 */

import { describe, expect, test } from "vitest";

import { Queue } from "../queue";
import { bail } from "../types";
import { Workflow } from "../workflow";
import { makeEchoSpec, makeSuspendingSpec } from "./fixtures/steps";
import { withQueue } from "./helpers/queue";
import { makeInMemoryStore } from "./helpers/store";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════════
// queue.status(runId)
// ════════════════════════════════════════════════════════════════════════════

describe("queue.status(runId)", () => {
  test("in-memory hit returns the live status", async () => {
    const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
    const wf = Workflow.create(makeEchoSpec("ok", "status-mem"));
    const d = queue.dispatch(wf);
    await d.result();
    expect(await queue.status(d.id)).toBe("complete");
  });

  test("store fallthrough on a fresh queue (live handle gone) reads the persisted status", async () => {
    const store = makeInMemoryStore();
    const queueA = new Queue({ concurrency: 1, store });
    const wf = Workflow.create(makeEchoSpec("ok", "status-db"));
    const d = queueA.dispatch(wf);
    await d.result();
    await queueA.drain();
    await queueA.shutdown();

    const queueB = new Queue({ concurrency: 1, store });
    expect(await queueB.status(d.id)).toBe("complete");
    await queueB.shutdown();
  });

  test("returns null for a missing runId", async () => {
    await withQueue(
      { concurrency: 1, store: makeInMemoryStore() },
      async (queue) => {
        expect(await queue.status("rn-nonexistent")).toBeNull();
      }
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// queue.snapshot(runId) / DispatchedWorkflow.snapshot
// ════════════════════════════════════════════════════════════════════════════

describe("queue.snapshot(runId)", () => {
  test("in-memory hit returns the live WorkflowState; DispatchedWorkflow.snapshot agrees", async () => {
    // The `DispatchedWorkflow.snapshot` getter is a latest-in-memory
    // projection; `queue.snapshot(runId)` is the same view through the
    // runId-keyed door. After a terminal run, both agree.
    const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
    const wf = Workflow.create(makeEchoSpec("payload", "snap-mem"));
    const d = queue.dispatch(wf);
    await d.result();
    const snap = await queue.snapshot(d.id);
    expect(snap?.status).toBe("complete");
    expect(snap?.input).toBe("payload");
    // DispatchedWorkflow.snapshot — same in-memory projection.
    expect(d.snapshot.status).toBe("complete");
    expect(d.snapshot.input).toBe("payload");
    expect(snap?.status).toBe(d.snapshot.status);
  });

  test("store fallthrough returns parsed metadata.workflow with persisted status", async () => {
    const store = makeInMemoryStore();
    const queueA = new Queue({ concurrency: 1, store });
    const wf = Workflow.create(makeEchoSpec("data", "snap-db"));
    const d = queueA.dispatch(wf);
    await d.result();
    await queueA.drain();
    await queueA.shutdown();

    const queueB = new Queue({ concurrency: 1, store });
    const snap = await queueB.snapshot(d.id);
    expect(snap?.status).toBe("complete");
    expect(snap?.input).toBe("data");
    // Snapshot tree is reachable from the persisted blob.
    expect(snap?.steps["snap-db"]?.status).toBe("complete");
    await queueB.shutdown();
  });

  test("returns null for a missing runId", async () => {
    const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
    expect(await queue.snapshot("rn-nonexistent")).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// queue.results(runId) / DispatchedWorkflow.results
// ════════════════════════════════════════════════════════════════════════════

describe("queue.results(runId)", () => {
  test("in-memory hit returns the path-keyed results map; DispatchedWorkflow.results agrees", async () => {
    const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
    const wf = Workflow.create({
      children: [
        { execute: async () => "A", input: undefined, name: "a" },
        { execute: async () => "B", input: undefined, name: "b" },
      ],
      execute: async (_input, ctx) => {
        await ctx.children[0]?.run();
        await ctx.children[1]?.run();
        return "ok";
      },
      input: undefined,
      name: "results-mem",
    });
    const d = queue.dispatch(wf);
    await d.result();
    const results = await queue.results(d.id);
    expect(results?.["results-mem.a"]).toBe("A");
    expect(results?.["results-mem.b"]).toBe("B");
    // Same path-keyed map via the dispatched-handle getter.
    expect(d.results["results-mem.a"]).toBe("A");
    expect(d.results["results-mem.b"]).toBe("B");
  });

  test("store fallthrough derives results from persisted metadata.workflow.steps", async () => {
    const store = makeInMemoryStore();
    const queueA = new Queue({ concurrency: 1, store });
    const wf = Workflow.create({
      children: [
        { execute: async () => "leafy", input: undefined, name: "leaf" },
      ],
      execute: async (_input, ctx) => {
        await ctx.children[0]?.run();
        return "ok";
      },
      input: undefined,
      name: "results-db",
    });
    const d = queueA.dispatch(wf);
    await d.result();
    await queueA.drain();
    await queueA.shutdown();

    const queueB = new Queue({ concurrency: 1, store });
    const results = await queueB.results(d.id);
    expect(results?.["results-db.leaf"]).toBe("leafy");
    await queueB.shutdown();
  });

  test("returns {} for a not-yet-started run (live in-memory)", async () => {
    // While the queue is paused, the run hasn't started — both the
    // queue accessor and DispatchedWorkflow.results return an empty map.
    const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
    await queue.pause();
    const wf = Workflow.create(makeEchoSpec("ok", "results-empty"));
    const d = queue.dispatch(wf);
    expect(d.results).toEqual({});
    expect(await queue.results(d.id)).toEqual({});
    await queue.resume();
    await d.result();
  });

  test("returns null for a missing runId", async () => {
    const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
    expect(await queue.results("rn-nonexistent")).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// queue.error(runId) / DispatchedWorkflow.error
// ════════════════════════════════════════════════════════════════════════════

describe("queue.error(runId)", () => {
  test("in-memory hit returns null for a successful run", async () => {
    const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
    const wf = Workflow.create(makeEchoSpec("ok", "err-success"));
    const d = queue.dispatch(wf);
    await d.result();
    expect(await queue.error(d.id)).toBeNull();
    expect(d.error).toBeNull();
  });

  test("in-memory hit returns ErrorShape { name, message, stack? } for a failed run", async () => {
    const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
    const wf = Workflow.create({
      execute: async () => {
        throw new TypeError("kaput");
      },
      input: undefined,
      name: "err-fail",
    });
    const d = queue.dispatch(wf);
    await d.result();
    const err = await queue.error(d.id);
    expect(err?.name).toBe("TypeError");
    expect(err?.message).toBe("kaput");
    expect(typeof err?.stack).toBe("string");
    // DispatchedWorkflow.error returns the same shape.
    expect(d.error?.name).toBe("TypeError");
    expect(d.error?.message).toBe("kaput");
  });

  test("populated for bailed workflows with the bail-decorated message", async () => {
    // Bail surfaces as a failed run with the policy/code preserved in
    // the error message.
    const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
    const wf = Workflow.create({
      execute: async () => bail({ code: 403, kind: "policy" }),
      input: undefined,
      name: "err-bail",
    });
    const d = queue.dispatch(wf);
    await d.result();
    const err = await queue.error(d.id);
    expect(err).not.toBeNull();
    expect(err?.message).toContain("err-bail");
    expect(err?.message).toContain("bailed");
    expect(err?.message).toContain("policy");
    expect(d.error?.message).toContain("policy");
  });

  test("null for suspended runs (suspension is not a failure)", async () => {
    const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
    const wf = Workflow.create(
      makeSuspendingSpec(
        { reason: "human", suspendName: "approve" },
        "err-susp"
      )
    );
    const d = queue.dispatch(wf);
    while (d.status !== "suspended") {
      await sleep(10);
    }
    expect(d.error).toBeNull();
    expect(await queue.error(d.id)).toBeNull();
  });

  test("store fallthrough reads metadata.workflow.error after process restart", async () => {
    const store = makeInMemoryStore();
    const queueA = new Queue({ concurrency: 1, store });
    const wf = Workflow.create({
      execute: async () => {
        throw new RangeError("out-of-range");
      },
      input: undefined,
      name: "err-db",
    });
    const d = queueA.dispatch(wf);
    await d.result();
    await queueA.drain();
    await queueA.shutdown();

    const queueB = new Queue({ concurrency: 1, store });
    const err = await queueB.error(d.id);
    expect(err?.name).toBe("RangeError");
    expect(err?.message).toBe("out-of-range");
    await queueB.shutdown();
  });

  test("returns null for a missing runId", async () => {
    const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
    expect(await queue.error("rn-nonexistent")).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DispatchedWorkflow.output — unique to the handle (no queue.output(runId))
// ════════════════════════════════════════════════════════════════════════════

describe("DispatchedWorkflow — output", () => {
  test("undefined before terminal, equals the workflow result after complete", async () => {
    const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
    await queue.pause();
    const wf = Workflow.create(makeEchoSpec(42, "out-num"));
    const d = queue.dispatch(wf);
    // Before the run starts, output is undefined.
    expect(d.output).toBeUndefined();
    await queue.resume();
    await d.result();
    expect(d.output).toBe(42);
  });

  test("undefined for failed runs (output is only populated on complete)", async () => {
    const queue = new Queue({ concurrency: 1, store: makeInMemoryStore() });
    const wf = Workflow.create({
      execute: async () => {
        throw new Error("boom");
      },
      input: undefined,
      name: "out-failed",
    });
    const d = queue.dispatch(wf);
    await d.result();
    expect(d.output).toBeUndefined();
  });
});
