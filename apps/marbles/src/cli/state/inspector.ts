import type { ActivityView, Fact } from "~/components/blocks/activity-details";
import type {
  CatalogDetailsView,
  ConfigurationView,
} from "~/components/blocks/catalog-details";
import type { LiveWorkItem } from "~/components/blocks/live-work";
import type { Breadcrumb, RunTabView } from "~/components/blocks/run-inspector";
import type {
  RunOverviewView,
  StepOverviewView,
} from "~/components/blocks/run-overview";
import { canRunSchedule } from "~/model/dashboard";
import type { JsonValue } from "~/model/json";
import type { LogEntry } from "~/model/log";
import { statusDisplay } from "~/model/run-status";
import {
  type DashboardSelection,
  type DashboardSnapshot,
  type DefinitionSnapshot,
  flattenSteps,
  type HarnessActivitySnapshot,
  type ResolvedSelection,
  type RunSnapshot,
  runSelection,
  type StepSnapshot,
  selectionKey,
  type TriggerSnapshot,
  triggerSelection,
} from "./dashboard-model";
import type { InspectorTab } from "./dashboard-state";
import { type CatalogSelection, scopedRuns } from "./dashboard-tree";
import { type RunActions, workLabel } from "./run-actions";
import { costLabel, tokensLabel } from "./usage-format";

type Gone = Extract<ResolvedSelection, { kind: "gone" }>;

export interface InspectorModel {
  readonly active: boolean;
  readonly configurationShown: boolean;
  readonly onFilter: (selection: CatalogSelection) => void;
  readonly onInspect: (selection: DashboardSelection) => void;
  readonly onLaunch?: (id: string) => void;
  readonly onRollSchedule?: (key: string) => void;
  readonly onTab: (tab: InspectorTab) => void;
  readonly onToggleConfiguration: () => void;
  readonly resolved: ResolvedSelection;
  readonly selection?: DashboardSelection;
  readonly snapshot: DashboardSnapshot;
  readonly stream?: RunActions["stream"];
  readonly tab: InspectorTab;
}

export interface RunStreamTarget {
  readonly local: boolean;
  readonly runId: string;
  readonly stepId?: string;
}

export type InspectorSubject =
  | {
      readonly kind: "message";
      readonly message: string;
      readonly title: string;
    }
  | {
      readonly activity: ActivityView<DashboardSelection>;
      readonly kind: "activity";
      readonly title: string;
    }
  | {
      readonly breadcrumbs: readonly Breadcrumb<DashboardSelection>[];
      readonly kind: "run";
      readonly path: readonly StepSnapshot[];
      readonly run: RunSnapshot;
      readonly stream: RunStreamTarget;
      readonly work: readonly LiveWorkItem[];
      readonly title: string;
    }
  | {
      readonly configuration?: JsonValue;
      readonly details: CatalogDetailsView<
        DashboardSelection,
        CatalogSelection
      >;
      readonly kind: "catalog";
      readonly launchable: boolean;
      readonly runNow: boolean;
      readonly title: string;
    };

const DETAILS = "Details";

