import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CONTAINER_ROW_STATUSES } from "../container/constants";
import { createMemoryContainerStore } from "../store/memory";
import type { ParsedImport } from "./helpers/boundary-scan";
import { importSites, REPO_ROOT, sourceFiles } from "./helpers/boundary-scan";

/** The store interface and the memory store, which load without a runtime. */
const CONTRACTS_ROOT = join(REPO_ROOT, "packages/sandbox/src/store");

/** The record definitions the contract may name, as types only. */
const RECORDS_SCHEMA = join(REPO_ROOT, "packages/sandbox/src/schema.ts");

/** Anything that would tie the contracts to a host runtime or a provider. */
const RUNTIME_SPECIFIERS = ["ignore", "just-bash", "microsandbox", "zod"];

function isRuntimeImport(
  fromPath: string,
  { specifier, typeOnly }: ParsedImport
): boolean {
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
  if (typeOnly && `${target}.ts` === RECORDS_SCHEMA) {
    return false;
  }
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
      .filter(({ path, import: parsed }) => isRuntimeImport(path, parsed))
      .map(
        ({ relativePath, import: parsed }) =>
          `${relativePath}:${parsed.line} imports ${parsed.specifier}`
      );
    expect(violations).toEqual([]);
  });

  it("keeps the registry and the memory store off the contracts entry", async () => {
    const contracts = await import("../store/index");
    expect(Object.keys(contracts)).toEqual([]);
    const memory = await import("../store/memory");
    expect(Object.keys(memory)).toEqual(["createMemoryContainerStore"]);
  });
});
