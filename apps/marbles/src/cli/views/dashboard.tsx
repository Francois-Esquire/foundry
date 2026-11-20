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
import {
  DashboardLayout,
  type DashboardPanels,
  dashboardMain,
} from "~/components/layouts/dashboard";
import { PanelShortcuts } from "~/components/ui/panel";
import { Text } from "~/components/ui/text";
import { helpSections } from "../state/dashboard-commands";
import type { DashboardViewKey } from "../state/dashboard-state";
import { type DashboardOptions, useDashboard } from "../state/use-dashboard";
import { DashboardDrawer } from "./dashboard-drawer";
import { DashboardMain } from "./dashboard-main";
import { BrowseSearch } from "./dashboard-search";
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
  const { drawer } = ui;
  const main = dashboardMain({
    drawer: drawer !== undefined,
    drawerDock: drawer?.dock,
    rail: ui.rail !== undefined,
    width,
  });
  const openWorkspaces = ui.workspaces.length ? ui.openWorkspaces : undefined;
  const panels = (): DashboardPanels => ({
    drawer: drawer && {
      content: (
        <PanelShortcuts.Provider value={ui.footer.hints}>
          <DashboardDrawer drawer={drawer.content()} />
        </PanelShortcuts.Provider>
      ),
      dock: drawer.dock,
    },
    main: main.shown ? (
      <PanelShortcuts.Provider value={drawer ? undefined : ui.footer.hints}>
        <DashboardMain
          height={dimensions.height}
          main={ui.main({ wide: main.wide })}
          wide={main.wide}
          width={main.width}
        />
      </PanelShortcuts.Provider>
    ) : undefined,
    rail: ui.rail && <WorkspacesPanel compact {...ui.rail} />,
  });

  return (
    <DashboardLayout
      above={
        <>
          {ui.search && <BrowseSearch search={ui.search} />}
          {state.help && (
            <KeyboardHelp
              active={!ui.quit.quitting}
              sections={helpSections()}
            />
          )}
          {(snapshot.notices ?? []).map((notice) => (
            <Text key={notice}>{notice}</Text>
          ))}
        </>
      }
      below={
        <>
          {state.prompt && (
            <PromptBar
              draft={state.draft}
              focused={!ui.quit.quitting}
              kind={state.prompt.kind}
              onInput={ui.setDraft}
              onSubmit={ui.submitPrompt}
              stepId={state.prompt.stepId}
            />
          )}
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
          <DashboardFooter
            onDiagnostics={ui.openDiagnostics}
            onSettings={ui.openSettings}
            onWorkspaces={openWorkspaces}
            shortcuts={ui.footer.lasting}
          />
          <WorkStatus
            busy={ui.starting.busy}
            error={ui.starting.error}
            label="Launching..."
          />
          {!state.help && toolbar}
          {ui.quit.quitting && (
            <QuitDialog
              hosted={hosted !== undefined}
              onCancel={ui.quit.cancel}
              onConfirm={onClose}
            />
          )}
        </>
      }
      header={
        <>
          <WorkspaceHeader
            onHome={ui.goHome}
            onWorkspaces={openWorkspaces}
            state={hosted?.state}
            workspace={snapshot.workspace}
          />
          <ViewTabs onChange={ui.setView} tabs={VIEW_TABS} view={state.view} />
        </>
      }
      panels={state.help ? undefined : panels()}
      width={width}
    />
  );
}
