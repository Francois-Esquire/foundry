import {
  type DatabaseLocation,
  type LibsqlDatabases,
  libsqlDatabases as openLibsqlDatabases,
} from "@foundry/lib/testing/sqlite";
import { workspaceEntries, workspaces } from "../../store/tables";

export type {
  DatabaseLocation,
  LibsqlDatabases,
} from "@foundry/lib/testing/sqlite";

export function libsqlDatabases(location: DatabaseLocation): LibsqlDatabases {
  return openLibsqlDatabases(location, {
    name: "workspaces",
    tables: [workspaces, workspaceEntries],
  });
}
