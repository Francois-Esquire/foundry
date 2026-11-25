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
  CapabilitiesOf,
  RefOf,
  SourceCapabilitiesFor,
  WorkspaceChange,
  WorkspaceContext,
  WorkspaceId,
  WorkspaceIdentity,
  WorkspaceLifecycle,
  WorkspaceRegistration,
  WorkspaceSourceAdapter,
} from "./types";

export interface WorkspacesOptions {
  readonly onError?: (error: unknown) => void;
  readonly store?: WorkspaceStore;
}

type ChangeListener = (change: WorkspaceChange) => void | Promise<void>;

interface ComposedWorkspace<
  Extensions extends readonly AnyWorkspaceExtension[],
> {
  readonly adapter: WorkspaceSourceAdapter;
  readonly hooks: readonly WorkspaceLifecycle[];
  readonly sourceOwner: AnyWorkspaceExtension;
  readonly workspace: Workspace & CapabilitiesOf<Extensions>;
}

interface MatchedExtensions {
  readonly matched: readonly AnyWorkspaceExtension[];
  readonly sourceOwner: AnyWorkspaceExtension;
}

interface StartingWorkspace {
  aborting?: Promise<void>;
  active: boolean;
  readonly cleanups: (() => Promise<void> | void)[];
  closed: boolean;
  readonly workspace: Workspace;
}

interface OpenedWorkspace<Extensions extends readonly AnyWorkspaceExtension[]> {
  readonly sourceOwner: AnyWorkspaceExtension;
  readonly stop: () => Promise<void>;
  readonly workspace: Workspace & CapabilitiesOf<Extensions>;
}

export class Workspaces<
  Extensions extends readonly AnyWorkspaceExtension[] = [],
