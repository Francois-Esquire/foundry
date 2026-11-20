import {
  DashboardMetrics,
  showsWorkflowRankings,
} from "~/components/blocks/dashboard-metrics";
import {
  LatestBlock,
  OverviewPanels,
} from "~/components/blocks/operating-overview";
import { RunsBlock } from "~/components/blocks/runs";
import { Action } from "~/components/ui/action";
import type { OverviewModel } from "../state/dashboard-views";

export function DashboardOverview({
  overview,
  width,
  height,
  wide,
}: {
  readonly overview: OverviewModel;
  readonly width: number;
  readonly height: number;
  readonly wide: boolean;
}) {
  const { next } = overview;
  return (
    <>
      <DashboardMetrics
        height={height}
        metrics={overview.metrics}
        rankings={
          showsWorkflowRankings(width, height)
            ? overview.rankWorkflows()
            : undefined
        }
        width={width}
      />
      {next && (
        <box flexShrink={0} paddingLeft={1}>
          <Action
            label={next.label}
            onAction={overview.onInspect}
            value={next.selection}
          />
        </box>
      )}
      <OverviewPanels
        latest={
          <LatestBlock items={overview.latest} onSelect={overview.onInspect} />
        }
        runs={
          <RunsBlock
            {...overview.runs}
            onReset={overview.onReset}
            onSelect={overview.onInspect}
            onToggle={overview.onToggle}
          />
        }
        wide={wide}
      />
    </>
  );
}
