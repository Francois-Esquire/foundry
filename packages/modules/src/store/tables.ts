import type { ArtifactId, ContentId } from "@foundry/artifacts";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import type { InstallationId, ModuleId } from "../domain";
import { INSTALLATION_STATUSES } from "../domain";
import type { ModuleManifest } from "../manifest";

/**
 * The tables `SqliteModuleStore` reads and writes, for a host to compose
 * into its own schema and migrations. Each holds the matching record from
 * `@foundry/modules/schema` field for field, plus two columns the record
 * has not:
 *
 * - `scope`, an opaque partition key the host chooses, first in every key.
 * - `position`, the order a row was first put in its scope. Reads list rows
 *   by it, as the memory store lists its records, and a row put again keeps
 *   its position.
 *
 * Timestamps, which the records hold as `Date`s, are ISO 8601 text
 * (`Date.prototype.toISOString`), exact to the millisecond.
 */

/** One row per `Module`. */
export const modules = sqliteTable(
  "modules",
  {
    artifactId: text("artifact_id").$type<ArtifactId>().notNull(),
    id: text("id").$type<ModuleId>().notNull(),
    position: integer("position").notNull(),
    scope: text("scope").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("modules_scope_position").on(table.scope, table.position),
    // The registry finds the Module an Artifact belongs to.
    index("modules_scope_artifact").on(table.scope, table.artifactId),
  ]
);

/** One row per retained manifest (`StoredManifest`), keyed by its Content. */
export const moduleManifests = sqliteTable(
  "module_manifests",
  {
    contentId: text("content_id").$type<ContentId>().notNull(),
    manifest: text("manifest", { mode: "json" })
      .$type<ModuleManifest>()
      .notNull(),
    moduleId: text("module_id").$type<ModuleId>().notNull(),
    position: integer("position").notNull(),
    scope: text("scope").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.contentId] }),
    index("module_manifests_scope_position").on(table.scope, table.position),
  ]
);

/**
 * One row per `StoredInstallation`: the Installation's fields, and its
 * whole set of Grants as one JSON array in Grant order, each Grant's
 * `createdAt` as ISO text. The Grants change only with their Installation,
 * so they are read and written with it.
 */
export const moduleInstallations = sqliteTable(
  "module_installations",
  {
    containerId: text("container_id"),
    contentId: text("content_id").$type<ContentId>().notNull(),
    createdAt: text("created_at").notNull(),
    generation: integer("generation").notNull(),
    grants: text("grants", { mode: "json" })
      .$type<
        readonly {
          readonly capability: string;
          readonly constraintsDigest: string;
          readonly createdAt: string;
          readonly version: number;
        }[]
      >()
      .notNull(),
    id: text("id").$type<InstallationId>().notNull(),
    moduleId: text("module_id").$type<ModuleId>().notNull(),
    position: integer("position").notNull(),
    scope: text("scope").notNull(),
    startAttempts: integer("start_attempts").notNull(),
    status: text("status", { enum: INSTALLATION_STATUSES }).notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("module_installations_scope_position").on(
      table.scope,
      table.position
    ),
    // The registry lists one Module's Installations.
    index("module_installations_scope_module").on(
      table.scope,
      table.moduleId,
      table.position
    ),
  ]
);
