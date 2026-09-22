import {
  type DashboardSelection,
  type DashboardSnapshot,
  flattenSteps,
  type RunSnapshot,
  type StepSnapshot,
  selectionKey,
} from "./dashboard-model";

export type CatalogSelection = Exclude<DashboardSelection, { kind: "run" }>;

export interface RunRow {
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
        ...flattenSteps(run.steps).map(
          ({ step }) => `${step.name} ${step.id} ${step.status}`
        ),
      ].join(" "),
      query
    )
  );
}

function stepRows(
  runId: string,
  steps: readonly StepSnapshot[],
  expanded: ReadonlySet<string>,
  reveal: boolean,
  depth = 1
): RunRow[] {
  return steps.flatMap((step) => {
    const selection: DashboardSelection = {
      id: runId,
      kind: "run",
      stepId: step.id,
    };
    const open = reveal || expanded.has(selectionKey(selection));
    return [
      {
        branch: step.children.length > 0,
        depth,
        elapsed: step.elapsed ?? "",
        expanded: open,
        name: step.name,
        selection,
        status: step.status,
      },
      ...(open
        ? stepRows(runId, step.children, expanded, reveal, depth + 1)
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
    return [
      {
        branch: run.steps.length > 0,
        depth: 0,
        elapsed: run.elapsed,
        expanded: open,
        name: run.name,
        selection,
        status: run.status,
      },
      ...(open ? stepRows(run.id, run.steps, expanded, reveal) : []),
    ];
  });
}

export function expandedRun(run: RunSnapshot): string[] {
  return [
    selectionKey({ id: run.id, kind: "run" }),
    ...flattenSteps(run.steps).map(({ step }) =>
      selectionKey({ id: run.id, kind: "run", stepId: step.id })
    ),
  ];
}
