import {
  type StorageEntry,
  withParentDirectories,
} from "@foundry/core/storage";
import { FILE_KINDS } from "@foundry/lib/file-classification";
import { z } from "zod";

/**
 * The records a `WorkspaceStore` holds: one registration per source and the
 * entries it owns. Each record type is inferred from its schema, so the
 * schema is the one definition of the persisted shape; only the id brands are
 * declared by hand, with their schemas bound to them. Nothing parses these on
 * the way into or out of a store; a store enforces nothing (see
 * `WorkspaceStore`).
 */

export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };

export type WorkspaceEntryId = string & {
  readonly __brand: "WorkspaceEntryId";
};

/**
 * Any nonempty string, bound to the `__brand` type the package mints by
 * casting a UUID. A Zod brand would be a different type from the one every
 * importer already holds.
 */
export const workspaceIdSchema = z.string().min(1) as unknown as z.ZodType<
  WorkspaceId,
  string
>;

export const workspaceEntryIdSchema = z.string().min(1) as unknown as z.ZodType<
  WorkspaceEntryId,
  string
>;

/**
 * Where a Workspace's bytes come from. `kind` is the string a layer claims
 * when it registers with the system.
 */
export const workspaceSourceSchema = z
  .strictObject({
    kind: z.string(),
    /** The canonical root for a directory, a resource URI for anything else. */
    path: z.string(),
    sourceId: z.string().nullable(),
  })
  .readonly();
export type WorkspaceSource = z.infer<typeof workspaceSourceSchema>;

/** The durable registration of one source, exactly as the store holds it. */
export const workspaceRegistrationSchema = z
  .strictObject({
    createdAt: z.date(),
    id: workspaceIdSchema,
    /** The last successful complete source observation, including an empty diff. */
    lastReconciledAt: z.date(),
    name: z.string(),
    source: workspaceSourceSchema,
    updatedAt: z.date(),
  })
  .readonly();
export type WorkspaceRegistration = z.infer<typeof workspaceRegistrationSchema>;

/*
 * `@foundry/core/storage` owns the node shapes below (`StorageEntry`,
 * `FileRepresentation`) and the rules for a valid path, digest, size, and
 * link target. This file only declares their field types and asks core's own
 * validator; tests hold the inferred types strictly equal to core's.
 */

/** A valid node at a valid path, by core's rules. */
function isStorageEntry(entry: StorageEntry): boolean {
  try {
    withParentDirectories({ [entry.path]: entry });
    return true;
  } catch {
    return false;
  }
}

/** Identity and time every entry carries beside what the source observed. */
const entryRecord = {
  createdAt: z.date(),
  id: workspaceEntryIdSchema,
  /** The last path segment. */
  name: z.string(),
  path: z.string(),
  updatedAt: z.date(),
  workspaceId: workspaceIdSchema,
};

const fileEntry = z.strictObject({
  ...entryRecord,
  bytes: z.int(),
  digest: z.string(),
  extension: z.string().nullable(),
  kind: z.enum(FILE_KINDS),
  mime: z.string().nullable(),
  type: z.literal("file"),
});

export const workspaceFileSchema = fileEntry
  .refine(isStorageEntry, "Expected a valid storage file")
  .readonly();
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

/** One included path: a File, or any other node the source reported there. */
export const workspaceEntrySchema = z
  .discriminatedUnion("type", [
    fileEntry,
    z.strictObject({ ...entryRecord, type: z.literal("directory") }),
    z.strictObject({
      ...entryRecord,
      /** The stored link target, never resolved. */
      target: z.string(),
      type: z.literal("symlink"),
    }),
    z.strictObject({ ...entryRecord, type: z.literal("socket") }),
    z.strictObject({ ...entryRecord, type: z.literal("device") }),
    z.strictObject({ ...entryRecord, type: z.literal("pipe") }),
  ])
  .refine(isStorageEntry, "Expected a valid storage entry")
  .readonly();
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;
