export type WorkspaceId = string;

export type WorkspaceIdentifier = WorkspaceId;

export interface Tree {
  children: Tree[];
}

export function load(id: WorkspaceId): Promise<WorkspaceId> {
  return Promise.resolve(id);
}
