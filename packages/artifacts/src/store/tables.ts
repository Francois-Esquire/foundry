import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { ARTIFACT_STATUSES, CONTENT_STATES } from "../constants";
import type { ArtifactId, BlobId, ContentId } from "../ref";
import type { ArtifactMetadata, ContentMetadata, ContentTree } from "../schema";

export const artifacts = sqliteTable(
  "artifacts",
  {
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    contentId: text("content_id").$type<ContentId>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").$type<ArtifactId>().notNull(),
    idLower: text("id_lower").notNull(),
    idOrder: blob("id_order", { mode: "buffer" }).$type<Uint8Array>().notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<ArtifactMetadata>()
      .notNull(),
    name: text("name").notNull(),
    nameLower: text("name_lower").notNull(),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    scope: text("scope").notNull(),
    status: text("status", { enum: ARTIFACT_STATUSES }).notNull(),
    textUnits: text("text_units").notNull(),
    type: text("type").notNull(),
    typeLower: text("type_lower").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("artifacts_scope_created").on(
      table.scope,
      table.createdAt,
      table.idOrder
    ),
    index("artifacts_scope_type_created").on(
      table.scope,
      table.type,
      table.createdAt,
      table.idOrder
    ),
  ]
);

export const artifactContents = sqliteTable(
  "artifact_contents",
  {
    artifactId: text("artifact_id").$type<ArtifactId>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    digest: text("digest").notNull(),
    frozenAt: integer("frozen_at", { mode: "timestamp_ms" }),
    id: text("id").$type<ContentId>().notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<ContentMetadata>()
      .notNull(),
    scope: text("scope").notNull(),
    state: text("state", { enum: CONTENT_STATES }).notNull(),
    tag: text("tag"),
    tree: text("tree", { mode: "json" }).$type<ContentTree>().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("artifact_contents_scope_artifact").on(table.scope, table.artifactId),
  ]
);

export const artifactBlobs = sqliteTable(
  "artifact_blobs",
  {
    byteLength: integer("byte_length").notNull(),
    bytes: blob("bytes", { mode: "buffer" }).$type<Uint8Array>(),
    chunks: text("chunks", { mode: "json" }).$type<readonly BlobId[]>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    digest: text("digest").notNull(),
    id: text("id").$type<BlobId>().notNull(),
    path: text("path"),
    scope: text("scope").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.id] }),
    index("artifact_blobs_scope_digest").on(table.scope, table.digest),
  ]
);

export const artifactContentBlobs = sqliteTable(
  "artifact_content_blobs",
  {
    blobId: text("blob_id").$type<BlobId>().notNull(),
    contentId: text("content_id").$type<ContentId>().notNull(),
    scope: text("scope").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.blobId, table.contentId] }),
    index("artifact_content_blobs_scope_content").on(
      table.scope,
      table.contentId
    ),
  ]
);

export const artifactBlobChunks = sqliteTable(
  "artifact_blob_chunks",
  {
    blobId: text("blob_id").$type<BlobId>().notNull(),
    chunkId: text("chunk_id").$type<BlobId>().notNull(),
    scope: text("scope").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.chunkId, table.blobId] }),
    index("artifact_blob_chunks_scope_blob").on(table.scope, table.blobId),
  ]
);
