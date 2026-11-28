import type { ArtifactId, ContentId } from "@foundry/artifacts";
import { Authorization } from "@foundry/authorization";
import type { AuthorizationStore } from "@foundry/authorization/store";
import { MemoryAuthorizationStore } from "@foundry/authorization/store/memory";
import type { Page, PageInput } from "@foundry/core/pagination";
import { type CommitEffects, runAfterCommit } from "@foundry/core/storage";
import { canonicalizeJson } from "@foundry/lib/json";
import { byCodeUnit } from "@foundry/lib/ordering";
import { pageLimit } from "@foundry/lib/pagination";
import { ReentrantCallError, Turns } from "@foundry/lib/turns";

import type {
  Installation,
  InstallationId,
  InstallationStatus,
  Module,
  ModuleId,
  ModuleVersion,
} from "./domain";
import { createDisabledInstallation } from "./domain";
import { ModuleStoreConflictError, ModuleStoreNotFoundError } from "./errors";
import {
  installationGrantsFrom,
  MODULE_CAPABILITY_ACTION,
  moduleInstallationPrincipal,
} from "./grants";
import type { ModuleManifest } from "./manifest";
import { page } from "./page";
import type {
  InstallationGrant,
  RetainedManifest,
  StoredInstallation,
} from "./records";
import type {
  ModuleStore,
  ModuleStoreDurability,
  ModuleStorePage,
  ModuleStorePageQuery,
  ModuleStoreWrite,
} from "./store";
import { plainCopy } from "./store/captured";
import { MemoryModuleStore } from "./store/memory";

export type { InstallationGrant, RetainedManifest } from "./records";

export interface ModuleGatewayContext {
  readonly grants: readonly InstallationGrant[];
  readonly installation: Installation;
}

export interface RegisterModuleInput {
  readonly module: Module;
}

export interface RetainManifestInput extends RetainedManifest {
  readonly module: Module;
}

export type SelectedVersion = Pick<
  ModuleVersion,
  "moduleId" | "artifactId" | "contentId"
>;

export interface ListInstallationsInput extends PageInput {
  readonly moduleId?: ModuleId;
}

export interface CreateInstallationInput {
  readonly id: InstallationId;
  readonly now: Date;
  readonly version: SelectedVersion;
}

export interface InstallationTransitionInput {
  readonly expectedGeneration: number;
  readonly installationId: InstallationId;
  readonly now: Date;
}

export interface BeginInstallationTransitionInput
  extends InstallationTransitionInput {
  readonly resetStartAttempts?: boolean;
  readonly status: Extract<InstallationStatus, "starting" | "stopping">;
}

export interface SettleInstallationStatusInput
  extends InstallationTransitionInput {
  readonly status: Extract<
    InstallationStatus,
    "active" | "disabled" | "failed"
  >;
}

export interface SelectInstallationVersionInput
  extends InstallationTransitionInput {
  readonly version: SelectedVersion;
}

export interface SetInstallationContainerIdInput
  extends InstallationTransitionInput {
  readonly containerId: string | null;
}

export interface DeleteInstallationInput {
  readonly expectedGeneration: number;
  readonly installationId: InstallationId;
}

export interface DeleteModuleInput {
  readonly moduleId: ModuleId;
}

export interface ModulesOptions {
  readonly artifactOfContent?: (
    contentId: ContentId
  ) => Promise<ArtifactId | null>;
  readonly authorization?: Authorization;
  readonly authorizationStore?: AuthorizationStore;
  readonly store?: ModuleStore;
}

export type ModuleCommand = Exclude<
  keyof Modules,
  "durability" | "transaction"
>;

export type ModuleUnit<Command extends ModuleCommand> = Pick<
  Modules,
  Command
> & {
  readonly durability?: ModuleStoreDurability;
  transaction<T>(
    work: (
      registry: Pick<Modules, Command>,
      effects: CommitEffects
    ) => Promise<T>
  ): Promise<T>;
};

export type ModuleCommands = ModuleUnit<ModuleCommand>;

const REENTRY =
  "Modules was called from inside its own transaction; use the Modules instance passed to the transaction's work instead";

