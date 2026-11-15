import { SqliteWorkflowStore } from "../store/sqlite";
import { describeWorkflowStore } from "../testing/store";
import { libsqlDatabases } from "./helpers/sqlite";

for (const location of ["memory", "file"] as const) {
  const databases = libsqlDatabases(location);
  describeWorkflowStore(`SqliteWorkflowStore (${location})`, async () => {
    const database = await databases.open();
    return (scope) => new SqliteWorkflowStore({ database, scope });
  });
}
