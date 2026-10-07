import type { StorageSubscription } from "@foundry/core/storage";
import { isStoragePath } from "@foundry/core/storage";
import { sha256Hex } from "@foundry/lib/digest";
import { decodeText } from "@foundry/lib/encoding";
import {
  InvalidWorkspaceInputError,
  WorkspaceFileNotFoundError,
  WorkspaceNotFoundError,
  WorkspacePersistenceError,
  WorkspaceSourceUnavailableError,
  WorkspaceSourceUnsupportedError,
} from "./errors";
import { nextWorkspaceObservation, observe } from "./observation";
import { diffCatalog, isEmptyChange, newEntryId } from "./reconcile";
import type {
  CreateFileCommand,
  FileContentResult,
  FileTextSnapshot,
  ObservedFacts,
  SaveFileCommand,
  SaveFileResult,
  WorkspaceContext,
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceFile,
  WorkspaceId,
  WorkspaceRegistration,
  WorkspaceSource,
  WorkspaceSourceStatus,
  WorkspaceSummary,
  WorkspaceView,
  WriteOutcome,
} from "./types";

type CatalogState = "current" | "refresh-required";

/**
 * The root of every Workspace: identity, catalog, reconciliation, and the
 * serialization guarantee. It knows nothing about where bytes come from.
 * A layer over it (a directory, an Artifact) answers `scan`, `readFile`, and
 * `writeFile`; further layers add capabilities on top.
 *
 * Not declared `abstract`, though the source primitives are abstract in every
 * sense that matters: TypeScript would then require every mixin to be
 * abstract too, and nothing could construct the composed class. The system
 * checks for a floor at open instead.
 *
 * Identity and source are fixed at construction; everything else is read
 * from the catalog on every call, so an instance never goes stale and two
 * instances of the same id never disagree.
 */
export class Workspace {
  readonly id: WorkspaceId;
  readonly source: WorkspaceSource;
  protected readonly context: WorkspaceContext;
  private observation: StorageSubscription | undefined;

  constructor(registration: WorkspaceRegistration, context: WorkspaceContext) {
    this.id = registration.id;
    this.source = registration.source;
    this.context = context;
  }

  /** The system's entry to the protected lifecycle hooks. Nothing else calls these. */
  static start(workspace: Workspace): Promise<void> {
    return workspace.start();
  }

  static stop(workspace: Workspace): Promise<void> {
    return workspace.stop();
  }

  /** True once a layer has answered the source primitives. */
  static hasFloor(workspace: Workspace): boolean {
    return workspace.scan !== Workspace.prototype.scan;
  }

  /** The complete entry inventory; only regular files carry content metadata. */
  scan(): Promise<readonly ObservedFacts[]> {
    return Promise.reject(
      new WorkspaceSourceUnsupportedError(this.source.kind)
    );
  }

  /** Current bytes for one catalogued File, decoded. */
  protected readFile(_file: WorkspaceFile): Promise<FileContentResult> {
    return Promise.reject(
      new WorkspaceSourceUnsupportedError(this.source.kind)
    );
  }

  /**
   * Replace one File's bytes when the source still holds the bytes the caller
   * last read. `expectedDigest` is that version; a mismatch is the conflict
   * outcome carrying what is there now.
   */
  protected writeFile(
    _file: WorkspaceFile,
    _bytes: Uint8Array,
    _expectedDigest: string
  ): Promise<WriteOutcome> {
    return Promise.reject(
      new WorkspaceSourceUnsupportedError(this.source.kind)
    );
  }

  /** Create one File at a valid storage path that nothing occupies yet. */
  protected insertFile(
    _path: string,
    _bytes: Uint8Array
  ): Promise<WriteOutcome> {
    return Promise.reject(
      new WorkspaceSourceUnsupportedError(this.source.kind)
    );
  }

  /** Runs once when the system opens this instance. Layers call `super`. */
  protected async start(): Promise<void> {
    this.observation = await observe(
      (changed, failed) => this.watch(changed, failed),
      () => this.reconcile(),
      this.context.report
    );
  }

  /** Runs once when the system closes this instance. Layers call `super`. */
  protected async stop(): Promise<void> {
    await this.observation?.close();
    this.observation = undefined;
  }

  protected watch(
    _changed: () => void,
    _failed: (error: unknown) => void
  ): Promise<StorageSubscription | undefined> {
    return Promise.resolve(undefined);
  }

  /** The registration alone. Cheap, always current, and never scans. */
  registration(): Promise<WorkspaceRegistration> {
    return this.require();
  }

  /** What a caller outside the trust boundary may see. */
  async summary(): Promise<WorkspaceSummary> {
    return summarize(
      await this.require(),
      await this.context.catalog.countFiles(this.id)
    );
  }

