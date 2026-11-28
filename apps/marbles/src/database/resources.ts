import type { SessionRecord } from "@foundry/agents/session";
import type { MessageTally } from "@foundry/agents/store/sqlite";
import type { Artifact, ArtifactCursor, ArtifactId } from "@foundry/artifacts";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
import { makeSqliteQueueStore } from "@foundry/queue/store/sqlite";
import type { ContainerRow } from "@foundry/sandbox";
import { SqliteContainerStore } from "@foundry/sandbox/store/sqlite";
import { asBusy } from "~/database/busy";
import { DatabaseSessionStore } from "~/database/sessions";
import type { StoreDatabase } from "~/database/types";
import { WorkspaceRegistry } from "~/database/workspaces";
import { ownerOfRun } from "~/lib/execution-record";
import type { ResourceKind, ResourceRef } from "~/lib/resources";
import type { RunReads, RunRecord } from "~/lib/workflow-runs";
import { readRuns, runStoreEffect } from "~/lib/workflow-runs";

export type ViewScope = { readonly workspace: string } | typeof ALL_WORKSPACES;

export const ALL_WORKSPACES = "all";

export interface Shown<T> {
  readonly ref: ResourceRef;
  readonly value: T;
}

export interface RunResource {
  readonly owner: ProcessIdentity | null;
  readonly record: RunRecord;
}

export interface ArtifactFile {
  readonly blob: string | null;
  readonly path: string;
}

export interface ResourceViewOptions {
  readonly acceptWorkspace?: (id: string) => boolean;
  readonly database: StoreDatabase;
  readonly scope: ViewScope;
}

const PAGE = 200;

interface KindReader<T> {
  id(value: T): string;
  list(owner: string): Promise<readonly T[]>;
}

export class ResourceView {
  readonly scope: ViewScope;
  readonly #database: StoreDatabase;
  readonly #registry: WorkspaceRegistry;

  constructor(options: ResourceViewOptions) {
    this.scope = options.scope;
    this.#database = options.database;
    const { acceptWorkspace, database } = options;
    this.#registry = new WorkspaceRegistry({
      database,
      ...(acceptWorkspace === undefined ? {} : { acceptWorkspace }),
    });
  }

  async runs(limit?: number): Promise<readonly Shown<RunResource>[]> {
    return newestOfEach(
      await this.#show("run", this.#runs()),
      (run) => run.record.timestamps.createdAt,
      limit
    );
  }

  async sessions(): Promise<readonly Shown<SessionRecord>[]> {
    const shown = await this.#show("session", this.#sessions());
    return shown.sort((a, b) => b.value.updatedAt - a.value.updatedAt);
  }

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

  async artifacts(): Promise<readonly Shown<Artifact>[]> {
    const shown = await this.#show("artifact", this.#artifacts());
    return shown.sort(
      (a, b) => b.value.createdAt.getTime() - a.value.createdAt.getTime()
    );
  }

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

  async sandboxes(): Promise<readonly Shown<ContainerRow>[]> {
    const shown = await this.#show("sandbox", this.#sandboxes());
    return shown.sort((a, b) => b.value.createdAt - a.value.createdAt);
  }

  async find(kind: ResourceKind, id: string): Promise<readonly ResourceRef[]> {
    const shown = await this.#show(kind, this.#reader(kind));
    return shown.map(({ ref }) => ref).filter((ref) => ref.id === id);
  }

  async #show<T>(
    kind: ResourceKind,
    reader: KindReader<T>
  ): Promise<Shown<T>[]> {
    const owners =
      this.scope === ALL_WORKSPACES
        ? (await this.#registry.list()).map((record) => record.id)
        : [this.scope.workspace];
    const shown: Shown<T>[] = [];
    for (const owner of owners) {
      for (const value of await reader.list(owner)) {
        shown.push({ ref: { id: reader.id(value), kind, owner }, value });
      }
    }
    return shown;
  }

  #reader(kind: ResourceKind): KindReader<unknown> {
    switch (kind) {
      case "artifact":
        return this.#artifacts() as KindReader<unknown>;
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
    const store = (owner: string) =>
      makeSqliteQueueStore({ database, scope: owner });
    return {
      id: (run) => run.record.id,
      list: (owner) =>
        asBusy(async () => {
          const runs = store(owner);
          const held = await holdersIn(runs);
          return (await readRuns(runs)).map((record) => ({
            owner: held.get(record.id) ?? null,
            record,
          }));
        }),
    };
  }

  #sessions(): KindReader<SessionRecord> {
    return {
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
      new SqliteContainerStore({ database: this.#database, scope: owner });
    return {
      id: (row) => row.id,
      list: (owner) => asBusy(() => store(owner).list()),
    };
  }
}

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

async function holdersIn(
  runs: Pick<RunReads, "listRuns">
): Promise<ReadonlyMap<string, ProcessIdentity>> {
  const held = new Map<string, ProcessIdentity>();
  for (const run of await runStoreEffect(runs.listRuns())) {
    const owner = ownerOfRun(run);
    if (owner !== undefined) {
      held.set(run.id, owner);
    }
  }
  return held;
}
