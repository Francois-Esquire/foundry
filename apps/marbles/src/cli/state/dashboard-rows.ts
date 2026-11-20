import { basename, dirname, join, sep } from "node:path";
import type { DefinitionRow, TriggerRow } from "~/components/blocks/catalog";
import type { LogLine } from "~/components/blocks/logs-panel";
import type { LatestRow } from "~/components/blocks/operating-overview";
import type { RunListRow } from "~/components/blocks/runs";
import type { WorkspaceRow } from "~/components/blocks/workspaces-panel";
import type { WorkspaceSummary } from "~/model/connection";
import { statusDisplay } from "~/model/run-status";
import {
  type DashboardSelection,
  type DashboardSnapshot,
  type DefinitionSnapshot,
  isSelected,
  runSelection,
  selectionKey,
  type TriggerSnapshot,
  triggerSelection,
} from "./dashboard-model";
import type { CatalogSelection, RunRow } from "./dashboard-tree";
import type { LatestItem, OperatingLogEntry } from "./operating-model";
import { costView } from "./usage-format";

export function describeFilter(
  snapshot: DashboardSnapshot,
  filter?: CatalogSelection
): string | undefined {
  if (!filter) {
    return undefined;
  }
  const name =
    filter.kind === "trigger"
      ? snapshot.triggers.find((item) => isSelected(item, filter))?.name
      : snapshot.definitions.find((item) => item.id === filter.id)?.name;
  return `${filter.kind}: ${name ?? filter.id}`;
}

function triggerRowId(trigger: TriggerSnapshot): string {
  return trigger.workspace === undefined
    ? `trigger:${trigger.id}`
    : `trigger:${selectionKey(triggerSelection(trigger))}`;
}

export function triggerRows(
  triggers: readonly TriggerSnapshot[],
  selected?: DashboardSelection
): TriggerRow<DashboardSelection>[] {
  return triggers.map((trigger) => {
    const selection = triggerSelection(trigger);
    return {
      detail: trigger.next ? `Next: ${trigger.next}` : trigger.description,
      id: triggerRowId(trigger),
      key: selectionKey(selection),
      kind: trigger.kind,
      name: trigger.name,
      selected: selected?.kind === "trigger" && isSelected(trigger, selected),
      selection,
      status: statusDisplay(trigger),
    };
  });
}

function originLabel(definition: DefinitionSnapshot): string | undefined {
  const { origin } = definition;
  if (!origin) {
    return;
  }
  return origin.external ? "outside workspace" : origin.source;
}

export function definitionRows(
  definitions: readonly DefinitionSnapshot[],
  selected?: DashboardSelection
): DefinitionRow<DashboardSelection>[] {
  return definitions.map((definition) => {
    const origin = originLabel(definition);
    return {
      id: `definition:${definition.id}`,
      key: definition.id,
      kind: definition.kind,
      name: definition.name,
      ...(origin === undefined ? {} : { origin }),
      selected:
        selected?.kind === "definition" && selected.id === definition.id,
      selection: { id: definition.id, kind: "definition" },
    };
  });
}

function isStepRow(row: RunRow): boolean {
  return (
    row.depth > 0 &&
    row.selection.kind === "run" &&
    row.selection.activityId === undefined
  );
}

export function runListRows(
  rows: readonly RunRow[],
  selected?: DashboardSelection
): RunListRow<DashboardSelection>[] {
  const selectedKey = selected && selectionKey(selected);
  return rows.map((row) => {
    const key = selectionKey(row.selection);
    return {
      branch: row.branch,
      ...(row.cost ? { cost: costView(row.cost) } : {}),
      depth: row.depth,
      elapsed: row.elapsed,
      expanded: row.expanded,
      key,
      name: row.name,
      ...(row.depth === 0 ? { runId: row.selection.id } : {}),
      selected: key === selectedKey,
      selection: row.selection,
      status: statusDisplay(row),
      step: isStepRow(row),
    };
  });
}

export function latestRows(
  items: readonly LatestItem[]
): LatestRow<DashboardSelection>[] {
  return items.map(({ at, id, run, text }) => ({
    at,
    id,
    ...(run === undefined ? {} : { selection: runSelection(run) }),
    text,
  }));
}

export function logLocation(entry: OperatingLogEntry): string {
  if (entry.source === "host") {
    return "marbles";
  }
  if (entry.setup) {
    return `${entry.runId ?? ""} setup`;
  }
  return entry.stepId ? `${entry.runId} ${entry.stepId}` : (entry.runId ?? "");
}

export function logLines(
  entries: readonly OperatingLogEntry[]
): LogLine<OperatingLogEntry>[] {
  return entries.map((entry) => ({
    entry,
    id: entry.id,
    level: entry.level,
    location: logLocation(entry),
    message: entry.message,
    timestamp: entry.timestamp,
  }));
}

function workspaceLabel(
  root: string,
  workspaces: readonly WorkspaceSummary[]
): string {
  let label = basename(root);
  let parent = dirname(root);
  while (
    workspaces.some(
      (other) => other.root !== root && other.root.endsWith(sep + label)
    )
  ) {
    if (parent === dirname(parent)) {
      return root;
    }
    label = join(basename(parent), label);
    parent = dirname(parent);
  }
  return label;
}

export function workspaceRows(
  workspaces: readonly WorkspaceSummary[]
): WorkspaceRow[] {
  return workspaces.map((workspace) => {
    const label = workspaceLabel(workspace.root, workspaces);
    return {
      ...workspace,
      label,
      qualified: label !== basename(workspace.root),
    };
  });
}
