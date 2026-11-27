import { describe, expect, it } from "vitest";

describe("@foundry/workspaces store surface", () => {
  it("keeps every store implementation off the main entry", async () => {
    const root = await import("../index");
    const store = await import("../store/index");
    const memory = await import("../store/memory");
    const sqlite = await import("../store/sqlite");
    const tables = await import("../store/tables");
    const testing = await import("../testing/store");

    expect(Object.keys(root)).not.toContain("MemoryWorkspaceStore");
    expect(Object.keys(root)).not.toContain("SqliteWorkspaceStore");
    expect(Object.keys(sqlite)).toEqual(["SqliteWorkspaceStore"]);
    expect(Object.keys(tables).sort()).toEqual([
      "workspaceEntries",
      "workspaces",
    ]);
    expect(Object.keys(store)).toEqual([]);
    expect(Object.keys(memory)).toEqual(["MemoryWorkspaceStore"]);
    expect(Object.keys(testing)).toEqual(["describeWorkspaceStore"]);
  });
});
