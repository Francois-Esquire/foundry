import {
  type StorageEntry,
  type StorageNode,
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
    withParentDirectories({ [entry.path]: storageNode(entry) });
    return true;
  } catch {
    return false;
  }
}

/** Only the fields core's node carries; the record's own fields stay here. */
function storageNode(entry: StorageEntry): StorageNode {
  switch (entry.type) {
    case "file":
      return {
        bytes: entry.bytes,
        digest: entry.digest,
        mime: entry.mime,
        type: "file",
      };
    case "symlink":
      return { target: entry.target, type: "symlink" };
    default:
      return { type: entry.type };
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

/** What every change event carries: its own id, when, and the Workspace. */
const changeEventFields = {
  /** When the change happened, as the record it changed stamps it, in ISO form. */
  at: z.iso.datetime(),
  /** Unique to this event. */
  id: z.string().min(1),
  workspaceId: workspaceIdSchema,
};

const entryIds = z.array(workspaceEntryIdSchema).readonly();

/**
 * One past change to a Workspace's catalog, built by `WorkspaceCatalog` and
 * carried in the store write that makes it (`WorkspaceStoreWrite.events`),
 * so a host's `onCommit` can record it with the change. Ids only, never
 * entry records:
 *
 * - `workspace.created`: a Workspace was registered, with its first entries.
 * - `workspace.updated`: its name changed.
 * - `workspace.entries.changed`: one reconciliation or save added, changed
 *   and removed these entries; at least one list is nonempty.
 * - `workspace.removed`: it was forgotten, with every entry it held.
 */
export const workspaceEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...changeEventFields,
    type: z.literal("workspace.created"),
  }),
  z.strictObject({
    ...changeEventFields,
    type: z.literal("workspace.updated"),
  }),
  z.strictObject({
    ...changeEventFields,
    added: entryIds,
    changed: entryIds,
    removed: entryIds,
    type: z.literal("workspace.entries.changed"),
  }),
  z.strictObject({
    ...changeEventFields,
    type: z.literal("workspace.removed"),
  }),
]);
export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;