const NESTED =
  "Modules.transaction was called on a Modules instance bound to a transaction, and transactions do not nest; use the Modules instance passed to the transaction's work instead";

const SETTLED =
  "Modules transaction has settled; register an effect while its work runs";

const BOUND = new WeakSet<Modules>();

const STORE_PAGE_LIMIT = 500;

export class Modules {
  readonly authorization: Authorization;
  readonly durability: ModuleStoreDurability;
  readonly #authorizationStore: AuthorizationStore | undefined;
  readonly #store: ModuleStore;
  readonly #artifactOfContent: ModulesOptions["artifactOfContent"];
  readonly #turns = new Turns(REENTRY);

  constructor(options: ModulesOptions = {}) {
    this.#store = options.store ?? new MemoryModuleStore();
    this.#artifactOfContent = options.artifactOfContent;
    this.durability = this.#store.durability ?? "commit";
    if (options.authorization !== undefined) {
      this.authorization = options.authorization;
      this.#authorizationStore = options.authorizationStore;
    } else if (options.authorizationStore !== undefined) {
      this.#authorizationStore = options.authorizationStore;
      this.authorization = new Authorization({
        store: options.authorizationStore,
      });
    } else if (this.#store.openAuthorizationStore === undefined) {
      const authStore = new MemoryAuthorizationStore();
      this.#authorizationStore = authStore;
      this.authorization = new Authorization({ store: authStore });
    } else {
      const authStore = this.#store.openAuthorizationStore();
      this.#authorizationStore = authStore;
      this.authorization = new Authorization({ store: authStore });
    }
  }

