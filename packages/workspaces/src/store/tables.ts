import type { FileKind } from "@foundry/lib/file-classification";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { WorkspaceEntry, WorkspaceEntryId, WorkspaceId } from "../schema";

/**
 * The tables `SqliteWorkspaceStore` reads and writes, for a host to compose
 * into its own schema and migrations. Each holds the matching record from
 * `@foundry/workspaces/schema` field for field, as the record holds it: a
 * `Date` is integer epoch milliseconds, and the registration's `source`
 * spreads over three `source_` columns so the finds can use an index. Every
 * table also has `scope`, an opaque partition key the host chooses, first
 * in every key.
 *
 * No table has a `position`: no read answers in the order rows were put.
 * Registrations list by creation time, then id; entries by path, then id.
 */

/**
 * One row per `WorkspaceRegistration`.
 *
 * - The primary key serves `getWorkspace`.
 * - `workspaces_scope_created` serves `listWorkspaces`, which pages in its
 *   order.
 * - `workspaces_scope_source_path` and `workspaces_scope_source_id` serve
 *   `findWorkspaceByPath` and `findWorkspaceBySourceId`: each finds the
 *   oldest match by reading the first row of its index.
 */
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
    /** `source.sourceId` */
    sourceId: text("source_id"),
    /** `source.kind` */
    sourceKind: text("source_kind").notNull(),
    /** `source.path` */
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

/**
 * One row per `WorkspaceEntry`, whatever its `type`. The columns only some
 * types have (a file's `bytes` through `mime`, a symlink's `target`) are
 * null on the others.
 *
 * The primary key serves every entry read and delete: `getEntry` reads one
 * row of it, `listEntries` one Workspace's run of it, and a write's entry
 * deletes name rows of its Workspace by id. No other index: `listEntries`
 * orders in the store, by code unit, which SQLite's collation does not.
 */
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
