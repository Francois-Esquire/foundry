/**
 * The records an `ArtifactStore` persists: Artifacts, their Contents, and the
 * blobs Content trees reference. Each schema is the single definition of its
 * record; the record types are inferred from it.
 *
 * Nothing parses through these today; `validateBlob` checks a blob's fields
 * with the components below.
 *
 * Metadata objects and record maps (`entries`, a Content tree) are checked
 * where they stand and come back as the same value, not a Zod copy: Zod's
 * object and record parsing drops an own `__proto__` key, which the store
 * keeps, and converts a non-plain object before any check could see it.
 *
 * Invariants that span records or fields (a pointer naming the Artifact's own
 * Content, a blob's inline bytes matching its `byteLength`, a tree entry's
 * parent directory) stay with the store, `validateBlob` and Core's
 * `validateStorageTree`.
 */

import type { FileNode, StorageNode } from "@foundry/core/storage";
import { isStoragePath } from "@foundry/core/storage";
import { z } from "zod";

import { ARTIFACT_STATUSES, CONTENT_STATES } from "./constants";
import { assertJsonMetadata } from "./content";
import { artifactIdSchema, blobIdSchema, contentIdSchema } from "./ref";

/** A SHA-256 hex digest, as `digestTree` and blob hashing produce it. */
export const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
/** A length in bytes. */
export const byteCountSchema = z.int().nonnegative();
/** Matches the manager's non-empty check: whitespace alone is empty. */
const nonBlankSchema = z.string().regex(/\S/);
/** Non-empty and free of NUL, as a filesystem path or link target must be. */
const nulFreeSchema = z.string().regex(/^[^\0]+$/);

export const artifactLifecycleStatusSchema = z.enum(ARTIFACT_STATUSES);
export type ArtifactLifecycleStatus = z.infer<
  typeof artifactLifecycleStatusSchema
>;

export const contentStateSchema = z.enum(CONTENT_STATES);
export type ContentState = z.infer<typeof contentStateSchema>;

// ── Checked in place ──

/**
 * A schema that checks the input itself and returns it unchanged, typed as
 * `T`. Output is never a copy, so nothing the input owns is lost.
 */
function checkedInPlace<T>(
  accepts: (value: unknown) => boolean,
  message: string
): z.ZodType<T> {
  return z.custom<T>(accepts, message);
}

function passes(check: () => void): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

/** A plain object, as Zod's record and object parsing would accept it. */
function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A map whose every own key and value is valid, including an own
 * `__proto__` entry, which Zod's record parsing would skip unchecked.
 */
function recordInPlace<V extends z.ZodType>(
  key: (key: string) => boolean,
  value: V,
  message: string
): z.ZodType<Readonly<Record<string, z.output<V>>>> {
  return checkedInPlace(
    (input) =>
      isPlainObject(input) &&
      Object.entries(input).every(
        ([name, entry]) => key(name) && value.safeParse(entry).success
      ),
    message
  );
}

// ── Metadata ──
// Open JSON objects: the named keys carry meaning to the package, and any
// other key is kept as written. The whole object, as given, must pass
// `assertJsonMetadata` before its named keys are checked.

/**
 * Metadata described by `keys`: JSON by `assertJsonMetadata`, then valid for
 * `keys`. Typed by `keys`; the value itself is what comes back.
 */
function jsonMetadataSchema<K extends z.ZodType>(
  keys: K
): z.ZodType<z.output<K>> {
  return checkedInPlace(
    (value) =>
      isPlainObject(value) &&
      passes(() => assertJsonMetadata(value)) &&
      keys.safeParse(value).success,
    "Metadata must be a plain JSON object with valid named keys"
  );
}

export const artifactMetadataSchema = jsonMetadataSchema(
  z.looseObject({ sessionId: z.string().optional() }).readonly()
);
export type ArtifactMetadata = z.infer<typeof artifactMetadataSchema>;

/**
 * Content metadata. `failure` is typed by the keys the package reads; any
 * other key a host stores beside them is kept, since nothing is copied.
 */
export const contentMetadataSchema = jsonMetadataSchema(
  z
    .looseObject({
      entries: recordInPlace(
        () => true,
        z.string(),
        "Named entries must map names to paths"
      ).optional(),
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
    .readonly()
);
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
    z.strictObject({ target: nulFreeSchema, type: z.literal("symlink") }),
    z.strictObject({ type: z.literal("socket") }),
    z.strictObject({ type: z.literal("device") }),
    z.strictObject({ type: z.literal("pipe") }),
  ])
  .readonly() satisfies z.ZodType<Exclude<StorageNode, FileNode>>;

/** Keys are root-relative storage paths, as in Core's `StorageTree`. */
export const contentTreeSchema = recordInPlace(
  isStoragePath,
  z.union([storedFileSchema, structuralNodeSchema]),
  "A Content tree maps storage paths to storage nodes"
);
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
export const blobPathSchema = nulFreeSchema;
const pathSourceSchema = z.strictObject({
  bytes: z.never().optional(),
  chunks: z.never().optional(),
  path: blobPathSchema,
});
/** Immutable leaf blobs of at most `CHUNK_BYTES` each. */
export const blobChunksSchema = z.array(blobIdSchema).min(1).readonly();
const chunksSourceSchema = z.strictObject({
  bytes: z.never().optional(),
  chunks: blobChunksSchema,
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
