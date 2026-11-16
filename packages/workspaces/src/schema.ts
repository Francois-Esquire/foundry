import {
  type StorageEntry,
  type StorageNode,
  withParentDirectories,
} from "@foundry/core/storage";
import { FILE_KINDS } from "@foundry/lib/file-classification";
import { z } from "zod";

export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };

export type WorkspaceEntryId = string & {
  readonly __brand: "WorkspaceEntryId";
};

export const workspaceIdSchema = z.string().min(1) as unknown as z.ZodType<
  WorkspaceId,
  string
>;

export const workspaceEntryIdSchema = z.string().min(1) as unknown as z.ZodType<
  WorkspaceEntryId,
  string
>;

export const workspaceSourceSchema = z
  .strictObject({
    kind: z.string(),
    path: z.string(),
    sourceId: z.string().nullable(),
  })
  .readonly();
export type WorkspaceSource = z.infer<typeof workspaceSourceSchema>;

export const workspaceRegistrationSchema = z
  .strictObject({
    createdAt: z.date(),
    id: workspaceIdSchema,
    lastReconciledAt: z.date(),
    name: z.string(),
    source: workspaceSourceSchema,
    updatedAt: z.date(),
  })
  .readonly();
export type WorkspaceRegistration = z.infer<typeof workspaceRegistrationSchema>;

function isStorageEntry(entry: StorageEntry): boolean {
  try {
    withParentDirectories({ [entry.path]: storageNode(entry) });
    return true;
  } catch {
    return false;
  }
}

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

const entryRecord = {
  createdAt: z.date(),
  id: workspaceEntryIdSchema,
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

export const workspaceEntrySchema = z
  .discriminatedUnion("type", [
    fileEntry,
    z.strictObject({ ...entryRecord, type: z.literal("directory") }),
    z.strictObject({
      ...entryRecord,
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
