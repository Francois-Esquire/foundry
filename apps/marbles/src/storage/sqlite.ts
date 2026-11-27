import type { SessionRecord } from "@foundry/agents/session";
import type { Artifact } from "@foundry/artifacts";
import type { ContainerRow } from "@foundry/sandbox";
import { ChangeRecorder } from "~/database/changes";
import {
  ALL_WORKSPACES,
  ResourceView,
  resourceAssociations,
  type ViewScope,
} from "~/database/resources";
import {
  assembleSqliteWorkspaceStores,
  type SqliteWorkspaceStores,
} from "~/database/stores";
import type { StoreDatabase } from "~/database/types";
import { WorkspaceRegistry } from "~/database/workspaces";
import type { OwnerLiveness } from "~/lib/owner-liveness";
import type {
  ResourceAssociations,
  ResourceKind,
  ResourceRef,
} from "~/lib/resources";
import { insideState } from "~/lib/state/workspace";
import { MemoryRunStreamStorage } from "~/storage/memory";
import {
  type ArtifactFileSummary,
  type BlobStorage,
  type MarblesStorage,
  type ResourceScope,
  type RunStreamStorage,
  resourceRefKey,
  type SessionMessageTally,
  type ShownResource,
  type StoredRunEntry,
  type TouchWorkspaceInput,
  type TouchWorkspaceOptions,
  type WorkspaceRegistryPort,
  type WorkspaceStoresPort,
} from "~/storage/ports";

export interface SqliteMarblesStorageOptions {
  readonly acceptWorkspace?: (id: string) => boolean;
  readonly blobs?: BlobStorage;
  readonly causingRun?: () => string | undefined;
  readonly close?: () => Promise<void> | void;
  readonly database: StoreDatabase;
  readonly liveness?: OwnerLiveness;
  readonly location?: string;
  readonly output?: RunStreamStorage;
  readonly state?: string;
}

function viewScopeOf(scope: ResourceScope): ViewScope {
  return "all" in scope ? ALL_WORKSPACES : { workspace: scope.workspace };
}

export class SqliteMarblesStorage implements MarblesStorage {
  readonly blobs?: BlobStorage;
  readonly output: RunStreamStorage;
  readonly workspaces: WorkspaceRegistryPort;

  readonly #acceptWorkspace: ((id: string) => boolean) | undefined;
  readonly #associations: ResourceAssociations;
  readonly #causingRun: (() => string | undefined) | undefined;
  readonly #close: (() => Promise<void> | void) | undefined;
  readonly #database: StoreDatabase;
  readonly #liveness: OwnerLiveness | undefined;
  readonly #location: string | undefined;
  readonly #registry: WorkspaceRegistry;
  readonly #scopes = new Map<string, Promise<WorkspaceStoresPort>>();
  readonly #stores = new Map<string, SqliteWorkspaceStores>();