  /**
   * Reconcile, then return the Workspace with the catalog that observation
   * produced.
   *
   * A source problem is reported beside the preserved prior catalog. Opening a
   * Workspace whose directory is unplugged must still show what was last known
   * — marking every File absent would turn a temporary outage into data loss.
   */
  async refresh(): Promise<WorkspaceView> {
    await this.require();
    const source = await this.reconcile();

    // One read of the rows answers both the catalog and its count, so the
    // view's `fileCount` can never disagree with its own entries.
    const current = await this.require();
    const entries = await this.context.catalog.listEntries(this.id);
    return {
      entries,
      source,
      workspace: summarize(
        current,
        entries.filter((entry) => entry.type === "file").length
      ),
    };
  }

  async rename(name: string): Promise<WorkspaceRegistration> {
    const renamed = await this.context.catalog.rename(
      this.id,
      normalizeWorkspaceName(name),
      new Date()
    );
    if (!renamed) {
      throw new WorkspaceNotFoundError(this.id);
    }
    return renamed;
  }

  /**
   * Forget this Workspace. The source is never touched — no unlink, no rmdir,
   * no delete of any kind reaches it from here.
   */
  async remove(): Promise<void> {
    await this.serialize(async () => {
      const result = await this.context.catalog.remove(this.id);
      if (result.kind === "not-found") {
        throw new WorkspaceNotFoundError(this.id);
      }
    });
    await this.context.close(this.id);
  }

  async files(): Promise<readonly WorkspaceFile[]> {
    const entries = await this.entries();
    return entries.filter(
      (entry): entry is WorkspaceFile => entry.type === "file"
    );
  }

  async entries(): Promise<readonly WorkspaceEntry[]> {
    await this.require();
    return this.context.catalog.listEntries(this.id);
  }

  /**
   * Current bytes for one owned File. Identity is the only input: a caller
   * names a File, never a path.
   */
  async read(fileId: WorkspaceEntryId): Promise<FileContentResult> {
    await this.require();
    const entry = await this.catalogEntry(fileId);
    return entry.type === "file" ? this.readFile(entry) : notRegular(entry);
  }

  /**
   * Replace one File's bytes with the command's UTF-8 draft.
   *
   * The expected digest is the version of the exact bytes the caller last
   * read. The write and its catalog update are serialized with this system's
   * own observations so a concurrent reconciliation cannot restore pre-write
   * facts.
   */
  save(command: SaveFileCommand): Promise<SaveFileResult> {
    return this.serialize(async () => {
      const workspace = await this.require();
      const file = await this.catalogEntry(command.fileId);
      if (file.type !== "file") {
        return notRegular(file);
      }
      return this.write(
        file.path,
        command.text,
        (bytes) => this.writeFile(file, bytes, command.expectedDigest),
        (snapshot) => this.recordWrite(workspace, file, snapshot)
      );
    });
  }

  /**
   * Create one File from UTF-8 text. Whether a new path joins the catalog is
   * the scan's decision — ignore rules live there — so the catalog catches up
   * through an ordinary observation rather than a one-row insert.
   */
  createFile(command: CreateFileCommand): Promise<SaveFileResult> {
    return this.serialize(async () => {
      const workspace = await this.require();
      if (!isStoragePath(command.path)) {
        return { kind: "failed", reason: "Invalid relative storage path" };
      }
      return this.write(
        command.path,
        command.text,
        (bytes) => this.insertFile(command.path, bytes),
        async () =>
          (await this.observeSource(workspace)).kind === "reconciled"
            ? "current"
            : "refresh-required"
      );
    });
  }

  /**
   * The one write flow behind save and create.
   *
   * The draft is encoded first and refused when those bytes would not decode
   * back to text, so the returned snapshot is truthful about the bytes at the
   * source (a draft containing NUL would turn the File binary and break every
   * later read/save round-trip). Once the layer reports `written`, the bytes
   * are at the source: a catalog that cannot catch up is `refresh-required`,
   * never a failed write and never an invitation to resend.
   */
  private async write(
    path: string,
    text: string,
    put: (bytes: Uint8Array) => Promise<WriteOutcome>,
    record: (snapshot: FileTextSnapshot) => Promise<CatalogState>
  ): Promise<SaveFileResult> {
    const bytes = new TextEncoder().encode(text);
    const written = decodeText(bytes);
    if (written === null) {
      return {
        kind: "failed",
        reason: `The draft for ${path} cannot be saved as UTF-8 text`,
      };
    }

    const outcome = await put(bytes);
    if (outcome.kind !== "written") {
      return outcome;
    }

    const snapshot: FileTextSnapshot = {
      bytes: bytes.byteLength,
      digest: await sha256Hex(bytes),
      text: written,
    };
    if (outcome.application === "pending") {
      return {
        application: "pending",
        catalog: "refresh-required",
        kind: "saved",
        snapshot,
      };
    }
    const catalog = await record(snapshot).catch(
      (): CatalogState => "refresh-required"
    );
    return { catalog, kind: "saved", snapshot };
  }

