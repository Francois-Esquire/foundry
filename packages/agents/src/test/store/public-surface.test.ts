import { describe, expect, it } from "vitest";
import manifest from "../../../package.json" with { type: "json" };

describe("@foundry/agents public paths", () => {
  it("declares every canonical subpath", () => {
    const subpaths = Object.keys(manifest.exports);
    for (const canonical of [
      ".",
      "./node",
      "./harness",
      "./session",
      "./store",
      "./store/memory",
      "./store/sqlite",
      "./store/tables",
      "./authorization",
      "./skills",
      "./mcp",
      "./testing/store",
    ]) {
      expect(subpaths).toContain(canonical);
    }
  });

  it("exports the SQLite store, its write capture, its tables and the event rule, and nothing else, from their paths", async () => {
    expect(Object.keys(await import("../../store/sqlite")).sort()).toEqual([
      "SqliteSessionStore",
      "capturedSessionWrite",
    ]);
    expect(Object.keys(await import("../../store/tables")).sort()).toEqual([
      "agentMessages",
      "agentSessions",
    ]);
    expect(Object.keys(await import("../../store/index"))).toEqual([]);
    expect(Object.keys(await import("../../store/memory"))).toEqual([
      "MemorySessionStore",
    ]);
  }, 30_000);
});
