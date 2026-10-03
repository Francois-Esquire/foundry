import {
  type DashboardSelection,
  type DashboardSnapshot,
  flattenSteps,
  type HarnessActivitySnapshot,
  type InputAttention,
  type RunSnapshot,
  type StepSnapshot,
  selectionKey,
} from "./dashboard-model";

export type CatalogSelection = Exclude<DashboardSelection, { kind: "run" }>;

export interface RunRow {
  readonly attention?: InputAttention;
  readonly branch: boolean;
  readonly depth: number;
  readonly elapsed: string;
  readonly expanded: boolean;
  readonly name: string;
  readonly selection: DashboardSelection;
  readonly status: string;
}

export function scopedRuns(
  snapshot: DashboardSnapshot,
  filter?: CatalogSelection
): readonly RunSnapshot[] {
  if (!filter) {
    return snapshot.runs;
  }
  return snapshot.runs.filter((run) =>
    filter.kind === "trigger"
      ? run.triggerId === filter.id
      : run.definitionId === filter.id
  );
}

export function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.trim().toLowerCase());
}

export function matchingRuns(
  runs: readonly RunSnapshot[],
  query: string
): readonly RunSnapshot[] {
  return runs.filter((run) =>
    matches(
      [
        run.name,
        run.id,
        run.status,
        ...(run.activities ?? []).map(
          (activity) =>
            `${activity.title} ${activity.id} ${activity.status} ${activity.kind}`
        ),
        ...flattenSteps(run.steps).map(
          ({ step }) => `${step.name} ${step.id} ${step.status}`
        ),
      ].join(" "),
      query
    )
  );
}

interface ActivityBranch {
  readonly activity: HarnessActivitySnapshot;
  readonly children: ActivityBranch[];
}

function activityKey(activity: HarnessActivitySnapshot): string {
  return JSON.stringify([activity.sessionId, activity.id]);
}

/** Missing parents and native cycles remain inspectable as independent roots. */
function activityRoots(run: RunSnapshot): ActivityBranch[] {
  const nodes = new Map(
    (run.activities ?? []).map((activity) => [
      activityKey(activity),
      { activity, children: [] as ActivityBranch[] },
    ])
  );
  const roots: ActivityBranch[] = [];
  for (const node of nodes.values()) {
    const parentKey =
      node.activity.parentId === undefined
        ? undefined
        : JSON.stringify([node.activity.sessionId, node.activity.parentId]);
    let parent = parentKey === undefined ? undefined : nodes.get(parentKey);
    const visited = new Set([activityKey(node.activity)]);
    let ancestor = parent;
    while (ancestor) {
      const key = activityKey(ancestor.activity);
      if (visited.has(key)) {
        parent = undefined;
        break;
      }
      visited.add(key);
      ancestor =
        ancestor.activity.parentId === undefined
          ? undefined
          : nodes.get(
              JSON.stringify([
                ancestor.activity.sessionId,
                ancestor.activity.parentId,
              ])
            );
    }
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function activityRows(
  runId: string,
  branches: readonly ActivityBranch[],
  expanded: ReadonlySet<string>,
  reveal: boolean,
  depth: number
): RunRow[] {
  return branches.flatMap(({ activity, children }) => {
    const selection: DashboardSelection = {
      activityId: activity.id,
      id: runId,
      kind: "run",
      sessionId: activity.sessionId,
    };
    const open = reveal || expanded.has(selectionKey(selection));
    return [
      {
        ...(activity.attention ? { attention: activity.attention } : {}),
        branch: children.length > 0,
        depth,
        elapsed: "",
        expanded: open,
        name: `${activity.kind}: ${activity.title}`,
        selection,
        status: activity.status,
      },
      ...(open
        ? activityRows(runId, children, expanded, reveal, depth + 1)
        : []),
    ];
  });
}

function stepRows(
  run: RunSnapshot,
  steps: readonly StepSnapshot[],
  roots: readonly ActivityBranch[],
  expanded: ReadonlySet<string>,
  reveal: boolean,
  depth = 1
): RunRow[] {
  return steps.flatMap((step) => {
    const selection: DashboardSelection = {
      id: run.id,
      kind: "run",
      stepId: step.id,
    };
    const owned = roots.filter((branch) => branch.activity.stepId === step.id);
    const open = reveal || expanded.has(selectionKey(selection));
    return [
      {
        ...(step.attention ? { attention: step.attention } : {}),
        branch: step.children.length > 0 || owned.length > 0,
        depth,
        elapsed: step.elapsed ?? "",
        expanded: open,
        name: step.name,
        selection,
        status: step.status,
      },
      ...(open
        ? [
            ...stepRows(run, step.children, roots, expanded, reveal, depth + 1),
            ...activityRows(run.id, owned, expanded, reveal, depth + 1),
          ]
        : []),
    ];
  });
}

export function runRows(
  runs: readonly RunSnapshot[],
  expanded: ReadonlySet<string>,
  reveal = false
): RunRow[] {
  return runs.flatMap((run) => {
    const selection: DashboardSelection = { id: run.id, kind: "run" };
    const open = reveal || expanded.has(selectionKey(selection));
    const roots = activityRoots(run);
    const stepIds = new Set(flattenSteps(run.steps).map(({ step }) => step.id));
    const unowned = roots.filter(
      (branch) =>
        !(branch.activity.stepId && stepIds.has(branch.activity.stepId))
    );
    return [
      {
        ...(run.attention ? { attention: run.attention } : {}),
        branch: run.steps.length > 0 || roots.length > 0,
        depth: 0,
        elapsed: run.elapsed,
        expanded: open,
        name: run.name,
        selection,
        status: run.status,
      },
      ...(open
        ? [
            ...stepRows(run, run.steps, roots, expanded, reveal),
            ...activityRows(run.id, unowned, expanded, reveal, 1),
          ]
        : []),
    ];
  });
}

export function expandedRun(run: RunSnapshot): string[] {
  return [
    selectionKey({ id: run.id, kind: "run" }),
    ...(run.activities ?? []).map((activity) =>
      selectionKey({
        activityId: activity.id,
        id: run.id,
        kind: "run",
        sessionId: activity.sessionId,
      })
    ),
    ...flattenSteps(run.steps).map(({ step }) =>
      selectionKey({ id: run.id, kind: "run", stepId: step.id })
    ),
  ];
}
