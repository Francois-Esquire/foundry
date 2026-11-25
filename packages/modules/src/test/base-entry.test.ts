import { resolve } from "node:path";
import {
  assertWebStandardExports,
  portableSubpaths,
} from "@foundry/lib/testing/seam";
import { expect, it } from "vitest";

import { Modules } from "../index";
import { MemoryModuleStore } from "../store/memory";

const PACKAGE_DIR = resolve(import.meta.dirname, "../..");

it("loads no node:* imports, ./node adapters, or unguarded Node/Bun globals from portable subpaths", () => {
  expect(() =>
    assertWebStandardExports(PACKAGE_DIR, portableSubpaths(PACKAGE_DIR))
  ).not.toThrow();
});

it("evaluates and constructs Modules over MemoryModuleStore without Node adapters", async () => {
  const modules = new Modules({ store: new MemoryModuleStore() });
  expect((await modules.listModules()).items).toEqual([]);
  expect((await modules.listInstallations()).items).toEqual([]);
});
