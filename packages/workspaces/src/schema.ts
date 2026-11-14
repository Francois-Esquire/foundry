import { isStoragePath } from "@foundry/core/storage";
import { FILE_KINDS } from "@foundry/lib/file-classification";
import { z } from "zod";

/**
 * The records a `WorkspaceStore` holds: one registration per source and the
 * entries it owns. These schemas are the single definition of those shapes;
 * the record types are inferred from them. Nothing parses with them on the
 * store path today — constraints describe what the catalog and the source
 * already guarantee, not new checks.
 */

const SHA256_HEX = /^[a-f0-9]{64}$/;

export const workspaceIdSchema = z.string().min(1).brand<"WorkspaceId">();
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

export const workspaceEntryIdSchema = z
  .string()
  .min(1)
  .brand<"WorkspaceEntryId">();
export type WorkspaceEntryId = z.infer<typeof workspaceEntryIdSchema>;

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

/** Identity and time every entry carries beside what the source observed. */
const entryRecord = {
  createdAt: z.date(),
  id: workspaceEntryIdSchema,
  /** The last path segment. */
  name: z.string(),
  /** Root-relative POSIX path without empty, `.` or `..` segments. */
  path: z.string().refine(isStoragePath, "Expected a root-relative path"),
  updatedAt: z.date(),
  workspaceId: workspaceIdSchema,
};

const fileEntry = z.strictObject({
  ...entryRecord,
  /** Length in bytes. */
  bytes: z.int().min(0),
  /** SHA-256 hex digest of the observed bytes. */
  digest: z.string().regex(SHA256_HEX),
  extension: z.string().nullable(),
  kind: z.enum(FILE_KINDS),
  mime: z.string().nullable(),
  type: z.literal("file"),
});

export const workspaceFileSchema = fileEntry.readonly();
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

/** One included path: a File, or any other node the source reported there. */
export const workspaceEntrySchema = z
  .discriminatedUnion("type", [
    fileEntry,
    z.strictObject({ ...entryRecord, type: z.literal("directory") }),
    z.strictObject({
      ...entryRecord,
      /** The stored link target, never resolved. */
      target: z
        .string()
        .min(1)
        .refine((target) => !target.includes("\0")),
      type: z.literal("symlink"),
    }),
    z.strictObject({ ...entryRecord, type: z.literal("socket") }),
    z.strictObject({ ...entryRecord, type: z.literal("device") }),
    z.strictObject({ ...entryRecord, type: z.literal("pipe") }),
  ])
  .readonly();
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;
