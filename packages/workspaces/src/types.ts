import type {
  AtomicStorageWriter,
  FileNode,
  FileRepresentation,
  StorageEntry,
  StorageFileCreator,
  StorageNode,
  StorageObserver,
  StorageReader,
  StorageSubscription,
  StorageTree,
} from "@foundry/core/storage";
import type { FileClassification } from "@foundry/lib/file-classification";
import type { Ignore } from "ignore";
import type { WorkspaceCatalog } from "./catalog";
import type { Workspace } from "./instance";
import type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceFile,
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

export interface WorkspaceAttachContext {
  readonly capabilities: Readonly<Record<PropertyKey, unknown>>;
  readonly registration: WorkspaceRegistration;
}

export interface WorkspaceLifecycle {
  start?(workspace: Workspace): Promise<void> | void;
  stop?(workspace: Workspace): Promise<void> | void;
}

type HasRequiredKeys<T> = Record<never, never> extends T ? false : true;

export type WorkspaceAttachment<Capabilities extends object = object> =
  WorkspaceLifecycle &
    (HasRequiredKeys<Capabilities> extends true
      ? { readonly capabilities: Capabilities }
      : { readonly capabilities?: Capabilities });

type ExtensionAttach<Capabilities extends object> =
  HasRequiredKeys<Capabilities> extends true
    ? {
        attach(
          context: WorkspaceAttachContext
        ):
          | Promise<WorkspaceAttachment<Capabilities>>
          | WorkspaceAttachment<Capabilities>;
      }
    : {
        attach?(
          context: WorkspaceAttachContext
        ):
          | Promise<WorkspaceAttachment<Capabilities> | undefined>
          | WorkspaceAttachment<Capabilities>
          | undefined;
      };

export type WorkspaceExtension<
  Ref extends object = never,
  SourceCapabilities = unknown,
  Capabilities = unknown,
  Always extends boolean = boolean,
> = {
  applies: (
    registration: WorkspaceRegistration
  ) => [Always] extends [true]
    ? Promise<true> | true
    : Promise<boolean> | boolean;
  identify?(ref: Ref): Promise<WorkspaceIdentity> | WorkspaceIdentity;
  readonly name: string;
  readonly ref?: string;
  source?(registration: WorkspaceRegistration): WorkspaceSourceAdapter;
  readonly types?: {
    readonly capabilities: Capabilities;
    readonly source: SourceCapabilities;
  };
} & ExtensionAttach<SourceCapabilities & Capabilities & object>;

export interface AnyWorkspaceExtension {
  applies: (registration: WorkspaceRegistration) => Promise<boolean> | boolean;
  attach?(
    context: WorkspaceAttachContext
  ):
    | Promise<WorkspaceAttachment<object> | undefined>
    | WorkspaceAttachment<object>
    | undefined;
  identify?(ref: object): Promise<WorkspaceIdentity> | WorkspaceIdentity;
  readonly name: string;
  readonly ref?: string;
  source?(registration: WorkspaceRegistration): WorkspaceSourceAdapter;
  readonly types?: { readonly capabilities: unknown; readonly source: unknown };
}

export type RefOf<Extensions extends readonly AnyWorkspaceExtension[]> =
  Extensions[number] extends infer E
    ? E extends WorkspaceExtension<infer R>
      ? R
      : never
    : never;

export type SourceCapabilitiesFor<
  Extensions extends readonly AnyWorkspaceExtension[],
  R,
> = OrUnknown<
  Extensions[number] extends infer E
    ? E extends WorkspaceExtension<
        infer Ref,
        infer SourceCapabilities,
        infer _Capabilities
      >
      ? R extends Ref
        ? unknown extends SourceCapabilities
          ? never
          : SourceCapabilities
        : never
      : never
    : never
>;

export type CapabilitiesOf<
  Extensions extends readonly AnyWorkspaceExtension[],
> = Unboxed<
  UnionToIntersection<
    | {
        readonly [K in keyof Extensions]: {
          readonly capabilities: ExtensionCapabilities<Extensions[K]>;
        };
      }[number]
    | { readonly capabilities: unknown }
  >
>;

type Unboxed<Box> = Box extends { readonly capabilities: infer Capabilities }
  ? Capabilities
  : unknown;

type UnionToIntersection<U> = (
  U extends unknown
    ? (member: U) => void
    : never
) extends (member: infer I) => void
  ? I
  : never;

type ExtensionCapabilities<E> =
  E extends WorkspaceExtension<never, unknown, infer Capabilities>
    ? unknown extends Capabilities
      ? unknown
      : AppliesAlways<E> extends true
        ? Capabilities
        : DistributivePartial<Capabilities>
    : unknown;

type AppliesAlways<E> = E extends {
  readonly applies: (registration: WorkspaceRegistration) => infer Applied;
}
  ? false extends Awaited<Applied>
    ? false
    : true
  : false;

type DistributivePartial<T> = T extends unknown ? Partial<T> : never;

type OrUnknown<T> = [T] extends [never] ? unknown : T;

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