  static #boundTo(
    view: ModuleStore,
    durability: ModuleStoreDurability,
    artifactOfContent: ModulesOptions["artifactOfContent"],
    authorization: Authorization
  ): Modules {
    const registry = new Modules({
      authorization,
      store: withoutTransaction(view, durability),
      ...(artifactOfContent === undefined ? {} : { artifactOfContent }),
    });
    BOUND.add(registry);
    return registry;
  }

  async transaction<T>(
    work: (registry: Modules, effects: CommitEffects) => Promise<T>
  ): Promise<T> {
    if (BOUND.has(this)) {
      throw new ReentrantCallError(NESTED);
    }
    const callbacks: (() => Promise<void>)[] = [];
    let open = true;
    const effects: CommitEffects = {
      afterCommit(effect) {
        if (!open) {
          throw new Error(SETTLED);
        }
        callbacks.push(effect);
      },
    };
    const rollsBack = this.#store.transaction !== undefined;
    const txDurability = rollsBack ? "host" : this.durability;
    let result: T;
    try {
      result = await this.#exclusive(async (store) => {
        if (store.openAuthorizationStore !== undefined) {
          const txAuth = this.authorization.within(
            store.openAuthorizationStore(),
            effects
          );
          return await work(
            Modules.#boundTo(
              store,
              txDurability,
              this.#artifactOfContent,
              txAuth
            ),
            effects
          );
        }
        if (this.#authorizationStore?.transaction !== undefined) {
          return await this.#authorizationStore.transaction(
            async (txAuthStore) => {
              const txAuth = this.authorization.within(txAuthStore, effects);
              return await work(
                Modules.#boundTo(
                  store,
                  txDurability,
                  this.#artifactOfContent,
                  txAuth
                ),
                effects
              );
            }
          );
        }
        if (rollsBack) {
          throw new TypeError(
            "Modules.transaction() requires an authorizationStore (or store.openAuthorizationStore) to guarantee atomic rollback."
          );
        }
        return await work(
          Modules.#boundTo(
            store,
            txDurability,
            this.#artifactOfContent,
            this.authorization
          ),
          effects
        );
      });
    } catch (error) {
      open = false;
      if (!rollsBack) {
        await runAfterCommit(callbacks).catch((effectError: unknown) => {
          throw new AggregateError(
            [error, effectError],
            "Modules transaction work failed after its commits landed, and so did their effects"
          );
        });
      }
      throw error;
    }
    open = false;
    await runAfterCommit(callbacks);
    return result;
  }

  async registerModule(input: RegisterModuleInput): Promise<Module> {
    const { module } = ownedInput<RegisterModuleInput>(input, {
      module: MODULE,
    });
    return await this.#exclusive(async (store) => {
      const registration = await registrationOf(store, module);
      if (registration.write !== undefined) {
        await store.commit(registration.write);
      }
      return copyModule(registration.module);
    });
  }

  async retainManifest(input: RetainManifestInput): Promise<void> {
    const { contentId, manifest, module } = ownedInput<RetainManifestInput>(
      input,
      { contentId: "value", manifest: "data", module: MODULE }
    );
    return await this.#exclusive(async (store) => {
      const registration = await registrationOf(store, module);
      const existing = await store.getManifest(contentId);
      if (
        existing !== null &&
        (existing.moduleId !== module.id ||
          canonicalizeJson(existing.manifest) !== canonicalizeJson(manifest))
      ) {
        throw new ModuleStoreConflictError(
          `Content ${contentId} already retains a different manifest`
        );
      }
      const write: ModuleStoreWrite = {
        ...registration.write,
        ...(existing === null
          ? { putManifests: [{ contentId, manifest, moduleId: module.id }] }
          : {}),
      };
      if (Object.keys(write).length > 0) {
        await store.commit(write);
      }
    });
  }

  async loadRetainedManifest(
    contentId: ContentId
  ): Promise<ModuleManifest | null> {
    return (await this.#store.getManifest(contentId))?.manifest ?? null;
  }

  async listRetainedManifests(): Promise<readonly RetainedManifest[]> {
    return (await this.#store.listManifests())
      .toSorted(byCodeUnit((stored) => stored.contentId))
      .map(({ contentId, manifest }) => Object.freeze({ contentId, manifest }));
  }

  async dropRetainedManifest(contentId: ContentId): Promise<void> {
    const owned = structuredClone(contentId);
    return await this.#exclusive((store) =>
      store.commit({ deleteManifests: [owned] })
    );
  }

  async loadModule(moduleId: ModuleId): Promise<Module | null> {
    const module = await this.#store.getModule(moduleId);
    return module === null ? null : copyModule(module);
  }

  async listModules(input: PageInput = {}): Promise<Page<Module>> {
    const owned = ownedInput<PageInput>(input, PAGE);
    return await this.#consistent(async (store) => {
      const { listModulesPage } = store;
      if (listModulesPage !== undefined) {
        const result = await mapPageErrors(() =>
          listModulesPage.call(store, {
            ...(owned.cursor === undefined ? {} : { cursor: owned.cursor }),
            limit: pageLimit(owned.limit, { max: 100 }),
          })
        );
        return Object.freeze({
          ...result,
          items: Object.freeze(result.items.map(copyModule)),
        });
      }
      return page(
        (await everything((query) => store.listModules(query))).sort(
          byCodeUnit((module) => module.id)
        ),
        owned,
        (module) => module.id,
        copyModule
      );
    });
  }

  async deleteModule(input: DeleteModuleInput): Promise<void> {
    const { moduleId } = ownedInput<DeleteModuleInput>(input, {
      moduleId: "value",
    });
    return await this.#exclusive(async (store) => {
      if ((await store.getModule(moduleId)) === null) {
        throw new ModuleStoreConflictError(
          `Module ${moduleId} is not registered`
        );
      }
      const [selecting] = (
        await store.listInstallations({ limit: 1, moduleId })
      ).items;
      if (selecting !== undefined) {
        throw new ModuleStoreConflictError(
          `Module ${moduleId} still has Installation ${selecting.installation.id}`
        );
      }
      const retained = await store.listManifests({ moduleId });
      await store.commit({
        deleteManifests: retained.map((stored) => stored.contentId),
        deleteModules: [moduleId],
      });
    });
  }

  async listInstallations(
    input: ListInstallationsInput = {}
  ): Promise<Page<Installation>> {
    const { moduleId, ...pageInput } = ownedInput<ListInstallationsInput>(
      input,
      { ...PAGE, moduleId: "value" }
    );
    return await this.#consistent(async (store) => {
      const { listInstallationsPage } = store;
      if (listInstallationsPage !== undefined) {
        const result = await mapPageErrors(() =>
          listInstallationsPage.call(store, {
            ...(pageInput.cursor === undefined
              ? {}
              : { cursor: pageInput.cursor }),
            limit: pageLimit(pageInput.limit, { max: 100 }),
            ...(moduleId === undefined ? {} : { moduleId }),
          })
        );
        return Object.freeze({
          ...result,
          items: Object.freeze(
            result.items.map((stored) => copyInstallation(stored.installation))
          ),
        });
      }
      return page(
        (
          await everything((query) =>
            store.listInstallations(
              moduleId === undefined ? query : { ...query, moduleId }
            )
          )
        )
          .map((stored) => stored.installation)
          .sort(byCodeUnit((installation) => installation.id)),
        pageInput,
        (installation) => installation.id,
        copyInstallation
      );
    });
  }

  async createInstallation(
    input: CreateInstallationInput
  ): Promise<Installation> {
    const owned = ownedInput<CreateInstallationInput>(input, {
      id: "value",
      now: "value",
      version: VERSION,
    });
    const created: StoredInstallation = {
      installation: createDisabledInstallation(owned),
    };
    await this.#assertContent(owned.version);
    return await this.#exclusive(async (store) => {
      await assertModuleVersion(store, owned.version);
      const { id } = created.installation;
      if ((await store.getInstallation(id)) !== null) {
        throw new ModuleStoreConflictError(`Installation ${id} already exists`);
      }
      await store.commit({ putInstallations: [created] });
      return copyInstallation(created.installation);
    });
  }

  async setInstallationContainerId(
    input: SetInstallationContainerIdInput
  ): Promise<Installation> {
    const owned = ownedInput<SetInstallationContainerIdInput>(input, {
      ...TRANSITION,
      containerId: "value",
    });
    return await this.#change(owned, (stored) =>
      patched(stored, { containerId: owned.containerId, updatedAt: owned.now })
    );
  }

  async beginInstallationTransition(
    input: BeginInstallationTransitionInput
  ): Promise<Installation> {
    const owned = ownedInput<BeginInstallationTransitionInput>(input, {
      ...TRANSITION,
      resetStartAttempts: "value",
      status: "value",
    });
    return await this.#change(owned, (stored) =>
      patched(stored, {
        generation: stored.installation.generation + 1,
        status: owned.status,
        ...(owned.resetStartAttempts === true ? { startAttempts: 0 } : {}),
        updatedAt: owned.now,
      })
    );
  }

  async settleInstallationStatus(
    input: SettleInstallationStatusInput
  ): Promise<Installation> {
    const owned = ownedInput<SettleInstallationStatusInput>(input, {
      ...TRANSITION,
      status: "value",
    });
    return await this.#change(owned, (stored) =>
      patched(stored, {
        startAttempts: settledStartAttempts(
          owned.status,
          stored.installation.startAttempts
        ),
        status: owned.status,
        updatedAt: owned.now,
      })
    );
  }

  async selectInstallationVersion(
    input: SelectInstallationVersionInput
  ): Promise<Installation> {
    const owned = ownedInput<SelectInstallationVersionInput>(input, {
      ...TRANSITION,
      version: VERSION,
    });
    await this.#assertContent(owned.version);
    return await this.#change(owned, async (stored, store) => {
      await assertModuleVersion(store, owned.version);
      if (stored.installation.moduleId !== owned.version.moduleId) {
        throw new ModuleStoreConflictError(
          `Content ${owned.version.contentId} does not belong to Installation ${stored.installation.id}'s Module`
        );
      }
      return patched(stored, {
        contentId: owned.version.contentId,
        generation: stored.installation.generation + 1,
        startAttempts: 0,
        updatedAt: owned.now,
      });
    });
  }

  async deleteInstallation(input: DeleteInstallationInput): Promise<void> {
    const owned = ownedInput<DeleteInstallationInput>(input, TARGET);
    if (BOUND.has(this)) {
      atGeneration(
        await this.#store.getInstallation(owned.installationId),
        owned.installationId,
        owned.expectedGeneration
      );
      await this.authorization.revoke(
        {
          kind: "principal",
          principal: moduleInstallationPrincipal(owned.installationId),
        },
        "Installation deleted"
      );
      await this.#store.commit({
        deleteInstallations: [owned.installationId],
      });
      return;
    }
    await this.transaction(async (registry) => {
      await registry.deleteInstallation(owned);
    });
  }

  async loadGatewayContext(
    installationId: InstallationId
  ): Promise<ModuleGatewayContext | null> {
    const stored = await this.#store.getInstallation(installationId);
    if (stored === null) {
      return null;
    }
    const activeGrants = await this.authorization.listGrants({
      action: MODULE_CAPABILITY_ACTION,
      principal: moduleInstallationPrincipal(installationId),
      state: "active",
    });
    return Object.freeze({
      grants: installationGrantsFrom(activeGrants),
      installation: copyInstallation(stored.installation),
    });
  }

  async #assertContent(version: SelectedVersion): Promise<void> {
    const resolve = this.#artifactOfContent;
    if (resolve === undefined) {
      return;
    }
    const owner = await resolve(version.contentId);
    if (owner === null) {
      throw new ModuleStoreConflictError(
        `Content ${version.contentId} does not exist`
      );
    }
    if (owner !== version.artifactId) {
      throw new ModuleStoreConflictError(
        `Content ${version.contentId} belongs to Artifact ${owner}, not ${version.artifactId}`
      );
    }
  }

  #change<Result>(
    target: Pick<
      InstallationTransitionInput,
      "expectedGeneration" | "installationId"
    >,
    rule: (
      stored: StoredInstallation,
      store: ModuleStore
    ) => InstallationChange<Result> | Promise<InstallationChange<Result>>
  ): Promise<Result> {
    return this.#exclusive(async (store) => {
      const stored = atGeneration(
        await store.getInstallation(target.installationId),
        target.installationId,
        target.expectedGeneration
      );
      const { next, result } = await rule(stored, store);
      await store.commit({ putInstallations: [next] });
      return result;
    });
  }

  #exclusive<T>(work: (store: ModuleStore) => Promise<T>): Promise<T> {
    const store = this.#store;
    if (store.transaction === undefined) {
      return this.#turns.run(() => work(store));
    }
    return store.transaction(work);
  }

  #consistent<T>(work: (store: ModuleStore) => Promise<T>): Promise<T> {
    const store = this.#store;
    return store.transaction === undefined
      ? work(store)
      : store.transaction(work);
  }
}

