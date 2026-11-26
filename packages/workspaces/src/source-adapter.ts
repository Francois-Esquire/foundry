import type {
  FileNode,
  FileRepresentation,
  StorageEntry,
  StorageSubscription,
} from "@foundry/core/storage";
import type { FileClassification } from "@foundry/lib/file-classification";
import type { WorkspaceFile } from "./schema";

export interface WorkspaceSourceAdapter {
  insertFile?(path: string, bytes: Uint8Array): Promise<WriteOutcome>;
  readFile?(file: WorkspaceFile): Promise<FileContentResult>;
  scan(): Promise<readonly ObservedFacts[]>;
  watch?(
    changed: () => void,
    failed: (error: unknown) => void
  ): Promise<StorageSubscription | undefined>;
  writeFile?(
    file: WorkspaceFile,
    bytes: Uint8Array,
    expectedDigest: string
  ): Promise<WriteOutcome>;
}

export type ObservedFacts =
  | (FileRepresentation & FileClassification)
  | (Exclude<StorageEntry, { readonly type: "file" }> & {
      readonly name: string;
    });

export type WriteOutcome =
  | { readonly kind: "written"; readonly application?: "pending" }
  | Exclude<SaveFileResult, { readonly kind: "saved" }>;

export type SaveFileResult =
  | {
      readonly kind: "saved";
      readonly snapshot: FileTextSnapshot;
      readonly catalog: "current" | "refresh-required";
      readonly application?: "pending";
    }
  | { readonly kind: "conflict"; readonly current: FileTextSnapshot }
  | { readonly kind: "stale"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

export interface FileTextSnapshot extends Pick<FileNode, "digest" | "bytes"> {
  readonly text: string;
}

export type FileContentResult =
  | (FileNode & {
      readonly kind: "text";
      readonly text: string;
    })
  | (FileNode & {
      readonly kind: "binary";
    })
  | { readonly kind: "stale"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string };

export type WorkspaceSourceStatus =
  | { readonly kind: "reconciled" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "scan-failed"; readonly reason: string };

export type WorkspaceSourceIssue = "unavailable" | "unreadable" | "scan-failed";

export interface GitPathStatus {
  readonly path: string;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
}

export type GitSnapshot =
  | { readonly kind: "none" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "repository";
      readonly branch: string | null;
      readonly detached: boolean;
      readonly paths: readonly GitPathStatus[];
    };
