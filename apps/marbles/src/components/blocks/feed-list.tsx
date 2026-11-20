import { type FeedMeta, FeedMetaLine } from "~/components/blocks/feed-meta";
import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { EmptyState } from "./empty-state";

export interface FeedItem {
  readonly entry: FeedEntrySnapshot;
  readonly key: string;
  readonly meta: FeedMeta;
}

export interface FeedRow extends FeedItem {
  readonly pending: boolean;
  readonly selected: boolean;
}

function FeedListRow({
  row,
  showWorkspace,
  onSelect,
}: {
  readonly row: FeedRow;
  readonly showWorkspace: boolean;
  readonly onSelect: (entry: FeedEntrySnapshot) => void;
}) {
  const { entry } = row;
  return (
    <SelectableRow
      id={`feed:${row.key}`}
      onSelect={onSelect}
      selected={row.selected}
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
            <strong>{row.pending ? "!" : " "}</strong>
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
            meta={row.meta}
          />
        </box>
      </box>
    </SelectableRow>
  );
}

export function FeedList({
  rows,
  selectedKey,
  active,
  scopeLabel,
  filtered,
  onSelect,
  onReset,
}: {
  readonly rows: readonly FeedRow[];
  readonly selectedKey?: string;
  readonly active: boolean;
  readonly scopeLabel: string;
  readonly filtered: boolean;
  readonly onSelect: (entry: FeedEntrySnapshot) => void;
  readonly onReset: () => void;
}) {
  return (
    <Panel
      active={active}
      borderHint={rows.length > 0 ? " ↑↓ select · Enter read " : undefined}
      id="panel:feed"
      selectedId={selectedKey === undefined ? undefined : `feed:${selectedKey}`}
      title={`Feed · ${scopeLabel}`}
    >
      {rows.length === 0 && (
        <EmptyState
          description={
            filtered
              ? "Nothing from this workspace yet. x shows all workspaces."
              : "Steps publish results and milestones here with feed.post()."
          }
          title={filtered ? "No entries here." : "No entries yet."}
          {...(filtered ? { onReset } : {})}
        />
      )}
      {rows.map((row) => (
        <FeedListRow
          key={row.key}
          onSelect={onSelect}
          row={row}
          showWorkspace={!filtered}
        />
      ))}
    </Panel>
  );
}