interface InputShape {
  readonly [field: string]:
    | "data"
    | "value"
    | InputShape
    | readonly [InputShape];
}

const MODULE = { artifactId: "value", id: "value" } as const;
const TARGET = {
  expectedGeneration: "value",
  installationId: "value",
} as const;
const TRANSITION = { ...TARGET, now: "value" } as const;
const VERSION = {
  artifactId: "value",
  contentId: "value",
  moduleId: "value",
} as const;
const PAGE = { cursor: "value", limit: "value" } as const;

function ownedInput<T>(input: unknown, shape: InputShape): T {
  return structuredClone(readInput(input, shape, "input")) as T;
}

function readInput(
  input: unknown,
  shape: InputShape,
  at: string
): Record<string, unknown> {
  if (typeof input !== "object" || input === null) {
    throw new TypeError(`${at} must be an object`);
  }
  const read: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(shape)) {
    const value: unknown = Reflect.get(input, field);
    if (value === undefined) {
      continue;
    }
    const fieldAt = `${at}.${field}`;
    if (kind === "value") {
      read[field] = value;
    } else if (kind === "data") {
      read[field] = plainCopy(value, fieldAt);
    } else if (isListShape(kind)) {
      if (!Array.isArray(value)) {
        throw new TypeError(`${fieldAt} must be an array`);
      }
      read[field] = Array.from({ length: value.length }, (_, index) =>
        readInput(value[index], kind[0], `${fieldAt}[${index}]`)
      );
    } else {
      read[field] = readInput(value, kind, fieldAt);
    }
  }
  return read;
}

