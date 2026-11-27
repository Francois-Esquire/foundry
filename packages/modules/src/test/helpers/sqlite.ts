import {
  authorizationClaims,
  authorizationGrants,
  authorizationRestrictions,
} from "@foundry/authorization/store/tables";
import {
  type DatabaseLocation,
  type LibsqlDatabases,
  libsqlDatabases as openLibsqlDatabases,
} from "@foundry/lib/testing/sqlite";
import {
  moduleInstallations,
  moduleManifests,
  modulePositions,
  modules,
} from "../../store/tables";

export type {
  DatabaseLocation,
  LibsqlDatabases,
} from "@foundry/lib/testing/sqlite";

export function libsqlDatabases(location: DatabaseLocation): LibsqlDatabases {
  return openLibsqlDatabases(location, {
    name: "modules",
    tables: [
      modules,
      moduleManifests,
      moduleInstallations,
      modulePositions,
      authorizationGrants,
      authorizationRestrictions,
      authorizationClaims,
    ],
  });
}
