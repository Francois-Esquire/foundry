import { expect, it } from "vitest";
import packageJson from "../../package.json";
import {
  DEFAULT_SANDBOX_WORKING_DIRECTORY,
  normalizeSandboxPath,
  SandboxError,
  sandboxFromAdapter,
} from "../index";
import { MemoryContainerStore } from "../store/memory";
import { createSandboxToolSchemas } from "../tools/index";

it("publishes explicit canonical subpaths with no wildcard exports", () => {
  const subpaths = Object.keys(packageJson.exports);
  expect(subpaths.filter((key) => key.includes("*"))).toEqual([]);
  for (const canonical of [
    ".",
    "./node",
    "./node/microsandbox",
    "./providers/microsandbox",
    "./store",
    "./store/memory",
    "./store/sqlite",
    "./store/tables",
    "./testing",
    "./testing/store",
    "./tools",
    "./virtual",
  ]) {
    expect(subpaths).toContain(canonical);
  }
});

it("evaluates portable contracts, MemoryContainerStore, and tool schemas without Node adapters", async () => {
  expect(normalizeSandboxPath("notes.md")).toBe(
    `${DEFAULT_SANDBOX_WORKING_DIRECTORY}/notes.md`
  );
  expect(new SandboxError("invalid-contract", "bad").code).toBe(
    "invalid-contract"
  );
  const store = new MemoryContainerStore();
  expect(await store.list()).toEqual([]);
  expect(sandboxFromAdapter).toBeTypeOf("function");
  const schemas = createSandboxToolSchemas();
  expect(Object.keys(schemas.tools)).toContain("read");
});
