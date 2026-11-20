import { StatusLabel } from "~/components/blocks/status-label";
import { Action } from "~/components/ui/action";
import { KeyValue } from "~/components/ui/key-value";
import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Tabs } from "~/components/ui/tabs";
import { Text } from "~/components/ui/text";
import { canRunSchedule } from "~/model/dashboard";
import type {
  DashboardSelection,
  DashboardSnapshot,
  DefinitionSnapshot,
  ResolvedSelection,
  RunSnapshot,
  StepSnapshot,
  TriggerSnapshot,
} from "~/views/dashboard-model";
import {
  flattenSteps,
  runSelection,
  selectionKey,
  triggerSelection,
} from "~/views/dashboard-model";
import type { InspectorTab } from "~/views/dashboard-state";
import { type CatalogSelection, scopedRuns } from "~/views/dashboard-tree";
import type { RunActions } from "~/views/run-actions";
import { costLabel, tokensLabel } from "~/views/usage-format";
import { ActivityDetails } from "./activity-details";
import { LiveWork } from "./live-work";
import { RunLogs } from "./run-logs";
import { RunOverview, StepOverview } from "./run-overview";
import { RunStream } from "./run-stream";
import { ValueViewer } from "./value-viewer";

function RunInspector({
  run,
  path,
  snapshot,
  focused,
  tab,
  onTab,
  onInspect,
  stream,
}: {
  readonly run: RunSnapshot;
  readonly path: readonly StepSnapshot[];
  readonly snapshot: DashboardSnapshot;
  readonly focused: boolean;
  readonly tab: InspectorTab;
  readonly onTab: (tab: InspectorTab) => void;
  readonly onInspect: (selection: DashboardSelection) => void;
  readonly stream?: RunActions["stream"];
}) {
  const step = path.at(-1);
  const subject = step ?? run;
  const work = flattenSteps(step ? [step] : run.steps).flatMap(
    (entry) => entry.step.work ?? []
  );
  const trigger =
    snapshot.triggers.find(
      (item) =>
        item.id === run.triggerId && item.workspace?.id === run.workspace?.id
    )?.name ??
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
    {
      content:
        tab === "stream" ? (
          <RunStream
            runId={run.id}
            source={run.workspace === undefined ? stream : undefined}
            stepId={step?.id}
          />
        ) : null,
      key: "stream",
      label: "Stream",
    },
  ] as const;
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" flexWrap="wrap" gap={1}>
        <Action
          id="breadcrumb:run"
          label={run.id}
          onAction={onInspect}
          value={runSelection(run)}
        />
        {path.map((item) => (
          <Action
            key={item.id}
            label={`› ${item.name}`}
            onAction={onInspect}
            value={runSelection(run, { stepId: item.id })}
          />
        ))}
      </box>
      <LiveWork work={work} />
      <Tabs activeTab={tab} onTabChange={onTab} tabs={tabs} />
    </box>
  );
}

function CatalogDetails({
  configuration,
  onToggleConfiguration,
  snapshot,
  item,
  onInspect,
  onFilter,
  onLaunch,
  onRollSchedule,
}: {
  readonly configuration: boolean;
  readonly onToggleConfiguration: () => void;
  readonly snapshot: DashboardSnapshot;
  readonly item:
    | { readonly kind: "trigger"; readonly value: TriggerSnapshot }
    | { readonly kind: "definition"; readonly value: DefinitionSnapshot };
  readonly onInspect: (selection: DashboardSelection) => void;
  readonly onFilter: (selection: CatalogSelection) => void;
  readonly onLaunch?: (id: string) => void;
  readonly onRollSchedule?: (key: string) => void;
}) {
  const { value } = item;
  const raw = item.kind === "trigger" ? item.value.configuration : undefined;
  const selection: CatalogSelection =
    item.kind === "trigger"
      ? triggerSelection(item.value)
      : { id: value.id, kind: item.kind };
  const runs = scopedRuns(snapshot, selection);
  const rootUsage = snapshot.usage?.byWorkflow.find(
    (group) => group.id === value.id
  )?.total;
  const emptyUsage = snapshot.usage
    ? "no usage recorded for runs started here"
    : "usage unavailable";
  return (
    <box flexDirection="column" gap={1}>
      <Text>{value.description}</Text>
      {item.kind === "trigger" && (
        <KeyValue
          items={[
            {
              key: "Target",
              value:
                snapshot.definitions.find(
                  (entry) => entry.id === item.value.targetId
                )?.name ?? item.value.targetId,
            },
            { key: "Status", value: item.value.status },
            ...(item.value.owner
              ? [{ key: "Owner", value: item.value.owner }]
              : []),
            ...(item.value.lifetime
              ? [{ key: "Lifetime", value: item.value.lifetime }]
              : []),
            { key: "Next", value: item.value.next ?? "Waiting for an event" },
          ]}
        />
      )}
      {raw !== undefined && (
        <Action
          label={
            configuration ? "v Hide configuration" : "v Show configuration"
          }
          onAction={onToggleConfiguration}
          value="configuration"
        />
      )}
      {configuration && raw !== undefined && (
        <Text>{JSON.stringify(raw, null, 2)}</Text>
      )}
      {item.kind === "definition" && (
        <KeyValue
          items={[
            { key: "Workspace", value: snapshot.workspace },
            {
              key: "Source",
              value: item.value.origin
                ? `${item.value.origin.source}${item.value.origin.external ? " (outside the workspace root)" : ""}`
                : "Not recorded",
            },
            { key: "Available", value: `throughout ${snapshot.workspace}` },
            {
              key: "Cost",
              value: rootUsage ? costLabel(rootUsage) : emptyUsage,
            },
            {
              key: "Tokens",
              value: rootUsage ? tokensLabel(rootUsage) : emptyUsage,
            },
            {
              key: "Covers",
              value: `runs started from ${value.name}; inside other runs its usage counts under their steps`,
            },
          ]}
        />
      )}
      {item.kind === "trigger" &&
        canRunSchedule(item.value) &&
        onRollSchedule && (
          <Action
            id="schedule:run"
            label="r Run now"
            onAction={onRollSchedule}
            value={value.id}
          />
        )}
      {item.kind === "definition" && onLaunch && (
        <Action
          active
          id="catalog:launch"
          label="l Launch"
          onAction={onLaunch}
          value={value.id}
        />
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
          id={`detail:${selectionKey(runSelection(run))}`}
          key={selectionKey(runSelection(run))}
          onSelect={onInspect}
          selected={false}
          value={runSelection(run)}
        >
          <Text>{run.id}</Text>
          <StatusLabel item={run} />
        </SelectableRow>
      ))}
    </box>
  );
}

