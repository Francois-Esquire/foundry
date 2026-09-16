import {
  InvalidWorkspaceInputError,
  WorkspaceFileNotFoundError,
  WorkspaceNotFoundError,
  WorkspacePersistenceError,
  WorkspaceSourceUnavailableError,
  WorkspaceSourceUnsupportedError,
} from "./errors";
import { sha256Hex } from "./filesystem";
import { createFileRecord, diffCatalog, isEmptyChange } from "./reconcile";
import type { FileCandidate } from "./scanner";
import { decodeUtf8 } from "./text";
import type {
  FileContentResult,
  FileTextSnapshot,
  SaveFileCommand,
  SaveFileResult,
  WorkspaceFile,
  WorkspaceFileId,
  WorkspaceId,
  WorkspaceRegistration,
  WorkspaceSource,
  WorkspaceSourceStatus,
  WorkspaceSummary,
  WorkspaceView,
  WriteOutcome,
} from "./workspace";
import { workspaceSummary } from "./workspace";
import type {
  StoredFileRecord,
  StoredWorkspaceRecord,
  WorkspaceStore,
} from "./workspace-store";
import { nextWorkspaceObservation } from "./workspace-store";

/**
 * What every instance shares with the system that made it.
 *
 * The two maps are the system's, never the instance's: two instances of the
 * same id must join the same running observation and the same save/scan
 * chain, or the serialization guarantee below is silently lost.
 */
export interface WorkspaceContext {
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

/**
 * The root of every Workspace: identity, catalog, reconciliation, and the
 * serialization guarantee. It knows nothing about where bytes come from.
 * A layer over it (a directory, an Artifact) answers `scan`, `readFile`, and
 * `writeFile`; further layers add capabilities on top.
 *
 * Not declared `abstract`, though the three source primitives are abstract
 * in every sense that matters: TypeScript would then require every mixin
 * to be abstract too, and nothing could construct the composed class. The
 * system checks for a floor at open instead.
 *
 * Identity and source are fixed at construction; everything else is read
 * from the store on every call, so an instance never goes stale and two
 * instances of the same id never disagree.
 */
export class Workspace {
  readonly id: WorkspaceId;
  readonly source: WorkspaceSource;
  protected readonly context: WorkspaceContext;

