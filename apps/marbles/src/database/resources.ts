import type { SessionMessage, SessionRecord } from "@foundry/agents/schema";
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
import { eq } from "drizzle-orm";
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

/** How a view reads one kind, from the store of the owner `owner`. */
interface KindReader<T> {
  get(owner: string, id: string): Promise<T | null>;
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

  /** Workflow runs, newest first. Their steps are in each record. */
  async runs(): Promise<readonly Shown<RunResource>[]> {
    const shown = await this.#show("run", this.#runs());
    return shown.sort(
      (a, b) =>
        b.value.record.timestamps.createdAt -
        a.value.record.timestamps.createdAt
    );
  }

  /** Agent sessions, most recently updated first. */
  async sessions(): Promise<readonly Shown<SessionRecord>[]> {
    const shown = await this.#show("session", this.#sessions());
    return shown.sort((a, b) => b.value.updatedAt - a.value.updatedAt);
  }

  /** The messages of a session the view shows, oldest first. */
  messages(ref: ResourceRef): Promise<readonly SessionMessage[]> {
    return this.#sessionStore(ref.owner).listMessages(ref.id);
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
    return (await this.#reader(ref.kind).get(ref.owner, ref.id)) !== null;
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
      workspaces: [
        ref.owner,
        ...associations
          .filter((association) => sameResource(association.ref, ref))
          .map((association) => association.workspace)
          .sort(),
      ],
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
      return (await Promise.all(owners.map(owned))).flat();
    }
    const here = this.scope.workspace;
    const found = await owned(here);
    for (const { ref, workspace } of associations) {
      if (workspace !== here || ref.owner === here) {
        continue;
      }
      const value = await reader.get(ref.owner, ref.id);
      if (value !== null) {
        found.push({ ref, value });
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
    const ownerPids = async (owner: string) =>
      new Map(
        (
          await database
            .select({
              ownerPid: marblesWorkflowRuns.ownerPid,
              runId: marblesWorkflowRuns.runId,
            })
            .from(marblesWorkflowRuns)
            .where(eq(marblesWorkflowRuns.scope, owner))
        ).map((row) => [row.runId, row.ownerPid])
      );
    const store = (owner: string) =>
      new SqliteWorkflowStore({ database, scope: owner });
    return {
      get: (owner, id) =>
        asBusy(async () => {
          const record = await store(owner).getRun(id);
          return record === null
            ? null
            : { ownerPid: (await ownerPids(owner)).get(id) ?? null, record };
        }),
      id: (run) => run.record.id,
      list: (owner) =>
        asBusy(async () => {
          const owners = await ownerPids(owner);
          const runs: RunResource[] = [];
          let after: number | undefined;
          do {
            const page = await store(owner).listRuns({
              limit: PAGE,
              ...(after === undefined ? {} : { after }),
            });
            for (const record of page.items) {
              runs.push({ ownerPid: owners.get(record.id) ?? null, record });
            }
            after = page.next;
          } while (after !== undefined);
          return runs;
        }),
    };
  }

  #sessions(): KindReader<SessionRecord> {
    return {
      get: (owner, id) => this.#sessionStore(owner).getSession(id),
      id: (session) => session.id,
      list: async (owner) => {
        const store = this.#sessionStore(owner);
        const sessions: SessionRecord[] = [];
        for (const { id } of await store.stamps()) {
          const session = await store.getSession(id);
          if (session !== null) {
            sessions.push(session);
          }
        }
        return sessions;
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
      get: (owner, id) =>
        asBusy(() => store(owner).getArtifact(id as ArtifactId)),
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
      get: (owner, id) =>
        asBusy(async () => (await store(owner).get(id)) ?? null),
      id: (row) => row.id,
      list: (owner) => asBusy(() => store(owner).list()),
    };
  }

  #modules(): KindReader<Module> {
    const store = (owner: string) =>
      new SqliteModuleStore({ database: this.#database, scope: owner });
    return {
      get: (owner, id) => asBusy(() => store(owner).getModule(id as ModuleId)),
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
      database.transaction((tx) => {
        const view = new ResourceView({
          database: tx,
          scope: ALL_WORKSPACES,
          state,
        });
        const registry = new WorkspaceRegistry({ database: tx, state });
        return work({
          directory: {
            has: (ref) => view.has(ref),
            registered: async (id) => (await registry.read(id)) !== undefined,
          },
          store: new DatabaseAssociationStore({ database: tx }),
        });
      })
    );
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
