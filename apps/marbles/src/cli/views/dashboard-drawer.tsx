import { LogsBlock } from "~/components/blocks/logs-panel";
import { SearchBar } from "~/components/blocks/search-bar";
import { SettingsBlock } from "~/components/blocks/settings-panel";
import { WorkspacesPanel } from "~/components/blocks/workspaces-panel";
import type { DrawerDock } from "~/components/layouts/dashboard";
import { Text } from "~/components/ui/text";
import { logLines, workspaceRows } from "../state/dashboard-rows";
import type { DashboardState } from "../state/dashboard-state";
import type { Dashboard } from "../state/use-dashboard";
import { settingsView } from "../theme";

export function drawerDock(
  state: Pick<DashboardState, "drawer" | "picker">
): DrawerDock | undefined {
  if (state.picker !== undefined) {
    return "left";
  }
  return state.drawer === "settings" ? "right" : undefined;
}

type LogsDashboard = Pick<
  Dashboard,
  | "finishSearch"
  | "inputActive"
  | "log"
  | "logTotal"
  | "logs"
  | "openLog"
  | "quit"
  | "setQuery"
  | "state"
>;

function LogsDrawer({ dashboard }: { readonly dashboard: LogsDashboard }) {
  const { state } = dashboard;
  return (
    <>
      <SearchBar
        editing={state.searching}
        focused={!dashboard.quit.quitting}
        onInput={dashboard.setQuery}
        onSubmit={dashboard.finishSearch}
        query={state.logs.query}
        scope="logs"
      />
      {state.logs.runId && <Text>Run {state.logs.runId} · x clear</Text>}
      <LogsBlock
        active={!dashboard.inputActive}
        filters={state.logs}
        lines={logLines(dashboard.logs)}
        onSelect={dashboard.openLog}
        selectedId={dashboard.log?.id}
        total={dashboard.logTotal}
      />
    </>
  );
}

export function DashboardDrawer({
  dashboard,
  rail,
  onRail,
  editable,
}: {
  readonly dashboard: LogsDashboard &
    Pick<
      Dashboard,
      "changeTheme" | "chooseWorkspace" | "snapshot" | "workspaces"
    >;
  readonly rail: boolean;
  readonly onRail: (show: boolean) => void;
  readonly editable: boolean;
}) {
  const { state, snapshot } = dashboard;
  if (state.picker !== undefined) {
    return (
      <WorkspacesPanel
        current={snapshot.workspaceId}
        onSelect={dashboard.chooseWorkspace}
        selected={state.picker}
        workspaces={workspaceRows(dashboard.workspaces)}
      />
    );
  }
  if (state.drawer === "settings") {
    return (
      <SettingsBlock
        onRail={dashboard.workspaces.length ? onRail : undefined}
        onTheme={editable ? dashboard.changeTheme : undefined}
        rail={rail}
        settings={snapshot.settings && settingsView(snapshot.settings)}
      />
    );
  }
  return <LogsDrawer dashboard={dashboard} />;
}
