import { KindBadge } from "~/components/blocks/kind-badge";
import { StatusLabel } from "~/components/blocks/status-label";
import { Action } from "~/components/ui/action";
import { KeyValue } from "~/components/ui/key-value";
import { Panel } from "~/components/ui/panel";
import { SelectableRow } from "~/components/ui/selectable-row";
import { Tabs } from "~/components/ui/tabs";
import { Text } from "~/components/ui/text";
import type {
  DashboardSelection,
  DashboardSnapshot,
  DefinitionSnapshot,
  ResolvedSelection,
  RunSnapshot,
  StepSnapshot,
  TriggerSnapshot,
} from "~/views/dashboard-model";
import { selectionKey } from "~/views/dashboard-model";
import type { InspectorTab } from "~/views/dashboard-state";
import { type CatalogSelection, scopedRuns } from "~/views/dashboard-tree";
import type { RunActions } from "~/views/run-actions";
import { ActivityDetails } from "./activity-details";
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
  /** From a top-level step down to the inspected one; empty for the run. */
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
    {
      content:
        tab === "stream" ? (
          <RunStream runId={run.id} source={stream} stepId={step?.id} />
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
  item,
  onInspect,
  onFilter,
  onLaunch,
}: {
  readonly snapshot: DashboardSnapshot;
  readonly item:
    | { readonly kind: "trigger"; readonly value: TriggerSnapshot }
    | { readonly kind: "definition"; readonly value: DefinitionSnapshot };
  readonly onInspect: (selection: DashboardSelection) => void;
  readonly onFilter: (selection: CatalogSelection) => void;
  readonly onLaunch?: (id: string) => void;
}) {
  const { value } = item;
  const selection: CatalogSelection = { id: value.id, kind: item.kind };
  const runs = scopedRuns(snapshot, selection);
  return (
    <box flexDirection="column" gap={1}>
      <KindBadge kind={value.kind} />
      <Text>
        <strong>{value.name}</strong>
      </Text>
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
      {item.kind === "trigger" && item.value.configuration !== undefined && (
        <Text>
          Configuration: {JSON.stringify(item.value.configuration, null, 2)}
        </Text>
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
          id={`detail:${run.id}`}
          key={run.id}
          onSelect={onInspect}
          selected={false}
          value={{ id: run.id, kind: "run" }}
        >
          <Text>{run.id}</Text>
          <StatusLabel item={run} />
        </SelectableRow>
      ))}
    </box>
  );
}

/** Why a selection shows nothing: it has dropped out of the snapshot. */
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
  tab,
  onTab,
  onInspect,
  onFilter,
  onLaunch,
  stream,
}: {
  readonly snapshot: DashboardSnapshot;
  readonly selection?: DashboardSelection;
  readonly resolved: ResolvedSelection;
  readonly active: boolean;
  readonly tab: InspectorTab;
  readonly onTab: (tab: InspectorTab) => void;
  readonly onInspect: (selection: DashboardSelection) => void;
  readonly onFilter: (selection: CatalogSelection) => void;
  readonly onLaunch?: (id: string) => void;
  readonly stream?: RunActions["stream"];
}) {
  let content = (
    <Text>Select a schedule, monitor, definition, run, or step.</Text>
  );
  if (resolved.kind === "gone") {
    content = <Text>{goneMessage(resolved)}</Text>;
  }
  if (resolved.kind === "activity") {
    content = (
      <ActivityDetails
        activity={resolved.activity}
        onInspect={onInspect}
        run={resolved.run}
      />
    );
  }
  if (resolved.kind === "run") {
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
    content = (
      <CatalogDetails
        item={
          resolved.kind === "trigger"
            ? { kind: "trigger", value: resolved.trigger }
            : { kind: "definition", value: resolved.definition }
        }
        onFilter={onFilter}
        onInspect={onInspect}
        onLaunch={onLaunch}
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
