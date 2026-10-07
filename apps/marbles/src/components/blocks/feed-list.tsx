import { FeedMetaLine, isPending } from "~/components/blocks/feed-meta";
import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
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
  const pending = isPending(entry);
  return (
    <SelectableRow
      id={`feed:${entry.id}`}
      onSelect={onSelect}
      selected={selected}
      value={entry}
    >
      <box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        paddingBottom={1}
      >
        <box flexDirection="row">
          <text fg={theme.colors.warning} flexShrink={0} width={2}>
            <strong>{pending ? "!" : " "}</strong>
          </text>
          <Text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="word">
            <strong>{entry.title}</strong>
          </Text>
        </box>
        <box flexDirection="row" paddingLeft={2}>
          <FeedMetaLine
            details={[
              showWorkspace ? entry.workspace.name : undefined,
              entry.posted,
              entry.media.length > 0
                ? `${entry.media.length} media`
                : undefined,
            ]}
            entry={entry}
          />
        </box>
      </box>
    </SelectableRow>
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
