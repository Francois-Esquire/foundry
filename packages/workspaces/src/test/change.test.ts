import { describe, expect, it, vi } from "vitest";
import { InMemoryWorkspaceStore } from "../in-memory-workspace-store";
import type { ObservedFacts, WorkspaceChange } from "../types";

import { WorkspaceSystem } from "../workspace-system";

function fixture() {
  const store = new InMemoryWorkspaceStore();
  let entries: readonly ObservedFacts[] = [
    { name: "empty", path: "empty", type: "directory" },
  ];
  const system = new WorkspaceSystem({ store }).extend({
    applies: () => true,
    name: "memory",
    wrap: (Base) =>
      class extends Base {
        scan() {
          return Promise.resolve(entries);
        }
      },
  });
  const identity = {
    name: "test",
    path: "memory:test",
    source: "memory",
    sourceId: null,
  };
  return {
    identity,
    setEntries: (next: readonly ObservedFacts[]) => {
      entries = next;
    },
    store,
    system,
  };
}

describe("workspace change delivery", () => {
  it("publishes nothing when registration fails", async () => {
    const { system, store, identity } = fixture();
    const listener = vi.fn();
    system.on("change", listener);
    vi.spyOn(store, "commitCreate").mockRejectedValue(new Error("refused"));
    await expect(system.create(identity)).rejects.toThrow("refused");
    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates listener errors and payload mutation from persistence and other listeners", async () => {
    const { system, store, identity } = fixture();
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      system.on("change", () => {
        throw new Error("sync listener");
      });
      system.on("change", () => Promise.reject(new Error("async listener")));
      system.on("change", ({ entry }) => {
        entry.updatedAt.setTime(0);
      });
      const events: WorkspaceChange[] = [];
      system.on("change", (change) => {
        events.push(change);
      });
      const workspace = await system.create(identity);
      expect(events).toEqual(
        (await store.listEntries(workspace.id)).map((entry) => ({
          action: "add",
          entry,
        }))
      );
      expect(events[0]?.entry.updatedAt.getTime()).toBeGreaterThan(0);
      expect(errors).toHaveBeenCalledTimes(2);
    } finally {
      errors.mockRestore();
    }
  });

  it("publishes nothing when reconciliation is refused", async () => {
    const { system, store, identity, setEntries } = fixture();
    const workspace = await system.create(identity);
    const listener = vi.fn();
    system.on("change", listener);
    vi.spyOn(store, "commitReconcile").mockResolvedValue({
      kind: "conflict",
      reason: "refused",
    });
    setEntries([]);
    await expect(workspace.refresh()).rejects.toThrow("Could not reconcile");
    expect(listener).not.toHaveBeenCalled();
    expect(await workspace.entries()).toHaveLength(1);
  });

  it("snapshots queued events and honors unsubscribe before commit", async () => {
    const { system, store, identity, setEntries } = fixture();
    const callbacks: (() => void)[] = [];
    vi.spyOn(store, "afterCommit").mockImplementation((callback) => {
      callbacks.push(callback);
    });
    const events: WorkspaceChange[] = [];
    system.on("change", (change) => {
      events.push(change);
    });
    const removedListener = vi.fn();
    const stop = system.on("change", removedListener);
    const workspace = await system.create(identity);
    setEntries([{ name: "empty", path: "empty", type: "socket" }]);
    await workspace.refresh();
    expect(events).toEqual([]);
    stop();
    for (const callback of callbacks) {
      callback();
    }
    expect(events.map(({ action, entry }) => [action, entry.type])).toEqual([
      ["add", "directory"],
      ["change", "socket"],
    ]);
    expect(removedListener).not.toHaveBeenCalled();
  });
});
