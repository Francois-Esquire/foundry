import type { ArtifactId, ContentId } from "@foundry/artifacts";
import type { Page, PageInput } from "@foundry/core/pagination";
import { type CommitEffects, runAfterCommit } from "@foundry/core/storage";
import { canonicalizeJson } from "@foundry/lib/json";
import { byCodeUnit } from "@foundry/lib/ordering";
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
import type { ModuleManifest } from "./manifest";
import { page } from "./page";
import type {
  InstallationGrant,
  RetainedManifest,
  StoredInstallation,
} from "./schema";
import { grantCapabilitiesProblem } from "./schema";
import type {
  ModuleStore,
  ModuleStoreDurability,
  ModuleStorePage,
  ModuleStorePageQuery,
  ModuleStoreWrite,
} from "./store";
import { plainCopy } from "./store/captured";
import { MemoryModuleStore } from "./store/memory";

export type { InstallationGrant, RetainedManifest } from "./schema";

export type ModuleGatewayContext = StoredInstallation;

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

export interface ReplaceInstallationGrantsInput {
  readonly expectedGeneration: number;
  readonly grants: readonly Omit<InstallationGrant, "createdAt">[];
  readonly installationId: InstallationId;
  readonly now: Date;
}

export interface RevokeInstallationGrantInput {
  readonly capability: string;
  readonly expectedGeneration: number;
  readonly installationId: InstallationId;
}

export interface DeleteModuleInput {
  readonly moduleId: ModuleId;
}

export interface ModuleRegistryOptions {
  readonly artifactOfContent?: (
    contentId: ContentId
  ) => Promise<ArtifactId | null>;
  readonly store?: ModuleStore;
}

export type ModuleRegistryCommand = Exclude<
  keyof ModuleRegistry,
  "durability" | "transaction"
>;

export type ModuleRegistryUnit<Command extends ModuleRegistryCommand> = Pick<
  ModuleRegistry,
  Command
> & {
  readonly durability?: ModuleStoreDurability;
  transaction<T>(
    work: (
      registry: Pick<ModuleRegistry, Command>,
      effects: CommitEffects
    ) => Promise<T>
  ): Promise<T>;
};

export type ModuleCommands = ModuleRegistryUnit<ModuleRegistryCommand>;

const REENTRY =
  "ModuleRegistry was called from inside its own transaction; use the registry passed to the transaction's work instead";

const NESTED =
  "ModuleRegistry.transaction was called on a registry bound to a transaction, and transactions do not nest; use the registry passed to the transaction's work instead";

const SETTLED =
  "ModuleRegistry transaction has settled; register an effect while its work runs";

const BOUND = new WeakSet<ModuleRegistry>();

const STORE_PAGE_LIMIT = 500;

export class ModuleRegistry {
  readonly durability: ModuleStoreDurability;
  readonly #store: ModuleStore;
  readonly #artifactOfContent: ModuleRegistryOptions["artifactOfContent"];
  readonly #turns = new Turns(REENTRY);

  constructor(options: ModuleRegistryOptions = {}) {
    this.#store = options.store ?? new MemoryModuleStore();
    this.#artifactOfContent = options.artifactOfContent;
    this.durability = this.#store.durability ?? "commit";
  }

  static #boundTo(
    view: ModuleStore,
    durability: ModuleStoreDurability,
    artifactOfContent: ModuleRegistryOptions["artifactOfContent"]
  ): ModuleRegistry {
    const registry = new ModuleRegistry({
      store: withoutTransaction(view, durability),
      ...(artifactOfContent === undefined ? {} : { artifactOfContent }),
    });
    BOUND.add(registry);
    return registry;
  }

  async transaction<T>(
    work: (registry: ModuleRegistry, effects: CommitEffects) => Promise<T>
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
    let result: T;
    try {
      result = await this.#exclusive((store) =>
        work(
          ModuleRegistry.#boundTo(
            store,
            rollsBack ? "host" : this.durability,
            this.#artifactOfContent
          ),
          effects
        )
      );
    } catch (error) {
      open = false;
      if (!rollsBack) {
        await runAfterCommit(callbacks).catch((effectError: unknown) => {
          throw new AggregateError(
            [error, effectError],
            "ModuleRegistry transaction work failed after its commits landed, and so did their effects"
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
    return await this.#consistent(async (store) =>
      page(
        (await everything((query) => store.listModules(query))).sort(
          byCodeUnit((module) => module.id)
        ),
        owned,
        (module) => module.id,
        copyModule
      )
    );
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
    return await this.#consistent(async (store) =>
      page(
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
      )
    );
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
      grants: [],
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
    return await this.#exclusive(async (store) => {
      atGeneration(
        await store.getInstallation(owned.installationId),
        owned.installationId,
        owned.expectedGeneration
      );
      await store.commit({ deleteInstallations: [owned.installationId] });
    });
  }

  async replaceInstallationGrants(
    input: ReplaceInstallationGrantsInput
  ): Promise<readonly InstallationGrant[]> {
    const owned = ownedInput<ReplaceInstallationGrantsInput>(input, {
      ...TRANSITION,
      grants: [
        { capability: "value", constraintsDigest: "value", version: "value" },
      ],
    });
    return await this.#change(owned, (stored) => {
      const problem = grantCapabilitiesProblem(owned.grants);
      if (problem !== null) {
        throw new ModuleStoreConflictError(problem);
      }
      const grants = owned.grants
        .map((grant) => copyGrant({ ...grant, createdAt: owned.now }))
        .sort(byCodeUnit((grant) => grant.capability));
      return {
        next: { ...stored, grants },
        result: Object.freeze(grants.map(copyGrant)),
      };
    });
  }

  async revokeInstallationGrant(
    input: RevokeInstallationGrantInput
  ): Promise<InstallationGrant> {
    const owned = ownedInput<RevokeInstallationGrantInput>(input, {
      ...TARGET,
      capability: "value",
    });
    return await this.#change(owned, (stored) => {
      const revoked = stored.grants.find(
        (grant) => grant.capability === owned.capability
      );
      if (revoked === undefined) {
        throw new ModuleStoreConflictError(
          `Installation ${owned.installationId} has no grant for ${owned.capability}`
        );
      }
      return {
        next: {
          ...stored,
          grants: stored.grants.filter((grant) => grant !== revoked),
        },
        result: copyGrant(revoked),
      };
    });
  }

  async loadGatewayContext(
    installationId: InstallationId
  ): Promise<ModuleGatewayContext | null> {
    const stored = await this.#store.getInstallation(installationId);
    if (stored === null) {
      return null;
    }
    return Object.freeze({
      grants: Object.freeze(stored.grants.map(copyGrant)),
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
  return {
    commit: (write) => view.commit(write),
    durability: view.durability ?? durability,
    getInstallation: (id) => view.getInstallation(id),
    getManifest: (contentId) => view.getManifest(contentId),
    getModule: (id) => view.getModule(id),
    listInstallations: (query) => view.listInstallations(query),
    listManifests: (query) => view.listManifests(query),
    listModules: (query) => view.listModules(query),
  };
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

function copyGrant(value: InstallationGrant): InstallationGrant {
  return Object.freeze({
    capability: value.capability,
    constraintsDigest: value.constraintsDigest,
    createdAt: new Date(value.createdAt),
    version: value.version,
  });
}
