import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModuleImports, sourceFiles } from "@foundry/lib/testing/seam";
import { describe, expect, it } from "vitest";

describe("@foundry/workspaces dependencies", () => {
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

const IMPORTS_DRIZZLE = /^drizzle-orm/;
const IMPORTS_LIBSQL = /^@libsql\/client(?:\/|$)/;
const IMPORTS_NODE = /^node:/;

describe("@foundry/workspaces runtime boundaries", () => {
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

  it("keeps node:* imports exclusively under node/", () => {
    expect(
      importers(IMPORTS_NODE).filter((path) => !path.startsWith("node/"))
    ).toEqual([]);
  });
});

function importers(pattern: RegExp): string[] {
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return sourceFiles(source, { extensions: [".ts"] })
    .map((path) => relative(source, path))
    .filter((path) => !path.startsWith("test/"))
    .filter((path) =>
      parseModuleImports(join(source, path)).some(({ specifier }) =>
        pattern.test(specifier)
      )
    )
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
