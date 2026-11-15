import type { SessionRecord } from "@foundry/agents/schema";
import type { MessageTally } from "@foundry/agents/store/sqlite";
import type { Artifact, ArtifactId } from "@foundry/artifacts";
import type { ArtifactCursor } from "@foundry/artifacts/listing";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import type { ModuleId } from "@foundry/modules/domain";
import type { Module } from "@foundry/modules/schema";
import { SqliteModuleStore } from "@foundry/modules/store/sqlite";
import type { ContainerRow } from "@foundry/sandbox/schema";
import { createSqliteContainerStore } from "@foundry/sandbox/store/sqlite";
import type { RunRecord } from "@foundry/workflows/schema";
import { SqliteWorkflowStore } from "@foundry/workflows/store/sqlite";
import { and, eq, inArray } from "drizzle-orm";
import { DatabaseAssociationStore } from "~/database/associations";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import { DatabaseSessionStore } from "~/database/sessions";
import { marblesWorkflowRuns } from "~/database/tables";
import { WorkspaceRegistry } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import type {
  AssociationTransaction,
  ResourceAssociation,
  ResourceKind,
  ResourceRef,
} from "~/lib/resources";
import { ResourceAssociations, sameResource } from "~/lib/resources";

/**
 * What a workspace shows of the resources Marbles keeps, read from the
 * Marbles database: the resources it owns and those shared with it
 * (`lib/resources.ts`), or, for `ALL_WORKSPACES`, every resource of every
 * registered workspace. Each resource is read through its package's own
 * store, scoped by its owner, never through the package's tables; each
 * comes with every workspace it belongs to, its owner first.
 *
 * A view only reads: it is as current as the database it is handed, and an
 * association naming a resource its owner no longer keeps shows nothing.
 */

/** Which workspaces a view shows the resources of. */
export type ViewScope = { readonly workspace: string } | typeof ALL_WORKSPACES;

export const ALL_WORKSPACES = "all";

/** A resource as a view shows it. */
export interface Shown<T> {
  readonly ref: ResourceRef;
  readonly value: T;
  /** Every workspace it belongs to, by id: its owner, then the rest by id. */
  readonly workspaces: readonly string[];
}

/** A workflow Run, and the process of the engine that owns it, if any. */
export interface RunResource {
  readonly ownerPid: number | null;
  readonly record: RunRecord;
}

/** A file of an artifact's Content, and the blob file holding its bytes, if one does. */
export interface ArtifactFile {
  readonly blob: string | null;
  readonly path: string;
}

export interface ResourceViewOptions {
  readonly database: StoreDatabase;
  readonly scope: ViewScope;
  /** The state root the workspace registry's directories are under. */
  readonly state: string;
}

/** Rows per page when a view reads a whole store. */
const PAGE = 200;

/**
 * How a view reads one kind from the store of the owner `owner`: all of
 * it, or the ones with some ids, in as few reads as that store allows.
 */
interface KindReader<T> {
  get(owner: string, ids: readonly string[]): Promise<readonly T[]>;
  id(value: T): string;
  list(owner: string): Promise<readonly T[]>;
}

export class ResourceView {
  readonly scope: ViewScope;
  readonly #associations: DatabaseAssociationStore;
  readonly #database: StoreDatabase;
  readonly #registry: WorkspaceRegistry;

  constructor(options: ResourceViewOptions) {
    this.scope = options.scope;
    this.#database = options.database;
    this.#associations = new DatabaseAssociationStore(options);
    this.#registry = new WorkspaceRegistry(options);
  }

  /**
   * Workflow runs, newest first. Their steps are in each record. With
   * `limit`, at most that many of each owning workspace, its newest.
   */
  async runs(limit?: number): Promise<readonly Shown<RunResource>[]> {
    return newestOfEach(
      await this.#show("run", this.#runs()),
      (run) => run.record.timestamps.createdAt,
      limit
    );
  }

  /**
   * The runs other workspaces share with this view's workspace, newest
   * first, at most `limit`: read through this workspace's shares alone,
   * whatever else their owners keep. None for the all-workspaces view.
   */
  async sharedRuns(limit?: number): Promise<readonly Shown<RunResource>[]> {
    if (this.scope === ALL_WORKSPACES) {
      return [];
    }
    const here = this.scope.workspace;
    const reader = this.#runs();
    const refs = (await this.#associations.sharedWith("run", here)).filter(
      (ref) => ref.owner !== here
    );
    const found = await this.#fetch("run", reader, refs);
    const all = await this.#associations.list("run");
    const shown = found.map(({ ref, value }) => ({
      ref,
      value,
      workspaces: workspacesOf(ref, all),
    }));
    return newestOfEach(
      shown,
      (run) => run.record.timestamps.createdAt,
      undefined
    ).slice(0, limit);
  }

