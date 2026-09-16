import {
  InvalidWorkspaceInputError,
  WorkspaceNotFoundError,
  WorkspaceSourceUnavailableError,
  WorkspaceSourceUnsupportedError,
} from "./errors";
import type {
  AnyWorkspaceExtension,
  CapOf,
  FloorFor,
  RefOf,
  WorkspaceIdentity,
} from "./extension";
import { InMemoryWorkspaceStore } from "./in-memory-workspace-store";
import type { WorkspaceContext, WorkspaceCtor } from "./instance";
import { initialFiles, Workspace } from "./instance";
import type { WorkspaceId } from "./workspace";
import type { StoredWorkspaceRecord, WorkspaceStore } from "./workspace-store";

export interface WorkspaceSystemOptions {
  readonly store?: WorkspaceStore;
}

/**
 * Composes and owns Workspace instances.
 *
 * Registered extensions decide what a stored record becomes: at `open` each
 * is asked whether it applies, and the ones that do are layered over the
 * root in registration order. The system holds one live instance per id and
 * runs its lifecycle; nothing else starts or stops one.
 *
 * `Exts` is the tuple of registered extensions. It types `add` by the refs
 * the floors accept and every returned Workspace by the capabilities the
 * layers declare, so what comes out of a system is what went into it.
 */
export class WorkspaceSystem<
  Exts extends readonly AnyWorkspaceExtension[] = [],
> {
  private readonly context: WorkspaceContext;
  private readonly extensions: AnyWorkspaceExtension[] = [];
  private readonly opened = new Map<
    WorkspaceId,
    Promise<Workspace & CapOf<Exts>>
  >();

  constructor(options: WorkspaceSystemOptions = {}) {
    this.context = {
      close: (workspaceId) => this.close(workspaceId),
      observing: new Map(),
      serialized: new Map(),
      store: options.store ?? new InMemoryWorkspaceStore(),
    };
  }

  /** Later extensions wrap earlier ones. Affects instances opened from now on. */
  extend<const More extends readonly AnyWorkspaceExtension[]>(
    ...extensions: More
  ): WorkspaceSystem<[...Exts, ...More]> {
    this.extensions.push(...extensions);
    return this;
  }

  /** The live instance for one id: composed and started once, then shared. */
  open(workspaceId: WorkspaceId): Promise<Workspace & CapOf<Exts>> {
    const running = this.opened.get(workspaceId);
    if (running) {
      return running;
    }

    const opening = (async () => {
      const record = await this.context.store.getWorkspace(workspaceId);
      if (!record) {
        throw new WorkspaceNotFoundError(workspaceId);
      }
      const workspace = await this.instantiate(record);
      await Workspace.start(workspace);
      return workspace;
    })();
    this.opened.set(workspaceId, opening);
    opening.catch(() => {
      if (this.opened.get(workspaceId) === opening) {
        this.opened.delete(workspaceId);
      }
    });
    return opening;
  }

  /** Stops and forgets one instance. A no-op for an id that is not open. */
  async close(workspaceId: WorkspaceId): Promise<void> {
    const running = this.opened.get(workspaceId);
    if (!running) {
      return;
    }
    this.opened.delete(workspaceId);
    await Workspace.stop(await running);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.opened.keys()].map((id) => this.close(id)));
  }

  async list(): Promise<readonly (Workspace & CapOf<Exts>)[]> {
    const records = await this.context.store.listWorkspaces();
    return Promise.all(records.map((record) => this.open(record.id)));
  }

  /**
   * Register a source by its ref — `{ path }`, `{ artifactId }` — and hand
   * back its Workspace. The floor whose key the ref carries turns it into an
   * identity; `create` does the rest.
   */
  async add<R extends RefOf<Exts>>(
    ref: R
  ): Promise<Workspace & CapOf<Exts> & FloorFor<Exts, R>> {
    const floor = this.extensions.find(
      (extension) => extension.ref !== undefined && extension.ref in ref
    );
    if (floor?.identify === undefined) {
      throw new InvalidWorkspaceInputError(
        `No registered layer accepts a ref with keys ${Object.keys(ref).join(", ")}`
      );
    }
    const workspace = await this.create(await floor.identify(ref));
    return workspace as Workspace & CapOf<Exts> & FloorFor<Exts, R>;
  }

  /**
   * Register one source and catalog it, or hand back the Workspace already
   * registered over its path, reconciled.
   *
   * The complete inventory is built before anything is written, so a failed
   * first scan creates nothing. A re-add is one of the moments the design
   * reconciles: it runs literally the path `refresh` runs, and throws when
   * the source cannot be observed, so it says the same thing a first add
   * would rather than returning an instance over a status it discarded.
   */
  async create(identity: WorkspaceIdentity): Promise<Workspace & CapOf<Exts>> {
    const existing = await this.context.store.findWorkspaceByPath(
      identity.path
    );
    if (existing) {
      const workspace = await this.open(existing.id);
      const view = await workspace.refresh();
      if (view.source.kind !== "reconciled") {
        throw new WorkspaceSourceUnavailableError(view.source.reason, {
          issue: view.source.kind,
        });
      }
      return workspace;
    }

    const createdAt = new Date();
    const record: StoredWorkspaceRecord = {
      createdAt,
      description: null,
      documentation: null,
      id: crypto.randomUUID() as WorkspaceId,
      lastReconciledAt: createdAt,
      updatedAt: createdAt,
      ...identity,
    };

    // Composed but never started or cached: it exists to run the first scan.
    const probe = await this.instantiate(record);
    const candidates = await probe.scan();
    const result = await this.context.store.commitCreate({
      files: initialFiles(record.id, candidates, createdAt),
      workspace: record,
    });
    return this.open(
      result.kind === "workspace-exists" ? result.existingId : record.id
    );
  }

  private async instantiate(
    record: StoredWorkspaceRecord
  ): Promise<Workspace & CapOf<Exts>> {
    let Composed: WorkspaceCtor = Workspace;
    for (const extension of this.extensions) {
      // biome-ignore lint/performance/noAwaitInLoops: Operations are intentionally sequential to preserve observation and mutation order.
      if (await extension.applies(record)) {
        Composed = extension.wrap(Composed);
      }
    }
    // The composed class is built at runtime; `Exts` is the static record of
    // what it was built from.
    const workspace = new Composed(record, this.context) as Workspace &
      CapOf<Exts>;
    // A record no registered layer claims composes to the bare root, which
    // constructs fine and fails on first use. Refused here, by name, instead.
    if (!Workspace.hasFloor(workspace)) {
      throw new WorkspaceSourceUnsupportedError(record.source);
    }
    return workspace;
  }
}
