import type { ContentId } from "@foundry/artifacts";
import type { Page, PageInput } from "@foundry/core/pagination";
import type { CommitEffects } from "@foundry/core/storage";

import type {
  Installation,
  InstallationId,
  InstallationStatus,
  Module,
  ModuleId,
  ModuleVersion,
} from "../domain";
import type { ModuleManifest } from "../manifest";
import type {
  InstallationGrant,
  RetainedManifest,
  StoredInstallation,
} from "../schema";

export type { InstallationGrant, RetainedManifest } from "../schema";

/** What the gateway reads to authorize a call: an Installation with its Grants. */
export type ModuleGatewayContext = StoredInstallation;

export interface RegisterModuleInput {
  readonly module: Module;
}

export interface RetainManifestInput extends RetainedManifest {
  readonly module: Module;
}

/** The Store checks that the version's Artifact belongs to the Module. */
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

/** Compare-and-set against the Installation's current generation. */
export interface InstallationTransitionInput {
  readonly expectedGeneration: number;
  readonly installationId: InstallationId;
  readonly now: Date;
}

/**
 * Opens a new occurrence (`starting`) or closes the current one (`stopping`).
 * Bumps the generation: the program that connects, or was connected, is bound
 * to the generation it saw. A user enable resets the crash-loop budget; an
 * automatic recovery attempt keeps consuming it.
 */
export interface BeginInstallationTransitionInput
  extends InstallationTransitionInput {
  readonly resetStartAttempts?: boolean;
  readonly status: Extract<InstallationStatus, "starting" | "stopping">;
}

/**
 * Settles the occurrence begun at this generation. The generation is kept, so
 * the connected program stays current. `active` resets `startAttempts`;
 * `failed` consumes one.
 */
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

/**
 * Retiring one Module and every retained manifest of its Artifact. The Store
 * refuses while any Installation still selects the Module: an Installation
 * carries authority and data, so removing what it points at is never implicit.
 */
export interface DeleteModuleInput {
  readonly moduleId: ModuleId;
}

export interface ModuleStore {
  beginInstallationTransition(
    input: BeginInstallationTransitionInput
  ): Promise<Installation>;
  createInstallation(input: CreateInstallationInput): Promise<Installation>;
  /** Removes the row and its grants. The caller has stopped it and detached its data. */
  deleteInstallation(input: DeleteInstallationInput): Promise<void>;
  deleteModule(input: DeleteModuleInput): Promise<void>;
  /** Only for a manifest proven equal to the Content's embedded source. */
  dropRetainedManifest(contentId: ContentId): Promise<void>;
  listInstallations(
    input?: ListInstallationsInput
  ): Promise<Page<Installation>>;
  listModules(input?: PageInput): Promise<Page<Module>>;
  /** Every retained manifest, in Content id order. */
  listRetainedManifests(): Promise<readonly RetainedManifest[]>;
  loadGatewayContext(
    installationId: InstallationId
  ): Promise<ModuleGatewayContext | null>;
  loadModule(moduleId: ModuleId): Promise<Module | null>;
  loadRetainedManifest(contentId: ContentId): Promise<ModuleManifest | null>;
  registerModule(input: RegisterModuleInput): Promise<Module>;
  /** The whole approved set; generation checked, not bumped. */
  replaceInstallationGrants(
    input: ReplaceInstallationGrantsInput
  ): Promise<readonly InstallationGrant[]>;
  /** Registers the Module if absent. Idempotent; a different manifest conflicts. */
  retainManifest(input: RetainManifestInput): Promise<void>;
  revokeInstallationGrant(
    input: RevokeInstallationGrantInput
  ): Promise<InstallationGrant>;
  /** Moves the selection; bumps the generation and resets `startAttempts`. */
  selectInstallationVersion(
    input: SelectInstallationVersionInput
  ): Promise<Installation>;
  /** Links the runtime container under the current generation without bumping it. */
  setInstallationContainerId(
    input: SetInstallationContainerIdInput
  ): Promise<Installation>;
  settleInstallationStatus(
    input: SettleInstallationStatusInput
  ): Promise<Installation>;
  /**
   * Runs one exclusive serializable Store unit. Effects registered with afterCommit
   * run only after the outermost commit, even if applying its records fails;
   * rollback discards them. Nested calls on the same Store
   * join the active transaction; calls outside it wait. Failure rolls back only
   * the unit's writes and cannot erase a queued concurrent write, with one
   * exception: a durable Store may commit the unit and then throw a
   * `StorageApplicationError` (`committed: true`) when applying the committed
   * records to the host fails. Those writes stand, and the operation's
   * result is lost.
   */
  transaction<T>(operation: (effects: CommitEffects) => Promise<T>): Promise<T>;
}

export class ModuleStoreConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModuleStoreConflictError";
  }
}

export class ModuleStoreNotFoundError extends Error {
  readonly installationId: InstallationId;

  constructor(installationId: InstallationId) {
    super(`Installation ${installationId} was not found`);
    this.installationId = installationId;
    this.name = "ModuleStoreNotFoundError";
  }
}

export class ModuleStoreCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleStoreCorruptionError";
  }
}
