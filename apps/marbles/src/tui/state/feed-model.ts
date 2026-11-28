import type { FeedItem, FeedRow } from "~/components/blocks/feed-list";
import type { FeedMeta } from "~/components/blocks/feed-meta";
import type { ReaderItem } from "~/components/blocks/feed-reader";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { answerView, type InputState, inputState } from "./feed-answer";
import type { FeedState } from "./use-feed";

export const ALL_WORKSPACES = "all";

export function feedKey(
  entry: Pick<FeedEntrySnapshot, "id" | "workspace">
): string {
  return JSON.stringify([entry.workspace.id, entry.id]);
}

const KIND_META: Readonly<Record<"milestone" | "result", FeedMeta>> = {
  milestone: { label: "milestone", tone: "info" },
  result: { label: "result", tone: "success" },
};

const INPUT_META: Readonly<Record<InputState, FeedMeta>> = {
  answered: { label: "answered", tone: "settled" },
  cancelled: { label: "cancelled", tone: "settled" },
  pending: { label: "needs input", tone: "attention" },
};

export function feedMeta(entry: FeedEntrySnapshot): FeedMeta {
  const state = inputState(entry.input);
  const meta =
    entry.kind === "input" ? INPUT_META[state] : KIND_META[entry.kind];
  return state === "pending" ? { ...meta, tone: "attention" } : meta;
}

export function feedItem(entry: FeedEntrySnapshot): FeedItem {
  return { entry, key: feedKey(entry), meta: feedMeta(entry) };
}

export function feedRows(
  entries: readonly FeedEntrySnapshot[],
  selected?: FeedEntrySnapshot
): FeedRow[] {
  const selectedKey = selected && feedKey(selected);
  return entries.map((entry) => {
    const item = feedItem(entry);
    return {
      ...item,
      pending: inputState(entry.input) === "pending",
      selected: item.key === selectedKey,
    };
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
    : entries.filter((entry) => entry.workspace.id === scope);
}

export interface FeedModel {
  readonly list: {
    readonly active: boolean;
    readonly filtered: boolean;
    readonly onReset: () => void;
    readonly onSelect: (entry: FeedEntrySnapshot) => void;
    readonly rows: readonly FeedRow[];
    readonly scopeLabel: string;
    readonly selectedKey?: string;
  };
  readonly reader: {
    readonly active: boolean;
    readonly selected?: ReaderItem;
  };
}

export function feedModel(feed: FeedState, inputActive: boolean): FeedModel {
  const { selected } = feed;
  return {
    list: {
      active: !inputActive && feed.focus === "list",
      filtered: feed.scope.id !== ALL_WORKSPACES,
      onReset: feed.resetScope,
      onSelect: feed.select,
      rows: feedRows(feed.visible, selected),
      scopeLabel: feed.scope.label,
      selectedKey: selected && feedKey(selected),
    },
    reader: {
      active: !inputActive && feed.focus === "reader",
      selected: selected && {
        ...feedItem(selected),
        answer: answerView(selected.input, feed.answer, !inputActive),
      },
    },
  };
}
