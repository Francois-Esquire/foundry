import { UsageBreakdown } from "~/components/blocks/operating-overview";
import { CatalogLayout } from "~/components/layouts/catalog";
import type { RunActions } from "../state/run-actions";
import { usageBreakdown } from "../state/usage-format";
import type { Dashboard } from "../state/use-dashboard";
import { DashboardCatalog } from "./dashboard-catalog";
import { DashboardOverview } from "./dashboard-overview";
import { FeedView } from "./feed";
import { Inspector } from "./inspector";

type MainDashboard = Pick<
  Dashboard,
  | "changeTab"
  | "clearFilters"
  | "definitions"
  | "feed"
  | "filterRuns"
  | "inspect"
  | "pane"
  | "resolved"
  | "rows"
  | "snapshot"
  | "state"
  | "toggle"
  | "toggleConfiguration"
  | "triggers"
>;

interface MainProps {
  readonly dashboard: MainDashboard;
  readonly height: number;
  readonly inputActive: boolean;
  readonly onLaunch?: (id: string) => void;
  readonly onRollSchedule?: (key: string) => void;
  readonly stream?: RunActions["stream"];
  readonly wide: boolean;
  readonly width: number;
}

function DashboardBrowser({
  dashboard,
  inputActive,
  width,
  wide,
  height,
  onLaunch,
  onRollSchedule,
  stream,
}: MainProps) {
  const { state, snapshot } = dashboard;
  const activePane = inputActive ? undefined : dashboard.pane;
  const details =
    dashboard.pane === "details" ? (
      <Inspector
        active={activePane === "details"}
        configuration={state.configuration}
        onFilter={dashboard.filterRuns}
        onInspect={dashboard.inspect}
        onLaunch={onLaunch}
        onRollSchedule={onRollSchedule}
        onTab={dashboard.changeTab}
        onToggleConfiguration={dashboard.toggleConfiguration}
        resolved={dashboard.resolved}
        selection={state.selected}
        snapshot={snapshot}
        stream={stream}
        tab={state.tab}
      />
    ) : undefined;
  if (details && !(wide && state.view === "catalog")) {
    return details;
  }
  if (state.breakdown) {
    return (
      <UsageBreakdown
        active={!inputActive}
        usage={snapshot.usage && usageBreakdown(snapshot.usage)}
      />
    );
  }
  if (state.view === "catalog") {
    return (
      <CatalogLayout
        catalog={
          <DashboardCatalog
            activePane={activePane}
            besideDetails={details !== undefined}
            dashboard={dashboard}
            width={width}
          />
        }
        details={details}
      />
    );
  }
  return (
    <DashboardOverview
      activePane={activePane}
      dashboard={dashboard}
      height={height}
      wide={wide}
      width={width}
    />
  );
}

export function DashboardMain(props: MainProps) {
  const { dashboard, inputActive, width } = props;
  if (dashboard.state.view === "feed") {
    return (
      <FeedView feed={dashboard.feed} inputActive={inputActive} width={width} />
    );
  }
  return <DashboardBrowser {...props} />;
}
