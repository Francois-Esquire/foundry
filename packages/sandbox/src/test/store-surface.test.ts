import { describe, expect, it } from "vitest";
import { MemoryContainerStore } from "../store/memory";
import { CONTAINER_ROW_STATUSES } from "../store/schema";

describe("container store contract", () => {
  it("loads the store contract and the memory store", () => {
    expect(MemoryContainerStore).toBeTypeOf("function");
    expect(CONTAINER_ROW_STATUSES).toEqual([
      "starting",
      "running",
      "restarting",
      "missing",
      "stopped",
      "failed",
      "removing",
    ]);
  });

  it("keeps Containers and the memory store off the contracts entry", async () => {
    const contracts = await import("../store/index");
    expect(Object.keys(contracts)).toEqual([]);
    const memory = await import("../store/memory");
    expect(Object.keys(memory)).toEqual(["MemoryContainerStore"]);
    const sqlite = await import("../store/sqlite");
    expect(Object.keys(sqlite)).toEqual(["SqliteContainerStore"]);
    const tables = await import("../store/tables");
    expect(Object.keys(tables)).toEqual(["sandboxContainers"]);
  });
});
