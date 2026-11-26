import type { Breadcrumb, RunTabView } from "~/components/blocks/run-inspector";
import type {
  RunOverviewView,
  StepOverviewView,
} from "~/components/blocks/run-overview";
import type { WorkspaceSummary } from "~/model/connection";
import {
  type DashboardSelection,
  type DashboardSnapshot,
  type RunSnapshot,
  resolveSelection,
  type StepSnapshot,
} from "~/tui/state/dashboard-model";
import type { InspectorTab } from "~/tui/state/dashboard-state";
import { inspectorSubject, runTab } from "~/tui/state/inspector";
import { previewScenarios } from "../fixtures/scenarios";
import { dashboardSnapshot } from "../fixtures/snapshot";

export function scenarioSnapshot(id: string): DashboardSnapshot {
  const frame = previewScenarios.find((scenario) => scenario.id === id)
    ?.frames[0];
  if (!frame) {
    throw new Error(`The stories need the ${id} preview scenario.`);
  }
  return frame;
}

export function fixtureRun(
  id: string,
  snapshot: DashboardSnapshot = dashboardSnapshot
): RunSnapshot {
  const run = snapshot.runs.find((item) => item.id === id);
  if (!run) {
    throw new Error(`The stories need the sample run ${id}.`);
  }
  return run;
}

interface InspectedRun {
  readonly breadcrumbs: readonly Breadcrumb<DashboardSelection>[];
  readonly path: readonly StepSnapshot[];
  readonly run: RunSnapshot;
}

export function inspectRun(
  selection: DashboardSelection,
  snapshot: DashboardSnapshot = dashboardSnapshot
): InspectedRun {
  const subject = inspectorSubject(
    snapshot,
    resolveSelection(snapshot, selection)
  );
  if (subject.kind !== "run") {
    throw new Error(`The stories cannot inspect ${selection.id} as a run.`);
  }
  return {
    breadcrumbs: subject.breadcrumbs,
    path: subject.path,
    run: subject.run,
  };
}

export function inspectedTab(
  selection: DashboardSelection,
  tab: InspectorTab,
  snapshot: DashboardSnapshot = dashboardSnapshot
): RunTabView {
  const { path, run } = inspectRun(selection, snapshot);
  return runTab(snapshot, run, path, tab);
}

export function runOverviewView(
  id: string,
  snapshot: DashboardSnapshot = dashboardSnapshot
): RunOverviewView {
  const body = inspectedTab({ id, kind: "run" }, "overview", snapshot);
  if (body.kind !== "overview" || body.overview.kind !== "run") {
    throw new Error(`The stories need an overview of run ${id}.`);
  }
  return body.overview.run;
}

export function stepOverviewView(
  id: string,
  stepId: string,
  snapshot: DashboardSnapshot = dashboardSnapshot
): StepOverviewView {
  const body = inspectedTab({ id, kind: "run", stepId }, "overview", snapshot);
  if (body.kind !== "overview" || body.overview.kind !== "step") {
    throw new Error(`The stories need an overview of step ${stepId}.`);
  }
  return body.overview.step;
}

export const workspaceSummaries: readonly WorkspaceSummary[] = [
  {
    config: ".foundry/marbles",
    id: "ws-foundry",
    pid: 4120,
    root: "/Users/sam/code/foundry",
    state: "ready",
  },
  {
    config: ".foundry/marbles",
    id: "ws-handbook",
    pid: 4120,
    root: "/Users/sam/code/handbook",
    state: "reloading",
  },
  {
    config: null,
    id: "ws-scratch",
    root: "/Users/sam/scratch",
    state: "starting",
  },
  {
    config: ".foundry/marbles",
    error: "Cannot load .foundry/marbles/index.ts: Unexpected token '}'",
    id: "ws-site",
    root: "/Users/sam/code/site",
    state: "failed",
  },
  {
    config: ".foundry/marbles",
    id: "ws-archive",
    root: "/Users/sam/code/archive",
    state: "stopped",
  },
];
