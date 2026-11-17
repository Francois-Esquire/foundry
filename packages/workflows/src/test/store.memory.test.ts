import { describe, expect, test } from "vitest";

import type { RunRecord } from "../schema";
import { MemoryWorkflowStore } from "../store/memory";
import { describeWorkflowStore } from "../testing/store";

describeWorkflowStore(
  "MemoryWorkflowStore",
  () => {
    const stores = new Map<string, MemoryWorkflowStore>();
    return (scope) => {
      let store = stores.get(scope);
      if (store === undefined) {
        store = new MemoryWorkflowStore();
        stores.set(scope, store);
      }
      return store;
    };
  },
  { hooked: false }
);

describe("MemoryWorkflowStore.snapshot", () => {
  const run = (id: string, step = "workflow.step"): RunRecord => ({
    error: null,
    extensions: {},
    id,
    input: null,
    metadata: { list: ["x"] },
    output: null,
    queueId: "q",
    snapshot: { cursor: null, input: null, name: "", steps: [] },
    status: "queued",
    step,
    tags: {},
    timestamps: {
      completedAt: null,
      createdAt: 1,
      failedAt: null,
      startedAt: null,
    },
  });

  test("reads the last completed state at once, while a transaction holds uncommitted work", async () => {
    const store = new MemoryWorkflowStore();
    await store.commit({ putRuns: [run("rn-a")] });
    const committed = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const running = store.transaction(async (view) => {
      await view.commit({
        deleteRuns: ["rn-a"],
        putRuns: [run("rn-b")],
      });
      committed.resolve();
      await held.promise;
    });
    await committed.promise;

    expect(store.snapshot()).toStrictEqual({
      frames: [],
      jobs: [],
      queues: [],
      runs: [run("rn-a")],
      suspensions: [],
      version: 1,
    });
    held.resolve();
    await running;
    expect(store.snapshot().runs).toStrictEqual([run("rn-b")]);
  });

  test("returns copies a caller may change", async () => {
    const store = new MemoryWorkflowStore();
    await store.commit({ putRuns: [run("rn-a")] });
    const first = store.snapshot();
    const [read] = first.runs as RunRecord[];
    if (read === undefined) {
      throw new Error("expected a Run");
    }
    (read.metadata.list as string[]).push("changed");
    (first.runs as RunRecord[]).push(run("rn-late"));

    expect(store.snapshot().runs).toStrictEqual([run("rn-a")]);
  });

  test("unshares byte memory in what it returns", async () => {
    const store = new MemoryWorkflowStore();
    const bytes = new Uint8Array(new SharedArrayBuffer(1));
    bytes[0] = 1;
    await store.commit({
      putRuns: [{ ...run("rn-a"), bytes } as unknown as RunRecord],
    });
    bytes[0] = 9;
    const [read] = store.snapshot().runs as unknown as {
      bytes: Uint8Array;
    }[];
    expect(read?.bytes[0]).toBe(1);
    expect(read?.bytes.buffer).not.toBeInstanceOf(SharedArrayBuffer);
    if (read !== undefined) {
      read.bytes[0] = 7;
    }
    expect(
      (store.snapshot().runs[0] as unknown as { bytes: Uint8Array }).bytes[0]
    ).toBe(1);
  });
});
