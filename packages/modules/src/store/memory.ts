import { AsyncLocalStorage } from "node:async_hooks";

import type { ContentId } from "@foundry/artifacts";
import type { Page, PageInput } from "@foundry/core/pagination";

import { canonicalizeJson } from "@foundry/lib/json";
import { byCodeUnit } from "@foundry/lib/ordering";

import type { Installation, InstallationId, Module, ModuleId } from "../domain";
import { createDisabledInstallation } from "../domain";
import type { ModuleManifest } from "../manifest";
import type {
  BeginInstallationTransitionInput,
  CreateInstallationInput,
  DeleteInstallationInput,
  DeleteModuleInput,
  InstallationGrant,
  ListInstallationsInput,
  ModuleGatewayContext,
  ModuleStore,
  RegisterModuleInput,
  ReplaceInstallationGrantsInput,
  RetainedManifest,
  RetainManifestInput,
  RevokeInstallationGrantInput,
  SelectedVersion,
  SelectInstallationVersionInput,
  SetInstallationContainerIdInput,
  SettleInstallationStatusInput,
} from "./contract";
import { ModuleStoreConflictError, ModuleStoreNotFoundError } from "./contract";
import { page } from "./page";

interface StoredInstallation {
  grants: InstallationGrant[];
  installation: Installation;
}

interface StoredManifest {
  readonly manifest: ModuleManifest;
  readonly moduleId: ModuleId;
}

interface Snapshot {
  readonly installations: Map<InstallationId, StoredInstallation>;
  readonly manifests: Map<ContentId, StoredManifest>;
  readonly moduleIdsByArtifact: Map<Module["artifactId"], ModuleId>;
  readonly modules: Map<ModuleId, Module>;
}

