import { InMemoryArtifactStore } from "../store/memory";
import { SqliteArtifactStore } from "../store/sqlite";
import { describeArtifactManager } from "../testing/manager";
import { describeArtifactStore } from "../testing/store";
import { libsqlDatabases } from "./helpers/sqlite";

/** Fresh storage: one store per scope, kept for that scope. */
function memoryStorage() {
  const scopes = new Map<string, InMemoryArtifactStore>();
  return (scope: string) => {
    const store = scopes.get(scope) ?? new InMemoryArtifactStore();
    scopes.set(scope, store);
    return store;
  };
}

describeArtifactStore("In-memory", memoryStorage);
describeArtifactManager("In-memory", () => new InMemoryArtifactStore());

for (const location of ["memory", "file"] as const) {
  const databases = libsqlDatabases(location);
  /** Fresh storage: one database, one store per scope, kept for that scope. */
  async function sqliteStorage() {
    const database = await databases.open();
    const scopes = new Map<string, SqliteArtifactStore>();
    return (scope: string) => {
      const store =
        scopes.get(scope) ?? new SqliteArtifactStore({ database, scope });
      scopes.set(scope, store);
      return store;
    };
  }
  describeArtifactStore(`SQLite on libSQL (${location})`, sqliteStorage);
  describeArtifactManager(
    `SQLite on libSQL (${location})`,
    async () =>
      new SqliteArtifactStore({ database: await databases.open(), scope: "s" })
  );
}