  /** The one-File catalog update after a successful replacement. */
  private async recordWrite(
    workspace: WorkspaceRegistration,
    file: WorkspaceFile,
    snapshot: FileTextSnapshot
  ): Promise<CatalogState> {
    if (file.digest === snapshot.digest && file.bytes === snapshot.bytes) {
      return "current";
    }
    const updatedAt = nextWorkspaceObservation(workspace.lastReconciledAt);
    const result = await this.context.catalog.applyChange({
      change: {
        deleted: [],
        inserted: [],
        updated: [
          {
            ...file,
            bytes: snapshot.bytes,
            digest: snapshot.digest,
            updatedAt,
          },
        ],
      },
      updatedAt,
      workspaceId: this.id,
    });
    return result.kind === "committed" ? "current" : "refresh-required";
  }

  /**
   * One observation, queued behind every save and observation already
   * pending, reading the registration only once it runs. A caller that
   * changed the source and then refreshes therefore always gets a scan that
   * began after its change — never one already in flight.
   */
  private reconcile(): Promise<WorkspaceSourceStatus> {
    return this.serialize(async () => this.observeSource(await this.require()));
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    return this.context.serialize(this.id, task);
  }

  /**
   * One complete observation applied as one catalog change.
   *
   * The scan finishes entirely before the catalog is touched, so a source that
   * failed halfway through never reaches a mutation. The catalog refuses a
   * change that no longer matches its rows and leaves the prior catalog exact.
   */
  private async observeSource(
    workspace: WorkspaceRegistration
  ): Promise<WorkspaceSourceStatus> {
    let candidates: readonly ObservedFacts[];
    try {
      candidates = await this.scan();
    } catch (error) {
      if (error instanceof WorkspaceSourceUnavailableError) {
        return { kind: error.issue, reason: error.message };
      }
      throw error;
    }

    // Freshness records a successful observation, so two observations in the
    // same clock tick still have a strict order. Catalog timestamps retain the
    // same value only when an actual File change is committed.
    const at = nextWorkspaceObservation(workspace.lastReconciledAt);
    const change = diffCatalog({
      at,
      candidates,
      existing: await this.context.catalog.listEntries(workspace.id),
      newEntryId,
      workspaceId: workspace.id,
    });
    const result = await this.context.catalog.applyChange({
      change,
      lastReconciledAt: at,
      ...(isEmptyChange(change) ? {} : { updatedAt: at }),
      workspaceId: workspace.id,
    });
    if (result.kind === "conflict") {
      throw new WorkspacePersistenceError(
        `Could not reconcile Workspace ${workspace.id}`,
        { cause: result.reason }
      );
    }
    if (result.kind === "workspace-not-found") {
      throw new WorkspaceNotFoundError(workspace.id);
    }
    return { kind: "reconciled" };
  }

  private async catalogEntry(
    entryId: WorkspaceEntryId
  ): Promise<WorkspaceEntry> {
    const entry = await this.context.catalog.getEntry(this.id, entryId);
    if (!entry) {
      throw new WorkspaceFileNotFoundError(this.id, entryId);
    }
    return entry;
  }

  private async require(): Promise<WorkspaceRegistration> {
    const registration = await this.context.catalog.getWorkspace(this.id);
    if (!registration) {
      throw new WorkspaceNotFoundError(this.id);
    }
    return registration;
  }
}

function notRegular(entry: WorkspaceEntry): {
  readonly kind: "stale";
  readonly reason: string;
} {
  return {
    kind: "stale",
    reason: `${entry.path} is a ${entry.type}, not a regular file`,
  };
}

function summarize(
  workspace: WorkspaceRegistration,
  fileCount: number
): WorkspaceSummary {
  return {
    createdAt: workspace.createdAt,
    fileCount,
    id: workspace.id,
    lastReconciledAt: workspace.lastReconciledAt,
    name: workspace.name,
    sourceKind: workspace.source.kind,
    updatedAt: workspace.updatedAt,
  };
}

function normalizeWorkspaceName(value: string): string {
  const name = value.trim();
  if (name.length === 0) {
    throw new InvalidWorkspaceInputError("Workspace name cannot be empty");
  }
  return name;
}