> {
  readonly #context: WorkspaceContext;
  readonly #listeners = new Set<ChangeListener>();
  readonly #extensions: AnyWorkspaceExtension[] = [];
  readonly #closing = new Map<WorkspaceId, Promise<void>>();
  readonly #opened = new Map<
    WorkspaceId,
    Promise<OpenedWorkspace<Extensions>>
  >();
  readonly #starting = new Map<WorkspaceId, StartingWorkspace>();
  readonly #queues = new KeyedQueue();

  constructor(options: WorkspacesOptions = {}) {
    this.#context = {
      catalog: new WorkspaceCatalog(
        options.store ?? new MemoryWorkspaceStore(),
        (changes) => {
          this.#publish(changes);
        }
      ),
      close: (workspaceId, from) => this.#close(workspaceId, from),
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
  ): Workspaces<[...Extensions, ...More]> {
    this.#extensions.push(...extensions);
    return this;
  }

  open(
    workspaceId: WorkspaceId
  ): Promise<Workspace & CapabilitiesOf<Extensions>> {
    return this.#openEntry(workspaceId).then((entry) => entry.workspace);
  }

  close(workspaceId: WorkspaceId): Promise<void> {
    return this.#close(workspaceId);
  }

  async #close(workspaceId: WorkspaceId, from?: Workspace): Promise<void> {
    const activeStartup = this.#starting.get(workspaceId);
    if (
      activeStartup?.active === true &&
      from !== undefined &&
      activeStartup.workspace === from
    ) {
      await this.#abortStartup(workspaceId, activeStartup);
      return;
    }
    const closing = this.#closing.get(workspaceId);
    if (closing) {
      return closing;
    }
    const running = this.#opened.get(workspaceId);
    if (!running) {
      return;
    }
    const stopping = running
      .then(
        (entry) => entry.stop(),
        () => undefined
      )
      .finally(() => {
        if (this.#opened.get(workspaceId) === running) {
          this.#opened.delete(workspaceId);
        }
        if (this.#closing.get(workspaceId) === stopping) {
          this.#closing.delete(workspaceId);
        }
      });
    this.#closing.set(workspaceId, stopping);
    await stopping;
  }

  #abortStartup(
    workspaceId: WorkspaceId,
    starting: StartingWorkspace
  ): Promise<void> {
    if (starting.aborting) {
      return starting.aborting;
    }
    starting.closed = true;
    this.#opened.delete(workspaceId);
    const stopping = this.#settleCleanups(starting.cleanups).finally(() => {
      if (this.#closing.get(workspaceId) === stopping) {
        this.#closing.delete(workspaceId);
      }
    });
    starting.aborting = stopping;
    if (!this.#closing.has(workspaceId)) {
      this.#closing.set(workspaceId, stopping);
    }
    return stopping;
  }

  async closeAll(): Promise<void> {
    const ids = new Set([...this.#opened.keys(), ...this.#closing.keys()]);
    await Promise.all([...ids].map((id) => this.close(id)));
  }

  async list(
    input: PageInput<number> = {}
  ): Promise<Page<Workspace & CapabilitiesOf<Extensions>, number>> {
    const page = await this.#context.catalog.listWorkspaces(input);
    const items = await Promise.all(
      page.items.map((registration) => this.open(registration.id))
    );
    return { ...page, items };
  }

  async load<R extends RefOf<Extensions>>(
    ref: R
  ): Promise<
    Workspace &
      CapabilitiesOf<Extensions> &
      SourceCapabilitiesFor<Extensions, R>
  > {
    const sourceExtension = this.#extensions.find(
      (extension) =>
        extension.identify !== undefined &&
        extension.ref !== undefined &&
        extension.ref in ref
    );
    if (sourceExtension?.identify === undefined) {
      throw new InvalidWorkspaceInputError(
        `No registered extension accepts a ref with keys ${Object.keys(ref).join(", ")}`
      );
    }
    const workspace = await this.#register(
      await sourceExtension.identify(ref),
      sourceExtension
    );
    return workspace as Workspace &
      CapabilitiesOf<Extensions> &
      SourceCapabilitiesFor<Extensions, R>;
  }

  #openEntry(
    workspaceId: WorkspaceId,
    prematched?: MatchedExtensions
  ): Promise<OpenedWorkspace<Extensions>> {
    const closing = this.#closing.get(workspaceId);
    if (closing) {
      return closing.then(() => this.#openEntry(workspaceId, prematched));
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
      const composed = prematched
        ? await this.#attachMatched(
            registration,
            prematched.matched,
            prematched.sourceOwner
          )
        : await this.#compose(registration);
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
    run: () => Promise<OpenedWorkspace<Extensions>>
  ): Promise<OpenedWorkspace<Extensions>> {
    const opening = Promise.resolve().then(run);
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
    sourceOwner: AnyWorkspaceExtension
  ): Promise<Workspace & CapabilitiesOf<Extensions>> {
    const existing = await this.#context.catalog.findWorkspaceByPath(
      identity.source.path
    );
    if (existing) {
      return this.#reconciled(existing.id, sourceOwner);
    }

    const createdAt = new Date();
    const registration: WorkspaceRegistration = {
      createdAt,
      id: crypto.randomUUID() as WorkspaceId,
      lastReconciledAt: createdAt,
      updatedAt: createdAt,
      ...identity,
    };
    const composed = await this.#compose(registration, sourceOwner);
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
      return this.#reconciled(result.existingId, sourceOwner);
    }

    committed.resolve(true);
    const entry = await opening;
    return entry.workspace;
  }

  async #reconciled(
    workspaceId: WorkspaceId,
    expectedOwner: AnyWorkspaceExtension
  ): Promise<Workspace & CapabilitiesOf<Extensions>> {
    while (this.#closing.has(workspaceId)) {
      await this.#closing.get(workspaceId);
    }
    let entry: OpenedWorkspace<Extensions>;
    const running = this.#opened.get(workspaceId);
    if (running) {
      entry = await running;
    } else {
      const registration =
        await this.#context.catalog.getWorkspace(workspaceId);
      if (!registration) {
        throw new WorkspaceNotFoundError(workspaceId);
      }
      const prematched = await this.#matchExtensions(
        registration,
        expectedOwner
      );
      entry = await this.#openEntry(workspaceId, prematched);
    }
    if (entry.sourceOwner !== expectedOwner) {
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
    expectedOwner?: AnyWorkspaceExtension
  ): Promise<ComposedWorkspace<Extensions>> {
    const { matched, sourceOwner } = await this.#matchExtensions(
      registration,
      expectedOwner
    );
    return this.#attachMatched(registration, matched, sourceOwner);
  }

  async #matchExtensions(
    registration: WorkspaceRegistration,
    expectedOwner?: AnyWorkspaceExtension
  ): Promise<MatchedExtensions> {
    const matched: AnyWorkspaceExtension[] = [];
    for (const extension of this.#extensions) {
      if (await extension.applies(registration)) {
        matched.push(extension);
      }
    }
    const sourceOwner = matched.find((extension) => extension.source);
    if (
      sourceOwner === undefined ||
      (expectedOwner !== undefined && sourceOwner !== expectedOwner)
    ) {
      throw new WorkspaceSourceUnsupportedError(registration.source.kind);
    }
    return { matched, sourceOwner };
  }

  async #attachMatched(
    registration: WorkspaceRegistration,
    matched: readonly AnyWorkspaceExtension[],
    sourceOwner: AnyWorkspaceExtension
  ): Promise<ComposedWorkspace<Extensions>> {
    if (!sourceOwner.source) {
      throw new WorkspaceSourceUnsupportedError(registration.source.kind);
    }
    const adapter = sourceOwner.source(registration);
    const workspace = new Workspace(
      registration,
      this.#context,
      adapter
    ) as Workspace & CapabilitiesOf<Extensions>;
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
    composed: ComposedWorkspace<Extensions>
  ): Promise<() => Promise<void>> {
    const { adapter, hooks, workspace } = composed;
    if (this.#closing.has(workspace.id)) {
      return () => Promise.resolve();
    }
    const state: StartingWorkspace = {
      active: true,
      cleanups: [],
      closed: false,
      workspace,
    };
    const { cleanups } = state;
    this.#starting.set(workspace.id, state);
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
        if (subscription && state.closed) {
          await subscription.close();
        } else if (subscription) {
          cleanups.push(() => subscription.close());
        }
      }
      for (const hook of hooks) {
        if (state.closed || this.#closing.has(workspace.id)) {
          break;
        }
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
    } finally {
      state.active = false;
      if (this.#starting.get(workspace.id) === state) {
        this.#starting.delete(workspace.id);
      }
    }

    return () => this.#settleCleanups(cleanups);
  }

  async #settleCleanups(
    cleanups: (() => Promise<void> | void)[]
  ): Promise<void> {
    const errors = await runCleanups(cleanups);
    for (const extra of errors.slice(1)) {
      this.#safeReport(extra);
    }
    if (errors.length > 0) {
      throw errors[0];
    }
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
  const prototype = Object.getPrototypeOf(capabilities);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new InvalidWorkspaceInputError(
      `Workspace extension "${extensionName}" must return capabilities as a plain object`
    );
  }
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
