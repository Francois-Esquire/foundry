import { Action } from "~/components/action";
import { KindBadge } from "~/components/kind-badge";
import { Panel } from "~/components/panel";
import { SelectableRow } from "~/components/selectable-row";
import { StatusLabel } from "~/components/status-label";
import { KeyValue } from "~/components/ui/key-value";
import { Tabs } from "~/components/ui/tabs";
import { Text } from "~/components/ui/text";
import type {
  DashboardSelection,
  DashboardSnapshot,
  RunSnapshot,
  StepSnapshot,
} from "~/views/dashboard-model";
import { selectionKey } from "~/views/dashboard-model";
import { type CatalogSelection, scopedRuns } from "~/views/dashboard-tree";
import type { InspectorTab } from "~/views/use-dashboard";
import { RunLogs } from "./run-logs";
import { RunOverview, StepOverview } from "./run-overview";
import { ValueViewer } from "./value-viewer";

function stepPath(
  steps: readonly StepSnapshot[],
  id?: string
): readonly StepSnapshot[] {
  for (const step of steps) {
    if (step.id === id) {
      return [step];
    }
    const children = stepPath(step.children, id);
    if (children.length) {
      return [step, ...children];
    }
  }
  return [];
}

function RunInspector({
  run,
  snapshot,
  selection,
  focused,
  tab,
  onTab,
  onInspect,
}: {
  readonly run: RunSnapshot;
  readonly snapshot: DashboardSnapshot;
  readonly selection: Extract<DashboardSelection, { kind: "run" }>;
  readonly focused: boolean;
  readonly tab: InspectorTab;
  readonly onTab: (tab: InspectorTab) => void;
  readonly onInspect: (selection: DashboardSelection) => void;
}) {
  const path = stepPath(run.steps, selection.stepId);
  const step = path.at(-1);
  if (selection.stepId && !step) {
    return <Text>This step is no longer available in run {run.id}.</Text>;
  }
  const subject = step ?? run;
  const trigger =
    snapshot.triggers.find((item) => item.id === run.triggerId)?.name ??
    run.triggerId ??
    "Manual";
  const tabs = [
    {
      content: step ? (
        <StepOverview run={run} step={step} />
      ) : (
        <RunOverview run={run} trigger={trigger} />
      ),
      key: "overview",
      label: "Overview",
    },
    {
      content: (
        <ValueViewer
          empty="No input recorded."
          focused={focused && tab === "input"}
          value={subject.input}
        />
      ),
      key: "input",
      label: "Input",
    },
    {
      content: (
        <box flexDirection="column">
          {subject.error && <Text>Error: {subject.error}</Text>}
          <ValueViewer
            empty="No output recorded."
            focused={focused && tab === "output"}
            value={subject.result}
          />
        </box>
      ),
      key: "output",
      label: "Output",
    },
    {
      content: (
        <RunLogs focused={focused && tab === "logs"} run={run} step={step} />
      ),
      key: "logs",
      label: "Logs",
    },
  ] as const;
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" flexWrap="wrap" gap={1}>
        <Action
          id="breadcrumb:run"
          label={run.id}
          onAction={onInspect}
          value={{ id: run.id, kind: "run" }}
        />
        {path.map((item) => (
          <Action
            key={item.id}
            label={`› ${item.name}`}
            onAction={onInspect}
            value={{ id: run.id, kind: "run", stepId: item.id }}
          />
        ))}
      </box>
      <Tabs activeTab={tab} onTabChange={onTab} tabs={tabs} />
    </box>
  );
}

function CatalogDetails({
  snapshot,
  selection,
  onInspect,
  onFilter,
}: {
  readonly snapshot: DashboardSnapshot;
  readonly selection: CatalogSelection;
  readonly onInspect: (selection: DashboardSelection) => void;
  readonly onFilter: (selection: CatalogSelection) => void;
}) {
  const item =
    selection.kind === "trigger"
      ? snapshot.triggers.find((entry) => entry.id === selection.id)
      : snapshot.definitions.find((entry) => entry.id === selection.id);
  if (!item) {
    return <Text>This item is no longer available.</Text>;
  }
  const runs = scopedRuns(snapshot, selection);
  return (
    <box flexDirection="column" gap={1}>
      <KindBadge kind={item.kind} />
      <Text>
        <strong>{item.name}</strong>
      </Text>
      <Text>{item.description}</Text>
      {"targetId" in item && (
        <KeyValue
          items={[
            {
              key: "Target",
              value:
                snapshot.definitions.find((entry) => entry.id === item.targetId)
                  ?.name ?? item.targetId,
            },
            { key: "Status", value: item.status },
            { key: "Next", value: item.next ?? "Waiting for an event" },
          ]}
        />
      )}
      {"configuration" in item && item.configuration !== undefined && (
        <Text>
          Configuration: {JSON.stringify(item.configuration, null, 2)}
        </Text>
      )}
      <Action
        id="filter:runs"
        label={`f Show these runs (${runs.length})`}
        onAction={onFilter}
        value={selection}
      />
      {runs.length === 0 && <Text>No runs recorded.</Text>}
      {runs.map((run) => (
        <SelectableRow
          id={`detail:${run.id}`}
          key={run.id}
          onSelect={onInspect}
          selected={false}
          value={{ id: run.id, kind: "run" }}
        >
          <Text>{run.id}</Text>
          <StatusLabel status={run.status} />
        </SelectableRow>
      ))}
    </box>
  );
}

export function DetailsBlock({
  snapshot,
  selection,
  active,
  tab,
  onTab,
  onInspect,
  onFilter,
}: {
  readonly snapshot: DashboardSnapshot;
  readonly selection?: DashboardSelection;
  readonly active: boolean;
  readonly tab: InspectorTab;
  readonly onTab: (tab: InspectorTab) => void;
  readonly onInspect: (selection: DashboardSelection) => void;
  readonly onFilter: (selection: CatalogSelection) => void;
}) {
  let content = (
    <Text>Select a schedule, monitor, definition, run, or step.</Text>
  );
  if (selection?.kind === "run") {
    const run = snapshot.runs.find((item) => item.id === selection.id);
    content = run ? (
      <RunInspector
        focused={active}
        key={`${run.id}:${selection.stepId ?? "run"}`}
        onInspect={onInspect}
        onTab={onTab}
        run={run}
        selection={selection}
        snapshot={snapshot}
        tab={tab}
      />
    ) : (
      <Text>This run is no longer available.</Text>
    );
  } else if (selection) {
    content = (
      <CatalogDetails
        onFilter={onFilter}
        onInspect={onInspect}
        selection={selection}
        snapshot={snapshot}
      />
    );
  }
  return (
    <Panel
      active={active}
      resetKey={selection && `${selectionKey(selection)}:${tab}`}
      scrollable={active}
      title="Details"
    >
      {content}
    </Panel>
  );
}
