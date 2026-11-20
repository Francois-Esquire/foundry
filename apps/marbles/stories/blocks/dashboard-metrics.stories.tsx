import { defineStories, story } from "textbook-sh";
import {
  dashboardMetrics,
  workflowRankingsView,
} from "~/cli/state/dashboard-metrics";
import type {
  DashboardSnapshot,
  RunSnapshot,
} from "~/cli/state/dashboard-model";
import {
  DashboardMetrics,
  showsWorkflowRankings,
} from "~/components/blocks/dashboard-metrics";
import type { UsageTotal } from "~/model/usage";
import { dashboardSnapshot } from "../fixtures/snapshot";
import { renderFrame } from "../frame";

function finishedRun(
  id: string,
  definitionId: string,
  name: string,
  seconds: number
): RunSnapshot {
  const startedAt = Date.parse("2026-09-22T13:00:00.000Z");
  return {
    definitionId,
    elapsed: `${seconds}s`,
    id,
    name,
    started: "13:00:00",
    status: "complete",
    steps: [],
    timing: {
      createdAt: startedAt,
      endedAt: startedAt + seconds * 1000,
      startedAt,
    },
  };
}

function spent(amount: number): UsageTotal {
  return {
    estimated: [{ amount, currency: "USD" }],
    missing: 0,
    reported: [],
    tokens: {
      cachedInput: 0,
      cacheWrite: 0,
      input: 10_000,
      output: 1000,
      total: 11_000,
    },
    turns: 2,
    unattributed: 0,
    unpriced: 0,
    unreadable: 0,
    untokened: 0,
  };
}

const busy: DashboardSnapshot = {
  ...dashboardSnapshot,
  definitions: [
    ...dashboardSnapshot.definitions,
    {
      description: "Draft the release notes.",
      id: "release",
      kind: "workflow",
      name: "draft-release-notes",
    },
  ],
  runs: [
    ...dashboardSnapshot.runs,
    finishedRun("run-101", "summary", "summarize-day", 95),
    finishedRun("run-100", "release", "draft-release-notes", 64),
    finishedRun("run-099", "docs", "update-documentation", 30),
  ],
  usage: dashboardSnapshot.usage && {
    ...dashboardSnapshot.usage,
    byWorkflow: [
      ...dashboardSnapshot.usage.byWorkflow,
      { id: "summary", total: spent(0.0712) },
      { id: "release", total: spent(0.0233) },
    ],
  },
};

function Metrics({
  height,
  rankings,
  snapshot = dashboardSnapshot,
  width,
}: {
  readonly height: number;
  readonly rankings?: "empty";
  readonly snapshot?: DashboardSnapshot;
  readonly width: number;
}) {
  let shown: ReturnType<typeof workflowRankingsView> | undefined;
  if (rankings === "empty") {
    shown = { elapsed: [], spend: [] };
  } else if (showsWorkflowRankings(width, height)) {
    shown = workflowRankingsView(snapshot);
  }
  return (
    <DashboardMetrics
      height={height}
      metrics={dashboardMetrics(snapshot)}
      width={width}
      {...(shown ? { rankings: shown } : {})}
    />
  );
}

function metricsStory(width: number, height: number) {
  return { height, padded: false, width };
}

const quiet: DashboardSnapshot = {
  ...dashboardSnapshot,
  runs: [],
  usage: undefined,
};

const partialUsage: DashboardSnapshot = {
  ...dashboardSnapshot,
  usage: dashboardSnapshot.usage && {
    ...dashboardSnapshot.usage,
    recovered: 2,
    unattributed: 1,
    unreadable: 3,
    unsaved: 1,
  },
};

export default defineStories({
  component: "DashboardMetrics",
  description:
    "The overview's metric cards, notes, and workflow spend and time rankings, laid out by the size it is given.",
  title: "Blocks/DashboardMetrics",
});

export const Wide = story({
  description:
    "A large terminal: full card details, top padding, and the top three workflows in each ranking.",
  name: "Wide",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Metrics height={30} snapshot={busy} width={120} />,
      metricsStory(120, 30)
    ),
});

export const Medium = story({
  description:
    "Under 106 columns and 30 rows: card details shorten, each ranking shows its top two, and a ranking short of room draws a shorter bar.",
  name: "Medium",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Metrics height={24} snapshot={busy} width={90} />,
      metricsStory(90, 24)
    ),
});

export const Stacked = story({
  description:
    "Under 68 columns and at least 22 rows the cards stack two by two; under 64 columns the rankings are hidden too.",
  name: "Stacked",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Metrics height={24} width={60} />,
      metricsStory(60, 24)
    ),
});

export const Short = story({
  description:
    "Fewer than 22 rows: one compact row of cards and notes, no rankings.",
  name: "Short",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Metrics height={12} width={100} />,
      metricsStory(100, 12)
    ),
});

export const Quiet = story({
  description:
    "No runs and no usage: zero counts, no success rate, no notes, and empty rankings.",
  name: "Quiet",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Metrics height={26} snapshot={quiet} width={110} />,
      metricsStory(110, 26)
    ),
});

export const EmptyRankings = story({
  description:
    "Runs with no priced usage or finished workflows: both rankings show their empty text.",
  name: "Empty rankings",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Metrics height={26} rankings="empty" width={110} />,
      metricsStory(110, 26)
    ),
});

export const PartialUsage = story({
  description:
    "Unreadable, recovered, unattributed, and unsaved usage each add a note.",
  name: "Partial usage notes",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Metrics height={26} snapshot={partialUsage} width={110} />,
      metricsStory(110, 26)
    ),
});
