import type { FileKind } from "@foundry/lib/file-classification";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { WorkspaceEntry, WorkspaceEntryId, WorkspaceId } from "../schema";

export const workspaces = sqliteTable(
  "workspaces",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").$type<WorkspaceId>().notNull(),
    lastReconciledAt: integer("last_reconciled_at", {
      mode: "timestamp_ms",
    }).notNull(),
    name: text("name").notNull(),
    scope: text("scope").notNull(),
    sourceId: text("source_id"),
    sourceKind: text("source_kind").notNull(),
    sourcePath: text("source_path").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("workspaces_scope_created").on(
      table.scope,
      table.createdAt,
      table.id
    ),
    index("workspaces_scope_source_path").on(
      table.scope,
      table.sourcePath,
      table.createdAt,
      table.id
    ),
    index("workspaces_scope_source_id").on(
      table.scope,
      table.sourceId,
      table.createdAt,
      table.id
    ),
  ]
);

export const workspaceEntries = sqliteTable(
  "workspace_entries",
  {
    bytes: integer("bytes"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    digest: text("digest"),
    extension: text("extension"),
    id: text("id").$type<WorkspaceEntryId>().notNull(),
    kind: text("kind").$type<FileKind>(),
    mime: text("mime"),
    name: text("name").notNull(),
    path: text("path").notNull(),
    scope: text("scope").notNull(),
    target: text("target"),
    type: text("type").$type<WorkspaceEntry["type"]>().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    workspaceId: text("workspace_id").$type<WorkspaceId>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.workspaceId, table.id] }),
  ]
);