  constructor(options: SqliteMarblesStorageOptions) {
    const { state } = options;
    this.#database = options.database;
    this.#acceptWorkspace =
      options.acceptWorkspace ??
      (state === undefined ? undefined : (id) => insideState(state, id));
    this.#causingRun = options.causingRun;
    this.#close = options.close;
    this.#liveness = options.liveness;
    this.#location = options.location;
    if (options.blobs !== undefined) {
      this.blobs = options.blobs;
    }
    this.output = options.output ?? new MemoryRunStreamStorage();
    const scopeOptions = {
      ...(this.#acceptWorkspace === undefined
        ? {}
        : { acceptWorkspace: this.#acceptWorkspace }),
    };
    this.#associations = resourceAssociations(options.database, scopeOptions);
    this.#registry = new WorkspaceRegistry({
      database: options.database,
      ...scopeOptions,
    });
    this.workspaces = {
      get: (id) => this.#registry.read(id),
      list: () => this.#registry.list(),
      touch: (
        workspace: TouchWorkspaceInput,
        config: string | null,
        touchOptions?: TouchWorkspaceOptions
      ) =>
        this.#registry.touch(
          { dir: workspace.root, id: workspace.id, root: workspace.root },
          config,
          touchOptions
        ),
      unhost: (id) => this.#registry.unhost(id),
    };
  }

  forWorkspace(workspaceId: string): Promise<WorkspaceStoresPort> {
    const existing = this.#scopes.get(workspaceId);
    if (existing !== undefined) {
      return existing;
    }
    const opening = this.#openWorkspace(workspaceId);
    opening.catch(() => {
      if (this.#scopes.get(workspaceId) === opening) {
        this.#scopes.delete(workspaceId);
      }
    });
    this.#scopes.set(workspaceId, opening);
    return opening;
  }

  runs(
    scope: ResourceScope,
    limit?: number
  ): Promise<readonly ShownResource<StoredRunEntry>[]> {
    return this.#view(scope).runs(limit);
  }

  sessions(
    scope: ResourceScope
  ): Promise<readonly ShownResource<SessionRecord>[]> {
    return this.#view(scope).sessions();
  }

  async messageTallies(
    refs: readonly ResourceRef[]
  ): Promise<ReadonlyMap<string, SessionMessageTally>> {
    const byRef = await this.#view({ all: true }).messageTallies(refs);
    const result = new Map<string, SessionMessageTally>();
    for (const [ref, tally] of byRef) {
      result.set(resourceRefKey(ref), tally);
    }
    return result;
  }

  artifacts(scope: ResourceScope): Promise<readonly ShownResource<Artifact>[]> {
    return this.#view(scope).artifacts();
  }

  artifactFiles(ref: ResourceRef): Promise<readonly ArtifactFileSummary[]> {
    return this.#view({ workspace: ref.owner }).artifactFiles(ref);
  }

  sandboxes(
    scope: ResourceScope
  ): Promise<readonly ShownResource<ContainerRow>[]> {
    return this.#view(scope).sandboxes();
  }

  find(
    scope: ResourceScope,
    kind: ResourceKind,
    id: string
  ): Promise<readonly ResourceRef[]> {
    return this.#view(scope).find(kind, id);
  }

  async share(ref: ResourceRef, targetWorkspaceId: string): Promise<void> {
    await this.#associations.share(ref, targetWorkspaceId);
  }

  async unshare(ref: ResourceRef, targetWorkspaceId: string): Promise<void> {
    await this.#associations.unshare(ref, targetWorkspaceId);
  }

  async close(): Promise<void> {
    for (const stores of this.#stores.values()) {
      await stores.runs.close();
      await stores.triggers.close();
      await stores.records.close();
    }
    await this.#close?.();
  }

  async #openWorkspace(workspaceId: string): Promise<WorkspaceStoresPort> {
    const assembled = assembleSqliteWorkspaceStores(
      this.#database,
      workspaceId,
      {
        changes: new ChangeRecorder(workspaceId, {
          ...(this.#causingRun === undefined
            ? {}
            : { causingRun: this.#causingRun }),
        }),
        ...(this.blobs === undefined ? {} : { blobs: this.blobs }),
        ...(this.#liveness === undefined ? {} : { liveness: this.#liveness }),
        ...(this.#location === undefined ? {} : { location: this.#location }),
      }
    );
    this.#stores.set(workspaceId, assembled);
    const [queue, schedules] = await Promise.all([
      assembled.runs.open(() => undefined),
      assembled.triggers.schedules(),
    ]);
    return {
      artifacts: assembled.artifacts,
      containers: assembled.containers,
      queue,
      schedules,
      sessions: assembled.sessions,
      tasks: assembled.records.taskStore,
      workspaces: assembled.workspaces,
    };
  }

  #view(scope: ResourceScope): ResourceView {
    return new ResourceView({
      ...(this.#acceptWorkspace === undefined
        ? {}
        : { acceptWorkspace: this.#acceptWorkspace }),
      database: this.#database,
      scope: viewScopeOf(scope),
    });
  }
}
