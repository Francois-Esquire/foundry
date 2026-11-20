import { useKeyboard } from "@opentui/react";
import { useCallback, useMemo, useState } from "react";
import { defineStories, story } from "textbook-sh";
import {
  type DashboardSelection,
  type RunSnapshot,
  selectionKey,
} from "~/cli/state/dashboard-model";
import { runListRows } from "~/cli/state/dashboard-rows";
import { expandedRun, runRows } from "~/cli/state/dashboard-tree";
import { RunsBlock } from "~/components/blocks/runs";
import { Text } from "~/components/ui/text";
import { dashboardSnapshot } from "../fixtures/snapshot";
import { ignore, renderFrame } from "../frame";
import { fixtureRun, scenarioSnapshot } from "./fixtures-b";

const size = { height: 14, width: 80 };

const sampleRuns = dashboardSnapshot.runs;
const docsRun = fixtureRun("run-104");

const waitingRun: RunSnapshot = {
  ...docsRun,
  attention: "approval",
  id: "run-105",
  name: "update-documentation",
  status: "suspended",
};

function rowsFor(
  runs: readonly RunSnapshot[],
  expanded: readonly string[],
  selected?: DashboardSelection
) {
  return runListRows(runRows(runs, new Set(expanded)), selected);
}

function StaticRuns({
  active = true,
  expanded = [],
  filterLabel,
  runs,
  selected,
}: {
  readonly active?: boolean;
  readonly expanded?: readonly string[];
  readonly filterLabel?: string;
  readonly runs: readonly RunSnapshot[];
  readonly selected?: DashboardSelection;
}) {
  return (
    <RunsBlock
      active={active}
      filtered={filterLabel !== undefined}
      filterLabel={filterLabel}
      onSelect={ignore}
      onToggle={ignore}
      rows={rowsFor(runs, expanded, selected)}
      selectedId={selected && selectionKey(selected)}
      triggerCount={dashboardSnapshot.triggers.length}
    />
  );
}

function BrowseRuns({
  initial = expandedRun(docsRun),
  runs = sampleRuns,
}: {
  readonly initial?: readonly string[];
  readonly runs?: readonly RunSnapshot[];
}) {
  const [expanded, setExpanded] = useState<readonly string[]>(initial);
  const [selected, setSelected] = useState<DashboardSelection | undefined>(
    runs[0] && { id: runs[0].id, kind: "run" }
  );
  const rows = useMemo(
    () => rowsFor(runs, expanded, selected),
    [runs, expanded, selected]
  );
  const toggle = useCallback((selection: DashboardSelection) => {
    const key = selectionKey(selection);
    setExpanded((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    );
  }, []);
  useKeyboard((key) => {
    const index = rows.findIndex((item) => item.selected);
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      const next = rows[index + (key.name === "down" ? 1 : -1)];
      if (next) {
        setSelected(next.selection);
      }
    }
    const row = rows[index];
    if (key.name === "space" && row?.branch) {
      key.preventDefault();
      toggle(row.selection);
    }
  });
  return (
    <RunsBlock
      active
      filtered={false}
      onSelect={setSelected}
      onToggle={toggle}
      rows={rows}
      selectedId={selected && selectionKey(selected)}
      triggerCount={dashboardSnapshot.triggers.length}
    />
  );
}

function ResettableFilter() {
  const [filtered, setFiltered] = useState(true);
  const reset = useCallback(() => setFiltered(false), []);
  const runs = filtered ? [] : sampleRuns;
  return (
    <>
      <Text>{filtered ? "Search runs: deploy" : "Filters cleared"}</Text>
      <RunsBlock
        active
        filtered={filtered}
        filterLabel={filtered ? "trigger: daily-summary" : undefined}
        onReset={reset}
        onSelect={ignore}
        onToggle={ignore}
        rows={rowsFor(runs, [])}
        triggerCount={dashboardSnapshot.triggers.length}
      />
    </>
  );
}

export default defineStories({
  component: "RunsBlock",
  description:
    "The Runs panel: each run as a row with its steps nested below, status, time, and cost.",
  title: "Blocks/RunsBlock",
});

export const Browse = story({
  description:
    "Up and Down select rows, Space or a click on the arrow folds a branch, a click selects.",
  name: "Browse",
  render: (renderer) => renderFrame(renderer, <BrowseRuns />, size),
});

