import {
  type DatabaseLocation,
  type LibsqlDatabases,
  libsqlDatabases as openLibsqlDatabases,
} from "@foundry/lib/testing/sqlite";
import {
  authorizationClaims,
  authorizationGrants,
  authorizationRestrictions,
} from "../../store/tables";

export type {
  DatabaseLocation,
  LibsqlDatabases,
} from "@foundry/lib/testing/sqlite";

export function libsqlDatabases(location: DatabaseLocation): LibsqlDatabases {
  return openLibsqlDatabases(location, {
    name: "authorization",
    tables: [
      authorizationGrants,
      authorizationRestrictions,
      authorizationClaims,
    ],
  });
}
