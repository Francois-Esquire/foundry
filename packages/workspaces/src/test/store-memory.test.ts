import { describe, expect, it } from "vitest";
import { MemoryWorkspaceStore } from "../store/memory";
import { hostWorkspace, newRoot } from "../testing/records";
import { describeWorkspaceStore } from "../testing/store";

describeWorkspaceStore(
  "memory",
  () => {
    const scopes = new Map<string, MemoryWorkspaceStore>();
    return (scope) => {
      const store = scopes.get(scope) ?? new MemoryWorkspaceStore();
      scopes.set(scope, store);
      return store;
    };
  },
  { hooked: false }
);

describe("MemoryWorkspaceStore transactions", () => {
  it("refuses a commit through a view after its transaction ends", async () => {
    const store = new MemoryWorkspaceStore();
    const workspace = hostWorkspace({ path: newRoot("ended") });
    const view = await store.transaction((inside) => Promise.resolve(inside));

    await expect(view.commit({ workspace })).rejects.toThrow(
      "This transaction has ended"
    );
    expect(await store.getWorkspace(workspace.id)).toBeNull();
  });
});