function goneMessage({ run, selection }: Gone): string {
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

function activityView(
  run: RunSnapshot,
  activity: HarnessActivitySnapshot
): ActivityView<DashboardSelection> {
  return {
    breadcrumb: { label: run.id, selection: { id: run.id, kind: "run" } },
    facts: [
      { key: "Kind", value: activity.kind },
      { key: "Status", value: statusDisplay(activity).label },
      { key: "Harness", value: activity.harness },
      { key: "Agent", value: activity.agentId },
      { key: "Lifetime", value: activity.lifetime },
      { key: "Session", value: activity.sessionId },
      { key: "Activity", value: activity.id },
      ...(activity.nativeId
        ? [{ key: "Native ID", value: activity.nativeId }]
        : []),
      ...(activity.parentId
        ? [{ key: "Parent", value: activity.parentId }]
        : []),
    ],
    ...(activity.summary === undefined ? {} : { summary: activity.summary }),
    title: activity.title,
    waiting: activity.attention !== undefined,
  };
}

function triggerName(snapshot: DashboardSnapshot, run: RunSnapshot): string {
  return (
    snapshot.triggers.find(
      (item) =>
        item.id === run.triggerId && item.workspace?.id === run.workspace?.id
    )?.name ??
    run.triggerId ??
    "Manual"
  );
}

function runOverview(
  snapshot: DashboardSnapshot,
  run: RunSnapshot
): RunOverviewView {
  const steps = flattenSteps(run.steps);
  const active = steps.filter(({ step }) => step.status === "running");
  return {
    cost: costLabel(run.usage),
    currentStep: active.at(-1)?.step.name ?? "None",
    elapsed: run.elapsed,
    ...(run.error === undefined ? {} : { error: run.error }),
    id: run.id,
    name: run.name,
    observedSteps: steps.length,
    started: run.started,
    status: statusDisplay(run).label,
    ...(run.timing === undefined ? {} : { timing: run.timing }),
    tokens: tokensLabel(run.usage),
    trigger: triggerName(snapshot, run),
  };
}

function stepOverview(run: RunSnapshot, step: StepSnapshot): StepOverviewView {
  return {
    children: step.children.length,
    costHere: costLabel(step.usage?.direct),
    costWithChildren: costLabel(step.usage?.inclusive),
    elapsed: step.elapsed ?? "Not recorded",
    ...(step.error === undefined ? {} : { error: step.error }),
    id: step.id,
    name: step.name,
    runId: run.id,
    status: statusDisplay(step).label,
  };
}

function runLogs(
  run: RunSnapshot,
  step: StepSnapshot | undefined
): readonly LogEntry[] {
  const logs = run.logs ?? [];
  if (!step) {
    return logs;
  }
  const ids = new Set([
    step.id,
    ...flattenSteps(step.children).map((entry) => entry.step.id),
  ]);
  return logs.filter(
    (entry) => entry.stepId !== undefined && ids.has(entry.stepId)
  );
}

function crumb(
  label: string,
  selection: DashboardSelection,
  id?: string
): Breadcrumb<DashboardSelection> {
  return {
    ...(id === undefined ? {} : { id }),
    key: selectionKey(selection),
    label,
    selection,
  };
}

function runBreadcrumbs(
  run: RunSnapshot,
  path: readonly StepSnapshot[]
): Breadcrumb<DashboardSelection>[] {
  return [
    crumb(run.id, runSelection(run), "breadcrumb:run"),
    ...path.map((item) =>
      crumb(`› ${item.name}`, runSelection(run, { stepId: item.id }))
    ),
  ];
}

export function runTab(
  snapshot: DashboardSnapshot,
  run: RunSnapshot,
  path: readonly StepSnapshot[],
  tab: InspectorTab
): RunTabView {
  const step = path.at(-1);
  const subject = step ?? run;
  switch (tab) {
    case "overview":
      return {
        kind: "overview",
        overview: step
          ? { kind: "step", step: stepOverview(run, step) }
          : { kind: "run", run: runOverview(snapshot, run) },
      };
    case "input":
      return {
        kind: "input",
        ...(subject.input === undefined ? {} : { input: subject.input }),
      };
    case "output":
      return {
        kind: "output",
        ...(subject.error === undefined ? {} : { error: subject.error }),
        ...(subject.result === undefined ? {} : { output: subject.result }),
      };
    case "logs":
      return { kind: "logs", logs: runLogs(run, step) };
    default:
      return { kind: "stream" };
  }
}

export function catalogConfiguration(
  configuration: JsonValue | undefined,
  expanded: boolean
): ConfigurationView | undefined {
  if (configuration === undefined) {
    return undefined;
  }
  return expanded
    ? { expanded, text: JSON.stringify(configuration, null, 2) }
    : { expanded };
}

function triggerFacts(
  snapshot: DashboardSnapshot,
  trigger: TriggerSnapshot
): Fact[] {
  return [
    {
      key: "Target",
      value:
        snapshot.definitions.find((entry) => entry.id === trigger.targetId)
          ?.name ?? trigger.targetId,
    },
    { key: "Status", value: trigger.status },
    ...(trigger.owner ? [{ key: "Owner", value: trigger.owner }] : []),
    ...(trigger.lifetime ? [{ key: "Lifetime", value: trigger.lifetime }] : []),
    { key: "Next", value: trigger.next ?? "Waiting for an event" },
  ];
}

function sourceLabel(definition: DefinitionSnapshot): string {
  const { origin } = definition;
  if (!origin) {
    return "Not recorded";
  }
  return `${origin.source}${origin.external ? " (outside the workspace root)" : ""}`;
}

function definitionFacts(
  snapshot: DashboardSnapshot,
  definition: DefinitionSnapshot
): Fact[] {
  const rootUsage = snapshot.usage?.byWorkflow.find(
    (group) => group.id === definition.id
  )?.total;
  const emptyUsage = snapshot.usage
    ? "no usage recorded for runs started here"
    : "usage unavailable";
  return [
    { key: "Workspace", value: snapshot.workspace },
    { key: "Source", value: sourceLabel(definition) },
    { key: "Available", value: `throughout ${snapshot.workspace}` },
    { key: "Cost", value: rootUsage ? costLabel(rootUsage) : emptyUsage },
    { key: "Tokens", value: rootUsage ? tokensLabel(rootUsage) : emptyUsage },
    {
      key: "Covers",
      value: `runs started from ${definition.name}; inside other runs its usage counts under their steps`,
    },
  ];
}

function catalogDetails(
  snapshot: DashboardSnapshot,
  item: TriggerSnapshot | DefinitionSnapshot,
  filter: CatalogSelection,
  facts: readonly Fact[]
): CatalogDetailsView<DashboardSelection, CatalogSelection> {
  return {
    description: item.description,
    facts,
    filter,
    id: item.id,
    runs: scopedRuns(snapshot, filter).map((run) => {
      const selection = runSelection(run);
      return {
        key: selectionKey(selection),
        runId: run.id,
        selection,
        status: statusDisplay(run),
      };
    }),
  };
}

function catalogTitle(item: TriggerSnapshot | DefinitionSnapshot): string {
  return `${item.kind[0]?.toUpperCase() ?? ""}${item.kind.slice(1)} / ${item.name}`;
}

function triggerSubject(
  snapshot: DashboardSnapshot,
  trigger: TriggerSnapshot
): InspectorSubject {
  const { configuration } = trigger;
  return {
    ...(configuration === undefined ? {} : { configuration }),
    details: catalogDetails(
      snapshot,
      trigger,
      triggerSelection(trigger),
      triggerFacts(snapshot, trigger)
    ),
    kind: "catalog",
    launchable: false,
    runNow: canRunSchedule(trigger),
    title: catalogTitle(trigger),
  };
}

function definitionSubject(
  snapshot: DashboardSnapshot,
  definition: DefinitionSnapshot
): InspectorSubject {
  return {
    details: catalogDetails(
      snapshot,
      definition,
      { id: definition.id, kind: "definition" },
      definitionFacts(snapshot, definition)
    ),
    kind: "catalog",
    launchable: true,
    runNow: false,
    title: catalogTitle(definition),
  };
}

const WORK_INPUT_HINT = {
  none: "· output only",
  stdin: "· s input: a line to its stdin, not a terminal",
  steer: "· s steer: interrupts the turn with your prompt",
} as const;

function liveWorkItems(
  run: RunSnapshot,
  path: readonly StepSnapshot[]
): readonly LiveWorkItem[] {
  const step = path.at(-1);
  return flattenSteps(step ? [step] : run.steps).flatMap(({ step: each }) =>
    (each.work ?? []).map((work) => ({
      attention: work.attention !== undefined,
      hint: work.attention
        ? `· ${statusDisplay({ attention: work.attention, status: "running" }).label} · i answer`
        : WORK_INPUT_HINT[work.input],
      id: work.id,
      kind: work.kind,
      label: `${workLabel(work)} in ${work.stepId}`,
    }))
  );
}

function runSubject(
  run: RunSnapshot,
  path: readonly StepSnapshot[]
): InspectorSubject {
  const step = path.at(-1);
  return {
    breadcrumbs: runBreadcrumbs(run, path),
    kind: "run",
    path,
    run,
    stream: {
      local: run.workspace === undefined,
      runId: run.id,
      ...(step === undefined ? {} : { stepId: step.id }),
    },
    title: step ? `Step / ${step.name}` : `Run / ${run.name}`,
    work: liveWorkItems(run, path),
  };
}

export function inspectorSubject(
  snapshot: DashboardSnapshot,
  resolved: ResolvedSelection
): InspectorSubject {
  switch (resolved.kind) {
    case "none":
      return {
        kind: "message",
        message: "Select a schedule, monitor, definition, run, or step.",
        title: DETAILS,
      };
    case "gone":
      return {
        kind: "message",
        message: goneMessage(resolved),
        title: DETAILS,
      };
    case "activity":
      return {
        activity: activityView(resolved.run, resolved.activity),
        kind: "activity",
        title: "Activity",
      };
    case "run":
      return runSubject(resolved.run, resolved.path);
    case "trigger":
      return triggerSubject(snapshot, resolved.trigger);
    default:
      return definitionSubject(snapshot, resolved.definition);
  }
}
