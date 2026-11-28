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

export const modulePositions = sqliteTable(
  "module_positions",
  {
    next: integer("next").notNull(),
    scope: text("scope").notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope] })]
);

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
    index("modules_scope_artifact").on(table.scope, table.artifactId),
  ]
);

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

export const moduleInstallations = sqliteTable(
  "module_installations",
  {
    containerId: text("container_id"),
    contentId: text("content_id").$type<ContentId>().notNull(),
    createdAt: text("created_at").notNull(),
    generation: integer("generation").notNull(),
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
    index("module_installations_scope_module").on(
      table.scope,
      table.moduleId,
      table.position
    ),
    index("module_installations_scope_module_id").on(
      table.scope,
      table.moduleId,
      table.id
    ),
  ]
);
