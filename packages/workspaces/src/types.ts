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
import type {
  FileClassification,
  FileKind,
} from "@foundry/lib/file-classification";
import type { Ignore } from "ignore";
import type { WorkspaceCatalog } from "./catalog";
import type { Workspace } from "./instance";

export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };

export type WorkspaceEntryId = string & {
  readonly __brand: "WorkspaceEntryId";
};

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

/** The durable registration of one source, exactly as the store holds it. */
export interface WorkspaceRegistration {
  readonly createdAt: Date;
  readonly id: WorkspaceId;
  /** The last successful complete source observation, including an empty diff. */
  readonly lastReconciledAt: Date;
  readonly name: string;
  readonly source: WorkspaceSource;
  readonly updatedAt: Date;
}

/** What a layer's `identify` produces; the system adds identity and time. */
export type WorkspaceIdentity = Pick<WorkspaceRegistration, "name" | "source">;

interface WorkspaceEntryMetadata {
  readonly createdAt: Date;
  readonly id: WorkspaceEntryId;
  readonly name: string;
  readonly updatedAt: Date;
  readonly workspaceId: WorkspaceId;
}

export interface WorkspaceFile
  extends FileRepresentation,
    WorkspaceEntryMetadata {
  readonly extension: string | null;
  readonly kind: FileKind;
}

export type WorkspaceEntry =
  | WorkspaceFile
  | (Exclude<StorageEntry, { readonly type: "file" }> & WorkspaceEntryMetadata);

/** A committed catalog change. Deletes carry the last known entry. */
export interface WorkspaceChange {
  readonly action: "add" | "change" | "delete";
  readonly entry: WorkspaceEntry;
}

/**
 * What a caller outside the trust boundary may see. The root path and the
 * source reference stay behind the system; the kind survives as a label.
 */
