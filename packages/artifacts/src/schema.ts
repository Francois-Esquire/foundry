/**
 * The records an `ArtifactStore` persists: Artifacts, their Contents, and the
 * blobs Content trees reference. Each schema is the single definition of its
 * record; the record types are inferred from it.
 *
 * Nothing parses through these today. Invariants that span records or fields
 * (a pointer naming the Artifact's own Content, a blob's inline bytes matching
 * its `byteLength`) stay with the store and `validateBlob`.
 */

import type { FileNode, StorageNode } from "@foundry/core/storage";
import { z } from "zod";

import { ARTIFACT_STATUSES, CONTENT_STATES } from "./constants";
import { artifactIdSchema, blobIdSchema, contentIdSchema } from "./ref";

/** A SHA-256 hex digest, as `digestTree` and blob hashing produce it. */
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** Matches the manager's non-empty check: whitespace alone is empty. */
const nonBlankSchema = z.string().regex(/\S/);
const byteCountSchema = z.int().nonnegative();

export const artifactLifecycleStatusSchema = z.enum(ARTIFACT_STATUSES);
export type ArtifactLifecycleStatus = z.infer<
  typeof artifactLifecycleStatusSchema
>;

export const contentStateSchema = z.enum(CONTENT_STATES);
export type ContentState = z.infer<typeof contentStateSchema>;

// ── Metadata ──
// Open JSON objects: the named keys carry meaning to the package, and any
// other key is kept as written.

export const artifactMetadataSchema = z
  .looseObject({ sessionId: z.string().optional() })
  .readonly();
export type ArtifactMetadata = z.infer<typeof artifactMetadataSchema>;

export const contentMetadataSchema = z
  .looseObject({
    entries: z.record(z.string(), z.string()).readonly().optional(),
    entry: z.string().optional(),
    failure: z
      .object({ code: z.string(), message: z.string() })
      .readonly()
      .optional(),
    from: z.string().optional(),
    messageId: z.string().optional(),
    runId: z.string().optional(),
    sessionId: z.string().optional(),
    thumbnail: z.string().optional(),
  })
  .readonly();
export type ContentMetadata = z.infer<typeof contentMetadataSchema>;

// ── Content tree ──
// Core's storage nodes, with each file entry naming the blob that holds it.

export const storedFileSchema = z
  .strictObject({
    blobId: blobIdSchema,
    bytes: byteCountSchema,
    digest: sha256DigestSchema,
    mime: z.string().nullable(),
    type: z.literal("file"),
  })
  .readonly() satisfies z.ZodType<FileNode>;
export type StoredFile = z.infer<typeof storedFileSchema>;

const structuralNodeSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ type: z.literal("directory") }),
    z.strictObject({ target: z.string(), type: z.literal("symlink") }),
    z.strictObject({ type: z.literal("socket") }),
    z.strictObject({ type: z.literal("device") }),
    z.strictObject({ type: z.literal("pipe") }),
  ])
  .readonly() satisfies z.ZodType<Exclude<StorageNode, FileNode>>;

/** Keys are root-relative storage paths, as in Core's `StorageTree`. */
export const contentTreeSchema = z
  .record(z.string(), z.union([storedFileSchema, structuralNodeSchema]))
  .readonly();
export type ContentTree = z.infer<typeof contentTreeSchema>;

// ── Blob ──
// A blob holds its bytes in exactly one source: inline, a backing file, or
// chunks. The absent sources are typed `never` so callers can test for them.

const bytesSourceSchema = z.strictObject({
  // `z.instanceof` would narrow to `Uint8Array<ArrayBuffer>`.
  bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
  chunks: z.never().optional(),
  path: z.never().optional(),
});
/** A store-owned, immutable backing file. */
const pathSourceSchema = z.strictObject({
  bytes: z.never().optional(),
  chunks: z.never().optional(),
  path: z.string().regex(/^[^\0]+$/),
});
/** Immutable leaf blobs of at most `CHUNK_BYTES` each. */
const chunksSourceSchema = z.strictObject({
  bytes: z.never().optional(),
  chunks: z.array(blobIdSchema).min(1).readonly(),
  path: z.never().optional(),
});

export const blobSourceSchema = z
  .union([bytesSourceSchema, pathSourceSchema, chunksSourceSchema])
  .readonly();
export type BlobSource = z.infer<typeof blobSourceSchema>;

const blobFields = {
  byteLength: byteCountSchema,
  createdAt: z.date(),
  digest: sha256DigestSchema,
  id: blobIdSchema,
};

/**
 * A stored object. File entries reference it by `id`; `digest` and
 * `byteLength` describe the bytes it holds now. An object referenced by one
 * file entry alone is rewritten in place when that entry's bytes change, so
 * its id stays stable. A shared object is never rewritten: the editing entry
 * gets a new object, which keeps frozen Content immutable.
 */
export const blobSchema = z
  .union([
    bytesSourceSchema.extend(blobFields),
    pathSourceSchema.extend(blobFields),
    chunksSourceSchema.extend(blobFields),
  ])
  .readonly();
export type Blob = z.infer<typeof blobSchema>;

// ── Artifact and Content ──

/** A thing people point at. `contentId` names its active Content, if any. */
export const artifactSchema = z
  .strictObject({
    archivedAt: z.date().nullable(),
    contentId: contentIdSchema.nullable(),
    createdAt: z.date(),
    id: artifactIdSchema,
    metadata: artifactMetadataSchema,
    name: nonBlankSchema,
    publishedAt: z.date().nullable(),
    status: artifactLifecycleStatusSchema,
    type: nonBlankSchema,
    updatedAt: z.date(),
  })
  .readonly();
export type Artifact = z.infer<typeof artifactSchema>;

/** One version of an Artifact. `digest` is the tree's `digestTree`. */
export const contentSchema = z
  .strictObject({
    artifactId: artifactIdSchema,
    createdAt: z.date(),
    digest: sha256DigestSchema,
    frozenAt: z.date().nullable(),
    id: contentIdSchema,
    metadata: contentMetadataSchema,
    state: contentStateSchema,
    tag: nonBlankSchema.nullable(),
    tree: contentTreeSchema,
    updatedAt: z.date(),
  })
  .readonly();
export type Content = z.infer<typeof contentSchema>;

/** A store's records as plain arrays: what a persistent host loads and saves. */
export const artifactRecordsSchema = z
  .strictObject({
    artifacts: z.array(artifactSchema).readonly(),
    blobs: z.array(blobSchema).readonly(),
    contents: z.array(contentSchema).readonly(),
  })
  .readonly();
export type ArtifactRecords = z.infer<typeof artifactRecordsSchema>;