/** Deterministic, adapter-neutral reference implementation of ModuleStore. */
export class InMemoryModuleStore implements ModuleStore {
  readonly #modules = new Map<ModuleId, Module>();
  readonly #moduleIdsByArtifact = new Map<Module["artifactId"], ModuleId>();
  readonly #manifests = new Map<ContentId, StoredManifest>();
  readonly #installations = new Map<InstallationId, StoredInstallation>();
  readonly #transactionScope = new AsyncLocalStorage<boolean>();
  #transactionTail: Promise<void> = Promise.resolve();

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#transactionScope.getStore() === true) {
      return operation();
    }
    const previous = this.#transactionTail;
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#transactionTail = previous.then(() => current);
    await previous;
    const snapshot = this.#snapshot();
    try {
      return await this.#transactionScope.run(true, operation);
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    } finally {
      release?.();
    }
  }

  async registerModule(input: RegisterModuleInput): Promise<Module> {
    await this.#turn();
    return this.#registerModule(input.module);
  }

  async retainManifest(input: RetainManifestInput): Promise<void> {
    await this.#turn();
    this.#registerModule(input.module);
    const existing = this.#manifests.get(input.contentId);
    if (existing === undefined) {
      this.#manifests.set(input.contentId, {
        manifest: structuredClone(input.manifest),
        moduleId: input.module.id,
      });
      return;
    }
    if (
      existing.moduleId !== input.module.id ||
      canonicalizeJson(existing.manifest) !== canonicalizeJson(input.manifest)
    ) {
      throw new ModuleStoreConflictError(
        `Content ${input.contentId} already retains a different manifest`
      );
    }
  }

  async loadRetainedManifest(
    contentId: ContentId
  ): Promise<ModuleManifest | null> {
    await this.#turn();
    const stored = this.#manifests.get(contentId);
    return stored === undefined ? null : structuredClone(stored.manifest);
  }

  async listRetainedManifests(): Promise<readonly RetainedManifest[]> {
    await this.#turn();
    return [...this.#manifests]
      .sort(byCodeUnit(([contentId]) => contentId))
      .map(([contentId, stored]) =>
        Object.freeze({
          contentId,
          manifest: structuredClone(stored.manifest),
        })
      );
  }

  async dropRetainedManifest(contentId: ContentId): Promise<void> {
    await this.#turn();
    this.#manifests.delete(contentId);
  }

  async loadModule(moduleId: ModuleId): Promise<Module | null> {
    await this.#turn();
    const module = this.#modules.get(moduleId);
    return module === undefined ? null : copyModule(module);
  }

  async listModules(input: PageInput = {}): Promise<Page<Module>> {
    await this.#turn();
    return page(
      [...this.#modules.values()].sort(byCodeUnit((module) => module.id)),
      input,
      (module) => module.id,
      copyModule
    );
  }

  async deleteModule(input: DeleteModuleInput): Promise<void> {
    await this.#turn();
    const module = this.#modules.get(input.moduleId);
    if (module === undefined) {
      throw new ModuleStoreConflictError(
        `Module ${input.moduleId} is not registered`
      );
    }
    for (const stored of this.#installations.values()) {
      if (stored.installation.moduleId === input.moduleId) {
        throw new ModuleStoreConflictError(
          `Module ${input.moduleId} still has Installation ${stored.installation.id}`
        );
      }
    }
    for (const [contentId, stored] of this.#manifests) {
      if (stored.moduleId === input.moduleId) {
        this.#manifests.delete(contentId);
      }
    }
    this.#modules.delete(input.moduleId);
    this.#moduleIdsByArtifact.delete(module.artifactId);
  }

  async listInstallations({
    moduleId,
    ...input
  }: ListInstallationsInput = {}): Promise<Page<Installation>> {
    await this.#turn();
    return page(
      [...this.#installations.values()]
        .map((stored) => stored.installation)
        .filter(
          (installation) =>
            moduleId === undefined || installation.moduleId === moduleId
        )
        .sort(byCodeUnit((installation) => installation.id)),
      input,
      (installation) => installation.id,
      copyInstallation
    );
  }

  async createInstallation(
    input: CreateInstallationInput
  ): Promise<Installation> {
    await this.#turn();
    const installation = createDisabledInstallation(input);
    this.#assertModuleVersion(input.version);
    if (this.#installations.has(installation.id)) {
      throw new ModuleStoreConflictError(
        `Installation ${installation.id} already exists`
      );
    }
    this.#installations.set(installation.id, {
      grants: [],
      installation: copyInstallation(installation),
    });
    return copyInstallation(installation);
  }

  async setInstallationContainerId(
    input: SetInstallationContainerIdInput
  ): Promise<Installation> {
    await this.#turn();
    const stored = this.#current(
      input.installationId,
      input.expectedGeneration
    );
    return this.#apply(stored, {
      containerId: input.containerId,
      updatedAt: input.now,
    });
  }

  async beginInstallationTransition(
    input: BeginInstallationTransitionInput
  ): Promise<Installation> {
    await this.#turn();
    const stored = this.#current(
      input.installationId,
      input.expectedGeneration
    );
    return this.#apply(stored, {
      generation: stored.installation.generation + 1,
      status: input.status,
      ...(input.resetStartAttempts === true ? { startAttempts: 0 } : {}),
      updatedAt: input.now,
    });
  }

  async settleInstallationStatus(
    input: SettleInstallationStatusInput
  ): Promise<Installation> {
    await this.#turn();
    const stored = this.#current(
      input.installationId,
      input.expectedGeneration
    );
    const { startAttempts } = stored.installation;
    return this.#apply(stored, {
      startAttempts: settledStartAttempts(input.status, startAttempts),
      status: input.status,
      updatedAt: input.now,
    });
  }

  async selectInstallationVersion(
    input: SelectInstallationVersionInput
  ): Promise<Installation> {
    await this.#turn();
    const stored = this.#current(
      input.installationId,
      input.expectedGeneration
    );
    this.#assertModuleVersion(input.version);
    if (stored.installation.moduleId !== input.version.moduleId) {
      throw new ModuleStoreConflictError(
        `Content ${input.version.contentId} does not belong to Installation ${stored.installation.id}'s Module`
      );
    }
    return this.#apply(stored, {
      contentId: input.version.contentId,
      generation: stored.installation.generation + 1,
      startAttempts: 0,
      updatedAt: input.now,
    });
  }

  async deleteInstallation(input: DeleteInstallationInput): Promise<void> {
    await this.#turn();
    this.#current(input.installationId, input.expectedGeneration);
    this.#installations.delete(input.installationId);
  }

  async replaceInstallationGrants(
    input: ReplaceInstallationGrantsInput
  ): Promise<readonly InstallationGrant[]> {
    await this.#turn();
    const stored = this.#current(
      input.installationId,
      input.expectedGeneration
    );
    const capabilities = new Set<string>();
    for (const grant of input.grants) {
      if (capabilities.has(grant.capability)) {
        throw new ModuleStoreConflictError(
          `Grant capability ${grant.capability} is duplicated`
        );
      }
      capabilities.add(grant.capability);
    }
    stored.grants = input.grants
      .map((grant) =>
        Object.freeze({ ...grant, createdAt: new Date(input.now) })
      )
      .sort(byCodeUnit((grant) => grant.capability));
    return stored.grants.map(copyGrant);
  }

  async revokeInstallationGrant(
    input: RevokeInstallationGrantInput
  ): Promise<InstallationGrant> {
    await this.#turn();
    const stored = this.#current(
      input.installationId,
      input.expectedGeneration
    );
    const index = stored.grants.findIndex(
      (candidate) => candidate.capability === input.capability
    );
    const grant = stored.grants[index];
    if (grant === undefined) {
      throw new ModuleStoreConflictError(
        `Installation ${input.installationId} has no grant for ${input.capability}`
      );
    }
    stored.grants.splice(index, 1);
    return copyGrant(grant);
  }

  async loadGatewayContext(
    installationId: InstallationId
  ): Promise<ModuleGatewayContext | null> {
    await this.#turn();
    const stored = this.#installations.get(installationId);
    if (stored === undefined) {
      return null;
    }
    return Object.freeze({
      grants: Object.freeze(stored.grants.map(copyGrant)),
      installation: copyInstallation(stored.installation),
    });
  }

  #current(
    installationId: InstallationId,
    expectedGeneration: number
  ): StoredInstallation {
    const stored = this.#installations.get(installationId);
    if (stored === undefined) {
      throw new ModuleStoreNotFoundError(installationId);
    }
    if (stored.installation.generation !== expectedGeneration) {
      throw new ModuleStoreConflictError(
        `Installation ${installationId} generation is ${stored.installation.generation}, not ${expectedGeneration}`
      );
    }
    return stored;
  }

  #apply(
    stored: StoredInstallation,
    patch: Partial<Installation>
  ): Installation {
    stored.installation = copyInstallation({
      ...stored.installation,
      ...patch,
    });
    return copyInstallation(stored.installation);
  }

  #assertModuleVersion(version: SelectedVersion): void {
    const module = this.#modules.get(version.moduleId);
    if (module?.artifactId !== version.artifactId) {
      throw new ModuleStoreConflictError(
        `Content ${version.contentId} does not belong to a registered Module`
      );
    }
  }

  #registerModule(module: Module): Module {
    const existing = this.#modules.get(module.id);
    if (existing !== undefined) {
      if (existing.artifactId !== module.artifactId) {
        throw new ModuleStoreConflictError(
          `Module ${module.id} already belongs to another Artifact`
        );
      }
      return copyModule(existing);
    }
    const artifactOwner = this.#moduleIdsByArtifact.get(module.artifactId);
    if (artifactOwner !== undefined && artifactOwner !== module.id) {
      throw new ModuleStoreConflictError(
        `Artifact ${module.artifactId} already belongs to Module ${artifactOwner}`
      );
    }
    const registered = copyModule(module);
    this.#modules.set(registered.id, registered);
    this.#moduleIdsByArtifact.set(registered.artifactId, registered.id);
    return copyModule(registered);
  }

  #snapshot(): Snapshot {
    return {
      installations: new Map(
        [...this.#installations].map(([id, stored]) => [
          id,
          { grants: [...stored.grants], installation: stored.installation },
        ])
      ),
      manifests: new Map(this.#manifests),
      moduleIdsByArtifact: new Map(this.#moduleIdsByArtifact),
      modules: new Map(this.#modules),
    };
  }

  #restore(snapshot: Snapshot): void {
    replaceMap(this.#modules, snapshot.modules);
    replaceMap(this.#moduleIdsByArtifact, snapshot.moduleIdsByArtifact);
    replaceMap(this.#manifests, snapshot.manifests);
    replaceMap(this.#installations, snapshot.installations);
  }

  /**
   * Yields one microtask before every operation so the reference adapter
   * interleaves exactly like a database-backed one; the shared conformance
   * suite relies on that to prove compare-and-set under concurrent callers.
   */
  #turn(): Promise<void> {
    return this.#transactionScope.getStore() === true
      ? Promise.resolve()
      : this.#transactionTail;
  }
}

/** Active resets the start budget; failed spends one attempt; others keep it. */
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

function copyModule(value: Module): Module {
  return Object.freeze({ ...value });
}

function copyInstallation(value: Installation): Installation {
  return Object.freeze({
    ...value,
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
  });
}

function copyGrant(value: InstallationGrant): InstallationGrant {
  return Object.freeze({ ...value, createdAt: new Date(value.createdAt) });
}

function replaceMap<Key, Value>(
  target: Map<Key, Value>,
  source: Map<Key, Value>
): void {
  target.clear();
  for (const [key, value] of source) {
    target.set(key, value);
  }
}
