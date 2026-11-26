import { dirname, join, relative, resolve } from "node:path";

import {
  type ModuleImport,
  parseModuleImports,
  sourceFiles,
} from "@foundry/lib/testing/seam";
import { describe, expect, it } from "vitest";
import { MemoryContainerStore } from "../store/memory";
import { CONTAINER_ROW_STATUSES } from "../store/schema";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const CONTRACTS_ROOT = join(REPO_ROOT, "packages/sandbox/src/store");

const RECORDS_SCHEMA = join(CONTRACTS_ROOT, "schema.ts");

const DRIZZLE_FILES = ["sqlite.ts", "tables.ts"].map((file) =>
  join(CONTRACTS_ROOT, file)
);

const RUNTIME_SPECIFIERS = ["ignore", "just-bash", "microsandbox", "zod"];

function isRuntimeImport(
  fromPath: string,
  { specifier }: ModuleImport
): boolean {
  if (specifier.startsWith("node:")) {
    return true;
  }
  if (RUNTIME_SPECIFIERS.includes(specifier)) {
    return !(specifier === "zod" && fromPath === RECORDS_SCHEMA);
  }
  if (!specifier.startsWith(".")) {
    return false;
  }
  const target = resolve(dirname(fromPath), specifier);
  if (`${target}.ts` === RECORDS_SCHEMA) {
    return false;
  }
  return relative(CONTRACTS_ROOT, target).startsWith("..");
}

function importSites(files: readonly string[]) {
  return files.flatMap((path) =>
    parseModuleImports(path).map((parsed) => ({
      import: parsed,
      path,
      relativePath: relative(REPO_ROOT, path),
    }))
  );
}

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

  it("stays free of host runtime and provider imports", () => {
    const files = sourceFiles(CONTRACTS_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const violations = importSites(files)
      .filter(({ path, import: parsed }) => isRuntimeImport(path, parsed))
      .map(
        ({ relativePath, import: parsed }) =>
          `${relativePath}:${parsed.line} imports ${parsed.specifier}`
      );
    expect(violations).toEqual([]);
  });

  it("keeps Drizzle to the SQLite store and its tables", () => {
    const violations = importSites(sourceFiles(CONTRACTS_ROOT))
      .filter(
        ({ path, import: parsed }) =>
          parsed.specifier.startsWith("drizzle-orm") &&
          !DRIZZLE_FILES.includes(path)
      )
      .map(({ relativePath }) => relativePath);
    expect(violations).toEqual([]);
    expect(
      importSites(sourceFiles(CONTRACTS_ROOT)).filter(({ import: parsed }) =>
        parsed.specifier.startsWith("@libsql/")
      )
    ).toEqual([]);
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
