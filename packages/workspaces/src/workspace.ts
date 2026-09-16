import { z } from "zod";

export const workspaceIdSchema = z
  .string()
  .min(1, "WorkspaceId must not be empty")
  .brand("WorkspaceId");
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

export const workspaceFileIdSchema = z
  .string()
  .min(1, "WorkspaceFileId must not be empty")
  .brand("WorkspaceFileId");
export type WorkspaceFileId = z.infer<typeof workspaceFileIdSchema>;

/**
 * The coarse whole-file categories. Deliberately not code symbols: a `FileKind`
 * classifies the file, a symbol is a future analysis-derived declaration.
 */
export const FILE_KINDS = [
  "code",
  "document",
  "image",
  "audio",
  "video",
  "data",
  "config",
  "skill",
  "agent",
  "other",
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/**
 * Where a Workspace's bytes come from. `kind` is the string a layer claims
 * when it registers with the system; this package names none of them.
 */
export interface WorkspaceSource {
  readonly kind: string;
  /** The canonical root for a directory, a resource URI for anything else. */
  readonly path: string;
  readonly sourceId: string | null;
}

/** The durable registration of one source: what the store holds, as the domain reads it. */
export interface WorkspaceRegistration {
  readonly createdAt: Date;
  readonly description: string | null;
  readonly documentation: string | null;
  readonly id: WorkspaceId;
  /** The last successful complete source observation, including an empty diff. */
  readonly lastReconciledAt: Date;
  readonly name: string;
  readonly source: WorkspaceSource;
  readonly updatedAt: Date;
}

/** One included source file. It never carries the file's current bytes. */
export interface WorkspaceFile {
  readonly checksum: string;
  readonly createdAt: Date;
  readonly extension: string | null;
  readonly id: WorkspaceFileId;
  readonly kind: FileKind;
  readonly mimeType: string | null;
  readonly name: string;
  /** Normalized POSIX path relative to the Workspace root. */
  readonly path: string;
  readonly size: number;
  readonly updatedAt: Date;
  readonly workspaceId: WorkspaceId;
}

/**
 * What a caller outside the trust boundary may see. The root path and the
 * source reference stay behind the system; the kind survives as a label.
 */
export interface WorkspaceSummary {
  readonly createdAt: Date;
  readonly description: string | null;
  readonly fileCount: number;
  readonly id: WorkspaceId;
  readonly lastReconciledAt: Date;
  readonly name: string;
  readonly sourceKind: string;
  readonly updatedAt: Date;
}

/**
 * The outcome of reading a known File's current bytes. Every non-text outcome
 * is explicit so presentation never has to infer one from empty content.
 *
 * `checksum` is computed from the exact byte sequence this read decoded and
 * sized — never copied from the catalog, whose observation may predate an
 * external change. It is the version a later save must present as expected.
 */
export type FileContentResult =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly mimeType: string | null;
      readonly size: number;
      readonly checksum: string;
    }
  | {
      readonly kind: "binary";
      readonly mimeType: string | null;
      readonly size: number;
      readonly checksum: string;
    }
  | { readonly kind: "stale"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * One host File save: identity, the complete UTF-8 draft, and the checksum of
 * the exact bytes the caller last read. Never a path.
 */
export interface SaveFileCommand {
  readonly expectedChecksum: string;
  readonly fileId: WorkspaceFileId;
  readonly text: string;
}

/** The source text after a read or write, versioned by its own checksum. */
export interface FileTextSnapshot {
  readonly checksum: string;
  readonly size: number;
  readonly text: string;
}

/**
 * The closed save outcomes.
 *
 * `saved` is computed from the bytes actually written; `catalog` reports
 * whether the one-File observation also committed (`refresh-required` means
 * the bytes are on disk but the catalog needs ordinary reconciliation — the
 * caller must adopt the snapshot and never resend the bytes). `conflict`
 * carries the current source snapshot so recovery is an explicit choice.
 * `stale` means the File is no longer representable as writable text (gone,
 * a directory, a symlink, binary, or an Artifact source). `failed` guarantees
 * this command left the original source bytes unchanged.
 */
export type SaveFileResult =
  | {
      readonly kind: "saved";
      readonly snapshot: FileTextSnapshot;
      readonly catalog: "current" | "refresh-required";
    }
  | { readonly kind: "conflict"; readonly current: FileTextSnapshot }
  | { readonly kind: "stale"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * What a layer's write reports back to `save`. The layer owns the conflict
 * check because it already holds the current bytes; the root turns `written`
 * into the saved snapshot and the catalog observation.
 */
export type WriteOutcome =
  | { readonly kind: "written" }
  | Exclude<SaveFileResult, { readonly kind: "saved" }>;

/**
 * How the source answered during the observation that just ran.
 *
 * A failure is a value here rather than a thrown error: open and refresh both
 * still have a Workspace and a prior catalog to return, and throwing would
 * force presentation to choose between showing nothing and inventing a state.
 */
export type WorkspaceSourceStatus =
  | { readonly kind: "reconciled" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "scan-failed"; readonly reason: string };

/** One Workspace, its catalog, and what the source said while producing it. */
export interface WorkspaceView {
  readonly files: readonly WorkspaceFile[];
  readonly source: WorkspaceSourceStatus;
  readonly workspace: WorkspaceSummary;
}

export function workspaceSummary(
  workspace: WorkspaceRegistration,
  fileCount: number
): WorkspaceSummary {
  return {
    createdAt: workspace.createdAt,
    description: workspace.description,
    fileCount,
    id: workspace.id,
    lastReconciledAt: workspace.lastReconciledAt,
    name: workspace.name,
    sourceKind: workspace.source.kind,
    updatedAt: workspace.updatedAt,
  };
}