export const Collapsed = story({
  description: "Every run folded, with the complete run selected.",
  name: "Collapsed",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StaticRuns
        runs={sampleRuns}
        selected={{ id: "run-102", kind: "run" }}
      />,
      size
    ),
});

export const SelectedStep = story({
  description: "A nested step selected inside an open run.",
  name: "Selected step",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StaticRuns
        expanded={expandedRun(docsRun)}
        runs={sampleRuns}
        selected={{ id: "run-104", kind: "run", stepId: "write" }}
      />,
      size
    ),
});

export const Inactive = story({
  description: "Without focus the border dims and no hints show.",
  name: "Inactive",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StaticRuns
        active={false}
        runs={sampleRuns}
        selected={{ id: "run-104", kind: "run" }}
      />,
      size
    ),
});

export const WaitingForInput = story({
  description: "A run waiting for approval shows a warning badge.",
  name: "Waiting for input",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StaticRuns
        runs={[waitingRun, ...sampleRuns]}
        selected={{ id: "run-105", kind: "run" }}
      />,
      size
    ),
});

export const FilteredRuns = story({
  description: "Runs filtered to one workflow, named in the title.",
  name: "Filtered",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StaticRuns
        expanded={expandedRun(docsRun)}
        filterLabel="workflow: update-documentation"
        runs={[docsRun]}
        selected={{ id: "run-104", kind: "run" }}
      />,
      size
    ),
});

export const NoRuns = story({
  description: "No runs and no triggers: suggests launching from Marbles.",
  name: "No runs",
  render: (renderer) =>
    renderFrame(
      renderer,
      <RunsBlock
        active
        filtered={false}
        onSelect={ignore}
        onToggle={ignore}
        rows={[]}
      />,
      size
    ),
});

export const WaitingForTrigger = story({
  description: "No runs yet, but triggers are configured.",
  name: "Waiting for a trigger",
  render: (renderer) =>
    renderFrame(
      renderer,
      <RunsBlock
        active
        filtered={false}
        onSelect={ignore}
        onToggle={ignore}
        rows={[]}
        triggerCount={dashboardSnapshot.triggers.length}
      />,
      size
    ),
});

export const NoMatches = story({
  description:
    "A filter that matches nothing; click the reset action to clear it.",
  name: "No matches",
  render: (renderer) => renderFrame(renderer, <ResettableFilter />, size),
});

export const LongHistory = story({
  description: "Forty runs scroll inside the panel; Up and Down follow.",
  name: "Long history",
  render: (renderer) =>
    renderFrame(
      renderer,
      <BrowseRuns initial={[]} runs={scenarioSnapshot("history").runs} />,
      size
    ),
});

export const DeepSteps = story({
  description: "Deeply nested steps indent one level each.",
  name: "Deep steps",
  render: (renderer) => {
    const { runs } = scenarioSnapshot("deep");
    return renderFrame(
      renderer,
      <BrowseRuns initial={runs.flatMap(expandedRun)} runs={runs} />,
      { height: 24, width: 90 }
    );
  },
});

export const DeepStepsNarrow = story({
  description:
    "In a narrow panel the indent stops growing once a deeper row would leave its name fewer than ten cells; deeper rows share that indent and every status stays whole.",
  name: "Deep steps, narrow",
  render: (renderer) => {
    const { runs } = scenarioSnapshot("deep");
    return renderFrame(
      renderer,
      <BrowseRuns initial={runs.flatMap(expandedRun)} runs={runs} />,
      { height: 20, width: 42 }
    );
  },
});

export const WaitingForInputNarrow = story({
  description:
    "When the full badge would leave the name fewer than ten cells, the badge shortens to what the run waits for.",
  name: "Waiting for input, narrow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StaticRuns
        runs={[waitingRun, ...sampleRuns]}
        selected={{ id: "run-105", kind: "run" }}
      />,
      { height: 10, width: 38 }
    ),
});

export const Narrow = story({
  description:
    "In a narrow panel each row stays on one line: the run id, cost and time drop in that order, then the name truncates.",
  name: "Narrow",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StaticRuns
        expanded={expandedRun(docsRun)}
        runs={sampleRuns}
        selected={{ id: "run-104", kind: "run" }}
      />,
      { height: 14, width: 40 }
    ),
});
