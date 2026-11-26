import type {
  DashboardSnapshot,
  DefinitionSnapshot,
  HarnessActivitySnapshot,
  RunSnapshot,
  StepSnapshot,
  TriggerSnapshot,
} from "~/model/dashboard";

export type {
  DashboardSnapshot,
  DefinitionSnapshot,
  HarnessActivitySnapshot,
  LiveWorkSnapshot,
  RunSnapshot,
  StepSnapshot,
  TriggerSnapshot,
} from "~/model/dashboard";

export type DashboardSelection =
  | {
      readonly kind: "trigger";
      readonly id: string;
      readonly workspace?: string;
    }
  | { readonly kind: "definition"; readonly id: string }
  | {
      readonly kind: "run";
      readonly id: string;
      readonly workspace?: string;
      readonly stepId?: string;
      readonly activityId?: string;
      readonly sessionId?: string;
    };

interface Owned {
  readonly id: string;
  readonly workspace?: { readonly id: string };
}

export function isSelected(
  item: Owned,
  selection: { readonly id: string; readonly workspace?: string }
): boolean {
  return item.id === selection.id && item.workspace?.id === selection.workspace;
}

export function runSelection(
  run: Owned,
  within: Pick<
    Extract<DashboardSelection, { kind: "run" }>,
    "activityId" | "sessionId" | "stepId"
  > = {}
): Extract<DashboardSelection, { kind: "run" }> {
  return {
    id: run.id,
    kind: "run",
    ...(run.workspace === undefined ? {} : { workspace: run.workspace.id }),
    ...within,
  };
}

export function triggerSelection(
  trigger: Owned
): Extract<DashboardSelection, { kind: "trigger" }> {
  return {
    id: trigger.id,
    kind: "trigger",
    ...(trigger.workspace === undefined
      ? {}
      : { workspace: trigger.workspace.id }),
  };
}

export type ResolvedSelection =
  | { readonly kind: "none" }
  | {
      readonly kind: "gone";
      readonly selection: DashboardSelection;
      readonly run?: RunSnapshot;
    }
  | { readonly kind: "trigger"; readonly trigger: TriggerSnapshot }
  | { readonly kind: "definition"; readonly definition: DefinitionSnapshot }
  | {
      readonly kind: "run";
      readonly run: RunSnapshot;
      readonly path: readonly StepSnapshot[];
    }
  | {
      readonly kind: "activity";
      readonly run: RunSnapshot;
      readonly activity: HarnessActivitySnapshot;
    };

export function flattenSteps(
  steps: readonly StepSnapshot[],
  depth = 0
): { step: StepSnapshot; depth: number }[] {
  return steps.flatMap((step) => [
    { depth, step },
    ...flattenSteps(step.children, depth + 1),
  ]);
}

export function selectionKey(selection: DashboardSelection): string {
  if (selection.kind === "definition") {
    return JSON.stringify([selection.kind, selection.id]);
  }
  if (selection.kind === "trigger") {
    return JSON.stringify([
      selection.kind,
      selection.workspace ?? null,
      selection.id,
    ]);
  }
  return JSON.stringify([
    selection.kind,
    selection.workspace ?? null,
    selection.id,
    selection.stepId ?? null,
    selection.sessionId ?? null,
    selection.activityId ?? null,
  ]);
}

function stepPath(
  steps: readonly StepSnapshot[],
  id: string
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

function resolveRun(
  run: RunSnapshot,
  selection: Extract<DashboardSelection, { kind: "run" }>
): ResolvedSelection {
  if (selection.activityId !== undefined) {
    const activity = run.activities?.find(
      (item) =>
        item.id === selection.activityId &&
        item.sessionId === selection.sessionId
    );
    return activity
      ? { activity, kind: "activity", run }
      : { kind: "gone", run, selection };
  }
  if (selection.stepId === undefined) {
    return { kind: "run", path: [], run };
  }
  const path = stepPath(run.steps, selection.stepId);
  return path.length
    ? { kind: "run", path, run }
    : { kind: "gone", run, selection };
}

export function resolveSelection(
  snapshot: DashboardSnapshot,
  selection: DashboardSelection | undefined
): ResolvedSelection {
  if (!selection) {
    return { kind: "none" };
  }
  if (selection.kind === "trigger") {
    const trigger = snapshot.triggers.find((item) =>
      isSelected(item, selection)
    );
    return trigger ? { kind: "trigger", trigger } : { kind: "gone", selection };
  }
  if (selection.kind === "definition") {
    const definition = snapshot.definitions.find(
      (item) => item.id === selection.id
    );
    return definition
      ? { definition, kind: "definition" }
      : { kind: "gone", selection };
  }
  const run = snapshot.runs.find((item) => isSelected(item, selection));
  return run ? resolveRun(run, selection) : { kind: "gone", selection };
}

export function actionTarget(
  resolved: Extract<ResolvedSelection, { kind: "run" }>
): { readonly stepId: string; readonly status: string } {
  const step = resolved.path.at(-1);
  return step
    ? { status: step.status, stepId: step.id }
    : { status: resolved.run.status, stepId: resolved.run.definitionId };
}

export function underSelection(
  resolved: Extract<ResolvedSelection, { kind: "run" }>
): readonly StepSnapshot[] {
  const step = resolved.path.at(-1);
  return flattenSteps(step ? [step] : resolved.run.steps).map(
    (entry) => entry.step
  );
}

export function canStopActivity(activity: HarnessActivitySnapshot): boolean {
  return (
    activity.actions?.includes("stop") === true &&
    (activity.status === "running" || activity.status === "waiting")
  );
}
