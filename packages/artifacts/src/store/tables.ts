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

/**
 * The tables `SqliteArtifactStore` reads and writes, for a host to compose
 * into its own schema and migrations. The first three hold the records from
 * `@foundry/artifacts/schema` field for field, as the records hold them: a
 * `Date` is integer epoch milliseconds, inline bytes are a blob, and
 * metadata, a Content tree and a blob's chunks are JSON text. Every table
 * also has `scope`, an opaque partition key the host chooses, first in
 * every key.
 *
 * Beside the record fields, the store writes what SQLite cannot work out
 * for itself with an index:
 *
 * - On `artifacts`, `name_lower`, `type_lower` and `id_lower`, each field
 *   lower-cased by JavaScript's `toLowerCase`, which the text filter
 *   matches; `text_units`, the same three as UTF-16 code units in hex,
 *   which a filter holding a lone surrogate matches by code unit; and
 *   `id_order`, the id's UTF-16 code units as big-endian bytes, which sort
 *   as the code units do. SQLite folds case for ASCII only, and compares
 *   and orders text by code point, so none can come from `name` or `id` in
 *   SQL.
 * - Two lookup tables, `artifact_content_blobs` and `artifact_blob_chunks`,
 *   one row per blob a Content's tree or a blob's chunks name, which
 *   `findReferences` reads. The JSON they come from cannot be indexed.
 *
 * No table has a `position`: no read answers in the order rows were put.
 * Artifacts list by creation time, then id; every other list is unordered.
 */

/**
 * One row per `Artifact`.
 *
 * - The primary key serves `getArtifact` and a write's Artifact deletes.
 * - `artifacts_scope_created` serves `listArtifacts` without `type`: it
 *   reads the index in listing order from the cursor on.
 * - `artifacts_scope_type_created` serves `listArtifacts` with `type`.
 */
export const artifacts = sqliteTable(
  "artifacts",
  {
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    contentId: text("content_id").$type<ContentId>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").$type<ArtifactId>().notNull(),
    /** `id.toLowerCase()` */
    idLower: text("id_lower").notNull(),
    /** `id` as UTF-16 code units, each two bytes, high byte first. */
    idOrder: blob("id_order", { mode: "buffer" }).notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<ArtifactMetadata>()
      .notNull(),
    name: text("name").notNull(),
    /** `name.toLowerCase()` */
    nameLower: text("name_lower").notNull(),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    scope: text("scope").notNull(),
    status: text("status", { enum: ARTIFACT_STATUSES }).notNull(),
    /**
     * `name`, `type` and `id`, each lower-cased, as UTF-16 code units in
     * hex (four digits and a comma per unit), joined by `|`.
     */
    textUnits: text("text_units").notNull(),
    type: text("type").notNull(),
    /** `type.toLowerCase()` */
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

/**
 * One row per `Content`.
 *
 * - The primary key serves `getContent`, `listContents()` (one scope's run
 *   of it) and a write's Content deletes.
 * - `artifact_contents_scope_artifact` serves `listContents(artifactId)`.
 */
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

/**
 * One row per `Blob`, whichever source holds its bytes: exactly one of
 * `bytes`, `path` and `chunks` is set, and the others are null.
 *
 * - The primary key serves `getBlob`, `listBlobs` (one scope's run of it)
 *   and a write's blob deletes.
 * - `artifact_blobs_scope_digest` serves `findBlobs`.
 */
export const artifactBlobs = sqliteTable(
  "artifact_blobs",
  {
    byteLength: integer("byte_length").notNull(),
    bytes: blob("bytes", { mode: "buffer" }),
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

/**
 * One row per Content and blob its tree names, however many files hold
 * that blob; the store writes them with the Content.
 *
 * - The primary key serves `findReferences`: it holds the Content ids.
 * - `artifact_content_blobs_scope_content` serves replacing or deleting a
 *   Content's rows.
 */
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

/**
 * One row per chunked blob and chunk it names, however many times; the
 * store writes them with the blob.
 *
 * - The primary key serves `findReferences`: it holds the chunked blobs'
 *   ids.
 * - `artifact_blob_chunks_scope_blob` serves replacing or deleting a
 *   blob's rows.
 */
export const artifactBlobChunks = sqliteTable(
  "artifact_blob_chunks",
  {
    /** The chunked blob. */
    blobId: text("blob_id").$type<BlobId>().notNull(),
    /** A chunk it names. */
    chunkId: text("chunk_id").$type<BlobId>().notNull(),
    scope: text("scope").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.chunkId, table.blobId] }),
    index("artifact_blob_chunks_scope_blob").on(table.scope, table.blobId),
  ]
);
