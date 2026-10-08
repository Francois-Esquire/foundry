import type { SandboxDirectoryEntry } from "@foundry/sandbox/types";
import { expect, it } from "vitest";
import { auditBuildWorkspace } from "~/main/modules/builds/workspace";

function filesystem(text: string, extra?: SandboxDirectoryEntry) {
  return {
    async list() {
      return [
        { path: "/workspace/app.ts", type: "file" as const },
        ...(extra ? [extra] : []),
      ];
    },
    async readFile() {
      return new TextEncoder().encode(text);
    },
  };
}
it("accepts derived output trees and a newly resolved lockfile", async () => {
  for (const path of [
    "node_modules",
    "packages/app/generated",
    "packages/app/dist",
    "packages/server/.turbo",
    "bun.lock",
  ]) {
    await expect(
      auditBuildWorkspace(
        filesystem("saved", { path: `/workspace/${path}`, type: "file" }),
        { "app.ts": "saved" },
        new AbortController().signal
      )
    ).resolves.toBeUndefined();
  }
});
it("rejects changed saved bytes and undeclared authored output", async () => {
  await expect(
    auditBuildWorkspace(
      filesystem("changed"),
      { "app.ts": "saved" },
      new AbortController().signal
    )
  ).rejects.toThrow("changed saved source");
  await expect(
    auditBuildWorkspace(
      filesystem("saved", { path: "/workspace/added.ts", type: "file" }),
      { "app.ts": "saved" },
      new AbortController().signal
    )
  ).rejects.toThrow("undeclared source");
});
it("rejects source symlinks and stops auditing after cancellation", async () => {
  await expect(
    auditBuildWorkspace(
      filesystem("saved", { path: "/workspace/linked", type: "symlink" }),
      { "app.ts": "saved" },
      new AbortController().signal
    )
  ).rejects.toThrow("undeclared source");
  await expect(
    auditBuildWorkspace(
      filesystem("saved"),
      { "app.ts": "saved" },
      AbortSignal.abort()
    )
  ).rejects.toThrow();
});
