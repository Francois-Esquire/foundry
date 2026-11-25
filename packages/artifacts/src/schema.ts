import type { FileNode, StorageNode } from "@foundry/core/storage";
import { isStoragePath } from "@foundry/core/storage";
import { z } from "zod";

import { ARTIFACT_STATUSES, CONTENT_STATES } from "./constants";
import { assertJsonMetadata } from "./content";
import { artifactIdSchema, blobIdSchema, contentIdSchema } from "./ref";

export const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const byteCountSchema = z.int().nonnegative();
const nonBlankSchema = z.string().regex(/\S/);
const nulFreeSchema = z.string().regex(/^[^\0]+$/);

const artifactLifecycleStatusSchema = z.enum(ARTIFACT_STATUSES);
export type ArtifactLifecycleStatus = z.infer<
  typeof artifactLifecycleStatusSchema
>;

const contentStateSchema = z.enum(CONTENT_STATES);
export type ContentState = z.infer<typeof contentStateSchema>;

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

function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

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

const storedFileSchema = z
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

export const contentTreeSchema = recordInPlace(
  isStoragePath,
  z.union([storedFileSchema, structuralNodeSchema]),
  "A Content tree maps storage paths to storage nodes"
);
export type ContentTree = z.infer<typeof contentTreeSchema>;

const bytesSourceSchema = z.strictObject({
  bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
  chunks: z.never().optional(),
  path: z.never().optional(),
});
export const blobPathSchema = nulFreeSchema;
const pathSourceSchema = z.strictObject({
  bytes: z.never().optional(),
  chunks: z.never().optional(),
  path: blobPathSchema,
});
export const blobChunksSchema = z.array(blobIdSchema).min(1).readonly();
const chunksSourceSchema = z.strictObject({
  bytes: z.never().optional(),
  chunks: blobChunksSchema,
  path: z.never().optional(),
});

const blobSourceSchema = z
  .union([bytesSourceSchema, pathSourceSchema, chunksSourceSchema])
  .readonly();
export type BlobSource = z.infer<typeof blobSourceSchema>;

const blobFields = {
  byteLength: byteCountSchema,
  createdAt: z.date(),
  digest: sha256DigestSchema,
  id: blobIdSchema,
};

const blobSchema = z
  .union([
    bytesSourceSchema.extend(blobFields),
    pathSourceSchema.extend(blobFields),
    chunksSourceSchema.extend(blobFields),
  ])
  .readonly();
export type Blob = z.infer<typeof blobSchema>;

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

export const artifactRecordsSchema = z
  .strictObject({
    artifacts: z.array(artifactSchema).readonly(),
    blobs: z.array(blobSchema).readonly(),
    contents: z.array(contentSchema).readonly(),
  })
  .readonly();
export type ArtifactRecords = z.infer<typeof artifactRecordsSchema>;

const eventFields = {
  artifactId: artifactIdSchema,
  at: z.iso.datetime(),
  id: z.string().min(1),
};
const contentEventFields = { ...eventFields, contentId: contentIdSchema };

export const artifactEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...eventFields, type: z.literal("artifact.created") }),
  z.strictObject({
    ...contentEventFields,
    sourceArtifactId: artifactIdSchema,
    sourceContentId: contentIdSchema,
    type: z.literal("artifact.forked"),
  }),
  z.strictObject({
    ...contentEventFields,
    type: z.literal("artifact.written"),
  }),
  z.strictObject({
    ...contentEventFields,
    sourceContentId: contentIdSchema,
    type: z.literal("artifact.revised"),
  }),
  z.strictObject({ ...contentEventFields, type: z.literal("artifact.frozen") }),
  z.strictObject({
    ...contentEventFields,
    type: z.literal("artifact.published"),
  }),
  z.strictObject({
    ...contentEventFields,
    type: z.literal("artifact.selected"),
  }),
  z.strictObject({
    ...contentEventFields,
    type: z.literal("artifact.cleared"),
  }),
  z.strictObject({
    ...contentEventFields,
    tag: nonBlankSchema.nullable(),
    type: z.literal("artifact.tagged"),
  }),
  z.strictObject({
    ...eventFields,
    contentId: contentIdSchema.nullable(),
    type: z.literal("artifact.updated"),
  }),
  z.strictObject({
    ...eventFields,
    name: nonBlankSchema,
    type: z.literal("artifact.renamed"),
  }),
  z.strictObject({ ...eventFields, type: z.literal("artifact.archived") }),
  z.strictObject({ ...eventFields, type: z.literal("artifact.unarchived") }),
  z.strictObject({
    ...eventFields,
    artifactType: nonBlankSchema,
    name: nonBlankSchema,
    type: z.literal("artifact.removed"),
  }),
  z.strictObject({
    ...contentEventFields,
    type: z.literal("artifact.discarded"),
  }),
]);
export type ArtifactEvent = z.infer<typeof artifactEventSchema>;
export type ArtifactEventType = ArtifactEvent["type"];
