import type { Page, PageInput } from "@foundry/core/pagination";
import { KeyedQueue } from "@foundry/lib/keyed-queue";
import { WorkspaceCatalog } from "./catalog";
import {
  InvalidWorkspaceInputError,
  WorkspaceNotFoundError,
  WorkspaceSourceUnavailableError,
  WorkspaceSourceUnsupportedError,
} from "./errors";
import { RECONCILE, Workspace } from "./instance";
import { observe } from "./observation";
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

interface ComposedWorkspace<Exts extends readonly AnyWorkspaceExtension[]> {
  readonly adapter: WorkspaceSourceAdapter;
  readonly hooks: readonly WorkspaceLifecycle[];
  readonly sourceOwner: AnyWorkspaceExtension;
  readonly workspace: Workspace & CapOf<Exts>;
}

interface OpenedWorkspace<Exts extends readonly AnyWorkspaceExtension[]> {
  readonly sourceOwner: AnyWorkspaceExtension;
  readonly stop: () => Promise<void>;
  readonly workspace: Workspace & CapOf<Exts>;
}

export class WorkspaceSystem<
  Exts extends readonly AnyWorkspaceExtension[] = [],
> {
  readonly #context: WorkspaceContext;
  readonly #listeners = new Set<ChangeListener>();
  readonly #extensions: AnyWorkspaceExtension[] = [];
  readonly #closing = new Map<WorkspaceId, Promise<void>>();
  readonly #opened = new Map<WorkspaceId, Promise<OpenedWorkspace<Exts>>>();
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
    return this.#openEntry(workspaceId).then((entry) => entry.workspace);
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
      .then((entry) => entry.stop())
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
    const workspace = await this.#register(await floor.identify(ref), floor);
    return workspace as Workspace & CapOf<Exts> & FloorFor<Exts, R>;
  }

  #openEntry(workspaceId: WorkspaceId): Promise<OpenedWorkspace<Exts>> {
    const closing = this.#closing.get(workspaceId);
    if (closing) {
      return closing.then(() => this.#openEntry(workspaceId));
    }
    const running = this.#opened.get(workspaceId);
    if (running) {
      return running;
    }

    return this.#trackOpening(workspaceId, async () => {
      const registration =
        await this.#context.catalog.getWorkspace(workspaceId);
      if (!registration) {
        throw new WorkspaceNotFoundError(workspaceId);
      }
      const composed = await this.#compose(registration);
      const stop = await this.#start(composed);
      return {
        sourceOwner: composed.sourceOwner,
        stop,
        workspace: composed.workspace,
      };
    });
  }

  #openComposed(
    workspaceId: WorkspaceId,
    composed: ComposedWorkspace<Exts>
  ): Promise<OpenedWorkspace<Exts>> {
    const closing = this.#closing.get(workspaceId);
    if (closing) {
      return closing.then(() => this.#openComposed(workspaceId, composed));
    }
    const running = this.#opened.get(workspaceId);
    if (running) {
      return running;
    }

    return this.#trackOpening(workspaceId, async () => {
      const stop = await this.#start(composed);
      return {
        sourceOwner: composed.sourceOwner,
        stop,
        workspace: composed.workspace,
      };
    });
  }

  #trackOpening(
    workspaceId: WorkspaceId,
    run: () => Promise<OpenedWorkspace<Exts>>
  ): Promise<OpenedWorkspace<Exts>> {
    const opening = run();
    this.#opened.set(workspaceId, opening);
    opening.catch(() => {
      if (this.#opened.get(workspaceId) === opening) {
        this.#opened.delete(workspaceId);
      }
    });
    return opening;
  }

  async #register(
    identity: WorkspaceIdentity,
    floor: AnyWorkspaceExtension
  ): Promise<Workspace & CapOf<Exts>> {
    const existing = await this.#context.catalog.findWorkspaceByPath(
      identity.source.path
    );
    if (existing) {
      return this.#reconciled(existing.id, floor);
    }

    const createdAt = new Date();
    const registration: WorkspaceRegistration = {
      createdAt,
      id: crypto.randomUUID() as WorkspaceId,
      lastReconciledAt: createdAt,
      updatedAt: createdAt,
      ...identity,
    };
    const composed = await this.#compose(registration, floor);
    const entries = initialEntries(
      registration.id,
      await composed.workspace.scan(),
      createdAt
    );

    const committed = Promise.withResolvers<boolean>();
    const opening = this.#trackOpening(registration.id, async () => {
      if (!(await committed.promise)) {
        throw new WorkspaceNotFoundError(registration.id);
      }
      const stop = await this.#start(composed);
      return {
        sourceOwner: composed.sourceOwner,
        stop,
        workspace: composed.workspace,
      };
    });

    let result: Awaited<ReturnType<WorkspaceCatalog["create"]>>;
    try {
      result = await this.#context.catalog.create({
        entries,
        workspace: registration,
      });
    } catch (error) {
      committed.resolve(false);
      await opening.catch(() => undefined);
      throw error;
    }

    if (result.kind === "workspace-exists") {
      committed.resolve(false);
      await opening.catch(() => undefined);
      return this.#reconciled(result.existingId, floor);
    }

    committed.resolve(true);
    const entry = await opening;
    return entry.workspace;
  }

  async #reconciled(
    workspaceId: WorkspaceId,
    expectedFloor: AnyWorkspaceExtension
  ): Promise<Workspace & CapOf<Exts>> {
    while (this.#closing.has(workspaceId)) {
      await this.#closing.get(workspaceId);
    }
    let entry: OpenedWorkspace<Exts>;
    const running = this.#opened.get(workspaceId);
    if (running) {
      entry = await running;
    } else {
      const registration =
        await this.#context.catalog.getWorkspace(workspaceId);
      if (!registration) {
        throw new WorkspaceNotFoundError(workspaceId);
      }
      const composed = await this.#compose(registration, expectedFloor);
      entry = await this.#openComposed(workspaceId, composed);
    }
    if (entry.sourceOwner !== expectedFloor) {
      throw new WorkspaceSourceUnsupportedError(entry.workspace.source.kind);
    }
    const view = await entry.workspace.refresh();
    if (view.source.kind !== "reconciled") {
      throw new WorkspaceSourceUnavailableError(view.source.reason, {
        issue: view.source.kind,
      });
    }
    return entry.workspace;
  }

  async #compose(
    registration: WorkspaceRegistration,
    expectedFloor?: AnyWorkspaceExtension
  ): Promise<ComposedWorkspace<Exts>> {
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
    if (expectedFloor !== undefined && sourceOwner !== expectedFloor) {
      throw new WorkspaceSourceUnsupportedError(registration.source.kind);
    }
    const adapter = sourceOwner.source(registration);
    const workspace = new Workspace(
      registration,
      this.#context,
      adapter
    ) as Workspace & CapOf<Exts>;
    const attached: Record<PropertyKey, unknown> = Object.create(null);
    const hooks: WorkspaceLifecycle[] = [];
    for (const extension of matched) {
      const attachment = await extension.attach?.({
        capabilities: Object.freeze({ ...attached }),
        registration,
      });
      if (attachment?.capabilities) {
        attachCapabilities(
          workspace,
          attached,
          extension.name,
          attachment.capabilities
        );
      }
      if (attachment?.start || attachment?.stop) {
        hooks.push(attachment);
      }
    }
    return { adapter, hooks, sourceOwner, workspace };
  }

  async #start(
    composed: ComposedWorkspace<Exts>
  ): Promise<() => Promise<void>> {
    const { adapter, hooks, workspace } = composed;
    const cleanups: (() => Promise<void> | void)[] = [];
    try {
      if (adapter.watch) {
        const subscription = await observe(
          (changed, failed) =>
            adapter.watch
              ? adapter.watch(changed, failed)
              : Promise.resolve(undefined),
          () => workspace[RECONCILE](),
          (error) => {
            this.#safeReport(error);
          }
        );
        if (subscription) {
          cleanups.push(() => subscription.close());
        }
      }
      for (const hook of hooks) {
        if (hook.stop) {
          cleanups.push(() => hook.stop?.(workspace));
        }
        await hook.start?.(workspace);
      }
    } catch (startupError) {
      for (const cleanupError of await runCleanups(cleanups)) {
        this.#safeReport(cleanupError);
      }
      throw startupError;
    }

    return async () => {
      const errors = await runCleanups(cleanups);
      for (const extra of errors.slice(1)) {
        this.#safeReport(extra);
      }
      if (errors.length > 0) {
        throw errors[0];
      }
    };
  }

  #safeReport(error: unknown): void {
    try {
      this.#context.report(error);
    } catch {
      // Never let a listener or error reporter mask primary errors or abort cleanup.
    }
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
        result.catch((error) => {
          this.#safeReport(error);
        });
      }
    } catch (error) {
      this.#safeReport(error);
    }
  }
}

async function runCleanups(
  cleanups: (() => Promise<void> | void)[]
): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function attachCapabilities(
  workspace: Workspace,
  attached: Record<PropertyKey, unknown>,
  extensionName: string,
  capabilities: object
): void {
  for (const key of Reflect.ownKeys(capabilities)) {
    const descriptor = Object.getOwnPropertyDescriptor(capabilities, key);
    if (!descriptor?.enumerable) {
      continue;
    }
    if (key in workspace) {
      throw new InvalidWorkspaceInputError(
        `Workspace extension "${extensionName}" cannot overwrite existing property "${String(key)}"`
      );
    }
    const value: unknown = Reflect.get(capabilities, key);
    attached[key] = value;
    Object.defineProperty(workspace, key, {
      configurable: false,
      enumerable: true,
      value,
      writable: false,
    });
  }
}

function reportError(error: unknown): void {
  console.error("[workspaces]", error);
}
