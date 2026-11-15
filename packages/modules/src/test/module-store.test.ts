import type { ModuleStore } from "../store";
import { MemoryModuleStore } from "../store/memory";
import { describeModuleStore } from "../testing/store";

describeModuleStore("MemoryModuleStore", () => {
  const stores = new Map<string, ModuleStore>();
  return (scope) => {
    const store = stores.get(scope) ?? new MemoryModuleStore();
    stores.set(scope, store);
    return store;
  };
});
