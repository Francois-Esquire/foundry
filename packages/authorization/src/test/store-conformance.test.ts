import type { AuthorizationStore } from "../store/index";
import { MemoryAuthorizationStore } from "../store/memory";
import { SqliteAuthorizationStore } from "../store/sqlite";
import { describeAuthorizationStore } from "../testing/store";
import { libsqlDatabases } from "./helpers/sqlite";

describeAuthorizationStore("MemoryAuthorizationStore", () => {
  const stores = new Map<string, AuthorizationStore>();
  return (scope) => {
    const store = stores.get(scope) ?? new MemoryAuthorizationStore();
    stores.set(scope, store);
    return store;
  };
});

for (const location of ["memory", "file"] as const) {
  const databases = libsqlDatabases(location);
  describeAuthorizationStore(
    `SqliteAuthorizationStore on libSQL (${location})`,
    async () => {
      const database = await databases.open();
      return (scope) => new SqliteAuthorizationStore({ database, scope });
    }
  );
}
