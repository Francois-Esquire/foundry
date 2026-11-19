import type { ReactNode } from "react";
import { BarChart } from "~/components/ui/bar-chart";
import { Panel } from "~/components/ui/panel";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import type { DashboardSnapshot } from "~/views/dashboard-model";
import {
  duration,
  operatingStats,
  workflowRankings,
} from "~/views/operating-model";
import {
  costCell,
  unattributedTurns,
  unreadableUsageRecords,
} from "~/views/usage-format";
import { CostTag } from "./cost-tag";

interface MetricValue {
  readonly color?: string;
  readonly detail: string;
  readonly label: string;
  readonly value: string | number;
}

function Metric({ label, value, detail, color }: MetricValue) {
  return (
    <box flexBasis={0} flexDirection="column" flexGrow={1} minWidth={0}>
      <text fg={theme.colors.mutedForeground} truncate wrapMode="none">
        {label}
      </text>
      <Text fg={color} truncate wrapMode="none">
        <strong>{value}</strong>
      </Text>
      <text fg={theme.colors.mutedForeground} truncate wrapMode="none">
        {detail}
      </text>
    </box>
  );
}

interface RankingRow {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly valueLabel: ReactNode;
  readonly valueWidth: number;
}

function Ranking({
  title,
  caption,
  empty,
  rows,
  limit,
  width,
  color,
}: {
  readonly title: string;
  readonly caption: string;
  readonly empty: string;
  readonly rows: readonly RankingRow[];
  readonly limit: number;
  readonly width: number;
  readonly color: string;
}) {
  return (
    <Panel title={title}>
      <text fg={theme.colors.mutedForeground} truncate wrapMode="none">
        {caption}
      </text>
      {rows.length === 0 && (
        <Text truncate wrapMode="none">
          {empty}
        </Text>
      )}
      <BarChart
        availableWidth={width}
        color={color}
        data={rows.slice(0, limit)}
      />
    </Panel>
  );
}

function WorkflowRankings({
  snapshot,
  limit,
  width,
}: {
  readonly snapshot: DashboardSnapshot;
  readonly limit: number;
  readonly width: number;
}) {
  const { elapsed, spend } = workflowRankings(snapshot);
  const chartWidth = Math.floor((width - 1) / 2) - 4;
  return (
    <box flexDirection="row" flexShrink={0} gap={1} height={limit + 3}>
      <Ranking
        caption="USD · ~ estimated · +? partial"
        color={theme.colors.accent}
        empty="No priced workflow usage"
        limit={limit}
        rows={spend.map(({ id, name, amount, cost }) => {
          const price = costCell(cost);
          return {
            id,
            label: name,
            value: amount,
            valueLabel: <CostTag value={price} />,
            valueWidth: price.length + 2,
          };
        })}
        title="Workflow spend"
        width={chartWidth}
      />
      <Ranking
        caption="Total elapsed · finished runs"
        color={theme.colors.info}
        empty="No finished workflow runs"
        limit={limit}
        rows={elapsed.map(({ id, name, ms, runs }) => {
          const timing = `${duration(ms)} · ${runs} ${runs === 1 ? "run" : "runs"}`;
          return {
            id,
            label: name,
            value: ms,
            valueLabel: (
              <Text fg={theme.colors.info} flexShrink={0} wrapMode="none">
                {timing}
              </Text>
            ),
            valueWidth: timing.length,
          };
        })}
        title="Workflow time"
        width={chartWidth}
      />
    </box>
  );
}

function metrics(
  snapshot: DashboardSnapshot,
  { counts, successRate }: ReturnType<typeof operatingStats>,
  compact: boolean
): readonly MetricValue[] {
  const { total } = snapshot.usage ?? {};
  const spend = costCell(total);
  const emptySpend = spend ? "Usage incomplete" : "No usage recorded";
  return [
    {
      color: theme.colors.info,
      detail: compact
        ? `${counts.running} running`
        : `${counts.running} running · ${counts.queued} queued`,
      label: "Active runs",
      value: counts.running + counts.queued,
    },
    {
      color:
        counts.failed + counts.waiting > 0 ? theme.colors.warning : undefined,
      detail: compact
        ? `${counts.failed} failed`
        : `${counts.failed} failed · ${counts.waiting} waiting`,
      label: "Needs attention",
      value: counts.failed + counts.waiting,
    },
    {
      color: theme.colors.success,
      detail: compact
        ? `${counts.complete} completed`
        : `${counts.complete} completed · ${counts.cancelled} cancelled`,
      label: "Success rate",
      value:
        successRate === undefined ? "—" : `${Math.round(successRate * 100)}%`,
    },
    {
      color: theme.colors.accent,
      detail:
        total && total.turns > 0
          ? `${total.turns} ${total.turns === 1 ? "turn" : "turns"}`
          : emptySpend,
      label: "Tracked spend",
      value: spend || "—",
    },
  ];
}

export function DashboardMetrics({
  snapshot,
  width,
  height,
}: {
  readonly snapshot: DashboardSnapshot;
  readonly width: number;
  readonly height: number;
}) {
  const stacked = width < 68 && height >= 22;
  const stats = operatingStats(snapshot.runs);
  const cards = metrics(snapshot, stats, !stacked && width < 106);
  const rows = stacked ? [cards.slice(0, 2), cards.slice(2)] : [cards];
  const limit = height >= 30 ? 3 : 2;
  const { medianRunMs, medianQueueMs } = stats;
  const { usage } = snapshot;
  const notes = [
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
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      gap={notes.length > 0 ? 0 : 1}
      paddingTop={height >= 26 ? 1 : 0}
    >
      {rows.map((row) => (
        <box flexDirection="row" gap={2} key={row[0]?.label} paddingX={1}>
          {row.map((metric) => (
            <Metric {...metric} key={metric.label} />
          ))}
        </box>
      ))}
      {notes.length > 0 && (
        <text fg={theme.colors.mutedForeground} marginLeft={1} wrapMode="word">
          {notes.join(" · ")}
        </text>
      )}
      {width >= 64 && height >= 22 && (
        <WorkflowRankings limit={limit} snapshot={snapshot} width={width} />
      )}
    </box>
  );
}
