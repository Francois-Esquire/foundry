import type {
  AtomicStorageWriter,
  FileNode,
  FileRepresentation,
  StorageEntry,
  StorageFileCreator,
  StorageNode,
  StorageObserver,
  StorageReader,
  StorageTree,
} from "@foundry/core/storage";
import type { FileClassification } from "@foundry/lib/file-classification";
import type { Ignore } from "ignore";
import type { WorkspaceCatalog } from "./catalog";
import type { Workspace } from "./instance";
import type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceId,
  WorkspaceRegistration,
} from "./schema";

export type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceEvent,
  WorkspaceFile,
  WorkspaceId,
  WorkspaceRegistration,
  WorkspaceSource,
} from "./schema";

export type WorkspaceIdentity = Pick<WorkspaceRegistration, "name" | "source">;

export interface WorkspaceChange {
  readonly action: "add" | "change" | "delete";
  readonly entry: WorkspaceEntry;
}

export interface WorkspaceSummary {
  readonly createdAt: Date;
  readonly fileCount: number;
  readonly id: WorkspaceId;
  readonly lastReconciledAt: Date;
  readonly name: string;
  readonly sourceKind: string;
  readonly updatedAt: Date;
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

export interface SaveFileCommand {
  readonly expectedDigest: string;
  readonly fileId: WorkspaceEntryId;
  readonly text: string;
}

export interface CreateFileCommand {
  readonly path: string;
  readonly text: string;
}

export interface FileTextSnapshot extends Pick<FileNode, "digest" | "bytes"> {
  readonly text: string;
}

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

export type WriteOutcome =
  | { readonly kind: "written"; readonly application?: "pending" }
  | Exclude<SaveFileResult, { readonly kind: "saved" }>;

export type WorkspaceSourceStatus =
  | { readonly kind: "reconciled" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "scan-failed"; readonly reason: string };

export interface WorkspaceView {
  readonly entries: readonly WorkspaceEntry[];
  readonly source: WorkspaceSourceStatus;
  readonly workspace: WorkspaceSummary;
}

export type ObservedFacts =
  | (FileRepresentation & FileClassification)
  | (Exclude<StorageEntry, { readonly type: "file" }> & {
      readonly name: string;
    });

export interface WorkspaceCatalogChange {
  readonly deleted: readonly WorkspaceEntry[];
  readonly inserted: readonly WorkspaceEntry[];
  readonly updated: readonly WorkspaceEntry[];
}

export interface WorkspaceExtension<
  Ref extends object = never,
  Floor = unknown,
  Cap = unknown,
> {
  applies: (registration: WorkspaceRegistration) => Promise<boolean> | boolean;
  identify?(ref: Ref): Promise<WorkspaceIdentity> | WorkspaceIdentity;
  readonly name: string;
  readonly ref?: string;
  readonly types?: { readonly floor: Floor; readonly cap: Cap };
  wrap: (Base: WorkspaceCtor) => WorkspaceCtor;
}

export type AnyWorkspaceExtension = WorkspaceExtension<object>;

export type RefOf<Exts extends readonly AnyWorkspaceExtension[]> =
  Exts[number] extends infer E
    ? E extends WorkspaceExtension<infer R>
      ? R
      : never
    : never;

export type FloorFor<
  Exts extends readonly AnyWorkspaceExtension[],
  R,
> = Exts[number] extends infer E
  ? E extends WorkspaceExtension<infer Ref, infer Floor>
    ? R extends Ref
      ? Floor
      : never
    : never
  : never;

export type CapOf<Exts extends readonly AnyWorkspaceExtension[]> =
  UnionToIntersection<
    Exts[number] extends infer E
      ? E extends WorkspaceExtension<never, unknown, infer Cap>
        ? unknown extends Cap
          ? never
          : Cap
        : never
      : never
  >;

type UnionToIntersection<U> = (
  U extends unknown
    ? (member: U) => void
    : never
) extends (member: infer I) => void
  ? I
  : unknown;

export interface ResolvedSource {
  readonly name?: string;
  readonly path: string;
  readonly sourceId?: string;
}

export interface WorkspaceFileSystem<
  Ref extends object = { readonly path: string },
> extends StorageReader,
    AtomicStorageWriter,
    Partial<StorageObserver>,
    Partial<StorageFileCreator> {
  readonly reference?: keyof Ref & string;
  resolve?(ref: Ref): Promise<ResolvedSource>;
  tree?(root: string): Promise<StorageTree>;
}

export interface WorkspaceContext {
  readonly catalog: WorkspaceCatalog;
  readonly close: (workspaceId: WorkspaceId) => Promise<void>;
  readonly report: (error: unknown) => void;
  readonly serialize: <T>(
    workspaceId: WorkspaceId,
    task: () => Promise<T>
  ) => Promise<T>;
}

// biome-ignore lint/suspicious/noExplicitAny: The generic mixin constructor requires an any[] rest parameter under TS2545.
export type WorkspaceCtor<T = Workspace> = new (...args: any[]) => T;

export interface IgnoreScope {
  readonly base: string;
  readonly matcher: Ignore;
}

export interface WalkedEntry {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly type: StorageNode["type"];
}

export type WorkspaceSourceIssue = "unavailable" | "unreadable" | "scan-failed";
