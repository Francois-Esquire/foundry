import type { FeedEntrySnapshot } from "./dashboard-model";

export const ALL_WORKSPACES = "all";

export interface FeedScope {
  /** `all`, or a workspace id. */
  readonly id: string;
  readonly label: string;
}

/**
 * All workspaces first, then this workspace, then any other workspace that
 * has posted. The dashboard cycles through them with `w`.
 */
export function feedScopes(
  entries: readonly FeedEntrySnapshot[],
  workspaceId?: string
): FeedScope[] {
  const names = new Map<string, string>();
  for (const entry of entries) {
    names.set(entry.workspace.id, entry.workspace.name);
  }
  const scopes: FeedScope[] = [{ id: ALL_WORKSPACES, label: "All workspaces" }];
  if (workspaceId) {
    const name = names.get(workspaceId);
    scopes.push({
      id: workspaceId,
      label: name ? `This workspace · ${name}` : "This workspace",
    });
  }
  for (const [id, name] of names) {
    if (id !== workspaceId) {
      scopes.push({ id, label: name });
    }
  }
  return scopes;
}

export function scopedFeed(
  entries: readonly FeedEntrySnapshot[],
  scope: string
): readonly FeedEntrySnapshot[] {
  return scope === ALL_WORKSPACES
    ? entries
    : entries.filter((entry) => entry.workspace.id === scope);
}
