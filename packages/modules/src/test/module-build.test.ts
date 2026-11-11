import { describe, expect, it } from "vitest";

import {
  auditModuleBuildWorkspace,
  isDerivedBuildPath,
  isModuleBuildOutputPath,
  type ModuleBuildWorkspace,
} from "../build";

const ROOT = "/workspace";

function workspace(
  text: string,
  extra?: { readonly path: string; readonly type: string }
): ModuleBuildWorkspace {
  return {
    list: () =>
      Promise.resolve([
        { path: `${ROOT}/app.ts`, type: "file" },
        ...(extra ? [extra] : []),
      ]),
    readFile: () => Promise.resolve(new TextEncoder().encode(text)),
  };
}

const audit = (
  files: ModuleBuildWorkspace,
  signal = new AbortController().signal
) => auditModuleBuildWorkspace(files, { "app.ts": "saved" }, signal, ROOT);

describe("Module build workspace audit", () => {
  it("accepts derived output trees and a newly resolved lockfile", async () => {
    for (const path of [
      "node_modules",
      "packages/app/generated",
      "packages/app/dist",
      "packages/server/.turbo",
      "bun.lock",
    ]) {
      await expect(
        audit(workspace("saved", { path: `${ROOT}/${path}`, type: "file" }))
      ).resolves.toBeUndefined();
    }
  });

  it("rejects changed saved bytes and undeclared authored output", async () => {
    await expect(audit(workspace("changed"))).rejects.toThrow(
      "changed saved source"
    );
    await expect(
      audit(workspace("saved", { path: `${ROOT}/added.ts`, type: "file" }))
    ).rejects.toThrow("undeclared source");
  });

  it("rejects source symlinks and stops auditing after cancellation", async () => {
    await expect(
      audit(workspace("saved", { path: `${ROOT}/linked`, type: "symlink" }))
    ).rejects.toThrow("undeclared source");
    await expect(
      audit(workspace("saved"), AbortSignal.abort())
    ).rejects.toThrow();
  });
});

describe("Module build paths", () => {
  it("derives dependencies, caches and package outputs, not authored files", () => {
    expect(isDerivedBuildPath("node_modules/x/index.js")).toBe(true);
    expect(isDerivedBuildPath("packages/app/dist/index.js")).toBe(true);
    expect(isDerivedBuildPath("packages/app/generated")).toBe(true);
    expect(isDerivedBuildPath("packages/app/src/index.ts")).toBe(false);
    // Narrower than capture: credentials are authored-looking, not derived.
    expect(isDerivedBuildPath(".env")).toBe(false);
  });

  it("publishes only portable files under a package's dist", () => {
    expect(isModuleBuildOutputPath("packages/app/dist/index.js")).toBe(true);
    expect(isModuleBuildOutputPath("packages/app/dist")).toBe(false);
    expect(isModuleBuildOutputPath("packages/app/src/index.ts")).toBe(false);
    expect(isModuleBuildOutputPath("packages/app/dist/../../x")).toBe(false);
  });
});
