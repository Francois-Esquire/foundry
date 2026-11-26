import type { TaskStore } from "../store/index";
import { MemoryTaskStore } from "../store/memory";
import { SqliteTaskStore } from "../store/sqlite";
import { describeTaskStore } from "../testing/store";
import { libsqlDatabases } from "./helpers/sqlite";

describeTaskStore("MemoryTaskStore", () => {
  const stores = new Map<string, TaskStore>();
  return (scope) => {
    const store = stores.get(scope) ?? new MemoryTaskStore();
    stores.set(scope, store);
    return store;
  };
});

for (const location of ["memory", "file"] as const) {
  const databases = libsqlDatabases(location);
  describeTaskStore(`SqliteTaskStore on libSQL (${location})`, async () => {
    const database = await databases.open();
    return (scope) => new SqliteTaskStore({ database, scope });
  });
}
