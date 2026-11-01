import { AsyncLocalStorage } from "node:async_hooks";

import type { ContentId } from "@foundry/artifacts";
import type { Page, PageInput } from "@foundry/core/pagination";

import { canonicalizeJson } from "@foundry/lib/json";
import { byCodeUnit } from "@foundry/lib/ordering";

import type { Installation, InstallationId, Module, ModuleId } from "../domain";
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
import { ModuleStoreConflictError } from "./contract";
import {
  atGeneration,
  beginTransition,
  copyGrant,
  copyInstallation,
  copyModule,
  type InstallationRule,
  type InstallationTarget,
  newInstallation,
  replaceGrants,
  revokeGrant,
  type StoredInstallation,
  selectVersion,
  setContainer,
  settle,
} from "./installation-rules";
import { page } from "./page";

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
    const created = newInstallation(input);
    this.#assertModuleVersion(input.version);
    if (this.#installations.has(created.installation.id)) {
      throw new ModuleStoreConflictError(
        `Installation ${created.installation.id} already exists`
      );
    }
    this.#installations.set(created.installation.id, created);
    return copyInstallation(created.installation);
  }

  setInstallationContainerId(
    input: SetInstallationContainerIdInput
  ): Promise<Installation> {
    return this.#mutate(input, setContainer(input));
  }

  beginInstallationTransition(
    input: BeginInstallationTransitionInput
  ): Promise<Installation> {
    return this.#mutate(input, beginTransition(input));
  }

  settleInstallationStatus(
    input: SettleInstallationStatusInput
  ): Promise<Installation> {
    return this.#mutate(input, settle(input));
  }

  async selectInstallationVersion(
    input: SelectInstallationVersionInput
  ): Promise<Installation> {
    return await this.#mutate(input, (stored) => {
      this.#assertModuleVersion(input.version);
      return selectVersion(input)(stored);
    });
  }

  async deleteInstallation(input: DeleteInstallationInput): Promise<void> {
    await this.#turn();
    atGeneration(
      this.#installations.get(input.installationId),
      input.installationId,
      input.expectedGeneration
    );
    this.#installations.delete(input.installationId);
  }

  replaceInstallationGrants(
    input: ReplaceInstallationGrantsInput
  ): Promise<readonly InstallationGrant[]> {
    return this.#mutate(input, replaceGrants(input));
  }

  revokeInstallationGrant(
    input: RevokeInstallationGrantInput
  ): Promise<InstallationGrant> {
    return this.#mutate(input, revokeGrant(input));
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

  /** Applies `rule` to the Installation at the expected generation and keeps the result. */
  async #mutate<Result>(
    target: InstallationTarget,
    rule: InstallationRule<Result>
  ): Promise<Result> {
    await this.#turn();
    const { next, result } = rule(
      atGeneration(
        this.#installations.get(target.installationId),
        target.installationId,
        target.expectedGeneration
      )
    );
    this.#installations.set(target.installationId, next);
    return result;
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
      installations: new Map(this.#installations),
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

function replaceMap<Key, Value>(
  target: Map<Key, Value>,
  source: Map<Key, Value>
): void {
  target.clear();
  for (const [key, value] of source) {
    target.set(key, value);
  }
}
