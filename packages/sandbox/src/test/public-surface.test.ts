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
} from "@foundry/sandbox/container/constants";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMicrosandboxRuntime } from "@foundry/sandbox/container/microsandbox-runtime";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { SandboxError } from "@foundry/sandbox/errors";
import { normalizeSandboxPath } from "@foundry/sandbox/path";
import { sandboxFromAdapter } from "@foundry/sandbox/sandbox";
import { expect, it } from "vitest";
import packageJson from "../../package.json";

it("loads portable and container functions through leaf exports", () => {
  for (const entry of [
    normalizeSandboxPath,
    createMemoryContainerStore,
    SandboxError,
    sandboxFromAdapter,
    createContainers,
    createMicrosandboxRuntime,
  ]) {
    expect(entry).toBeTypeOf("function");
  }
});

it("preserves persisted container labels and the spec format", () => {
  expect(CONTAINER_SANDBOX_BASE_LABEL).toBe("com.foundry.sandbox");
  expect(CONTAINER_MANAGED_BY_LABEL).toBe("com.foundry.environment.managed-by");
  expect(CONTAINER_MANAGED_BY_VALUE).toBe("foundry-studio");
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

it("resolves source and built declarations for the public leaf modules", () => {
  expect(Object.hasOwn(packageJson.exports, ".")).toBe(false);
  for (const entry of [
    "types",
    "sandbox",
    "errors",
    "path",
    "constants",
    "container/store",
    "container/constants",
    "container/constraints",
    "container/containers",
    "container/types",
    "container/microsandbox-runtime",
    "tools/toolkit",
    "tools/definitions",
    "tools/guards",
    "virtual/system",
    "testing",
  ]) {
    for (const target of Object.values(packageJson.exports["./*"])) {
      expect(
        existsSync(
          resolve(import.meta.dirname, "../..", target.replace("*", entry))
        )
      ).toBe(true);
    }
  }
});
