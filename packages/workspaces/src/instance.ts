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
  WorkspaceLifecycle,
  WorkspaceRegistration,
  WorkspaceSource,
  WorkspaceSourceAdapter,
  WorkspaceSourceStatus,
  WorkspaceSummary,
  WorkspaceView,
  WriteOutcome,
} from "./types";

type CatalogState = "current" | "refresh-required";

const lifecycles = new WeakMap<
  Workspace,
  {
    readonly start: (hooks: readonly WorkspaceLifecycle[]) => Promise<void>;
    readonly stop: () => Promise<void>;
  }
>();

export function startWorkspace(
  workspace: Workspace,
  hooks: readonly WorkspaceLifecycle[] = []
): Promise<void> {
  const control = lifecycles.get(workspace);
  return control ? control.start(hooks) : Promise.resolve();
}

export function stopWorkspace(workspace: Workspace): Promise<void> {
  const control = lifecycles.get(workspace);
  return control ? control.stop() : Promise.resolve();
}

export class Workspace {
  readonly id: WorkspaceId;
  readonly source: WorkspaceSource;
  readonly #context: WorkspaceContext;
  readonly #adapter: WorkspaceSourceAdapter;
  #observation: StorageSubscription | undefined;
  readonly #startedHooks: WorkspaceLifecycle[] = [];

  constructor(
    registration: WorkspaceRegistration,
    context: WorkspaceContext,
    adapter: WorkspaceSourceAdapter
  ) {
    this.id = registration.id;
    this.source = registration.source;
    this.#context = context;
    this.#adapter = adapter;
    lifecycles.set(this, {
      start: (hooks) => this.#start(hooks),
      stop: () => this.#stop(),
    });
  }

  scan(): Promise<readonly ObservedFacts[]> {
    return this.#adapter.scan();
  }

  registration(): Promise<WorkspaceRegistration> {
    return this.#require();
  }

  async summary(): Promise<WorkspaceSummary> {
    return summarize(
      await this.#require(),
      await this.#context.catalog.countFiles(this.id)
    );
  }

  async refresh(): Promise<WorkspaceView> {
    const source = await this.#reconcile();
    const current = await this.#require();
    const entries = await this.#context.catalog.listEntries(this.id);
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
    const renamed = await this.#context.catalog.rename(
      this.id,
      normalizeWorkspaceName(name),
      new Date()
    );
    if (!renamed) {
      throw new WorkspaceNotFoundError(this.id);
    }
    return renamed;
  }

  async remove(): Promise<void> {
    await this.#serialize(async () => {
      const result = await this.#context.catalog.remove(this.id);
      if (result.kind === "not-found") {
        throw new WorkspaceNotFoundError(this.id);
      }
    });
    await this.#context.close(this.id);
  }

  async files(): Promise<readonly WorkspaceFile[]> {
    const entries = await this.entries();
    return entries.filter(
      (entry): entry is WorkspaceFile => entry.type === "file"
    );
  }

  async entries(): Promise<readonly WorkspaceEntry[]> {
    await this.#require();
    return this.#context.catalog.listEntries(this.id);
  }

  async read(fileId: WorkspaceEntryId): Promise<FileContentResult> {
    await this.#require();
    const entry = await this.#catalogEntry(fileId);
    if (entry.type !== "file") {
      return notRegular(entry);
    }
    if (!this.#adapter.readFile) {
      throw new WorkspaceSourceUnsupportedError(this.source.kind);
    }
    return this.#adapter.readFile(entry);
  }

  save(command: SaveFileCommand): Promise<SaveFileResult> {
    return this.#serialize(async () => {
      const workspace = await this.#require();
      const file = await this.#catalogEntry(command.fileId);
      if (file.type !== "file") {
        return notRegular(file);
      }
      const { writeFile } = this.#adapter;
      if (!writeFile) {
        throw new WorkspaceSourceUnsupportedError(this.source.kind);
      }
      return this.#write(
        file.path,
        command.text,
        (bytes) => writeFile(file, bytes, command.expectedDigest),
        (snapshot) => this.#recordWrite(workspace, file, snapshot)
      );
    });
  }

  createFile(command: CreateFileCommand): Promise<SaveFileResult> {
    return this.#serialize(async () => {
      const workspace = await this.#require();
      if (!isStoragePath(command.path)) {
        return { kind: "failed", reason: "Invalid relative storage path" };
      }
      const { insertFile } = this.#adapter;
      if (!insertFile) {
        throw new WorkspaceSourceUnsupportedError(this.source.kind);
      }
      return this.#write(
        command.path,
        command.text,
        (bytes) => insertFile(command.path, bytes),
        async () =>
          (await this.#observeSource(workspace)).kind === "reconciled"
            ? "current"
            : "refresh-required"
      );
    });
  }

  async #start(hooks: readonly WorkspaceLifecycle[]): Promise<void> {
    const { watch } = this.#adapter;
    if (watch) {
      this.#observation = await observe(
        (changed, failed) => watch(changed, failed),
        () => this.#reconcile(),
        this.#context.report
      );
    }
    for (const hook of hooks) {
      await hook.start?.();
      this.#startedHooks.push(hook);
    }
  }

  async #stop(): Promise<void> {
    const hooks = this.#startedHooks.splice(0).reverse();
    let firstError: unknown;
    let hasError = false;
    for (const hook of hooks) {
      try {
        await hook.stop?.();
      } catch (error) {
        if (!hasError) {
          firstError = error;
          hasError = true;
        }
      }
    }
    const observation = this.#observation;
    this.#observation = undefined;
    try {
      await observation?.close();
    } catch (error) {
      if (!hasError) {
        firstError = error;
        hasError = true;
      }
    }
    if (hasError) {
      throw firstError;
    }
  }

  async #write(
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

  async #recordWrite(
    workspace: WorkspaceRegistration,
    file: WorkspaceFile,
    snapshot: FileTextSnapshot
  ): Promise<CatalogState> {
    if (file.digest === snapshot.digest && file.bytes === snapshot.bytes) {
      return "current";
    }
    const updatedAt = nextWorkspaceObservation(workspace.lastReconciledAt);
    const result = await this.#context.catalog.applyChange({
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

  #reconcile(): Promise<WorkspaceSourceStatus> {
    return this.#serialize(async () =>
      this.#observeSource(await this.#require())
    );
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    return this.#context.serialize(this.id, task);
  }

  async #observeSource(
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

    const at = nextWorkspaceObservation(workspace.lastReconciledAt);
    const change = diffCatalog({
      at,
      candidates,
      existing: await this.#context.catalog.listEntries(workspace.id),
      newEntryId,
      workspaceId: workspace.id,
    });
    const result = await this.#context.catalog.applyChange({
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

  async #catalogEntry(entryId: WorkspaceEntryId): Promise<WorkspaceEntry> {
    const entry = await this.#context.catalog.getEntry(this.id, entryId);
    if (!entry) {
      throw new WorkspaceFileNotFoundError(this.id, entryId);
    }
    return entry;
  }

  async #require(): Promise<WorkspaceRegistration> {
    const registration = await this.#context.catalog.getWorkspace(this.id);
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
