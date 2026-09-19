import type {
  AtomicStorageWriter,
  FileNode,
  FileRepresentation,
  StorageEntry,
  StorageNode,
  StorageObserver,
  StorageReader,
} from "@foundry/core/storage";
import type { Ignore } from "ignore";
import type { z } from "zod";
import type { Workspace } from "./instance";
import type {
  FILE_KINDS,
  workspaceEntryIdSchema,
  workspaceIdSchema,
} from "./workspace";

export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

export type WorkspaceEntryId = z.infer<typeof workspaceEntryIdSchema>;

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

/** The source text after a read or write, versioned by its own digest. */
export interface FileTextSnapshot extends Pick<FileNode, "digest" | "bytes"> {
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
 * a directory, a symlink, or binary). `failed` guarantees
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

export interface WorkspaceView {
  readonly entries: readonly WorkspaceEntry[];
  readonly source: WorkspaceSourceStatus;
  readonly workspace: WorkspaceSummary;
}

export interface FileClassification extends Pick<FileNode, "mime"> {
  readonly extension: string | null;
  readonly kind: FileKind;
  readonly name: string;
}

/**
 * Store-owned Workspace state. The `source`/`sourceId`/`path` triple is the
 * persistence encoding of the domain's `WorkspaceSource`; the system converts
 * between the two and never leaks this shape outward.
 */
export interface StoredWorkspaceRecord {
  readonly createdAt: Date;
  readonly description: string | null;
  readonly documentation: string | null;
  readonly id: WorkspaceId;
  readonly lastReconciledAt: Date;
  readonly name: string;
  readonly path: string;
  /** The string the layer that owns this source claims. */
  readonly source: string;
  readonly sourceId: string | null;
  readonly updatedAt: Date;
}

export type ObservedFacts =
  | (FileRepresentation & FileClassification)
  | (Exclude<StorageEntry, { readonly type: "file" }> & {
      readonly name: string;
    });

/**
 * `workspace-exists` names the Workspace already registered for this source —
 * matched on the canonical root, or on a non-null source reference. One source
 * cannot have two competing catalogs, so both spellings of "already taken"
 * resolve to the incumbent rather than failing.
 */
export type CommitCreateResult =
  | { readonly kind: "committed" }
  | { readonly kind: "workspace-exists"; readonly existingId: WorkspaceId };

/** One reconciliation's exact diff, applied or not applied as a whole. */
export interface WorkspaceCatalogChange {
  readonly deletedIds: readonly WorkspaceEntryId[];
  readonly inserted: readonly WorkspaceEntry[];
  readonly updated: readonly WorkspaceEntry[];
}

export type CommitReconcileResult =
  | { readonly kind: "committed" }
  | { readonly kind: "workspace-not-found" }
  | { readonly kind: "conflict"; readonly reason: string };

/**
 * Refusals are explicit: a missing Workspace or File, or a row whose stored
 * path no longer matches the observation's, must never become an insert or a
 * replacement row.
 */
export type CommitFileObservationResult =
  | { readonly kind: "committed" }
  | { readonly kind: "workspace-not-found" }
  | { readonly kind: "file-not-found" }
  | { readonly kind: "path-mismatch" };

export type RemoveWorkspaceResult =
  | { readonly kind: "removed" }
  | { readonly kind: "not-found" };

/**
 * Persistence capability consumed by WorkspaceSystem.
 *
 * Implementations store canonical records and own atomicity. They do not
 * canonicalize paths, scan sources, classify content, match moves, or choose
 * domain errors — that is WorkspaceSystem behavior.
 */
export interface WorkspaceStore {
  /** Run after the outer transaction commits; discard on rollback. Run immediately without a transaction. */
  afterCommit: (callback: () => void) => void;

  /** Inserts one Workspace and its complete initial catalog together. */
  commitCreate: (input: {
    readonly workspace: StoredWorkspaceRecord;
    readonly entries: readonly WorkspaceEntry[];
  }) => Promise<CommitCreateResult>;

  /**
   * Records what one successful source write observed about one File — the
   * facts of the bytes just written, applied atomically to the existing row.
   * Not a content store, not a second reconciliation, and never an identity
   * allocator: it refuses rather than inserting.
   */
  commitFileObservation: (input: {
    readonly workspaceId: WorkspaceId;
    readonly fileId: WorkspaceEntryId;
    readonly observed: Extract<ObservedFacts, { readonly type: "file" }>;
    readonly updatedAt: Date;
  }) => Promise<CommitFileObservationResult>;

