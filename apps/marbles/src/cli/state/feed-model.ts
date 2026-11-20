import type { FeedItem, FeedRow } from "~/components/blocks/feed-list";
import type { FeedEntrySnapshot } from "~/lib/feed/read";

export const ALL_WORKSPACES = "all";

export function feedKey(
  entry: Pick<FeedEntrySnapshot, "id" | "workspace">
): string {
  return JSON.stringify([entry.workspace.id, entry.id]);
}

export function feedItem(entry: FeedEntrySnapshot): FeedItem {
  return { entry, key: feedKey(entry) };
}

export function feedRows(
  entries: readonly FeedEntrySnapshot[],
  selected?: FeedEntrySnapshot
): FeedRow[] {
  const selectedKey = selected && feedKey(selected);
  return entries.map((entry) => {
    const item = feedItem(entry);
    return { ...item, selected: item.key === selectedKey };
  });
}

export interface FeedScope {
  readonly id: string;
  readonly label: string;
}

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
    : entries.filter((entry) =>
        (entry.workspaces ?? [entry.workspace.id]).includes(scope)
      );
}
