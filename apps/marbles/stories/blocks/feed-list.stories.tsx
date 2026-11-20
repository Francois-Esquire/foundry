import { useCallback, useMemo, useState } from "react";
import { defineStories, story } from "textbook-sh";
import { feedKey, feedRows } from "~/cli/state/feed-model";
import { FeedList, type FeedRow } from "~/components/blocks/feed-list";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { ignore, renderFrame } from "../frame";
import {
  feedEntries,
  feedListRows,
  longEntry,
  mediaEntry,
  summaryEntry,
} from "./fixtures-a";

const size = { height: 24, padded: false, width: 56 };

function selectedKey(rows: readonly FeedRow[]): string | undefined {
  return rows.find((row) => row.selected)?.key;
}

function List({
  active = true,
  filtered = false,
  rows,
  scopeLabel = "all workspaces",
}: {
  readonly active?: boolean;
  readonly filtered?: boolean;
  readonly rows: readonly FeedRow[];
  readonly scopeLabel?: string;
}) {
  return (
    <FeedList
      active={active}
      filtered={filtered}
      onReset={ignore}
      onSelect={ignore}
      rows={rows}
      scopeLabel={scopeLabel}
      selectedKey={selectedKey(rows)}
    />
  );
}

function ClickableList() {
  const [selected, setSelected] = useState<FeedEntrySnapshot>(summaryEntry);
  const [scoped, setScoped] = useState(false);
  const entries = useMemo(
    () =>
      scoped
        ? feedEntries.filter((entry) => entry.workspace.id === "ws-handbook")
        : feedEntries,
    [scoped]
  );
  const rows = useMemo(() => feedRows(entries, selected), [entries, selected]);
  const showAll = useCallback(() => setScoped(false), []);
  return (
    <FeedList
      active
      filtered={scoped}
      onReset={showAll}
      onSelect={setSelected}
      rows={rows}
      scopeLabel={scoped ? "handbook" : "all workspaces"}
      selectedKey={feedKey(selected)}
    />
  );
}

export default defineStories({
  component: "FeedList",
  description:
    "Feed entries newest first, each with its kind, workspace, time, and media count.",
  title: "Blocks/FeedList",
});

export const AllWorkspaces = story({
  description:
    "Every workspace's entries with each kind and answer status; one is selected and one needs input.",
  name: "All workspaces",
  render: (renderer) =>
    renderFrame(renderer, <List rows={feedListRows} />, size),
});

export const OneWorkspace = story({
  description: "Scoped to one workspace, so rows leave out the workspace name.",
  name: "One workspace",
  render: (renderer) =>
    renderFrame(
      renderer,
      <List
        filtered
        rows={feedRows(
          feedEntries.filter((entry) => entry.workspace.id === "ws-foundry"),
          summaryEntry
        )}
        scopeLabel="foundry"
      />,
      size
    ),
});

export const Inactive = story({
  description: "The list while the reader has focus.",
  name: "Inactive",
  render: (renderer) =>
    renderFrame(renderer, <List active={false} rows={feedListRows} />, size),
});

export const Empty = story({
  description: "No entries anywhere yet, with a hint on posting one.",
  name: "Empty",
  render: (renderer) => renderFrame(renderer, <List rows={[]} />, size),
});

export const EmptyWorkspace = story({
  description:
    "Nothing in the chosen workspace, with an action to show every workspace.",
  name: "Empty workspace",
  render: (renderer) =>
    renderFrame(
      renderer,
      <FeedList
        active
        filtered
        onReset={ignore}
        onSelect={ignore}
        rows={[]}
        scopeLabel="handbook"
      />,
      size
    ),
});

export const LongTitles = story({
  description:
    "A long title wraps, and an entry with media shows the media count.",
  name: "Long titles and media",
  render: (renderer) =>
    renderFrame(
      renderer,
      <List rows={feedRows([longEntry, mediaEntry, ...feedEntries])} />,
      { ...size, width: 40 }
    ),
});

export const Clickable = story({
  description:
    "Click a row to select it; the list scrolls the selection into view.",
  name: "Clickable",
  render: (renderer) => renderFrame(renderer, <ClickableList />, size),
});
