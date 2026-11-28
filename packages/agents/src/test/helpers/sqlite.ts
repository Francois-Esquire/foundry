import {
  type DatabaseLocation,
  type LibsqlDatabases,
  libsqlDatabases as openLibsqlDatabases,
} from "@foundry/lib/testing/sqlite";
import { agentMessages, agentSessions } from "../../store/tables";

export type {
  DatabaseLocation,
  LibsqlDatabases,
  OnQuery,
} from "@foundry/lib/testing/sqlite";

export function libsqlDatabases(location: DatabaseLocation): LibsqlDatabases {
  return openLibsqlDatabases(location, {
    name: "sessions",
    tables: [agentSessions, agentMessages],
  });
}
