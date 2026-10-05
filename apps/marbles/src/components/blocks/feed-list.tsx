import { useCallback } from "react";
import { FeedMetaLine, isPending } from "~/components/feed-meta";
import { Panel } from "~/components/panel";
import { useTheme } from "~/hooks/use-theme";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { EmptyState } from "./empty-state";

function FeedRow({
  entry,
  selected,
  showWorkspace,
  onSelect,
}: {
  readonly entry: FeedEntrySnapshot;
  readonly selected: boolean;
  readonly showWorkspace: boolean;
  readonly onSelect: (entry: FeedEntrySnapshot) => void;
}) {
  const theme = useTheme();
  const handleSelect = useCallback(() => onSelect(entry), [onSelect, entry]);
  const pending = isPending(entry);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Terminal row; the feed tab provides keyboard navigation.
    <box
      backgroundColor={selected ? theme.colors.muted : undefined}
      flexDirection="column"
      flexShrink={0}
      id={`feed:${entry.id}`}
      onMouseDown={handleSelect}
      paddingBottom={1}
    >
      <box flexDirection="row">
        <text fg={theme.colors.foreground} flexShrink={0} width={2}>
          {selected ? "›" : " "}
        </text>
        <text fg={theme.colors.warning} flexShrink={0} width={2}>
          <strong>{pending ? "!" : " "}</strong>
        </text>
        <text
          fg={theme.colors.foreground}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          wrapMode="word"
        >
          <strong>{entry.title}</strong>
        </text>
      </box>
      <box flexDirection="row" paddingLeft={4}>
        <FeedMetaLine
          details={[
            showWorkspace ? entry.workspace.name : undefined,
            entry.posted,
            entry.media.length > 0 ? `${entry.media.length} media` : undefined,
          ]}
          entry={entry}
        />
      </box>
    </box>
  );
}

export function FeedList({
  entries,
  selected,
  active,
  scopeLabel,
  filtered,
  onSelect,
  onReset,
}: {
  readonly entries: readonly FeedEntrySnapshot[];
  readonly selected?: FeedEntrySnapshot;
  readonly active: boolean;
  readonly scopeLabel: string;
  readonly filtered: boolean;
  readonly onSelect: (entry: FeedEntrySnapshot) => void;
  readonly onReset: () => void;
}) {
  return (
    <Panel
      active={active}
      id="panel:feed"
      selectedId={selected && `feed:${selected.id}`}
      title={`Feed · ${scopeLabel}`}
    >
      {entries.length === 0 && (
        <EmptyState
          description={
            filtered
              ? "Nothing from this workspace yet. w changes workspace."
              : "Steps publish results and milestones here with feed.post()."
          }
          title={filtered ? "No entries here." : "No entries yet."}
          {...(filtered ? { onReset } : {})}
        />
      )}
      {entries.map((entry) => (
        <FeedRow
          entry={entry}
          key={entry.id}
          onSelect={onSelect}
          selected={entry.id === selected?.id}
          showWorkspace={!filtered}
        />
      ))}
    </Panel>
  );
}
