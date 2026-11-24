import type { Page, PageInput } from "@foundry/core/pagination";
import { KeyedQueue } from "@foundry/lib/keyed-queue";
import { WorkspaceCatalog } from "./catalog";
import {
  InvalidWorkspaceInputError,
  WorkspaceNotFoundError,
  WorkspaceSourceUnavailableError,
  WorkspaceSourceUnsupportedError,
} from "./errors";
import { startWorkspace, stopWorkspace, Workspace } from "./instance";
import { initialEntries } from "./reconcile";
import type { WorkspaceStore } from "./store";
import { MemoryWorkspaceStore } from "./store/memory";
import type {
  AnyWorkspaceExtension,
  CapOf,
  FloorFor,
  RefOf,
  WorkspaceChange,
  WorkspaceContext,
  WorkspaceId,
  WorkspaceIdentity,
  WorkspaceLifecycle,
  WorkspaceRegistration,
  WorkspaceSourceAdapter,
} from "./types";

export interface WorkspaceSystemOptions {
  readonly onError?: (error: unknown) => void;
  readonly store?: WorkspaceStore;
}

type ChangeListener = (change: WorkspaceChange) => void | Promise<void>;

export class WorkspaceSystem<
  Exts extends readonly AnyWorkspaceExtension[] = [],
> {
  readonly #context: WorkspaceContext;
  readonly #listeners = new Set<ChangeListener>();
  readonly #extensions: AnyWorkspaceExtension[] = [];
  readonly #closing = new Map<WorkspaceId, Promise<void>>();
  readonly #opened = new Map<WorkspaceId, Promise<Workspace & CapOf<Exts>>>();
  readonly #queues = new KeyedQueue();

  constructor(options: WorkspaceSystemOptions = {}) {
    this.#context = {
      catalog: new WorkspaceCatalog(
        options.store ?? new MemoryWorkspaceStore(),
        (changes) => {
          this.#publish(changes);
        }
      ),
      close: (workspaceId) => this.close(workspaceId),
      report: options.onError ?? reportError,
      serialize: (workspaceId, task) => this.#queues.run(workspaceId, task),
    };
  }

  on(_event: "change", listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  extend<const More extends readonly AnyWorkspaceExtension[]>(
    ...extensions: More
  ): WorkspaceSystem<[...Exts, ...More]> {
    this.#extensions.push(...extensions);
    return this;
  }

  open(workspaceId: WorkspaceId): Promise<Workspace & CapOf<Exts>> {
    const closing = this.#closing.get(workspaceId);
    if (closing) {
      return closing.then(() => this.open(workspaceId));
    }
    const running = this.#opened.get(workspaceId);
    if (running) {
      return running;
    }

    const opening = (async () => {
      const registration =
        await this.#context.catalog.getWorkspace(workspaceId);
      if (!registration) {
        throw new WorkspaceNotFoundError(workspaceId);
      }
      const { hooks, workspace } = await this.#instantiate(registration);
      try {
        await startWorkspace(workspace, hooks);
      } catch (error) {
        await stopWorkspace(workspace);
        throw error;
      }
      return workspace;
    })();
    this.#opened.set(workspaceId, opening);
    opening.catch(() => {
      if (this.#opened.get(workspaceId) === opening) {
        this.#opened.delete(workspaceId);
      }
    });
    return opening;
  }

  async close(workspaceId: WorkspaceId): Promise<void> {
    const closing = this.#closing.get(workspaceId);
    if (closing) {
      return closing;
    }
    const running = this.#opened.get(workspaceId);
    if (!running) {
      return;
    }
    const stopping = running
      .then((workspace) => stopWorkspace(workspace))
      .finally(() => {
        this.#opened.delete(workspaceId);
        this.#closing.delete(workspaceId);
      });
    this.#closing.set(workspaceId, stopping);
    await stopping;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#opened.keys()].map((id) => this.close(id)));
  }

  async list(
    input: PageInput<number> = {}
  ): Promise<Page<Workspace & CapOf<Exts>, number>> {
    const page = await this.#context.catalog.listWorkspaces(input);
    const items = await Promise.all(
      page.items.map((registration) => this.open(registration.id))
    );
    return { ...page, items };
  }

  async load<R extends RefOf<Exts>>(
    ref: R
  ): Promise<Workspace & CapOf<Exts> & FloorFor<Exts, R>> {
    const floor = this.#extensions.find(
      (extension) => extension.ref !== undefined && extension.ref in ref
    );
    if (floor?.identify === undefined) {
      throw new InvalidWorkspaceInputError(
        `No registered layer accepts a ref with keys ${Object.keys(ref).join(", ")}`
      );
    }
    const workspace = await this.#register(await floor.identify(ref));
    return workspace as Workspace & CapOf<Exts> & FloorFor<Exts, R>;
  }

  async #register(
    identity: WorkspaceIdentity
  ): Promise<Workspace & CapOf<Exts>> {
    const existing = await this.#context.catalog.findWorkspaceByPath(
      identity.source.path
    );
    if (existing) {
      return this.#reconciled(existing.id);
    }

    const createdAt = new Date();
    const registration: WorkspaceRegistration = {
      createdAt,
      id: crypto.randomUUID() as WorkspaceId,
      lastReconciledAt: createdAt,
      updatedAt: createdAt,
      ...identity,
    };
    const source = await this.#resolveSource(registration);
    const entries = initialEntries(
      registration.id,
      await source.scan(),
      createdAt
    );
    const result = await this.#context.catalog.create({
      entries,
      workspace: registration,
    });
    return result.kind === "committed"
      ? this.open(registration.id)
      : this.#reconciled(result.existingId);
  }

  async #reconciled(
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

  async #resolveSource(
    registration: WorkspaceRegistration
  ): Promise<WorkspaceSourceAdapter> {
    for (const extension of this.#extensions) {
      if (extension.source && (await extension.applies(registration))) {
        return extension.source(registration);
      }
    }
    throw new WorkspaceSourceUnsupportedError(registration.source.kind);
  }

  async #instantiate(registration: WorkspaceRegistration): Promise<{
    readonly hooks: readonly WorkspaceLifecycle[];
    readonly workspace: Workspace & CapOf<Exts>;
  }> {
    const matched: AnyWorkspaceExtension[] = [];
    for (const extension of this.#extensions) {
      if (await extension.applies(registration)) {
        matched.push(extension);
      }
    }
    const sourceOwner = matched.find((extension) => extension.source);
    if (!sourceOwner?.source) {
      throw new WorkspaceSourceUnsupportedError(registration.source.kind);
    }
    const workspace = new Workspace(
      registration,
      this.#context,
      sourceOwner.source(registration)
    ) as Workspace & CapOf<Exts>;
    const hooks: WorkspaceLifecycle[] = [];
    for (const extension of matched) {
      const attachment = await extension.attach?.(workspace);
      if (attachment?.capabilities) {
        Object.assign(workspace, attachment.capabilities);
      }
      if (attachment?.start || attachment?.stop) {
        hooks.push(attachment);
      }
    }
    return { hooks, workspace };
  }

  #publish(changes: readonly WorkspaceChange[]): void {
    for (const change of changes) {
      for (const listener of [...this.#listeners]) {
        if (this.#listeners.has(listener)) {
          this.#deliver(listener, change);
        }
      }
    }
  }

  #deliver(listener: ChangeListener, change: WorkspaceChange): void {
    try {
      const result = listener(structuredClone(change));
      if (result) {
        result.catch(this.#context.report);
      }
    } catch (error) {
      this.#context.report(error);
    }
  }
}

function reportError(error: unknown): void {
  console.error("[workspaces]", error);
}
