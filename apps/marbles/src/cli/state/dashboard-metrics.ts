import type { DashboardMetricsView } from "~/components/blocks/dashboard-metrics";
import type { WorkspaceUsage } from "~/model/usage";
import type { DashboardSnapshot } from "./dashboard-model";
import {
  duration,
  type OperatingStats,
  operatingStats,
  workflowRankings,
} from "./operating-model";
import {
  costCell,
  costView,
  unattributedTurns,
  unreadableUsageRecords,
} from "./usage-format";

function successRate({ successRate: rate }: OperatingStats): string {
  return rate === undefined ? "—" : `${Math.round(rate * 100)}%`;
}

function trackedSpend(
  usage: WorkspaceUsage | undefined
): DashboardMetricsView["spend"] {
  const { total } = usage ?? {};
  const spend = costCell(total);
  const emptySpend = spend ? "Usage incomplete" : "No usage recorded";
  return {
    detail:
      total && total.turns > 0
        ? `${total.turns} ${total.turns === 1 ? "turn" : "turns"}`
        : emptySpend,
    value: spend || "—",
  };
}

function metricNotes(
  { medianRunMs, medianQueueMs }: OperatingStats,
  usage: WorkspaceUsage | undefined
): string[] {
  return [
    ...(medianRunMs === undefined
      ? []
      : [`Median run ${duration(medianRunMs)}`]),
    ...(medianQueueMs === undefined
      ? []
      : [`Median wait ${duration(medianQueueMs)}`]),
    ...(usage?.unreadable
      ? [`${unreadableUsageRecords(usage.unreadable)}, totals partial`]
      : []),
    ...(usage?.recovered
      ? [`${usage.recovered} turns recovered from transcripts`]
      : []),
    ...(usage?.unattributed
      ? [`${unattributedTurns(usage.unattributed)}`]
      : []),
    ...(usage?.unsaved
      ? [`${usage.unsaved} unsaved turn${usage.unsaved === 1 ? "" : "s"}`]
      : []),
  ];
}

function rankings(
  snapshot: DashboardSnapshot
): DashboardMetricsView["rankings"] {
  const { elapsed, spend } = workflowRankings(snapshot);
  return {
    elapsed: elapsed.map(({ id, name, ms, runs }) => ({
      id,
      ms,
      name,
      timing: `${duration(ms)} · ${runs} ${runs === 1 ? "run" : "runs"}`,
    })),
    spend: spend.map(({ id, name, amount, cost }) => ({
      amount,
      cost: costView(costCell(cost)),
      id,
      name,
    })),
  };
}

export function dashboardMetrics(
  snapshot: DashboardSnapshot
): DashboardMetricsView {
  const stats = operatingStats(snapshot.runs);
  return {
    counts: stats.counts,
    notes: metricNotes(stats, snapshot.usage),
    rankings: rankings(snapshot),
    spend: trackedSpend(snapshot.usage),
    successRate: successRate(stats),
  };
}