function isListShape(
  kind: InputShape | readonly [InputShape]
): kind is readonly [InputShape] {
  return Array.isArray(kind);
}

interface InstallationChange<Result> {
  readonly next: StoredInstallation;
  readonly result: Result;
}

interface Registration {
  readonly module: Module;
  readonly write?: ModuleStoreWrite;
}

async function registrationOf(
  store: ModuleStore,
  module: Module
): Promise<Registration> {
  const existing = await store.getModule(module.id);
  if (existing !== null) {
    if (existing.artifactId !== module.artifactId) {
      throw new ModuleStoreConflictError(
        `Module ${module.id} already belongs to another Artifact`
      );
    }
    return { module: existing };
  }
  const [owner] = (
    await store.listModules({ artifactId: module.artifactId, limit: 1 })
  ).items;
  if (owner !== undefined) {
    throw new ModuleStoreConflictError(
      `Artifact ${module.artifactId} already belongs to Module ${owner.id}`
    );
  }
  return { module, write: { putModules: [module] } };
}

async function assertModuleVersion(
  store: ModuleStore,
  version: SelectedVersion
): Promise<void> {
  const module = await store.getModule(version.moduleId);
  if (module?.artifactId !== version.artifactId) {
    throw new ModuleStoreConflictError(
      `Content ${version.contentId} does not belong to a registered Module`
    );
  }
}

