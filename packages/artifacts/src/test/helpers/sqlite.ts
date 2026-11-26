import {
  type DatabaseLocation,
  type LibsqlDatabases,
  libsqlDatabases as openLibsqlDatabases,
} from "@foundry/lib/testing/sqlite";

import {
  artifactBlobChunks,
  artifactBlobs,
  artifactContentBlobs,
  artifactContents,
  artifacts,
} from "../../store/tables";

export type {
  DatabaseLocation,
  LibsqlDatabases,
} from "@foundry/lib/testing/sqlite";

export const ARTIFACT_TABLES = [
  artifacts,
  artifactContents,
  artifactBlobs,
  artifactContentBlobs,
  artifactBlobChunks,
] as const;

export function libsqlDatabases(location: DatabaseLocation): LibsqlDatabases {
  return openLibsqlDatabases(location, {
    name: "artifacts",
    tables: ARTIFACT_TABLES,
  });
}
