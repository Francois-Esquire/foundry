import { expect, it } from "vitest";

import { Modules } from "../index";
import { MemoryModuleStore } from "../store/memory";

it("evaluates and constructs Modules over MemoryModuleStore without Node adapters", async () => {
  const modules = new Modules({ store: new MemoryModuleStore() });
  expect((await modules.listModules()).items).toEqual([]);
  expect((await modules.listInstallations()).items).toEqual([]);
});