function atGeneration(
  stored: StoredInstallation | null,
  installationId: InstallationId,
  expectedGeneration: number
): StoredInstallation {
  if (stored === null) {
    throw new ModuleStoreNotFoundError(installationId);
  }
  const { generation } = stored.installation;
  if (generation !== expectedGeneration) {
    throw new ModuleStoreConflictError(
      `Installation ${installationId} generation is ${generation}, not ${expectedGeneration}`
    );
  }
  return stored;
}

function settledStartAttempts(
  status: SettleInstallationStatusInput["status"],
  startAttempts: number
): number {
  if (status === "active") {
    return 0;
  }
  if (status === "failed") {
    return startAttempts + 1;
  }
  return startAttempts;
}

function patched(
  stored: StoredInstallation,
  patch: Partial<Installation>
): InstallationChange<Installation> {
  const installation = copyInstallation({ ...stored.installation, ...patch });
  return {
    next: { ...stored, installation },
    result: copyInstallation(installation),
  };
}

function withoutTransaction(
  view: ModuleStore,
  durability: ModuleStoreDurability
): ModuleStore {
  const { listInstallationsPage, listModulesPage } = view;
  return {
    commit: (write) => view.commit(write),
    durability: view.durability ?? durability,
    getInstallation: (id) => view.getInstallation(id),
    getManifest: (contentId) => view.getManifest(contentId),
    getModule: (id) => view.getModule(id),
    listInstallations: (query) => view.listInstallations(query),
    ...(listInstallationsPage === undefined
      ? {}
      : {
          listInstallationsPage: (query) =>
            listInstallationsPage.call(view, query),
        }),
    listManifests: (query) => view.listManifests(query),
    listModules: (query) => view.listModules(query),
    ...(listModulesPage === undefined
      ? {}
      : {
          listModulesPage: (query) => listModulesPage.call(view, query),
        }),
  };
}

async function mapPageErrors<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ModuleStoreConflictError(error.message, { cause: error });
    }
    throw error;
  }
}

async function everything<T>(
  list: (query: ModuleStorePageQuery) => Promise<ModuleStorePage<T>>
): Promise<T[]> {
  const items: T[] = [];
  let after: number | undefined;
  do {
    const read = await list(
      after === undefined
        ? { limit: STORE_PAGE_LIMIT }
        : { after, limit: STORE_PAGE_LIMIT }
    );
    items.push(...read.items);
    after = read.next;
  } while (after !== undefined);
  return items;
}

function copyModule(value: Module): Module {
  return Object.freeze({ artifactId: value.artifactId, id: value.id });
}

function copyInstallation(value: Installation): Installation {
  return Object.freeze({
    containerId: value.containerId,
    contentId: value.contentId,
    createdAt: new Date(value.createdAt),
    generation: value.generation,
    id: value.id,
    moduleId: value.moduleId,
    startAttempts: value.startAttempts,
    status: value.status,
    updatedAt: new Date(value.updatedAt),
  });
}
