import { Action } from "~/components/action";
import { KindBadge } from "~/components/kind-badge";
import { Panel } from "~/components/panel";
import { SelectableRow } from "~/components/selectable-row";
import { StatusLabel } from "~/components/status-label";
import { Text } from "~/components/ui/text";
import { type DashboardSelection, selectionKey } from "~/views/dashboard-model";
import type { RunRow } from "~/views/dashboard-tree";

export function RunsBlock({
  rows,
  selected,
  active,
  onSelect,
  onToggle,
  filterLabel,
  filtered,
}: {
  readonly rows: readonly RunRow[];
  readonly selected?: DashboardSelection;
  readonly active: boolean;
  readonly onSelect: (selection: DashboardSelection) => void;
  readonly onToggle: (selection: DashboardSelection) => void;
  readonly filterLabel?: string;
  readonly filtered: boolean;
}) {
  return (
    <Panel
      active={active}
      id="panel:run"
      selectedId={selected && selectionKey(selected)}
      title={filterLabel ? `3 Runs · ${filterLabel}` : "3 Runs"}
    >
      {rows.length === 0 && (
        <Text>
          {filtered
            ? "No matching runs. x clears filters."
            : "No runs yet. Waiting for a trigger."}
        </Text>
      )}
      {rows.map((row) => (
        <SelectableRow
          depth={row.depth}
          id={selectionKey(row.selection)}
          key={selectionKey(row.selection)}
          onSelect={onSelect}
          selected={
            selected !== undefined &&
            selectionKey(selected) === selectionKey(row.selection)
          }
          value={row.selection}
        >
          {row.branch ? (
            <Action
              id={`expand:${selectionKey(row.selection)}`}
              label={row.expanded ? "▾" : "▸"}
              onAction={onToggle}
              value={row.selection}
            />
          ) : (
            <Text>·</Text>
          )}
          {row.depth > 0 && <KindBadge kind="step" />}
          <Text>{row.name}</Text>
          <StatusLabel status={row.status} />
          <Text>{row.elapsed}</Text>
          {row.depth === 0 && <Text>· {row.selection.id}</Text>}
        </SelectableRow>
      ))}
    </Panel>
  );
}
