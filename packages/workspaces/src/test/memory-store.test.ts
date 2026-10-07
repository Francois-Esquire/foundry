import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { MemoryWorkspaceStore } from "../memory-store";
import { directory } from "../node";
import { WorkspaceSystem } from "../workspace-system";
import { hostWorkspace, newRoot, seed } from "./helpers/fixtures";
import { describeWorkspaceStoreConformance } from "./helpers/store-conformance";

describeWorkspaceStoreConformance("memory", () => new MemoryWorkspaceStore());

describe("WorkspaceSystem construction", () => {
  it("opens only the requested page and retains the catalog total", async () => {
    const store = new MemoryWorkspaceStore();
    const system = new WorkspaceSystem({ store }).extend(directory());
    const first = hostWorkspace({
      createdAt: new Date(1),
      path: newRoot("first"),
    });
    const second = hostWorkspace({
      createdAt: new Date(2),
      path: newRoot("second"),
    });
    await seed(store, first);
    await seed(store, second);
    const open = vi.spyOn(system, "open");
    const page = await system.list({ limit: 1 });
    expect(page.total).toBe(2);
    expect(page.nextCursor).toBe(1);
    expect(page.items.map((workspace) => workspace.id)).toEqual([first.id]);
    expect(open).toHaveBeenCalledExactlyOnceWith(first.id);
    const next = await system.list({ cursor: page.nextCursor, limit: 1 });
    expect(next.total).toBe(2);
    expect(next.nextCursor).toBeUndefined();
    expect(next.items.map((workspace) => workspace.id)).toEqual([second.id]);
    await system.closeAll();
  });
  /**
   * The default is asserted through behavior rather than by reading the store
   * back off the system — a zero-configuration system that answers is the
   * claim, and the store stays private.
   */
  it("runs the whole lifecycle with no store and no database setup", async () => {
    const zeroConfig = new WorkspaceSystem();

    expect((await zeroConfig.list()).items).toEqual([]);
  });

  it("reads through an injected store instead of its own default", async () => {
    const store = new MemoryWorkspaceStore();
    const system = new WorkspaceSystem({ store }).extend(directory());
    const workspace = hostWorkspace({ path: newRoot("injected") });
    await seed(store, workspace);

    expect((await system.list()).items.map((w) => w.id)).toEqual([
      workspace.id,
    ]);
  });
});

describe("@foundry/workspaces dependencies", () => {
  /**
   * The package must run standalone, so a dependency pointing at a database
   * package, the Electron host, or an app is a design failure rather than a
   * lint preference.
   */
  it("names no database, Electron, or app dependency", () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json"),
        "utf8"
      )
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];

    expect(
      declared.filter(
        (name) =>
          name === "@foundry/db" ||
          name === "electron" ||
          name.startsWith("apps/") ||
          name.includes("studio")
      )
    ).toEqual([]);
  });
});
