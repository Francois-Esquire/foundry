import type { Page, PageInput } from "@foundry/core/pagination";
import { WorkspaceCatalog } from "./catalog";
import {
  InvalidWorkspaceInputError,
  WorkspaceNotFoundError,
  WorkspaceSourceUnavailableError,
  WorkspaceSourceUnsupportedError,
} from "./errors";
import { Workspace } from "./instance";
import { MemoryWorkspaceStore } from "./memory-store";
import { initialEntries } from "./reconcile";
import type { WorkspaceStore } from "./store";
import type {
  AnyWorkspaceExtension,
  CapOf,
  FloorFor,
  RefOf,
  WorkspaceChange,
  WorkspaceContext,
  WorkspaceCtor,
  WorkspaceId,
  WorkspaceIdentity,
  WorkspaceRegistration,
} from "./types";

export interface WorkspaceSystemOptions {
  /** Receives background failures: observations and change listeners. */
  readonly onError?: (error: unknown) => void;
  readonly store?: WorkspaceStore;
}

type ChangeListener = (change: WorkspaceChange) => void | Promise<void>;

/**
 * Composes and owns Workspace instances.
 *
 * Registered extensions decide what a registration becomes: at `open` each
 * is asked whether it applies, and the ones that do are layered over the
 * root in registration order. The system holds one live instance per id and
 * runs its lifecycle; nothing else starts or stops one.
 *
 * `Exts` is the tuple of registered extensions. It types `load` by the refs
 * the floors accept and every returned Workspace by the capabilities the
 * layers declare, so what comes out of a system is what went into it.
 */
export class WorkspaceSystem<
  Exts extends readonly AnyWorkspaceExtension[] = [],
