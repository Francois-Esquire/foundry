import { KindBadge } from "~/components/blocks/kind-badge";
import { StatusLabel, type StatusView } from "~/components/blocks/status-label";
import { Action } from "~/components/ui/action";
import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Text } from "~/components/ui/text";
import { CostTag, type CostView } from "./cost-tag";
import { EmptyState } from "./empty-state";

export interface RunListRow<S> {
  readonly branch: boolean;
  readonly cost?: CostView;
  readonly depth: number;
  readonly elapsed: string;
  readonly expanded: boolean;
  readonly key: string;
  readonly name: string;
  readonly runId?: string;
  readonly selected: boolean;
  readonly selection: S;
  readonly status: StatusView;
  readonly step: boolean;
}

export function RunsBlock<S>({
  rows,
  selectedId,
  active,
  onSelect,
  onToggle,
  filterLabel,
  filtered,
  triggerCount = 0,
  onReset,
}: {
  readonly rows: readonly RunListRow<S>[];
  readonly selectedId?: string;
  readonly active: boolean;
  readonly onSelect: (selection: S) => void;
  readonly onToggle: (selection: S) => void;
  readonly filterLabel?: string;
  readonly filtered: boolean;
  readonly triggerCount?: number;
  readonly onReset?: () => void;
}) {
  const idleDescription = triggerCount
    ? "Waiting for a configured trigger, or launch a catalog item now."
    : "Launch a step or workflow from Marbles. Add triggers for automatic runs.";
  return (
    <Panel
      active={active}
      id="panel:run"
      selectedId={selectedId}
      title={filterLabel ? `3 Runs · ${filterLabel}` : "3 Runs"}
    >
      {rows.length === 0 && (
        <EmptyState
          description={
            filtered
              ? "Clear filters to see all recorded runs."
              : idleDescription
          }
          onReset={filtered ? onReset : undefined}
          title={
            filtered ? "No matching runs. x clears filters." : "No runs yet."
          }
        />
      )}
      {rows.map((row) => (
        <SelectableRow
          depth={row.depth}
          id={row.key}
          key={row.key}
          onSelect={onSelect}
          selected={row.selected}
          value={row.selection}
        >
          {row.branch ? (
            <Action
              id={`expand:${row.key}`}
              label={row.expanded ? "▾" : "▸"}
              onAction={onToggle}
              value={row.selection}
            />
          ) : (
            <Text>·</Text>
          )}
          {row.step && <KindBadge kind="step" />}
          <Text>{row.name}</Text>
          <StatusLabel status={row.status} />
          <Text>{row.elapsed}</Text>
          {row.cost && <CostTag cost={row.cost} />}
          {row.runId !== undefined && <Text>· {row.runId}</Text>}
        </SelectableRow>
      ))}
    </Panel>
  );
}
