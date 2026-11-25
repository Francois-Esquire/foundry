import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONTAINER_ENVIRONMENT_ID_LABEL,
  CONTAINER_MANAGED_BY_LABEL,
  CONTAINER_MANAGED_BY_VALUE,
  CONTAINER_OWNER_ID_LABEL,
  CONTAINER_OWNER_KIND_LABEL,
  CONTAINER_RUNTIME_SCOPE_LABEL,
  CONTAINER_SANDBOX_BASE_LABEL,
  CONTAINER_SANDBOX_CONSTRAINTS_FORMAT,
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
import { createSandboxToolkit } from "@foundry/sandbox/tools";
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
  ]) {
    expect(entry).toBeTypeOf("function");
  }
});

it("exposes sandbox ownership labels and the persisted spec format", () => {
  expect(CONTAINER_SANDBOX_BASE_LABEL).toBe("com.foundry.sandbox");
  expect(CONTAINER_MANAGED_BY_LABEL).toBe("com.foundry.environment.managed-by");
  expect(CONTAINER_MANAGED_BY_VALUE).toBe("foundry-sandbox");
  expect(CONTAINER_RUNTIME_SCOPE_LABEL).toBe(
    "com.foundry.environment.scope-id"
  );
  expect(CONTAINER_ENVIRONMENT_ID_LABEL).toBe("com.foundry.environment.id");
  expect(CONTAINER_OWNER_KIND_LABEL).toBe("com.foundry.environment.owner-kind");
  expect(CONTAINER_OWNER_ID_LABEL).toBe("com.foundry.environment.owner-id");
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