export interface WorkspaceSummary {
  readonly createdAt: Date;
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
 * `digest` is computed from the exact byte sequence this read decoded and
 * sized — never copied from the catalog, whose observation may predate an
 * external change. It is the version a later save must present as expected.
 */
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

/**
 * One File save: identity, the complete UTF-8 draft, and the digest of
 * the exact bytes the caller last read. Never a path.
 */
export interface SaveFileCommand {
  readonly expectedDigest: string;
  readonly fileId: WorkspaceEntryId;
  readonly text: string;
}

/** One new File: a root-relative path and its complete UTF-8 text. */
export interface CreateFileCommand {
  readonly path: string;
  readonly text: string;
}

/** The source text after a read or write, versioned by its own digest. */
export interface FileTextSnapshot extends Pick<FileNode, "digest" | "bytes"> {
  readonly text: string;
}

/**
 * The closed write outcomes, shared by save and create.
 *
 * `saved` is computed from the bytes actually written; `catalog` reports
 * whether the catalog also caught up (`refresh-required` means the bytes are
 * at the source but the catalog needs ordinary reconciliation — the caller
 * must adopt the snapshot and never resend the bytes). `conflict` carries the
 * current source snapshot so recovery is an explicit choice. `stale` means
 * the File is no longer representable as writable text (gone, a directory, a
 * symlink, or binary). `failed` guarantees this command left the original
 * source bytes unchanged.
 */
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

/**
 * What a layer's write reports back. The layer owns the conflict check
 * because it already holds the current bytes; the root turns `written` into
 * the saved snapshot and the catalog update.
 */
export type WriteOutcome =
  | { readonly kind: "written"; readonly application?: "pending" }
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

/** One catalog change, applied or refused as a whole. */
export interface WorkspaceCatalogChange {
  /** The rows removed, as last known. */
  readonly deleted: readonly WorkspaceEntry[];
  readonly inserted: readonly WorkspaceEntry[];
  readonly updated: readonly WorkspaceEntry[];
}

/**
 * One layer the system may wrap around a Workspace at open.
 *
 * `applies` is asked with the registration alone; `wrap` is a class mixin.
 * Layers are applied in registration order, each extending the class the
 * previous one returned, so `super` runs the whole chain. The layer that
 * answers `scan`/`readFile`/`writeFile` must come first for its source;
 * anything after it only adds.
 *
 * The three type parameters are what the system accumulates through
 * `extend`, so a composed system's `load` and `open` are typed by the layers
 * it holds:
 *
 * - `Ref` — what `load` accepts for this layer's source (`{ path }`). Only a
 *   floor has one; `ref` names the key the system dispatches on.
 * - `Floor` — what `load(ref)` returns beyond the root (`DirectoryCapable`).
 * - `Cap` — what every opened Workspace carries. A layer that applies per
 *   record declares it optional (`{ git?: Git }`).
 */
export interface WorkspaceExtension<
  Ref extends object = never,
  Floor = unknown,
  Cap = unknown,
> {
  applies: (registration: WorkspaceRegistration) => Promise<boolean> | boolean;
  identify?(ref: Ref): Promise<WorkspaceIdentity> | WorkspaceIdentity;
  readonly name: string;
  /** The key of `Ref` that names this layer's source. Absent on an additive layer. */
  readonly ref?: string;
  /** Never set; carries `Floor` and `Cap` for the system's typing. */
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

/** What every Workspace a system opens carries: the intersection of each layer's `Cap`. */
export type CapOf<Exts extends readonly AnyWorkspaceExtension[]> =
  UnionToIntersection<
    Exts[number] extends infer E
      ? E extends WorkspaceExtension<never, unknown, infer Cap>
        ? unknown extends Cap
          ? never // a layer with no `Cap` would absorb the union
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

/** What a filesystem's `resolve` hands back for a ref. */
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
  /** An authoritative inventory bypasses filesystem ignore rules and byte hashing. */
  tree?(root: string): Promise<StorageTree>;
}

/** What every instance shares with the system that made it. */
export interface WorkspaceContext {
  /** Owns every rule over the catalog and publishes what it commits. */
  readonly catalog: WorkspaceCatalog;
  /** Tells the system an instance is finished with, so it stops and forgets it. */
  readonly close: (workspaceId: WorkspaceId) => Promise<void>;
  /** Receives background failures no caller is waiting on. */
  readonly report: (error: unknown) => void;
  /**
   * Runs `task` after every observation, save, and removal already queued for
   * this Workspace. The queue belongs to the system, not the instance: an
   * instance reopened while its predecessor's work is still in flight must
   * wait behind it, or two scans of one source commit the same arrival twice.
   * A scan that read pre-write bytes must not commit after a save's own
   * catalog update either. In-process only; a second system over the same
   * store remains the documented collision case.
   */
  readonly serialize: <T>(
    workspaceId: WorkspaceId,
    task: () => Promise<T>
  ) => Promise<T>;
}

/**
 * What a layer extends. Every layer takes `(registration, context)`; the rest
 * signature is TypeScript's requirement for a mixin base (TS2545), not a
 * looser contract.
 */
// biome-ignore lint/suspicious/noExplicitAny: The generic mixin constructor requires an any[] rest parameter under TS2545.
export type WorkspaceCtor<T = Workspace> = new (...args: any[]) => T;

/**
 * Git-compatible ignore evaluation over a stack of `.gitignore` files.
 *
 * Each entry in the stack is scoped to the directory that declared it, which is
 * what makes a nested `.gitignore` apply to its own subtree only.
 */
export interface IgnoreScope {
  /** POSIX path of the declaring directory, relative to the Workspace root. */
  readonly base: string;
  readonly matcher: Ignore;
}

export interface WalkedEntry {
  /**
   * Built from the raw entry names the source reported, never from
   * `relativePath` — a normalized spelling is not guaranteed to be openable on
   * a filesystem that stores names decomposed.
   */
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly type: StorageNode["type"];
}

/**
 * Why one incomplete observation failed, as a caller-facing distinction:
 * the source itself is gone, a part of it refused to be read, or the walk
 * broke for some other reason. Reconciliation reports one of these beside the
 * preserved prior catalog instead of throwing the whole operation away.
 */
export type WorkspaceSourceIssue = "unavailable" | "unreadable" | "scan-failed";
