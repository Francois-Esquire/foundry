import { expect, it } from "vitest";
import {
  dashboardMetrics,
  workflowRankingsView,
} from "~/tui/state/dashboard-metrics";
import type { DashboardSnapshot } from "~/tui/state/dashboard-model";
import { dashboardSnapshot } from "../stories/fixtures/snapshot";

const PERCENT = /^\d+%$/;

it("counts runs, rates success, and ranks workflows by spend and time", () => {
  const metrics = dashboardMetrics(dashboardSnapshot);
  expect(metrics.counts).toMatchObject({ failed: 1, running: 1 });
  expect(metrics.successRate).toMatch(PERCENT);
  expect(metrics.spend).toEqual({ detail: "7 turns", value: "~$0.1601+?" });
  const rankings = workflowRankingsView(dashboardSnapshot);
  expect(rankings.spend.map(({ id, cost }) => [id, cost])).toEqual([
    ["review", { priced: true, value: "~$0.1180" }],
    ["docs", { priced: true, value: "~$0.0421+?" }],
  ]);
  expect(rankings.elapsed[0]).toMatchObject({
    id: "review",
    timing: "41.0s · 1 run",
  });
});

it("reports missing usage and partial totals in its notes", () => {
  const empty: DashboardSnapshot = { ...dashboardSnapshot, runs: [] };
  const { usage } = dashboardSnapshot;
  if (!usage) {
    throw new Error("fixture has no usage");
  }
  expect(workflowRankingsView({ ...empty, usage: undefined })).toMatchObject({
    elapsed: [],
  });
  expect(dashboardMetrics({ ...empty, usage: undefined })).toMatchObject({
    notes: [],
    spend: { detail: "No usage recorded", value: "—" },
    successRate: "—",
  });
  expect(
    dashboardMetrics({
      ...empty,
      usage: {
        ...usage,
        recovered: 2,
        unattributed: 1,
        unreadable: 1,
        unsaved: 1,
      },
    }).notes
  ).toEqual([
    "1 unreadable usage record, totals partial",
    "2 turns recovered from transcripts",
    "1 unattributed turn",
    "1 unsaved turn",
  ]);
});
