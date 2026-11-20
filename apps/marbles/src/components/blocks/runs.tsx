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
const MIN_NAME = 10;
const MIN_INDENT_CAP = 2;

function statusWidth({ label, tone }: StatusView): number {
  return tone === "error" || tone === "warning"
    ? label.length + 2
    : label.length;
}

function costWidth(cost: CostView): number {
  return cost.priced ? cost.value.length + 2 : cost.value.length;
}

function nameRoom<S>(
  row: RunListRow<S>,
  width: number,
  depth: number,
  status: StatusView
): number {
  return (
    width -
    depth * 2 -
    4 -
    (row.step ? STEP_BADGE : 0) -
    1 -
    statusWidth(status)
  );
}

function readableName<S>(row: RunListRow<S>): number {
  return Math.min(row.name.length, MIN_NAME);
}

function shortStatus({ label, short, tone }: StatusView): StatusView {
  return { label: short ?? label, tone };
}

function shownStatus<S>(
  row: RunListRow<S>,
  width: number,
  depth: number
): StatusView {
  if (
    row.status.short === undefined ||
    width <= 0 ||
    nameRoom(row, width, depth, row.status) >= readableName(row)
  ) {
    return row.status;
  }
  return shortStatus(row.status);
}

function indentCap<S>(
  rows: readonly RunListRow<S>[],
  width: number
): number | undefined {
  if (width <= 0) {
    return;
  }
  let cap: number | undefined;
  for (const row of rows) {
    const status = shortStatus(row.status);
    const readable = readableName(row);
    if (
      row.depth > MIN_INDENT_CAP &&
      nameRoom(row, width, row.depth, status) < readable
    ) {
      const fits = Math.floor((nameRoom(row, width, 0, status) - readable) / 2);
      cap = Math.min(cap ?? row.depth, Math.max(fits, MIN_INDENT_CAP));
    }
  }
  return cap;
}

type Detail = "cost" | "elapsed" | "runId";

interface RowFit {
  readonly name?: number;
  readonly shown: ReadonlySet<Detail>;
  readonly status: StatusView;
}

function rowFit<S>(row: RunListRow<S>, width: number, depth: number): RowFit {
  const pieces: [Detail, number][] = [["elapsed", row.elapsed.length + 1]];
  if (row.cost) {
    pieces.push(["cost", costWidth(row.cost) + 1]);
  }
  if (row.runId !== undefined) {
    pieces.push(["runId", row.runId.length + 3]);
  }
  if (width <= 0) {
    return {
      shown: new Set(pieces.map(([piece]) => piece)),
      status: row.status,
    };
  }
  const status = shownStatus(row, width, depth);
  const room = nameRoom(row, width, depth, status);
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
    status,
  };
}

function RunRow<S>({
  depth,
  row,
  width,
  onSelect,
  onToggle,
}: {
  readonly depth: number;
  readonly row: RunListRow<S>;
  readonly width: number;
  readonly onSelect: (selection: S) => void;
  readonly onToggle: (selection: S) => void;
}) {
  const { name, shown, status } = rowFit(row, width, depth);
  return (
    <SelectableRow
      depth={depth}
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
      <StatusLabel status={status} />
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
  const cap = indentCap(rows, width);
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
              depth={cap === undefined ? row.depth : Math.min(row.depth, cap)}
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