function goneMessage(
  resolved: Extract<ResolvedSelection, { kind: "gone" }>
): string {
  const { run, selection } = resolved;
  if (selection.kind !== "run") {
    return "This item is no longer available.";
  }
  if (!run) {
    return "This run is no longer available.";
  }
  return selection.activityId === undefined
    ? `This step is no longer available in run ${run.id}.`
    : `This activity is no longer available in run ${run.id}.`;
}

export function DetailsBlock({
  snapshot,
  selection,
  resolved,
  active,
  configuration,
  onToggleConfiguration,
  tab,
  onTab,
  onInspect,
  onFilter,
  onLaunch,
  onRollSchedule,
  stream,
}: {
  readonly snapshot: DashboardSnapshot;
  readonly selection?: DashboardSelection;
  readonly resolved: ResolvedSelection;
  readonly active: boolean;
  readonly configuration: boolean;
  readonly onToggleConfiguration: () => void;
  readonly tab: InspectorTab;
  readonly onTab: (tab: InspectorTab) => void;
  readonly onInspect: (selection: DashboardSelection) => void;
  readonly onFilter: (selection: CatalogSelection) => void;
  readonly onLaunch?: (id: string) => void;
  readonly onRollSchedule?: (key: string) => void;
  readonly stream?: RunActions["stream"];
}) {
  let title = "Details";
  let content = (
    <Text>Select a schedule, monitor, definition, run, or step.</Text>
  );
  if (resolved.kind === "gone") {
    content = <Text>{goneMessage(resolved)}</Text>;
  }
  if (resolved.kind === "activity") {
    title = "Activity";
    content = (
      <ActivityDetails
        activity={resolved.activity}
        onInspect={onInspect}
        run={resolved.run}
      />
    );
  }
  if (resolved.kind === "run") {
    const step = resolved.path.at(-1);
    title = step ? `Step / ${step.name}` : `Run / ${resolved.run.name}`;
    content = (
      <RunInspector
        focused={active}
        key={selection && selectionKey(selection)}
        onInspect={onInspect}
        onTab={onTab}
        path={resolved.path}
        run={resolved.run}
        snapshot={snapshot}
        stream={stream}
        tab={tab}
      />
    );
  }
  if (resolved.kind === "trigger" || resolved.kind === "definition") {
    const item =
      resolved.kind === "trigger" ? resolved.trigger : resolved.definition;
    title = `${item.kind[0]?.toUpperCase() ?? ""}${item.kind.slice(1)} / ${item.name}`;
    content = (
      <CatalogDetails
        configuration={configuration}
        item={
          resolved.kind === "trigger"
            ? { kind: "trigger", value: resolved.trigger }
            : { kind: "definition", value: resolved.definition }
        }
        key={selection && selectionKey(selection)}
        onFilter={onFilter}
        onInspect={onInspect}
        onLaunch={onLaunch}
        onRollSchedule={onRollSchedule}
        onToggleConfiguration={onToggleConfiguration}
        snapshot={snapshot}
      />
    );
  }
  return (
    <Panel
      active={active}
      resetKey={selection && `${selectionKey(selection)}:${tab}`}
      scrollable={active}
      title={title}
    >
      {content}
    </Panel>
  );
}
