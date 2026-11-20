import type { ReactNode } from "react";
import { BarChart } from "~/components/ui/bar-chart";
import { Panel } from "~/components/ui/panel";
import { Text } from "~/components/ui/text";
import { theme } from "~/components/ui/theme";
import { CostTag, type CostView } from "./cost-tag";

interface RunCounts {
  readonly cancelled: number;
  readonly complete: number;
  readonly failed: number;
  readonly queued: number;
  readonly running: number;
  readonly waiting: number;
}

interface SpendRanking {
  readonly amount: number;
  readonly cost: CostView;
  readonly id: string;
  readonly name: string;
}

interface ElapsedRanking {
  readonly id: string;
  readonly ms: number;
  readonly name: string;
  readonly timing: string;
}

export interface WorkflowRankingsView {
  readonly elapsed: readonly ElapsedRanking[];
  readonly spend: readonly SpendRanking[];
}

export interface DashboardMetricsView {
  readonly counts: RunCounts;
  readonly notes: readonly string[];
  readonly spend: { readonly detail: string; readonly value: string };
  readonly successRate: string;
}

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

const PANEL_INSET = 4;

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
  rankings,
  limit,
  width,
}: {
  readonly rankings: WorkflowRankingsView;
  readonly limit: number;
  readonly width: number;
}) {
  const { elapsed, spend } = rankings;
  const spendWidth = Math.ceil((width - 1) / 2);
  const timeWidth = width - 1 - spendWidth;
  return (
    <box flexDirection="row" flexShrink={0} gap={1} height={limit + 3}>
      <box flexDirection="column" flexShrink={0} width={spendWidth}>
        <Ranking
          caption="USD · ~ estimated · +? partial"
          color={theme.colors.accent}
          empty="No priced workflow usage"
          limit={limit}
          rows={spend.map(({ id, name, amount, cost }) => ({
            id,
            label: name,
            value: amount,
            valueLabel: <CostTag cost={cost} />,
            valueWidth: cost.value.length + 2,
          }))}
          title="Workflow spend"
          width={spendWidth - PANEL_INSET}
        />
      </box>
      <box flexDirection="column" flexShrink={0} width={timeWidth}>
        <Ranking
          caption="Total elapsed · finished runs"
          color={theme.colors.info}
          empty="No finished workflow runs"
          limit={limit}
          rows={elapsed.map(({ id, name, ms, timing }) => ({
            id,
            label: name,
            value: ms,
            valueLabel: (
              <Text fg={theme.colors.info} flexShrink={0} wrapMode="none">
                {timing}
              </Text>
            ),
            valueWidth: timing.length,
          }))}
          title="Workflow time"
          width={timeWidth - PANEL_INSET}
        />
      </box>
    </box>
  );
}

function metricCards(
  { counts, spend, successRate }: DashboardMetricsView,
  compact: boolean
): readonly MetricValue[] {
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
      value: successRate,
    },
    {
      color: theme.colors.accent,
      detail: spend.detail,
      label: "Tracked spend",
      value: spend.value,
    },
  ];
}

export function showsWorkflowRankings(width: number, height: number): boolean {
  return width >= 64 && height >= 22;
}

export function DashboardMetrics({
  metrics,
  rankings,
  width,
  height,
}: {
  readonly metrics: DashboardMetricsView;
  readonly rankings?: WorkflowRankingsView;
  readonly width: number;
  readonly height: number;
}) {
  const stacked = width < 68 && height >= 22;
  const cards = metricCards(metrics, !stacked && width < 106);
  const rows = stacked ? [cards.slice(0, 2), cards.slice(2)] : [cards];
  const limit = height >= 30 ? 3 : 2;
  const { notes } = metrics;
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
      {rankings && (
        <WorkflowRankings limit={limit} rankings={rankings} width={width} />
      )}
    </box>
  );
}
