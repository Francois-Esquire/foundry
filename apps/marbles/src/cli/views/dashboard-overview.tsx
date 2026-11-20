import { DashboardMetrics } from "~/components/blocks/dashboard-metrics";
import {
  LatestBlock,
  OverviewPanels,
} from "~/components/blocks/operating-overview";
import { RunsBlock } from "~/components/blocks/runs";
import { Action } from "~/components/ui/action";
import { dashboardMetrics } from "../state/dashboard-metrics";
import { selectionKey, triggerSelection } from "../state/dashboard-model";
import {
  describeFilter,
  latestRows,
  runListRows,
} from "../state/dashboard-rows";
import type { Pane } from "../state/dashboard-state";
import { latestActivity, nextSchedule } from "../state/operating-model";
import type { Dashboard } from "../state/use-dashboard";

const LATEST_ITEMS = 12;

export function DashboardOverview({
  dashboard,
  activePane,
  width,
  height,
  wide,
}: {
  readonly dashboard: Pick<
    Dashboard,
    "clearFilters" | "inspect" | "rows" | "snapshot" | "state" | "toggle"
  >;
  readonly activePane?: Pane;
  readonly width: number;
  readonly height: number;
  readonly wide: boolean;
}) {
  const { snapshot, state } = dashboard;
  const next = nextSchedule(snapshot.triggers);
  return (
    <>
      <DashboardMetrics
        height={height}
        metrics={dashboardMetrics(snapshot)}
        width={width}
      />
      {next && (
        <box flexShrink={0} paddingLeft={1}>
          <Action
            label={`Up next · ${next.name} · ${next.next}`}
            onAction={dashboard.inspect}
            value={triggerSelection(next)}
          />
        </box>
      )}
      <OverviewPanels
        latest={
          <LatestBlock
            items={latestRows(latestActivity(snapshot, LATEST_ITEMS))}
            onSelect={dashboard.inspect}
          />
        }
        runs={
          <RunsBlock
            active={activePane === "run"}
            filtered={Boolean(state.filter || state.queries.run)}
            filterLabel={describeFilter(snapshot, state.filter)}
            onReset={dashboard.clearFilters}
            onSelect={dashboard.inspect}
            onToggle={dashboard.toggle}
            rows={runListRows(dashboard.rows, state.selected)}
            selectedId={state.selected && selectionKey(state.selected)}
            triggerCount={snapshot.triggers.length}
          />
        }
        wide={wide}
      />
    </>
  );
}
