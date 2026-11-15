import type { ModuleStore } from "../store";
import { MemoryModuleStore } from "../store/memory";
import { SqliteModuleStore } from "../store/sqlite";
import { describeModuleStore } from "../testing/store";
import { libsqlDatabases } from "./helpers/sqlite";

describeModuleStore("MemoryModuleStore", () => {
  const stores = new Map<string, ModuleStore>();
  return (scope) => {
    const store = stores.get(scope) ?? new MemoryModuleStore();
    stores.set(scope, store);
    return store;
  };
});

for (const location of ["memory", "file"] as const) {
  const databases = libsqlDatabases(location);
  describeModuleStore(`SqliteModuleStore on libSQL (${location})`, async () => {
    const database = await databases.open();
    return (scope) => new SqliteModuleStore({ database, scope });
  });
}
