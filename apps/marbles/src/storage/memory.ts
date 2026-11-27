import type { SessionRecord } from "@foundry/agents/session";
import type { SessionStore, SessionStoreWrite } from "@foundry/agents/store";
import { MemorySessionStore } from "@foundry/agents/store/memory";
import {
  type ArtifactCursor,
  type ArtifactId,
  type ArtifactResolved,
  Artifacts,
} from "@foundry/artifacts";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
import { makeMemoryQueueStore } from "@foundry/queue/store/memory";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import { makeMemoryScheduleStore } from "@foundry/scheduling/store/memory";
import { MemoryTaskStore } from "@foundry/tasks/store/memory";
import { MemoryWorkspaceStore } from "@foundry/workspaces/store/memory";
import { Effect } from "effect";
import { ownerOfRun } from "~/lib/execution-record";
import {
  type ResourceAssociation,
  ResourceAssociations,
  type ResourceKind,
  type ResourceRef,
} from "~/lib/resources";
import type { OutputRecord } from "~/lib/state/output";
import { readRuns, runStoreEffect } from "~/lib/workflow-runs";
import {
  type MarblesStorage,
  type ResourceScope,
  type RunStreamStorage,
  resourceRefKey,
  type SessionMessageTally,
  type ShownResource,
  type StoredWorkspace,
  type WorkspaceRegistryPort,
  type WorkspaceStoresPort,
} from "~/storage/ports";

export class MemoryRunStreamStorage implements RunStreamStorage {
  readonly #records = new Map<string, OutputRecord[]>();
  append(runId: string, record: OutputRecord): void {
    const records = this.#records.get(runId) ?? [];
    records.push(structuredClone(record));
    this.#records.set(runId, records);
  }
  read(runId: string): readonly OutputRecord[] {
    return structuredClone(this.#records.get(runId) ?? []);
  }
  remove(runId: string): void {
    this.#records.delete(runId);
  }
}

class MemoryWorkspaceRegistry implements WorkspaceRegistryPort {
  readonly #records = new Map<string, StoredWorkspace>();
  list(): Promise<readonly StoredWorkspace[]> {
    return Promise.resolve(
      [...this.#records.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((record) => ({ ...record }))
    );
  }
  get(id: string): Promise<StoredWorkspace | undefined> {
    const record = this.#records.get(id);
    return Promise.resolve(record && { ...record });
  }
  touch(
    workspace: { readonly id: string; readonly root: string },
    config: string | null,
    options: { readonly cwd?: string; readonly hosted?: boolean } = {}
  ): Promise<void> {
    const previous = this.#records.get(workspace.id);
    const now = new Date().toISOString();
    this.#records.set(workspace.id, {
      ...workspace,
      config,
      cwd: options.cwd ?? previous?.cwd ?? workspace.root,
      firstSeen: previous?.firstSeen ?? now,
      hosted: options.hosted ?? previous?.hosted ?? false,
      lastSeen: now,
    });
    return Promise.resolve();
  }
  unhost(id: string): Promise<boolean> {
    const record = this.#records.get(id);
    if (!record?.hosted) {
      return Promise.resolve(false);
    }
    this.#records.set(id, { ...record, hosted: false });
    return Promise.resolve(true);
  }
}

function trackedSessions(store: SessionStore, ids: Set<string>): SessionStore {
  return {
    async commit(write: SessionStoreWrite) {
      await store.commit(write);
      for (const record of write.putSessions ?? []) {
        ids.add(record.id);
      }
    },
    getMessage: (id) => store.getMessage(id),
    getSession: (id) => store.getSession(id),
    listMessages: (id) => store.listMessages(id),
    async transaction<T>(work: (view: SessionStore) => Promise<T>): Promise<T> {
      const added = new Set<string>();
      if (!store.transaction) {
        throw new Error("Session transactions unavailable");
      }
      const result = await store.transaction((view) =>
        work(trackedSessions(view, added))
      );
      for (const id of added) {
        ids.add(id);
      }
      return result;
    },
  };
}

