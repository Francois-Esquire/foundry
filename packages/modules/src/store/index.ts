import type { ArtifactId, ContentId } from "@foundry/artifacts";
import type { AuthorizationStore } from "@foundry/authorization/store";
import type { Page, PageInput } from "@foundry/core/pagination";

import type { InstallationId, ModuleId } from "../domain";
import type { Module, StoredInstallation, StoredManifest } from "../records";

export type { Module, StoredInstallation, StoredManifest } from "../records";

export interface ModuleStoreWrite {
  readonly deleteInstallations?: readonly InstallationId[];
  readonly deleteManifests?: readonly ContentId[];
  readonly deleteModules?: readonly ModuleId[];
  readonly putInstallations?: readonly StoredInstallation[];
  readonly putManifests?: readonly StoredManifest[];
  readonly putModules?: readonly Module[];
}

export type ModuleStoreDurability = "commit" | "host";

export type ModuleStoreCursor = number;

export interface ModuleStorePageQuery {
  readonly after?: ModuleStoreCursor;
  readonly limit: number;
}

export interface ModuleStorePage<T> {
  readonly items: readonly T[];
  readonly next?: ModuleStoreCursor;
}

export interface ModuleListQuery extends ModuleStorePageQuery {
  readonly artifactId?: ArtifactId;
}

export interface InstallationListQuery extends ModuleStorePageQuery {
  readonly moduleId?: ModuleId;
}

export interface ModuleIdPageQuery extends PageInput<string> {
  readonly artifactId?: ArtifactId;
}

export interface InstallationIdPageQuery extends PageInput<string> {
  readonly moduleId?: ModuleId;
}

export interface ManifestListQuery {
  readonly moduleId?: ModuleId;
}

export interface ModuleStore {
  commit(write: ModuleStoreWrite): Promise<void>;
  readonly durability?: ModuleStoreDurability;
  getInstallation(id: InstallationId): Promise<StoredInstallation | null>;
  getManifest(contentId: ContentId): Promise<StoredManifest | null>;
  getModule(id: ModuleId): Promise<Module | null>;
  listInstallations(
    query: InstallationListQuery
  ): Promise<ModuleStorePage<StoredInstallation>>;
  listInstallationsPage?(
    query?: InstallationIdPageQuery
  ): Promise<Page<StoredInstallation, string>>;
  listManifests(query?: ManifestListQuery): Promise<readonly StoredManifest[]>;
  listModules(query: ModuleListQuery): Promise<ModuleStorePage<Module>>;
  listModulesPage?(query?: ModuleIdPageQuery): Promise<Page<Module, string>>;
  openAuthorizationStore?(): AuthorizationStore;
  transaction?<T>(work: (view: ModuleStore) => Promise<T>): Promise<T>;
}