  /** Applies one reconciliation diff, or none of it. */
  commitReconcile: (input: {
    readonly workspaceId: WorkspaceId;
    /** Set only when the observation changed the File catalog. */
    readonly updatedAt?: Date;
    readonly lastReconciledAt: Date;
    readonly change: WorkspaceCatalogChange;
  }) => Promise<CommitReconcileResult>;
  countFiles: (workspaceId: WorkspaceId) => Promise<number>;
  /** Looks a Workspace up by its canonical root, which is unique per source. */
  findWorkspaceByPath: (path: string) => Promise<StoredWorkspaceRecord | null>;
  getEntry: (
    workspaceId: WorkspaceId,
    entryId: WorkspaceEntryId
  ) => Promise<WorkspaceEntry | null>;
  getWorkspace: (
    workspaceId: WorkspaceId
  ) => Promise<StoredWorkspaceRecord | null>;
  listEntries: (workspaceId: WorkspaceId) => Promise<readonly WorkspaceEntry[]>;
  listWorkspaces: () => Promise<readonly StoredWorkspaceRecord[]>;

  removeWorkspace: (workspaceId: WorkspaceId) => Promise<RemoveWorkspaceResult>;

  renameWorkspace: (
    workspaceId: WorkspaceId,
    name: string,
    updatedAt: Date
  ) => Promise<StoredWorkspaceRecord | null>;
}

export type WorkspaceIdentity = Pick<
  StoredWorkspaceRecord,
  "name" | "source" | "sourceId" | "path"
>;

/**
 * One layer the system may wrap around a Workspace at open.
 *
 * `applies` is asked with the stored record alone; `wrap` is a class mixin.
 * Layers are applied in registration order, each extending the class the
 * previous one returned, so `super` runs the whole chain. The layer that
 * answers `scan`/`readFile`/`writeFile` must come first for its source;
 * anything after it only adds.
 *
 * The three type parameters are what the system accumulates through
 * `extend`, so a composed system's `add` and `open` are typed by the layers
 * it holds:
 *
 * - `Ref` — what `add` accepts for this layer's source (`{ path }`). Only a
 *   floor has one; `ref` names the key the system dispatches on.
 * - `Floor` — what `add(ref)` returns beyond the root (`DirectoryCapable`).
 * - `Cap` — what every opened Workspace carries. A layer that applies per
 *   record declares it optional (`{ git?: Git }`).
 */
export interface WorkspaceExtension<
  Ref extends object = never,
  Floor = unknown,
  Cap = unknown,
> {
  applies: (record: StoredWorkspaceRecord) => Promise<boolean> | boolean;
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

export interface WorkspaceFileSystem
  extends StorageReader,
    AtomicStorageWriter,
    Partial<StorageObserver> {}

/**
 * What every instance shares with the system that made it.
 *
 * The two maps are the system's, never the instance's: two instances of the
 * same id must join the same running observation and the same save/scan
 * chain, or the serialization guarantee below is silently lost.
 */
export interface WorkspaceContext {
  readonly changed?: (change: WorkspaceChange) => void;
  /** Tells the system an instance is finished with, so it stops and forgets it. */
  readonly close: (workspaceId: WorkspaceId) => Promise<void>;
  /** The observation currently running for a Workspace, if any. */
  readonly observing: Map<WorkspaceId, Promise<WorkspaceSourceStatus>>;
  /**
   * Per-Workspace exclusion shared by observations and saves. A scan that
   * read pre-write bytes must not commit after a save's targeted observation
   * — serializing both makes the save's facts land in a gap no stale broad
   * commit can close. In-process only; a second system over the same store
   * remains the documented persistence-collision case.
   */
  readonly serialized: Map<WorkspaceId, Promise<void>>;
  readonly store: WorkspaceStore;
}

/**
 * What a layer extends. Every layer takes `(record, context)`; the rest
 * signature is TypeScript's requirement for a mixin base (TS2545), not a
 * looser contract.
 */
// biome-ignore lint/suspicious/noExplicitAny: The generic mixin constructor requires an any[] rest parameter under TS2545.
export type WorkspaceCtor<T = Workspace> = new (...args: any[]) => T;

export interface WorkspaceSystemOptions {
  readonly store?: WorkspaceStore;
}

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