export class MemoryMarblesStorage implements MarblesStorage {
  readonly output = new MemoryRunStreamStorage();
  readonly workspaces = new MemoryWorkspaceRegistry();
  readonly #stores = new Map<string, Promise<WorkspaceStoresPort>>();
  readonly #artifactStores = new Map<string, MemoryArtifactStore>();
  readonly #sessionIds = new Map<string, Set<string>>();
  readonly #shares = new Map<string, ResourceAssociation>();
  readonly #associations = new ResourceAssociations({
    transact: (work) =>
      work({
        directory: {
          has: async (ref) =>
            (await this.find({ workspace: ref.owner }, ref.kind, ref.id)).some(
              (candidate) => resourceRefKey(candidate) === resourceRefKey(ref)
            ),
          registered: async (id) =>
            (await this.workspaces.get(id)) !== undefined,
        },
        store: {
          commit: (write) => {
            for (const item of write.put ?? []) {
              this.#shares.set(
                JSON.stringify([
                  item.ref.kind,
                  item.ref.owner,
                  item.ref.id,
                  item.workspace,
                ]),
                structuredClone(item)
              );
            }
            for (const item of write.remove ?? []) {
              this.#shares.delete(
                JSON.stringify([
                  item.ref.kind,
                  item.ref.owner,
                  item.ref.id,
                  item.workspace,
                ])
              );
            }
            return Promise.resolve();
          },
          list: (kind) =>
            Promise.resolve(
              [...this.#shares.values()].filter(
                (item) => item.ref.kind === kind
              )
            ),
        },
      }),
  });
  forWorkspace(workspaceId: string): Promise<WorkspaceStoresPort> {
    let stores = this.#stores.get(workspaceId);
    if (!stores) {
      const artifactStore = new MemoryArtifactStore();
      this.#artifactStores.set(workspaceId, artifactStore);
      const ids = new Set<string>();
      this.#sessionIds.set(workspaceId, ids);
      stores = Promise.all([
        Effect.runPromise(makeMemoryQueueStore),
        Effect.runPromise(makeMemoryScheduleStore),
      ]).then(([queue, schedules]) => ({
        artifacts: new Artifacts({ store: artifactStore }),
        containers: new MemoryContainerStore(),
        queue,
        schedules,
        sessions: trackedSessions(new MemorySessionStore(), ids),
        tasks: new MemoryTaskStore(),
        workspaces: new MemoryWorkspaceStore(),
      }));
      this.#stores.set(workspaceId, stores);
    }
    return stores;
  }
  async #show<T>(
    scope: ResourceScope,
    kind: ResourceKind,
    list: (owner: string, stores: WorkspaceStoresPort) => Promise<readonly T[]>,
    id: (value: T) => string
  ): Promise<ShownResource<T>[]> {
    const owners = new Set(
      (await this.workspaces.list()).map((record) => record.id)
    );
    if ("workspace" in scope) {
      owners.add(scope.workspace);
    }
    const shown: ShownResource<T>[] = [];
    for (const owner of owners) {
      for (const value of await list(owner, await this.forWorkspace(owner))) {
        const ref = { id: id(value), kind, owner };
        const workspaces = [
          owner,
          ...[...this.#shares.values()]
            .filter((item) => resourceRefKey(item.ref) === resourceRefKey(ref))
            .map((item) => item.workspace)
            .sort(),
        ];
        if (!("workspace" in scope) || workspaces.includes(scope.workspace)) {
          shown.push({ ref, value, workspaces });
        }
      }
    }
    return shown;
  }
  async runs(scope: ResourceScope, limit?: number) {
    const shown = await this.#show(
      scope,
      "run",
      async (_owner, stores) => {
        const held = new Map<string, ProcessIdentity | null>(
          (await runStoreEffect(stores.queue.listRuns())).map((run) => [
            run.id,
            ownerOfRun(run) ?? null,
          ])
        );
        return (await readRuns(stores.queue)).map((record) => ({
          owner: held.get(record.id) ?? null,
          record,
        }));
      },
      (value) => value.record.id
    );
    shown.sort(
      (a, b) =>
        b.value.record.timestamps.createdAt -
        a.value.record.timestamps.createdAt
    );
    const counts = new Map<string, number>();
    return limit === undefined
      ? shown
      : shown.filter(({ ref }) => {
          const count = counts.get(ref.owner) ?? 0;
          counts.set(ref.owner, count + 1);
          return count < limit;
        });
  }
  async sessions(scope: ResourceScope) {
    const shown = await this.#show(
      scope,
      "session",
      async (owner, stores) => {
        const records = await Promise.all(
          [...(this.#sessionIds.get(owner) ?? [])].map((id) =>
            stores.sessions.getSession(id)
          )
        );
        return records.filter(
          (record): record is SessionRecord => record !== null
        );
      },
      (value) => value.id
    );
    return shown.sort((a, b) => b.value.updatedAt - a.value.updatedAt);
  }
  async messageTallies(
    refs: readonly ResourceRef[]
  ): Promise<ReadonlyMap<string, SessionMessageTally>> {
    const result = new Map<string, SessionMessageTally>();
    for (const ref of refs) {
      if (ref.kind !== "session") {
        continue;
      }
      const store = (await this.forWorkspace(ref.owner)).sessions;
      if (!(await store.getSession(ref.id))) {
        continue;
      }
      const messages = await store.listMessages(ref.id);
      if (messages.length === 0) {
        continue;
      }
      result.set(resourceRefKey(ref), {
        messages: messages.length,
        summarized: messages.some((message) => message.role === "summary"),
      });
    }
    return result;
  }
  async artifacts(scope: ResourceScope) {
    const shown = await this.#show(
      scope,
      "artifact",
      async (_owner, stores) => {
        const records: ArtifactResolved[] = [];
        let cursor: ArtifactCursor | undefined;
        for (;;) {
          const page = await stores.artifacts.list({
            includeArchived: true,
            ...(cursor === undefined ? {} : { cursor }),
          });
          records.push(...page.items);
          if (page.nextCursor === undefined) {
            return records;
          }
          cursor = page.nextCursor;
        }
      },
      (value) => value.id
    );
    return shown.sort(
      (a, b) => b.value.createdAt.getTime() - a.value.createdAt.getTime()
    );
  }
  async artifactFiles(ref: ResourceRef) {
    const artifact = await (await this.forWorkspace(ref.owner)).artifacts.get(
      ref.id as ArtifactId
    );
    const files: { path: string; blob: string | null }[] = [];
    const store = this.#artifactStores.get(ref.owner);
    for (const [path, node] of Object.entries(artifact?.content?.tree ?? {})) {
      if (node.type === "file") {
        const blob = await store?.getBlob(node.blobId);
        files.push({ blob: blob?.path ?? null, path });
      }
    }
    return files;
  }

  async sandboxes(scope: ResourceScope) {
    const shown = await this.#show(
      scope,
      "sandbox",
      (_owner, stores) => stores.containers.list(),
      (value) => value.id
    );
    return shown.sort((a, b) => b.value.createdAt - a.value.createdAt);
  }
  async find(
    scope: ResourceScope,
    kind: ResourceKind,
    id: string
  ): Promise<readonly ResourceRef[]> {
    const readers = {
      artifact: () => this.artifacts(scope),
      run: () => this.runs(scope),
      sandbox: () => this.sandboxes(scope),
      session: () => this.sessions(scope),
    };
    const shown = await readers[kind]();
    return shown.map((item) => item.ref).filter((ref) => ref.id === id);
  }
  async share(ref: ResourceRef, targetWorkspaceId: string): Promise<void> {
    await this.#associations.share(ref, targetWorkspaceId);
  }
  async unshare(ref: ResourceRef, targetWorkspaceId: string): Promise<void> {
    await this.#associations.unshare(ref, targetWorkspaceId);
  }
}