  /** Agent sessions, most recently updated first. */
  async sessions(): Promise<readonly Shown<SessionRecord>[]> {
    const shown = await this.#show("session", this.#sessions());
    return shown.sort((a, b) => b.value.updatedAt - a.value.updatedAt);
  }

  /**
   * How many messages each of these sessions holds, and whether one is a
   * summary, read in a batch per owner; one with none is left out.
   */
  async messageTallies(
    refs: readonly ResourceRef[]
  ): Promise<ReadonlyMap<ResourceRef, MessageTally>> {
    const tallies = new Map<ResourceRef, MessageTally>();
    for (const [owner, group] of byOwner(refs)) {
      const counted = await this.#sessionStore(owner).messageTallies(
        group.map((ref) => ref.id)
      );
      for (const ref of group) {
        const tally = counted.get(ref.id);
        if (tally !== undefined) {
          tallies.set(ref, tally);
        }
      }
    }
    return tallies;
  }

  /** Artifacts, newest first. */
  async artifacts(): Promise<readonly Shown<Artifact>[]> {
    const shown = await this.#show("artifact", this.#artifacts());
    return shown.sort(
      (a, b) => b.value.createdAt.getTime() - a.value.createdAt.getTime()
    );
  }

  /**
   * The files of the artifact `ref`'s active Content, by path, each with
   * the name of the blob file that holds its bytes under its owner's blob
   * directory, or null when no one file does (bytes kept inline in the
   * database, or chunked). Empty for an artifact with no active Content,
   * or one its owner does not keep.
   */
  artifactFiles(ref: ResourceRef): Promise<readonly ArtifactFile[]> {
    const store = new SqliteArtifactStore({
      database: this.#database,
      scope: ref.owner,
    });
    return asBusy(async () => {
      const artifact = await store.getArtifact(ref.id as ArtifactId);
      const contentId = artifact?.contentId ?? null;
      const content =
        contentId === null ? null : await store.getContent(contentId);
      const files: ArtifactFile[] = [];
      for (const [path, node] of Object.entries(content?.tree ?? {})) {
        if (node.type === "file") {
          const blob = await store.getBlob(node.blobId);
          files.push({ blob: blob?.path ?? null, path });
        }
      }
      return files;
    });
  }

  /** Sandbox containers, newest first. */
  async sandboxes(): Promise<readonly Shown<ContainerRow>[]> {
    const shown = await this.#show("sandbox", this.#sandboxes());
    return shown.sort((a, b) => b.value.createdAt - a.value.createdAt);
  }

  /** Modules, in the order each owner registered them. */
  modules(): Promise<readonly Shown<Module>[]> {
    return this.#show("module", this.#modules());
  }

  /** The resources of `kind` with id `id` this view shows. */
  async find(kind: ResourceKind, id: string): Promise<readonly ResourceRef[]> {
    const shown = await this.#show(kind, this.#reader(kind));
    return shown.map(({ ref }) => ref).filter((ref) => ref.id === id);
  }

  /** Whether the owner of `ref` keeps it, whatever this view's scope. */
  async has(ref: ResourceRef): Promise<boolean> {
    return (await this.#reader(ref.kind).get(ref.owner, [ref.id])).length > 0;
  }

  /** Every resource of `kind` this view shows, with the workspaces each belongs to. */
  async #show<T>(
    kind: ResourceKind,
    reader: KindReader<T>
  ): Promise<Shown<T>[]> {
    const associations = await this.#associations.list(kind);
    const found = await this.#collect(kind, reader, associations);
    return found.map(({ ref, value }) => ({
      ref,
      value,
      workspaces: workspacesOf(ref, associations),
    }));
  }

  /**
   * What the scope shows: for one workspace, what its own store keeps and
   * each resource shared with it that its owner still keeps; for all
   * workspaces, what every registered workspace's store keeps.
   */
  async #collect<T>(
    kind: ResourceKind,
    reader: KindReader<T>,
    associations: readonly ResourceAssociation[]
  ): Promise<{ readonly ref: ResourceRef; readonly value: T }[]> {
    const owned = async (owner: string) =>
      (await reader.list(owner)).map((value) => ({
        ref: { id: reader.id(value), kind, owner },
        value,
      }));
    if (this.scope === ALL_WORKSPACES) {
      const owners = (await this.#registry.list()).map((record) => record.id);
      const found: { readonly ref: ResourceRef; readonly value: T }[] = [];
      for (const owner of owners) {
        found.push(...(await owned(owner)));
      }
      return found;
    }
    const here = this.scope.workspace;
    const shared = associations
      .filter(({ ref, workspace }) => workspace === here && ref.owner !== here)
      .map(({ ref }) => ref);
    return [
      ...(await owned(here)),
      ...(await this.#fetch(kind, reader, shared)),
    ];
  }

  /** The resources `refs` name that their owners keep, read in a batch per owner. */
  async #fetch<T>(
    kind: ResourceKind,
    reader: KindReader<T>,
    refs: readonly ResourceRef[]
  ): Promise<{ readonly ref: ResourceRef; readonly value: T }[]> {
    const found: { readonly ref: ResourceRef; readonly value: T }[] = [];
    for (const [owner, group] of byOwner(refs)) {
      for (const value of await reader.get(
        owner,
        group.map((ref) => ref.id)
      )) {
        found.push({ ref: { id: reader.id(value), kind, owner }, value });
      }
    }
    return found;
  }

  #reader(kind: ResourceKind): KindReader<unknown> {
    switch (kind) {
      case "artifact":
        return this.#artifacts() as KindReader<unknown>;
      case "module":
        return this.#modules() as KindReader<unknown>;
      case "run":
        return this.#runs() as KindReader<unknown>;
      case "sandbox":
        return this.#sandboxes() as KindReader<unknown>;
      case "session":
        return this.#sessions() as KindReader<unknown>;
      default:
        throw new Error(`no resource kind ${String(kind satisfies never)}`);
    }
  }

  #runs(): KindReader<RunResource> {
    const database = this.#database;
    /** The owner pids of `owner`'s runs, every one or those with `ids`, in one read each batch. */
    const ownerPids = async (owner: string, ids?: readonly string[]) => {
      const pids = new Map<string, number | null>();
      const read = (batch?: readonly string[]) =>
        database
          .select({
            ownerPid: marblesWorkflowRuns.ownerPid,
            runId: marblesWorkflowRuns.runId,
          })
          .from(marblesWorkflowRuns)
          .where(
            and(
              eq(marblesWorkflowRuns.scope, owner),
              batch === undefined
                ? undefined
                : inArray(marblesWorkflowRuns.runId, [...batch])
            )
          );
      for (const rows of ids === undefined
        ? [await read()]
        : await Promise.all(batches(ids).map(read))) {
        for (const row of rows) {
          pids.set(row.runId, row.ownerPid);
        }
      }
      return pids;
    };
    const store = (owner: string) =>
      new SqliteWorkflowStore({ database, scope: owner });
    return {
      get: (owner, ids) =>
        asBusy(async () => {
          const runs = store(owner);
          const pids = await ownerPids(owner, ids);
          const found: RunResource[] = [];
          for (const id of ids) {
            const record = await runs.getRun(id);
            if (record !== null) {
              found.push({ ownerPid: pids.get(id) ?? null, record });
            }
          }
          return found;
        }),
      id: (run) => run.record.id,
      list: (owner) =>
        asBusy(async () => {
          const pids = await ownerPids(owner);
          const runs: RunResource[] = [];
          let after: number | undefined;
          do {
            const page = await store(owner).listRuns({
              limit: PAGE,
              ...(after === undefined ? {} : { after }),
            });
            for (const record of page.items) {
              runs.push({ ownerPid: pids.get(record.id) ?? null, record });
            }
            after = page.next;
          } while (after !== undefined);
          return runs;
        }),
    };
  }

  #sessions(): KindReader<SessionRecord> {
    return {
      get: (owner, ids) => this.#sessionStore(owner).getSessions(ids),
      id: (session) => session.id,
      list: async (owner) => {
        const store = this.#sessionStore(owner);
        return store.getSessions((await store.stamps()).map(({ id }) => id));
      },
    };
  }

  #sessionStore(owner: string): DatabaseSessionStore {
    return new DatabaseSessionStore({ database: this.#database, scope: owner });
  }

  #artifacts(): KindReader<Artifact> {
    const store = (owner: string) =>
      new SqliteArtifactStore({ database: this.#database, scope: owner });
    return {
      get: (owner, ids) =>
        asBusy(async () => {
          const artifacts = store(owner);
          const found: Artifact[] = [];
          for (const id of ids) {
            const artifact = await artifacts.getArtifact(id as ArtifactId);
            if (artifact !== null) {
              found.push(artifact);
            }
          }
          return found;
        }),
      id: (artifact) => artifact.id,
      list: (owner) =>
        asBusy(async () => {
          const artifacts: Artifact[] = [];
          let after: ArtifactCursor | undefined;
          for (;;) {
            const page = await store(owner).listArtifacts({
              limit: PAGE,
              ...(after === undefined ? {} : { after }),
            });
            artifacts.push(...page.artifacts);
            const last = page.artifacts.at(-1);
            if (last === undefined || page.artifacts.length < PAGE) {
              return artifacts;
            }
            after = { createdAt: last.createdAt, id: last.id };
          }
        }),
    };
  }

  #sandboxes(): KindReader<ContainerRow> {
    const store = (owner: string) =>
      createSqliteContainerStore({ database: this.#database, scope: owner });
    return {
      get: (owner, ids) =>
        asBusy(async () => {
          const containers = store(owner);
          const found: ContainerRow[] = [];
          for (const id of ids) {
            const row = await containers.get(id);
            if (row !== undefined) {
              found.push(row);
            }
          }
          return found;
        }),
      id: (row) => row.id,
      list: (owner) => asBusy(() => store(owner).list()),
    };
  }

  #modules(): KindReader<Module> {
    const store = (owner: string) =>
      new SqliteModuleStore({ database: this.#database, scope: owner });
    return {
      get: (owner, ids) =>
        asBusy(async () => {
          const modules = store(owner);
          const found: Module[] = [];
          for (const id of ids) {
            const module = await modules.getModule(id as ModuleId);
            if (module !== null) {
              found.push(module);
            }
          }
          return found;
        }),
      id: (module) => module.id,
      list: (owner) =>
        asBusy(async () => {
          const modules: Module[] = [];
          let after: number | undefined;
          do {
            const page = await store(owner).listModules({
              limit: PAGE,
              ...(after === undefined ? {} : { after }),
            });
            modules.push(...page.items);
            after = page.next;
          } while (after !== undefined);
          return modules;
        }),
    };
  }
}

/** Every workspace `ref` belongs to: its owner, then those it is shared with, by id. */
function workspacesOf(
  ref: ResourceRef,
  associations: readonly ResourceAssociation[]
): readonly string[] {
  return [
    ref.owner,
    ...associations
      .filter((association) => sameResource(association.ref, ref))
      .map((association) => association.workspace)
      .sort(),
  ];
}

/** `refs` by owner, in the order each owner first appears. */
function byOwner(
  refs: readonly ResourceRef[]
): Map<string, readonly ResourceRef[]> {
  const grouped = new Map<string, ResourceRef[]>();
  for (const ref of refs) {
    const group = grouped.get(ref.owner) ?? [];
    group.push(ref);
    grouped.set(ref.owner, group);
  }
  return grouped;
}

/** Ids per statement, well under SQLite's parameter limit. */
const BATCH = 500;

function batches(ids: readonly string[]): (readonly string[])[] {
  const all: (readonly string[])[] = [];
  for (let start = 0; start < ids.length; start += BATCH) {
    all.push(ids.slice(start, start + BATCH));
  }
  return all;
}

/** `shown`, newest first by `at`; with `limit`, at most that many of each owner. */
function newestOfEach<T>(
  shown: readonly Shown<T>[],
  at: (value: T) => number,
  limit: number | undefined
): Shown<T>[] {
  const newest = [...shown].sort((a, b) => at(b.value) - at(a.value));
  if (limit === undefined) {
    return newest;
  }
  const taken = new Map<string, number>();
  return newest.filter(({ ref }) => {
    const count = taken.get(ref.owner) ?? 0;
    taken.set(ref.owner, count + 1);
    return count < limit;
  });
}

/**
 * The association rules over the Marbles database: shared resources are
 * checked against what their owners' stores keep and the workspace
 * registry under the state root `state`.
 */
export function resourceAssociations(
  database: StoreDatabase,
  state: string
): ResourceAssociations {
  return new ResourceAssociations({
    read: (work) => asBusy(() => work(associationUnit(database, state))),
    transact: associationTransaction(database, state),
  });
}

/**
 * One write transaction over `database`, taken before it reads, with the
 * associations, the resources' stores and the workspace registry all
 * read and written through it: a delete of a resource, in this process or
 * another, lands before it or after it, never between a check and a
 * write.
 */
export function associationTransaction(
  database: StoreDatabase,
  state: string
): AssociationTransaction {
  return (work) =>
    asBusy(() =>
      database.transaction((tx) => work(associationUnit(tx, state)))
    );
}

/** The associations, and what exists, read and written through `database`, the database or one transaction. */
function associationUnit(
  database: StoreDatabase,
  state: string
): Parameters<Parameters<AssociationTransaction>[0]>[0] {
  const view = new ResourceView({ database, scope: ALL_WORKSPACES, state });
  const registry = new WorkspaceRegistry({ database, state });
  return {
    directory: {
      has: (ref) => view.has(ref),
      registered: async (id) => (await registry.read(id)) !== undefined,
    },
    store: new DatabaseAssociationStore({ database }),
  };
}

/**
 * Run `work` on the view `scope` of the Marbles database at the state root
 * `state`, through a read-only connection (`readDatabase`): nothing is
 * created, migrated or written. Undefined, and `work` not run, with no
 * database or nothing migrated into it: there are no resources yet.
 */
export function readResourceView<T>(
  state: string,
  scope: ViewScope,
  work: (view: ResourceView) => Promise<T>
): Promise<T | undefined> {
  return readDatabase(stateDatabase(state), (database) =>
    work(new ResourceView({ database, scope, state }))
  );
}
