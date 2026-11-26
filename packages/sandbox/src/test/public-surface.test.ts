import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertNotAborted,
  CONTAINER_ENVIRONMENT_ID_LABEL,
  CONTAINER_MANAGED_BY_LABEL,
  CONTAINER_MANAGED_BY_VALUE,
  CONTAINER_PORTABLE_ID_PATTERN,
  CONTAINER_SANDBOX_BASE_LABEL,
  CONTAINER_SANDBOX_CONSTRAINTS_FORMAT,
  containerSandboxConfigFromConstraints,
  DEFAULT_CONTAINER_CPUS,
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_CONTAINER_MEMORY_MIB,
  DEFAULT_CONTAINER_WORKDIR,
  INVENTORY_PAGE_LIMIT,
  MAX_INVENTORY_PAGES,
  normalizeSandboxPath,
  SandboxError,
  sandboxFromAdapter,
} from "@foundry/sandbox";
import {
  createContainers,
  ProcessController,
  prepareSandboxProcess,
} from "@foundry/sandbox/node";
import { createMicrosandboxRuntime } from "@foundry/sandbox/node/microsandbox";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import {
  bashDefinition,
  COUNT_WORDS,
  cdDefinition,
  createSandboxToolkit,
  createSandboxToolSchemas,
  DEFAULT_LIMITS,
  DEFAULT_READ_LIMIT,
  editDefinition,
  globDefinition,
  grepDefinition,
  guardExecute,
  guardState,
  MAX_EDIT_RESULT_CHARS,
  readDefinition,
  SandboxRateLimitError,
  sandboxInstructions,
  sandboxToolDefinitions,
  TOOL_LINES,
  writeDefinition,
} from "@foundry/sandbox/tools";
import { createVirtualSandbox } from "@foundry/sandbox/virtual";
import { expect, it } from "vitest";
import packageJson from "../../package.json";

it("loads portable, tool, virtual, and node functions through canonical exports", () => {
  for (const entry of [
    normalizeSandboxPath,
    MemoryContainerStore,
    SandboxError,
    sandboxFromAdapter,
    createSandboxToolkit,
    createVirtualSandbox,
    createContainers,
    prepareSandboxProcess,
    ProcessController,
    createMicrosandboxRuntime,
    assertNotAborted,
    containerSandboxConfigFromConstraints,
    createSandboxToolSchemas,
    sandboxInstructions,
    guardExecute,
    guardState,
    SandboxRateLimitError,
  ]) {
    expect(entry).toBeTypeOf("function");
  }
});

it("exposes container defaults and toolkit building blocks", () => {
  for (const value of [
    CONTAINER_PORTABLE_ID_PATTERN,
    DEFAULT_CONTAINER_CPUS,
    DEFAULT_CONTAINER_IMAGE,
    DEFAULT_CONTAINER_MEMORY_MIB,
    DEFAULT_CONTAINER_WORKDIR,
    INVENTORY_PAGE_LIMIT,
    MAX_INVENTORY_PAGES,
    DEFAULT_LIMITS,
    DEFAULT_READ_LIMIT,
    MAX_EDIT_RESULT_CHARS,
    COUNT_WORDS,
    TOOL_LINES,
    bashDefinition,
    cdDefinition,
    editDefinition,
    globDefinition,
    grepDefinition,
    readDefinition,
    writeDefinition,
    sandboxToolDefinitions,
  ]) {
    expect(value).toBeDefined();
  }
});

it("exposes sandbox ownership labels and the persisted spec format", () => {
  expect(CONTAINER_SANDBOX_BASE_LABEL).toBe("com.foundry.sandbox");
  expect(CONTAINER_MANAGED_BY_LABEL).toBe("com.foundry.environment.managed-by");
  expect(CONTAINER_MANAGED_BY_VALUE).toBe("foundry-sandbox");
  expect(CONTAINER_ENVIRONMENT_ID_LABEL).toBe("com.foundry.environment.id");
  expect(CONTAINER_SANDBOX_CONSTRAINTS_FORMAT).toBe(
    "foundry.sandbox.container/1"
  );
});

it("resolves source and built declarations for every explicit public export without wildcards", () => {
  const entries = Object.entries(packageJson.exports);
  expect(
    entries.map(([key]) => key).filter((key) => key.includes("*"))
  ).toEqual([]);
  expect(Object.hasOwn(packageJson.exports, ".")).toBe(true);
  for (const [, target] of entries) {
    for (const filePath of Object.values(target)) {
      expect(
        existsSync(resolve(import.meta.dirname, "../..", filePath)),
        `${filePath} should exist`
      ).toBe(true);
    }
  }
});