  constructor(record: StoredWorkspaceRecord, context: WorkspaceContext) {
    this.id = record.id;
    this.source = toRegistration(record).source;
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

  /** The complete inventory of the source, with checksums and sizes; no bytes are kept. */
  scan(): Promise<readonly FileCandidate[]> {
    return Promise.reject(
      new WorkspaceSourceUnsupportedError(this.source.kind)
    );
  }

  /** Current bytes for one catalogued File, decoded. */
  protected readFile(_file: StoredFileRecord): Promise<FileContentResult> {
    return Promise.reject(
      new WorkspaceSourceUnsupportedError(this.source.kind)
    );
  }

  /**
   * Replace one File's bytes when the source still holds the bytes the caller
   * last read. `expectedChecksum` is that version; a mismatch is the conflict
   * outcome carrying what is there now.
   */
  protected writeFile(
    _file: StoredFileRecord,
    _bytes: Uint8Array,
    _expectedChecksum: string
  ): Promise<WriteOutcome> {
    return Promise.reject(
      new WorkspaceSourceUnsupportedError(this.source.kind)
    );
  }

  /** Runs once when the system opens this instance. Layers call `super`. */
  protected start(): Promise<void> {
    return Promise.resolve();
  }

  /** Runs once when the system closes this instance. Layers call `super`. */
  protected stop(): Promise<void> {
    return Promise.resolve();
  }

  /** The registration alone. Cheap, always current, and never scans. */
  async registration(): Promise<WorkspaceRegistration> {
    return toRegistration(await this.require());
  }

  /** What a caller outside the trust boundary may see. */
  async summary(): Promise<WorkspaceSummary> {
    const record = await this.require();
    return workspaceSummary(
      toRegistration(record),
      await this.context.store.countFiles(record.id)
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
    const workspace = await this.require();
    const source = await this.reconcile(workspace);

    // One read of the rows answers both the catalog and its count. Asking the
    // store twice would let a concurrent writer land between them and produce
    // a view whose `fileCount` disagrees with its own `files`.
    const current = await this.require();
    const rows = await this.context.store.listFiles(this.id);
    return {
      files: rows.map(toWorkspaceFile),
      source,
      workspace: workspaceSummary(toRegistration(current), rows.length),
    };
  }

  async rename(name: string): Promise<WorkspaceRegistration> {
    const renamed = await this.context.store.renameWorkspace(
      this.id,
      normalizeWorkspaceName(name),
      new Date()
    );
    if (!renamed) {
      throw new WorkspaceNotFoundError(this.id);
    }
    return toRegistration(renamed);
  }

  /**
   * Forget this Workspace. The source is never touched — no unlink, no rmdir,
   * no delete of any kind reaches it from here.
   */
  async remove(): Promise<void> {
    const result = await this.context.store.removeWorkspace(this.id);
    if (result.kind === "not-found") {
      throw new WorkspaceNotFoundError(this.id);
    }
    await this.context.close(this.id);
  }

  async files(): Promise<readonly WorkspaceFile[]> {
    await this.require();
    const rows = await this.context.store.listFiles(this.id);
    return rows.map(toWorkspaceFile);
  }

  /**
   * Current bytes for one owned File. Identity is the only input: a caller
   * names a File, never a path.
   */
  async read(fileId: WorkspaceFileId): Promise<FileContentResult> {
    await this.require();
    const file = await this.context.store.getFile(this.id, fileId);
    if (!file) {
      throw new WorkspaceFileNotFoundError(this.id, fileId);
    }
    return this.readFile(file);
  }

  /**
   * Replace one File's bytes with the command's UTF-8 draft — the only write
   * this package performs against a source.
   *
   * The expected checksum is the version of the exact bytes the caller last
   * read. The write and its catalog observation are serialized with this
   * system's own observations so a concurrent reconciliation cannot restore
   * pre-write facts; a second system over the same store can still interleave
   * (documented optimistic concurrency, G-04).
   */
  // biome-ignore lint/suspicious/useAwait: Keep synchronous failures as rejected promises under the asynchronous public contract.
  async save(command: SaveFileCommand): Promise<SaveFileResult> {
    return this.serialize(() => this.performSave(command));
  }

  private async performSave(command: SaveFileCommand): Promise<SaveFileResult> {
    const workspace = await this.require();
    const file = await this.context.store.getFile(this.id, command.fileId);
    if (!file) {
      throw new WorkspaceFileNotFoundError(this.id, command.fileId);
    }

    // The returned snapshot must be truthful about the bytes at the source, so
    // the draft is encoded first and the write is refused when those bytes
    // would not decode back to text (a draft containing NUL would turn the
    // File binary and break every later read/save round-trip).
    const bytes = new TextEncoder().encode(command.text);
    const written = decodeUtf8(bytes);
    if (written === null) {
      return {
        kind: "failed",
        reason: `The draft for ${file.path} cannot be saved as UTF-8 text`,
      };
    }

    const outcome = await this.writeFile(file, bytes, command.expectedChecksum);
    if (outcome.kind !== "written") {
      return outcome;
    }

    const snapshot: FileTextSnapshot = {
      checksum: sha256Hex(bytes),
      size: bytes.byteLength,
      text: written,
    };
    return {
      catalog: await this.recordWrite(workspace, file, snapshot),
      kind: "saved",
      snapshot,
    };
  }

  /**
   * The one-File catalog observation after a successful replacement. The
   * bytes are already at the source, so any refusal or failure here is
   * truthfully `refresh-required` — never a failed save, and never a byte
   * retry; the caller schedules ordinary reconciliation.
   */
  private async recordWrite(
    workspace: StoredWorkspaceRecord,
    file: StoredFileRecord,
    snapshot: FileTextSnapshot
  ): Promise<"current" | "refresh-required"> {
    try {
      const result = await this.context.store.commitFileObservation({
        fileId: file.id,
        observed: {
          checksum: snapshot.checksum,
          extension: file.extension,
          kind: file.kind,
          mimeType: file.mimeType,
          name: file.name,
          path: file.path,
          size: snapshot.size,
        },
        updatedAt: nextWorkspaceObservation(workspace.lastReconciledAt),
        workspaceId: workspace.id,
      });
      return result.kind === "committed" ? "current" : "refresh-required";
    } catch {
      // The store's own words may carry the absolute database path; they stay
      // out of the result entirely — the outcome alone says what to do next.
      return "refresh-required";
    }
  }

  /**
   * One observation per Workspace at a time.
   *
   * Two overlapping observations both see the same arrival missing, both
   * allocate an id for it, and the second commit collides on the unique
   * `(workspaceId, path)` pair — surfacing as a persistence exception, which
   * is precisely the shape this milestone refuses for source-side trouble.
   * A renderer that opens and refreshes together reaches that today, so the
   * second caller joins the observation already running instead.
   */
  private reconcile(
    workspace: StoredWorkspaceRecord
  ): Promise<WorkspaceSourceStatus> {
    const { observing } = this.context;
    const running = observing.get(this.id);
    if (running) {
      return running;
    }

    const started = this.serialize(() => this.observeSource(workspace)).finally(
      () => {
        observing.delete(this.id);
      }
    );
    observing.set(this.id, started);
    return started;
  }

  /** Chains one task after whatever observation or save currently runs. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const { serialized } = this.context;
    const previous = serialized.get(this.id) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    serialized.set(this.id, tail);
    // biome-ignore lint/complexity/noVoid: The serialized queue tail handles both outcomes; cleanup must not delay the caller.
    void tail.then(() => {
      if (serialized.get(this.id) === tail) {
        serialized.delete(this.id);
      }
    });
    return run;
  }

  /**
   * One complete observation applied as one catalog.
   *
   * The scan finishes entirely before the store is touched, so a source that
   * failed halfway through never reaches a mutation. The rows are reloaded as
   * late as possible for the same reason. That reload and the commit are not
   * one transaction — the store contract takes a computed change, so identity
   * policy stays here rather than moving into the store. What the store does
   * guarantee is that the change applies whole or not at all, and that its own
   * path and ownership rules reject a diff it cannot accept, leaving the prior
   * catalog exact. The guard above prevents a race between two observations of
   * this system instance; a second system over the same database — another
   * process, or a rebuilt one — can still collide here, and that surfaces as a
   * persistence failure rather than a source status.
   */
  private async observeSource(
    workspace: StoredWorkspaceRecord
  ): Promise<WorkspaceSourceStatus> {
    let candidates: readonly FileCandidate[];
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
      existing: await this.context.store.listFiles(workspace.id),
      newFileId: () => crypto.randomUUID() as WorkspaceFileId,
      workspaceId: workspace.id,
    });
    const result = await this.context.store.commitReconcile({
      workspaceId: workspace.id,
      ...(isEmptyChange(change) ? {} : { updatedAt: at }),
      change,
      lastReconciledAt: at,
    });
    if (result.kind === "conflict") {
      // The reason is the store's own words — for SQLite, the driver's message,
      // which embeds the absolute database path. It travels as a cause for the
      // log and never as message text that could reach a renderer.
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

  private async require(): Promise<StoredWorkspaceRecord> {
    const record = await this.context.store.getWorkspace(this.id);
    if (!record) {
      throw new WorkspaceNotFoundError(this.id);
    }
    return record;
  }
}

/** The File rows a Workspace is born with, built by the same builder reconciliation uses. */
export function initialFiles(
  workspaceId: WorkspaceId,
  candidates: readonly FileCandidate[],
  createdAt: Date
): StoredFileRecord[] {
  return candidates.map((candidate) =>
    createFileRecord(
      workspaceId,
      candidate,
      createdAt,
      crypto.randomUUID() as WorkspaceFileId
    )
  );
}

function toRegistration(record: StoredWorkspaceRecord): WorkspaceRegistration {
  return {
    createdAt: record.createdAt,
    description: record.description,
    documentation: record.documentation,
    id: record.id,
    lastReconciledAt: record.lastReconciledAt,
    name: record.name,
    source: {
      kind: record.source,
      path: record.path,
      sourceId: record.sourceId,
    },
    updatedAt: record.updatedAt,
  };
}

function normalizeWorkspaceName(value: string): string {
  const name = value.trim();
  if (name.length === 0) {
    throw new InvalidWorkspaceInputError("Workspace name cannot be empty");
  }
  return name;
}

/** Detached, renderer-safe: relative path only, no root and no bytes. */
function toWorkspaceFile(record: StoredFileRecord): WorkspaceFile {
  return {
    checksum: record.checksum,
    createdAt: record.createdAt,
    extension: record.extension,
    id: record.id,
    kind: record.kind,
    mimeType: record.mimeType,
    name: record.name,
    path: record.path,
    size: record.size,
    updatedAt: record.updatedAt,
    workspaceId: record.workspaceId,
  };
}
