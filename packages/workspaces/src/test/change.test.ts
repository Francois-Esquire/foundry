import { describe, expect, it, vi } from "vitest";
import { MemoryWorkspaceStore } from "../memory-store";
import type { ObservedFacts, WorkspaceChange } from "../types";

import { WorkspaceSystem } from "../workspace-system";

function fixture() {
  const store = new MemoryWorkspaceStore();
  const errors: unknown[] = [];
  let entries: readonly ObservedFacts[] = [
    { name: "empty", path: "empty", type: "directory" },
  ];
  const system = new WorkspaceSystem({
    onError: (error) => {
      errors.push(error);
    },
    store,
  }).extend({
    applies: (registration) => registration.source.kind === "memory",
    identify: ({ memory }: { readonly memory: string }) => ({
      name: memory,
      source: { kind: "memory", path: `memory:${memory}`, sourceId: null },
    }),
    name: "memory",
    ref: "memory",
    wrap: (Base) =>
      class extends Base {
        scan() {
          return Promise.resolve(entries);
        }
      },
  });
  return {
    errors,
    load: () => system.load({ memory: "test" }),
    setEntries: (next: readonly ObservedFacts[]) => {
      entries = next;
    },
    store,
    system,
  };
}

describe("workspace change delivery", () => {
  it("publishes nothing when registration fails", async () => {
    const { system, store, load } = fixture();
    const listener = vi.fn();
    system.on("change", listener);
    vi.spyOn(store, "commit").mockRejectedValue(new Error("refused"));
    await expect(load()).rejects.toThrow("refused");
    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates listener errors and payload mutation from persistence and other listeners", async () => {
    const { system, store, load, errors } = fixture();
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
    const workspace = await load();
    await Promise.resolve();
    expect(events).toEqual(
      (await store.listEntries(workspace.id)).map((entry) => ({
        action: "add",
        entry,
      }))
    );
    expect(events[0]?.entry.updatedAt.getTime()).toBeGreaterThan(0);
    expect(errors.map((error) => (error as Error).message).sort()).toEqual([
      "async listener",
      "sync listener",
    ]);
  });

  it("publishes nothing when the catalog refuses a reconciliation", async () => {
    const { system, load, setEntries } = fixture();
    const workspace = await load();
    const listener = vi.fn();
    system.on("change", listener);
    // An orphan the layer reports unvalidated; the catalog refuses the tree.
    setEntries([{ name: "child", path: "missing/child", type: "directory" }]);
    await expect(workspace.refresh()).rejects.toThrow("Could not reconcile");
    expect(listener).not.toHaveBeenCalled();
    expect(await workspace.entries()).toHaveLength(1);
  });

  it("publishes one commit's changes in order and honors unsubscribe mid-delivery", async () => {
    const { system, load, setEntries } = fixture();
    const workspace = await load();
    const events: WorkspaceChange[] = [];
    const removedListener = vi.fn();
    let stop = (): void => undefined;
    system.on("change", (change) => {
      events.push(change);
      stop();
    });
    stop = system.on("change", removedListener);
    setEntries([
      { name: "empty", path: "empty", type: "socket" },
      { name: "pipe", path: "pipe", type: "pipe" },
    ]);
    await workspace.refresh();
    expect(events.map(({ action, entry }) => [action, entry.type])).toEqual([
      ["change", "socket"],
      ["add", "pipe"],
    ]);
    expect(removedListener).not.toHaveBeenCalled();
  });
});