> {
  private readonly context: WorkspaceContext;
  private readonly listeners = new Set<ChangeListener>();
  private readonly extensions: AnyWorkspaceExtension[] = [];
  private readonly closing = new Map<WorkspaceId, Promise<void>>();
  private readonly opened = new Map<
    WorkspaceId,
    Promise<Workspace & CapOf<Exts>>
  >();
  private readonly queues = new Map<WorkspaceId, Promise<void>>();

  constructor(options: WorkspaceSystemOptions = {}) {
    this.context = {
      catalog: new WorkspaceCatalog(
        options.store ?? new MemoryWorkspaceStore(),
        (changes) => {
          this.publish(changes);
        }
      ),
      close: (workspaceId) => this.close(workspaceId),
      report: options.onError ?? reportError,
      serialize: (workspaceId, task) => this.serialize(workspaceId, task),
    };
  }

  /** Future changes from this system; no replay. Listener failures do not fail committed operations. */
  on(_event: "change", listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
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
    const closing = this.closing.get(workspaceId);
    if (closing) {
      return closing.then(() => this.open(workspaceId));
    }
    const running = this.opened.get(workspaceId);
    if (running) {
      return running;
    }

    const opening = (async () => {
      const registration = await this.context.catalog.getWorkspace(workspaceId);
      if (!registration) {
        throw new WorkspaceNotFoundError(workspaceId);
      }
      const workspace = await this.instantiate(registration);
      try {
        await Workspace.start(workspace);
      } catch (error) {
        await Workspace.stop(workspace);
        throw error;
      }
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
    const closing = this.closing.get(workspaceId);
    if (closing) {
      return closing;
    }
    const running = this.opened.get(workspaceId);
    if (!running) {
      return;
    }
    const stopping = running
      .then((workspace) => Workspace.stop(workspace))
      .finally(() => {
        this.opened.delete(workspaceId);
        this.closing.delete(workspaceId);
      });
    this.closing.set(workspaceId, stopping);
    await stopping;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.opened.keys()].map((id) => this.close(id)));
  }

  async list(
    input: PageInput<number> = {}
  ): Promise<Page<Workspace & CapOf<Exts>, number>> {
    const page = await this.context.catalog.listWorkspaces(input);
    const items = await Promise.all(
      page.items.map((registration) => this.open(registration.id))
    );
    return { ...page, items };
  }

  /**
   * Register a source by its ref — `{ path }`, `{ artifactId }` — and hand
   * back its Workspace. The floor whose key the ref carries turns it into an
   * identity; registration does the rest.
   */
  async load<R extends RefOf<Exts>>(
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
    const workspace = await this.register(await floor.identify(ref));
    return workspace as Workspace & CapOf<Exts> & FloorFor<Exts, R>;
  }

  /**
   * Register one source and catalog it, or hand back the Workspace already
   * registered over it, reconciled.
   *
   * The complete inventory is built before anything is written, so a failed
   * first scan creates nothing. An incumbent — found up front, or winning a
   * concurrent registration — runs literally the path `refresh` runs and
   * throws when its source cannot be observed, so it says the same thing a
   * first load would.
   */
  private async register(
    identity: WorkspaceIdentity
  ): Promise<Workspace & CapOf<Exts>> {
    const existing = await this.context.catalog.findWorkspaceByPath(
      identity.source.path
    );
    if (existing) {
      return this.reconciled(existing.id);
    }

    const createdAt = new Date();
    const registration: WorkspaceRegistration = {
      createdAt,
      id: crypto.randomUUID() as WorkspaceId,
      lastReconciledAt: createdAt,
      updatedAt: createdAt,
      ...identity,
    };
    // Composed but never started or cached: it exists to run the first scan.
    const probe = await this.instantiate(registration);
    const entries = initialEntries(
      registration.id,
      await probe.scan(),
      createdAt
    );
    const result = await this.context.catalog.create({
      entries,
      workspace: registration,
    });
    return result.kind === "committed"
      ? this.open(registration.id)
      : this.reconciled(result.existingId);
  }

  private async reconciled(
    workspaceId: WorkspaceId
  ): Promise<Workspace & CapOf<Exts>> {
    const workspace = await this.open(workspaceId);
    const view = await workspace.refresh();
    if (view.source.kind !== "reconciled") {
      throw new WorkspaceSourceUnavailableError(view.source.reason, {
        issue: view.source.kind,
      });
    }
    return workspace;
  }

  private async instantiate(
    registration: WorkspaceRegistration
  ): Promise<Workspace & CapOf<Exts>> {
    let Composed: WorkspaceCtor = Workspace;
    for (const extension of this.extensions) {
      // Operations are intentionally sequential to preserve layer order.
      if (await extension.applies(registration)) {
        Composed = extension.wrap(Composed);
      }
    }
    // The composed class is built at runtime; `Exts` is the static record of
    // what it was built from.
    const workspace = new Composed(registration, this.context) as Workspace &
      CapOf<Exts>;
    // A registration no layer claims composes to the bare root, which
    // constructs fine and fails on first use. Refused here, by name, instead.
    if (!Workspace.hasFloor(workspace)) {
      throw new WorkspaceSourceUnsupportedError(registration.source.kind);
    }
    return workspace;
  }

  /** Chains one task after whatever already runs for this Workspace. */
  private serialize<T>(
    workspaceId: WorkspaceId,
    task: () => Promise<T>
  ): Promise<T> {
    const previous = this.queues.get(workspaceId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(workspaceId, tail);
    tail.then(() => {
      if (this.queues.get(workspaceId) === tail) {
        this.queues.delete(workspaceId);
      }
    });
    return run;
  }

  private publish(changes: readonly WorkspaceChange[]): void {
    for (const change of changes) {
      for (const listener of [...this.listeners]) {
        if (this.listeners.has(listener)) {
          this.deliver(listener, change);
        }
      }
    }
  }

  private deliver(listener: ChangeListener, change: WorkspaceChange): void {
    try {
      const result = listener(structuredClone(change));
      if (result) {
        result.catch(this.context.report);
      }
    } catch (error) {
      this.context.report(error);
    }
  }
}

function reportError(error: unknown): void {
  console.error("[workspaces]", error);
}
