import { useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useState } from "react";
import { DashboardFooter } from "~/components/blocks/dashboard-footer";
import { KeyboardHelp } from "~/components/blocks/keyboard-help";
import { PromptBar } from "~/components/blocks/prompt-bar";
import { QuitDialog } from "~/components/blocks/quit-dialog";
import { type ViewTabItem, ViewTabs } from "~/components/blocks/view-tabs";
import { WorkStatus } from "~/components/blocks/work-status";
import { WorkspaceHeader } from "~/components/blocks/workspace-header";
import { WorkspacesPanel } from "~/components/blocks/workspaces-panel";
import { DashboardLayout, dashboardMain } from "~/components/layouts/dashboard";
import { PanelShortcuts } from "~/components/ui/panel";
import { Text } from "~/components/ui/text";
import { helpSections } from "../state/dashboard-commands";
import { workspaceRows } from "../state/dashboard-rows";
import type { DashboardViewKey } from "../state/dashboard-state";
import { type DashboardOptions, useDashboard } from "../state/use-dashboard";
import { DashboardDrawer, drawerDock } from "./dashboard-drawer";
import { DashboardMain } from "./dashboard-main";
import { BrowseSearch, browsing } from "./dashboard-search";
import { LaunchView } from "./launch";

const VIEW_TABS: readonly ViewTabItem<DashboardViewKey>[] = [
  { label: "Dashboard", view: "overview" },
  { label: "Catalog", view: "catalog" },
  { label: "Feed", view: "feed" },
];

type DashboardProps = DashboardOptions & {
  readonly toolbar?: ReactNode;
  readonly viewportWidth?: number;
};

export function DashboardView({
  toolbar,
  viewportWidth,
  ...options
}: DashboardProps) {
  const { onClose, onLaunch, hosted } = options;
  const dimensions = useTerminalDimensions();
  const width = Math.min(viewportWidth ?? dimensions.width, dimensions.width);
  const [localRail, setLocalRail] = useState(false);
  const rail = options.workspaceRail ?? localRail;
  const onRail = options.onWorkspaceRail ?? setLocalRail;
  const ui = useDashboard({
    ...options,
    onWorkspaceRail: onRail,
    workspaceRail: rail,
  });
  const { snapshot, state } = ui;
  if (ui.form && onLaunch) {
    return (
      <LaunchView
        definition={ui.form}
        onCancel={ui.leaveForm}
        onClose={onClose}
        onLaunch={onLaunch}
        onStarted={ui.showRun}
      />
    );
  }
  const utility = state.drawer !== undefined || state.picker !== undefined;
  const dock = drawerDock(state);
  const showRail = rail && ui.workspaces.length > 0;
  const main = dashboardMain({
    drawer: utility,
    drawerDock: dock,
    rail: showRail,
    width,
  });
  const openWorkspaces = ui.workspaces.length ? ui.openWorkspaces : undefined;

  return (
    <DashboardLayout
      drawer={
        utility ? (
          <PanelShortcuts.Provider value={ui.footer.hints}>
            <DashboardDrawer
              dashboard={ui}
              editable={options.onSettings !== undefined}
              onRail={onRail}
              rail={rail}
            />
          </PanelShortcuts.Provider>
        ) : undefined
      }
      drawerDock={dock}
      footer={
        <DashboardFooter
          onDiagnostics={ui.openDiagnostics}
          onSettings={ui.openSettings}
          onWorkspaces={openWorkspaces}
          shortcuts={ui.footer.lasting}
        />
      }
      header={
        <WorkspaceHeader
          onHome={ui.goHome}
          onWorkspaces={openWorkspaces}
          state={hosted?.state}
          workspace={snapshot.workspace}
        />
      }
      help={
        state.help ? (
          <KeyboardHelp active={!ui.quit.quitting} sections={helpSections()} />
        ) : undefined
      }
      main={
        <PanelShortcuts.Provider value={utility ? undefined : ui.footer.hints}>
          <DashboardMain
            dashboard={ui}
            height={dimensions.height}
            inputActive={ui.inputActive || utility}
            onLaunch={onLaunch ? ui.launch : undefined}
            onRollSchedule={
              options.onRollSchedule ? ui.rollSchedule : undefined
            }
            stream={options.actions?.stream}
            wide={main.wide}
            width={main.width}
          />
        </PanelShortcuts.Provider>
      }
      notices={(snapshot.notices ?? []).map((notice) => (
        <Text key={notice}>{notice}</Text>
      ))}
      overlay={
        ui.quit.quitting ? (
          <QuitDialog
            hosted={hosted !== undefined}
            onCancel={ui.quit.cancel}
            onConfirm={onClose}
          />
        ) : undefined
      }
      prompt={
        state.prompt ? (
          <PromptBar
            draft={state.draft}
            focused={!ui.quit.quitting}
            kind={state.prompt.kind}
            onInput={ui.setDraft}
            onSubmit={ui.submitPrompt}
            stepId={state.prompt.stepId}
          />
        ) : undefined
      }
      rail={
        showRail ? (
          <WorkspacesPanel
            compact
            current={snapshot.workspaceId}
            onSelect={ui.chooseWorkspace}
            selected={snapshot.workspaceId ?? ""}
            workspaces={workspaceRows(ui.workspaces)}
          />
        ) : undefined
      }
      search={browsing(state) ? <BrowseSearch dashboard={ui} /> : undefined}
      status={
        <>
          <WorkStatus
            busy={ui.control.busy}
            error={ui.control.error}
            label="Working…"
          />
          <WorkStatus
            busy={ui.schedule.busy}
            error={ui.schedule.error}
            label="Waiting for schedule run…"
          />
        </>
      }
      tabs={
        <ViewTabs onChange={ui.setView} tabs={VIEW_TABS} view={state.view} />
      }
      toolbar={toolbar}
      trailingStatus={
        <WorkStatus
          busy={ui.starting.busy}
          error={ui.starting.error}
          label="Launching..."
        />
      }
      width={width}
    />
  );
}
