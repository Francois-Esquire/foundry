import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { directory } from "../node";
import { MemoryWorkspaceStore } from "../store/memory";
import { hostWorkspace, newRoot, seed } from "../testing/records";
import { describeWorkspaceStore } from "../testing/store";
import { WorkspaceSystem } from "../workspace-system";

describeWorkspaceStore(
  "memory",
  () => {
    // One memory store per scope stands in for one storage holding many scopes.
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
   * The package must run standalone, so a dependency pointing at another
   * Foundry package (a database package, say), the Electron host, or an app
   * is a design failure rather than a lint preference. Drizzle is an optional
   * peer, needed only on the SQLite paths.
   */
  it("names no other Foundry package, Electron, or app dependency", () => {
    const manifest = readManifest();
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];

    expect(
      declared.filter(
        (name) =>
          name === "electron" ||
          name.startsWith("apps/") ||
          (name.startsWith("@foundry/") &&
            !["@foundry/core", "@foundry/lib", "@foundry/tsconfig"].includes(
              name
            )) ||
          name.startsWith("@foundry.sh/")
      )
    ).toEqual([]);
  });
});

describe("@foundry/workspaces store paths", () => {
  it("maps the store, both stores, the tables, and the suite to their files", () => {
    const { exports } = readManifest();
    expect(exports?.["./store"]?.import).toBe("./src/store/index.ts");
    expect(exports?.["./store/memory"]?.import).toBe("./src/store/memory.ts");
    expect(exports?.["./store/sqlite"]?.import).toBe("./src/store/sqlite.ts");
    expect(exports?.["./store/tables"]?.import).toBe("./src/store/tables.ts");
    expect(exports?.["./testing/store"]?.import).toBe("./src/testing/store.ts");
  });

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

const IMPORTS_DRIZZLE = /from "drizzle-orm/;
const IMPORTS_LIBSQL = /from "@libsql\/client"/;

describe("@foundry/workspaces SQLite dependencies", () => {
  it("keeps Drizzle an optional peer, used only on the SQLite paths", () => {
    expect(manifestPeerIsOptional("drizzle-orm")).toBe(true);
    expect(importers(IMPORTS_DRIZZLE)).toEqual([
      "store/sqlite.ts",
      "store/tables.ts",
    ]);
  });

  it("never opens a connection outside its tests", () => {
    expect(importers(IMPORTS_LIBSQL)).toEqual([]);
  });
});

/** Every non-test source file under `src/` whose text matches `pattern`. */
function importers(pattern: RegExp): string[] {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return readdirSync(source, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => relative(source, join(entry.parentPath, entry.name)))
    .filter((path) => !path.startsWith("test/"))
    .filter((path) => pattern.test(readFileSync(join(source, path), "utf8")))
    .sort();
}

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: Record<string, { import?: string }>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function manifestPeerIsOptional(name: string): boolean {
  const manifest = readManifest();
  return (
    manifest.peerDependencies?.[name] !== undefined &&
    manifest.peerDependenciesMeta?.[name]?.optional === true
  );
}

function readManifest(): Manifest {
  return JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json"),
      "utf8"
    )
  ) as Manifest;
}
