import type { Page, PageInput } from "@foundry/core/pagination";
import { byCodeUnit } from "@foundry/lib/ordering";
import { pageLimit, sliceRanked } from "@foundry/lib/pagination";
import type { WorkspaceStore, WorkspaceStoreWrite } from "./store";
import type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceId,
  WorkspaceRegistration,
} from "./types";

/** The default store: plain maps in this process. */
export class MemoryWorkspaceStore implements WorkspaceStore {
  private readonly workspaces = new Map<WorkspaceId, WorkspaceRegistration>();
  private readonly entries = new Map<
    WorkspaceId,
    Map<WorkspaceEntryId, WorkspaceEntry>
  >();

  commit(write: WorkspaceStoreWrite): Promise<void> {
    const entries = new Map(this.entries.get(write.workspace.id));
    for (const id of write.deleteEntries ?? []) {
      entries.delete(id);
    }
    for (const entry of write.putEntries ?? []) {
      entries.set(entry.id, copyEntry(entry));
    }
    this.workspaces.set(write.workspace.id, copyWorkspace(write.workspace));
    this.entries.set(write.workspace.id, entries);
    return Promise.resolve();
  }

  removeWorkspace(workspaceId: WorkspaceId): Promise<void> {
    this.workspaces.delete(workspaceId);
    this.entries.delete(workspaceId);
    return Promise.resolve();
  }

  getWorkspace(
    workspaceId: WorkspaceId
  ): Promise<WorkspaceRegistration | null> {
    const workspace = this.workspaces.get(workspaceId);
    return Promise.resolve(workspace ? copyWorkspace(workspace) : null);
  }

  findWorkspaceByPath(path: string): Promise<WorkspaceRegistration | null> {
    return this.oldest((workspace) => workspace.source.path === path);
  }

  findWorkspaceBySourceId(
    sourceId: string
  ): Promise<WorkspaceRegistration | null> {
    return this.oldest((workspace) => workspace.source.sourceId === sourceId);
  }

  listWorkspaces(
    input: PageInput<number> = {}
  ): Promise<Page<WorkspaceRegistration, number>> {
    const page = sliceRanked(
      this.ordered(),
      pageLimit(input.limit),
      input.cursor ?? 0
    );
    return Promise.resolve({ ...page, items: page.items.map(copyWorkspace) });
  }

  getEntry(
    workspaceId: WorkspaceId,
    entryId: WorkspaceEntryId
  ): Promise<WorkspaceEntry | null> {
    const entry = this.entries.get(workspaceId)?.get(entryId);
    return Promise.resolve(entry ? copyEntry(entry) : null);
  }

  listEntries(workspaceId: WorkspaceId): Promise<readonly WorkspaceEntry[]> {
    const entries = [...(this.entries.get(workspaceId)?.values() ?? [])];
    return Promise.resolve(
      entries.sort(byCodeUnit((entry) => entry.path)).map(copyEntry)
    );
  }

  private oldest(
    matches: (workspace: WorkspaceRegistration) => boolean
  ): Promise<WorkspaceRegistration | null> {
    const found = this.ordered().find(matches);
    return Promise.resolve(found ? copyWorkspace(found) : null);
  }

  private ordered(): WorkspaceRegistration[] {
    return [...this.workspaces.values()].sort(byCreatedAtThenId);
  }
}

const byId = byCodeUnit((workspace: WorkspaceRegistration) => workspace.id);

function byCreatedAtThenId(
  a: WorkspaceRegistration,
  b: WorkspaceRegistration
): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime === 0 ? byId(a, b) : byTime;
}

function copyWorkspace(
  workspace: WorkspaceRegistration
): WorkspaceRegistration {
  return {
    ...workspace,
    createdAt: new Date(workspace.createdAt),
    lastReconciledAt: new Date(workspace.lastReconciledAt),
    source: { ...workspace.source },
    updatedAt: new Date(workspace.updatedAt),
  };
}

function copyEntry(entry: WorkspaceEntry): WorkspaceEntry {
  return {
    ...entry,
    createdAt: new Date(entry.createdAt),
    updatedAt: new Date(entry.updatedAt),
  };
}
