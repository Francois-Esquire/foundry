import type { ContainerStore } from "../store/index";
import { createMemoryContainerStore } from "../store/memory";
import { createSqliteContainerStore } from "../store/sqlite";
import { describeContainerStore } from "../testing/store";
import { libsqlDatabases } from "./helpers/sqlite";

describeContainerStore("memory", () => {
  const stores = new Map<string, ContainerStore>();
  return (scope) => {
    const store = stores.get(scope) ?? createMemoryContainerStore();
    stores.set(scope, store);
    return store;
  };
});

for (const location of ["memory", "file"] as const) {
  const databases = libsqlDatabases(location);
  describeContainerStore(`SQLite on libSQL (${location})`, async () => {
    const database = await databases.open();
    return (scope) => createSqliteContainerStore({ database, scope });
  });
}
