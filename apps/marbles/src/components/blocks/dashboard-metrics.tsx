import type { ReactNode } from "react";
import { BarChart, chartBarWidth } from "~/components/ui/bar-chart";
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

const FOUR_ACROSS = 68;
const CARD_GAP = 2;
const CARD_INSET = 2;

function fit(text: string, width: number): string {
  if (text.length <= width) {
    return text;
  }
  return width > 1 ? `${text.slice(0, width - 1).trimEnd()}…` : "";
}

function cardWidth(width: number, across: number): number {
  return Math.floor((width - CARD_INSET - CARD_GAP * (across - 1)) / across);
}

function Metric({
  label,
  value,
  detail,
  color,
  details,
  width,
}: MetricValue & { readonly details: boolean; readonly width: number }) {
  return (
    <box flexBasis={0} flexDirection="column" flexGrow={1} minWidth={0}>
      <text fg={theme.colors.mutedForeground} wrapMode="none">
        {fit(label, width)}
      </text>
      <Text fg={color} wrapMode="none">
        <strong>{fit(String(value), width)}</strong>
      </Text>
      {details && (
        <text fg={theme.colors.mutedForeground} wrapMode="none">
          {fit(detail, width)}
        </text>
      )}
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
  bars,
  width,
  color,
}: {
  readonly title: string;
  readonly caption: string;
  readonly empty: string;
  readonly rows: readonly RankingRow[];
  readonly bars: number | undefined;
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
        data={rows}
        maxBarWidth={bars}
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
  const spendRows = spend.slice(0, limit).map(({ id, name, amount, cost }) => ({
    id,
    label: name,
    value: amount,
    valueLabel: <CostTag cost={cost} />,
    valueWidth: cost.value.length + 2,
  }));
  const timeRows = elapsed.slice(0, limit).map(({ id, name, ms, timing }) => ({
    id,
    label: name,
    value: ms,
    valueLabel: (
      <Text fg={theme.colors.info} flexShrink={0} wrapMode="none">
        {timing}
      </Text>
    ),
    valueWidth: timing.length,
  }));
  const fits = [
    chartBarWidth(spendRows, spendWidth - PANEL_INSET),
    chartBarWidth(timeRows, timeWidth - PANEL_INSET),
  ].filter((room) => room !== undefined);
  const bars = fits.length > 0 ? Math.min(...fits) : undefined;
  return (
    <box flexDirection="row" flexShrink={0} gap={1} height={limit + 3}>
      <box flexDirection="column" flexShrink={0} width={spendWidth}>
        <Ranking
          bars={bars}
          caption="USD · ~ estimated · +? partial"
          color={theme.colors.accent}
          empty="No priced workflow usage"
          rows={spendRows}
          title="Workflow spend"
          width={spendWidth - PANEL_INSET}
        />
      </box>
      <box flexDirection="column" flexShrink={0} width={timeWidth}>
        <Ranking
          bars={bars}
          caption="Total elapsed · finished runs"
          color={theme.colors.info}
          empty="No finished workflow runs"
          rows={timeRows}
          title="Workflow time"
          width={timeWidth - PANEL_INSET}
        />
      </box>
    </box>
  );
}

function metricCards(
  { counts, spend, successRate }: DashboardMetricsView,
  full: boolean
): readonly MetricValue[] {
  return [
    {
      color: theme.colors.info,
      detail: full
        ? `${counts.running} running · ${counts.queued} queued`
        : `${counts.running} running`,
      label: "Active runs",
      value: counts.running + counts.queued,
    },
    {
      color:
        counts.failed + counts.waiting > 0 ? theme.colors.warning : undefined,
      detail: full
        ? `${counts.failed} failed · ${counts.waiting} waiting`
        : `${counts.failed} failed`,
      label: "Needs attention",
      value: counts.failed + counts.waiting,
    },
    {
      color: theme.colors.success,
      detail: full
        ? `${counts.complete} completed · ${counts.cancelled} cancelled`
        : `${counts.complete} completed`,
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
  return width >= FOUR_ACROSS && height >= 22;
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
  const stacked = width < FOUR_ACROSS;
  const card = cardWidth(width, stacked ? 2 : 4);
  const details = !stacked || height >= 22;
  const full = metricCards(metrics, true);
  const cards = full.every(({ detail }) => detail.length <= card)
    ? full
    : metricCards(metrics, false);
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
            <Metric
              {...metric}
              details={details}
              key={metric.label}
              width={card}
            />
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
