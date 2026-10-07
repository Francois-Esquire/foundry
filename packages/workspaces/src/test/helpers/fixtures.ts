import type { WorkspaceStore } from "../../store";
import type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceFile,
  WorkspaceId,
  WorkspaceRegistration,
} from "../../types";

/** A canonical root no other case can collide with. */
export function newRoot(label: string): string {
  return `/src/${crypto.randomUUID()}/${label}`;
}

export function newWorkspaceId(): WorkspaceId {
  return crypto.randomUUID() as WorkspaceId;
}

export function newWorkspaceEntryId(): WorkspaceEntryId {
  return crypto.randomUUID() as WorkspaceEntryId;
}

export interface WorkspaceOverrides {
  readonly createdAt?: Date;
  readonly id?: WorkspaceId;
  readonly kind?: string;
  readonly lastReconciledAt?: Date;
  readonly name?: string;
  readonly path: string;
  readonly sourceId?: string | null;
  readonly updatedAt?: Date;
}

export function hostWorkspace(
  overrides: WorkspaceOverrides
): WorkspaceRegistration {
  const createdAt = overrides.createdAt ?? new Date(1000);
  return {
    createdAt,
    id: overrides.id ?? newWorkspaceId(),
    lastReconciledAt: overrides.lastReconciledAt ?? createdAt,
    name: overrides.name ?? "alpha",
    source: {
      kind: overrides.kind ?? "host",
      path: overrides.path,
      sourceId: overrides.sourceId ?? null,
    },
    updatedAt: overrides.updatedAt ?? createdAt,
  };
}

/** One registration over an Artifact: a source reference beside its root. */
export function artifactWorkspace(
  artifactId: string,
  path: string
): WorkspaceRegistration {
  return hostWorkspace({ kind: "artifact", path, sourceId: artifactId });
}

export function directoryRecord(
  workspaceId: WorkspaceId,
  path: string
): WorkspaceEntry {
  return {
    createdAt: new Date(1000),
    id: newWorkspaceEntryId(),
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    type: "directory",
    updatedAt: new Date(1000),
    workspaceId,
  };
}

export function fileRecord(
  workspaceId: WorkspaceId,
  overrides: Partial<WorkspaceFile> & { path: string }
): WorkspaceFile {
  const createdAt = overrides.createdAt ?? new Date(1000);
  return {
    bytes: 4,
    createdAt,
    digest: "0bf474896363505e5ea5e5d6ace8ebfb13a760a409b1fb467d428fc716f9f284",
    extension: "md",
    id: newWorkspaceEntryId(),
    kind: "document",
    mime: "text/markdown",
    name: overrides.path.split("/").at(-1) ?? overrides.path,
    type: "file",
    updatedAt: overrides.updatedAt ?? createdAt,
    workspaceId,
    ...overrides,
  };
}

/** Writes one registration and its entries straight into a store. */
export function seed(
  store: WorkspaceStore,
  workspace: WorkspaceRegistration,
  entries: readonly WorkspaceEntry[] = []
): Promise<void> {
  return store.commit({ putEntries: entries, workspace });
}
