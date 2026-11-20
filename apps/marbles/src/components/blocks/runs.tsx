import type { BoxRenderable } from "@opentui/core";
import { useCallback, useState } from "react";
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

const STEP_BADGE = "[step]".length + 1;

function statusWidth({ label, tone }: StatusView): number {
  return tone === "error" || tone === "warning"
    ? label.length + 2
    : label.length;
}

function costWidth(cost: CostView): number {
  return cost.priced ? cost.value.length + 2 : cost.value.length;
}

type Detail = "cost" | "elapsed" | "runId";

interface RowFit {
  readonly name?: number;
  readonly shown: ReadonlySet<Detail>;
}

function rowFit<S>(row: RunListRow<S>, width: number): RowFit {
  const pieces: [Detail, number][] = [["elapsed", row.elapsed.length + 1]];
  if (row.cost) {
    pieces.push(["cost", costWidth(row.cost) + 1]);
  }
  if (row.runId !== undefined) {
    pieces.push(["runId", row.runId.length + 3]);
  }
  if (width <= 0) {
    return { shown: new Set(pieces.map(([piece]) => piece)) };
  }
  const room =
    width -
    row.depth * 2 -
    4 -
    (row.step ? STEP_BADGE : 0) -
    1 -
    statusWidth(row.status);
  let used = row.name.length;
  const shown = new Set<Detail>();
  for (const [piece, size] of pieces) {
    used += size;
    if (used > room) {
      break;
    }
    shown.add(piece);
  }
  return {
    name: row.name.length > room ? Math.max(room, 0) : undefined,
    shown,
  };
}

function RunRow<S>({
  row,
  width,
  onSelect,
  onToggle,
}: {
  readonly row: RunListRow<S>;
  readonly width: number;
  readonly onSelect: (selection: S) => void;
  readonly onToggle: (selection: S) => void;
}) {
  const { name, shown } = rowFit(row, width);
  return (
    <SelectableRow
      depth={row.depth}
      id={row.key}
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
        <Text flexShrink={0}>·</Text>
      )}
      {row.step && <KindBadge kind="step" />}
      <Text
        flexShrink={name === undefined ? 1 : 0}
        minWidth={0}
        truncate
        width={name ?? "auto"}
        wrapMode="none"
      >
        {row.name}
      </Text>
      <box flexShrink={0}>
        <StatusLabel status={row.status} />
      </box>
      {shown.has("elapsed") && (
        <Text flexShrink={0} wrapMode="none">
          {row.elapsed}
        </Text>
      )}
      {shown.has("cost") && row.cost && <CostTag cost={row.cost} />}
      {shown.has("runId") && (
        <Text flexShrink={0} wrapMode="none">
          · {row.runId}
        </Text>
      )}
    </SelectableRow>
  );
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
  const [width, setWidth] = useState(0);
  const measure = useCallback(function measureRows(this: BoxRenderable) {
    setWidth(this.width);
  }, []);
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
      {rows.length > 0 && (
        <box flexDirection="column" flexShrink={0} onSizeChange={measure}>
          {rows.map((row) => (
            <RunRow
              key={row.key}
              onSelect={onSelect}
              onToggle={onToggle}
              row={row}
              width={width}
            />
          ))}
        </box>
      )}
    </Panel>
  );
}
