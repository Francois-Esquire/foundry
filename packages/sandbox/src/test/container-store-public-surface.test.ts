import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CONTAINER_ROW_STATUSES } from "../container/constants";
import { createMemoryContainerStore } from "../container/store";
import { importSites, REPO_ROOT, sourceFiles } from "./helpers/boundary-scan";

const MISSING_CONTAINER_ERROR = /does not exist/;
const DUPLICATE_CONTAINER_ERROR = /already exists/;

const CONTRACTS_ROOT = join(
  REPO_ROOT,
  "packages/sandbox/src/container/store.ts"
);

/** Anything that would tie the contracts to a host runtime or a provider. */
const RUNTIME_SPECIFIERS = ["ignore", "just-bash", "microsandbox", "zod"];

function isRuntimeImport(fromPath: string, specifier: string): boolean {
  if (specifier.startsWith("node:")) {
    return true;
  }
  if (RUNTIME_SPECIFIERS.includes(specifier)) {
    return true;
  }
  if (!specifier.startsWith(".")) {
    return false;
  }
  const target = resolve(dirname(fromPath), specifier);
  return relative(CONTRACTS_ROOT, target).startsWith("..");
}

describe("container store contract", () => {
  it("loads the store contract and the memory store", () => {
    expect(createMemoryContainerStore).toBeTypeOf("function");
    expect(CONTAINER_ROW_STATUSES).toEqual([
      "starting",
      "running",
      "restarting",
      "missing",
      "stopped",
      "failed",
    ]);
  });

  it("stays free of host runtime and provider imports", () => {
    const files = sourceFiles(CONTRACTS_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const violations = importSites(files)
      .filter(({ path, import: parsed }) =>
        isRuntimeImport(path, parsed.specifier)
      )
      .map(
        ({ relativePath, import: parsed }) =>
          `${relativePath}:${parsed.line} imports ${parsed.specifier}`
      );
    expect(violations).toEqual([]);
  });

  it("keeps the registry off the contracts entry", async () => {
    const containers = await import("../container/store");
    expect(containers).not.toHaveProperty("createContainers");
  });

  it("round-trips rows through the memory store", async () => {
    const store = createMemoryContainerStore();
    const row = {
      createdAt: 1,
      id: "c1",
      nativeId: undefined,
      spec: "{}",
      status: "starting" as const,
      updatedAt: 1,
    };
    await store.insert(row);
    await expect(store.insert(row)).rejects.toThrow(DUPLICATE_CONTAINER_ERROR);
    await store.update("c1", { nativeId: "c1-1", status: "running" });
    expect(await store.get("c1")).toEqual({
      ...row,
      nativeId: "c1-1",
      status: "running",
    });
    expect(await store.list()).toHaveLength(1);
    await store.remove("c1");
    expect(await store.get("c1")).toBeUndefined();
    await expect(store.update("c1", { status: "stopped" })).rejects.toThrow(
      MISSING_CONTAINER_ERROR
    );
  });
});
