import { useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useState } from "react";
import { DefinitionsBlock, TriggersBlock } from "~/components/blocks/catalog";
import { CatalogPanels } from "~/components/blocks/catalog-panels";
import { DashboardMetrics } from "~/components/blocks/dashboard-metrics";
import { DetailsBlock } from "~/components/blocks/details";
import { KeyboardHelp } from "~/components/blocks/keyboard-help";
import { LogsBlock } from "~/components/blocks/logs-panel";
import {
  LatestBlock,
  OverviewPanels,
  UsageBreakdown,
} from "~/components/blocks/operating-overview";
import { QuitDialog } from "~/components/blocks/quit-dialog";
import { RunsBlock } from "~/components/blocks/runs";
import { SettingsBlock } from "~/components/blocks/settings-panel";
import { ViewTabs } from "~/components/blocks/view-tabs";
import { WorkspaceHeader } from "~/components/blocks/workspace-header";
import { WorkspacesPanel } from "~/components/blocks/workspaces-panel";
import { Action } from "~/components/ui/action";
import { PanelShortcuts } from "~/components/ui/panel";
import { Text } from "~/components/ui/text";
import { TextInput } from "~/components/ui/text-input";
import { theme } from "~/components/ui/theme";
import { ThemeProvider } from "~/components/ui/theme-provider";
import type { DashboardSnapshot } from "./dashboard-model";
import { isSelected, triggerSelection } from "./dashboard-model";
import type { CatalogSelection } from "./dashboard-tree";
import { FeedView } from "./feed";
import { LaunchView } from "./launch";
import { latestActivity } from "./operating-model";
import type { RunActions, RunPrompt } from "./run-actions";
import { type DashboardOptions, useDashboard } from "./use-dashboard";

function describeFilter(
  snapshot: DashboardSnapshot,
  filter?: CatalogSelection
): string | undefined {
  if (!filter) {
    return undefined;
  }
  const name =
    filter.kind === "trigger"
      ? snapshot.triggers.find((item) => isSelected(item, filter))?.name
      : snapshot.definitions.find((item) => item.id === filter.id)?.name;
  return `${filter.kind}: ${name ?? filter.id}`;
}

const WIDE = 110;
const UTILITY_WIDTH = 46;
const UTILITY_REMAINDER = 68;
const RAIL_WIDTH = 27;
const LATEST_ITEMS = 12;

function DashboardSearch({
  filterLabel,
  searching,
  quitting,
  pane,
  query,
  onInput,
  onSubmit,
}: {
  readonly filterLabel?: string;
  readonly searching: boolean;
  readonly quitting: boolean;
  readonly pane: string;
  readonly query: string;
  readonly onInput: (value: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <>
      {filterLabel && (
        <text fg={theme.colors.info}>
          Run filter: {filterLabel} · x all runs
        </text>
      )}
      {searching ? (
        <box flexDirection="row" height={1}>
          <Text>Search {pane}: </Text>
          <TextInput
            flexGrow={1}
            focused={!quitting}
            onInput={onInput}
            onSubmit={onSubmit}
            value={query}
          />
          <Text>Enter apply · Esc clear</Text>
        </box>
      ) : (
        query && (
          <Text>
            Search {pane}: {query} · / edit · x clear
          </Text>
        )
      )}
    </>
  );
}

function PromptBar({
  prompt,
  draft,
  onInput,
  onSubmit,
  quitting,
}: {
  readonly prompt: RunPrompt;
  readonly draft: string;
  readonly onInput: (value: string) => void;
  readonly onSubmit: () => void;
  readonly quitting: boolean;
}) {
  const label =
    prompt.kind === "steer"
      ? `steer ${prompt.stepId} › `
      : `resume ${prompt.stepId} · prompt optional › `;
  return (
    <box flexDirection="row" height={1}>
      <Text>{label}</Text>
      <TextInput
        flexGrow={1}
        focused={!quitting}
        onInput={onInput}
        onSubmit={onSubmit}
        value={draft}
      />
      <Text>Enter send · Esc cancel</Text>
    </box>
  );
}

function WorkStatus({
  busy,
  error,
  label,
}: {
  readonly busy: boolean;
  readonly error?: string;
  readonly label: string;
}) {
  if (busy) {
    return <Text>{label}</Text>;
  }
  return error ? <Text>{error}</Text> : null;
}

type DashboardUi = ReturnType<typeof useDashboard>;

function BrowserContent({
  ui,
  snapshot,
  width,
  height,
  onLaunch,
  onRollSchedule,
  stream,
}: {
  readonly ui: DashboardUi;
  readonly snapshot: DashboardSnapshot;
  readonly width: number;
  readonly height: number;
  readonly onLaunch?: (id: string) => void;
  readonly onRollSchedule?: (key: string) => void;
  readonly stream?: RunActions["stream"];
}) {
  const { state } = ui;
  const wide = width >= WIDE;
  const activePane = ui.inputActive ? undefined : ui.pane;
  const details =
    ui.pane === "details" ? (
      <DetailsBlock
        active={activePane === "details"}
        onFilter={ui.filterRuns}
        onInspect={ui.inspect}
        onLaunch={onLaunch}
        onRollSchedule={onRollSchedule}
        onTab={ui.changeTab}
        resolved={ui.resolved}
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
    return <UsageBreakdown active={!ui.inputActive} usage={snapshot.usage} />;
  }
  if (state.view === "catalog") {
    const catalog = (
      <CatalogPanels
        catalog={
          <DefinitionsBlock
            active={activePane === "definition"}
            compact={Boolean(details) || width < 75}
            items={ui.definitions}
            onReset={ui.clearFilters}
            onSelect={ui.inspect}
            searching={state.queries.definition.length > 0}
            selected={state.selected}
            workspace={snapshot.workspace}
          />
        }
        triggers={
          <TriggersBlock
            active={activePane === "trigger"}
            compact={Boolean(details)}
            items={ui.triggers}
            onReset={ui.clearFilters}
            onSelect={ui.inspect}
            searching={state.queries.trigger.length > 0}
            selected={state.selected}
          />
        }
      />
    );
    return details ? (
      <box flexDirection="row" flexGrow={1} gap={1} minHeight={0}>
        <box flexBasis={0} flexDirection="column" flexGrow={2} minWidth={0}>
          {catalog}
        </box>
        <box flexBasis={0} flexDirection="column" flexGrow={3} minWidth={0}>
          {details}
        </box>
      </box>
    ) : (
      catalog
    );
  }
  const [next] = snapshot.triggers
    .filter(
      (trigger) =>
        trigger.kind === "schedule" &&
        trigger.next &&
        trigger.status === "waiting"
    )
    .sort(
      (left, right) =>
        (left.nextAt ?? Number.MAX_SAFE_INTEGER) -
        (right.nextAt ?? Number.MAX_SAFE_INTEGER)
    );
  return (
    <>
      <DashboardMetrics height={height} snapshot={snapshot} width={width} />
      {next && (
        <box flexShrink={0} paddingLeft={1}>
          <Action
            label={`Up next · ${next.name} · ${next.next}`}
            onAction={ui.inspect}
            value={triggerSelection(next)}
          />
        </box>
      )}
      <OverviewPanels
        latest={
          <LatestBlock
            items={latestActivity(snapshot, LATEST_ITEMS)}
            onSelect={ui.inspect}
          />
        }
        runs={
          <RunsBlock
            active={activePane === "run"}
            filtered={Boolean(state.filter || state.queries.run)}
            filterLabel={describeFilter(snapshot, state.filter)}
            onReset={ui.clearFilters}
            onSelect={ui.inspect}
            onToggle={ui.toggle}
            rows={ui.rows}
            selected={state.selected}
            triggerCount={snapshot.triggers.length}
          />
        }
        wide={wide}
      />
    </>
  );
}

function DashboardDrawer({
  ui,
  docked,
  rail,
  onRail,
  editable,
}: {
  readonly ui: DashboardUi;
  readonly docked: boolean;
  readonly rail: boolean;
  readonly onRail: (show: boolean) => void;
  readonly editable: boolean;
}) {
  const { picker, state, snapshot } = ui;
  let content: ReactNode;
  const right = picker === undefined && state.view === "settings";
  if (picker !== undefined) {
    content = (
      <WorkspacesPanel
        current={snapshot.workspaceId}
        onSelect={ui.chooseWorkspace}
        selected={picker}
        workspaces={ui.workspaces}
      />
    );
  } else if (right) {
    content = (
      <SettingsBlock
        onRail={ui.workspaces.length ? onRail : undefined}
        onTheme={editable ? ui.changeTheme : undefined}
        rail={rail}
        settings={snapshot.settings}
      />
    );
  } else {
    content = (
      <>
        <DashboardSearch
          onInput={ui.setQuery}
          onSubmit={ui.finishSearch}
          pane="logs"
          query={state.logs.query}
          quitting={ui.quit.quitting}
          searching={state.searching}
        />
        {state.logs.runId && <Text>Run {state.logs.runId} · x clear</Text>}
        <LogsBlock
          active={!ui.inputActive}
          filters={state.logs}
          lines={ui.logs}
          onSelect={ui.openLog}
          selected={ui.log}
          total={ui.logTotal}
        />
      </>
    );
  }
  return (
    <box
      backgroundColor={theme.colors.background}
      flexDirection="column"
      flexShrink={0}
      minHeight={0}
      width={docked ? UTILITY_WIDTH : "100%"}
    >
      <PanelShortcuts.Provider
        value={
          picker === undefined
            ? ui.footer.hints
            : "↑↓ select · Enter switch · Esc close"
        }
      >
        {content}
      </PanelShortcuts.Provider>
    </box>
  );
}

function DashboardSurface({
  ui,
  surface,
  obscured,
  height,
  options,
  width,
}: {
  readonly ui: DashboardUi;
  readonly surface: ReturnType<typeof primaryView>;
  readonly obscured: boolean;
  readonly height: number;
  readonly options: DashboardOptions;
  readonly width: number;
}) {
  if (surface === "feed") {
    return (
      <FeedView
        feed={ui.feed}
        inputActive={ui.inputActive || obscured}
        width={width}
      />
    );
  }
  return (
    <BrowserContent
      height={height}
      onLaunch={options.onLaunch ? ui.launch : undefined}
      onRollSchedule={options.onRollSchedule ? ui.rollSchedule : undefined}
      snapshot={ui.snapshot}
      stream={options.actions?.stream}
      ui={{
        ...ui,
        inputActive: ui.inputActive || obscured,
        state: { ...ui.state, view: surface },
      }}
      width={width}
    />
  );
}

function DashboardBody({
  ui,
  width,
  height,
  options,
  rail,
  onRail,
}: {
  readonly ui: DashboardUi;
  readonly width: number;
  readonly height: number;
  readonly options: DashboardOptions;
  readonly rail: boolean;
  readonly onRail: (show: boolean) => void;
}) {
  const { state, snapshot } = ui;
  const surface = primaryView(state);
  const utility = surface !== state.view;
  const picker = ui.picker !== undefined;
  const openingUtility = utility || picker;
  const docked =
    (picker || state.view === "settings") &&
    width >= UTILITY_WIDTH + UTILITY_REMAINDER + 1;
  const showRail =
    !openingUtility && rail && width >= 94 && ui.workspaces.length > 0;
  const surfaceWidth =
    width - (docked ? UTILITY_WIDTH + 1 : 0) - (showRail ? RAIL_WIDTH : 0);
  const drawer = openingUtility && (
    <DashboardDrawer
      docked={docked}
      editable={options.onSettings !== undefined}
      onRail={onRail}
      rail={rail}
      ui={ui}
    />
  );
  if (drawer && !docked) {
    return (
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        {drawer}
      </box>
    );
  }
  const right = !picker && state.view === "settings";
  return (
    <box flexDirection="row" flexGrow={1} gap={docked ? 1 : 0} minHeight={0}>
      {!right && drawer}
      {showRail && (
        <box
          flexDirection="column"
          flexShrink={0}
          paddingRight={1}
          width={RAIL_WIDTH}
        >
          <WorkspacesPanel
            compact
            current={snapshot.workspaceId}
            onSelect={ui.chooseWorkspace}
            selected={snapshot.workspaceId ?? ""}
            workspaces={ui.workspaces}
          />
        </box>
      )}
      <box
        flexBasis={0}
        flexDirection="column"
        flexGrow={1}
        minWidth={0}
        overflow="hidden"
      >
        <PanelShortcuts.Provider
          value={openingUtility ? undefined : ui.footer.hints}
        >
          <DashboardSurface
            height={height}
            obscured={openingUtility}
            options={options}
            surface={surface}
            ui={ui}
            width={surfaceWidth}
          />
        </PanelShortcuts.Provider>
      </box>
      {right && drawer}
    </box>
  );
}

function primaryView(state: DashboardUi["state"]) {
  return state.view === "logs" || state.view === "settings"
    ? (state.returnView ?? "overview")
    : state.view;
}

function DashboardFooter({ ui }: { readonly ui: DashboardUi }) {
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      flexWrap="wrap"
      gap={2}
      justifyContent="space-between"
    >
      <box flexDirection="row" gap={2}>
        {ui.workspaces.length > 0 && (
          <Action
            label="w Workspaces"
            onAction={ui.openWorkspaces}
            value="workspaces"
          />
        )}
        <Action
          id="view:logs"
          label="d Diagnostics"
          onAction={ui.setView}
          value="logs"
        />
      </box>
      <box flexDirection="row" gap={2}>
        <text fg={theme.colors.mutedForeground} wrapMode="none">
          {ui.footer.lasting}
        </text>
        <Action
          id="view:settings"
          label="S Settings"
          onAction={ui.setView}
          value="settings"
        />
      </box>
    </box>
  );
}

type DashboardProps = DashboardOptions & {
  readonly toolbar?: ReactNode;
  readonly viewportWidth?: number;
};

export function DashboardView(props: DashboardProps) {
  const name = props.snapshot.settings?.theme;
  return name === undefined ? (
    <DashboardScreen {...props} />
  ) : (
    <ThemeProvider name={name}>
      <DashboardScreen {...props} />
    </ThemeProvider>
  );
}

function DashboardScreen({
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
  const surface = primaryView(state);
  const browsing =
    (state.view === "overview" || state.view === "catalog") &&
    ui.picker === undefined;

  return (
    <box
      backgroundColor={theme.colors.background}
      flexDirection="column"
      height="100%"
      paddingX={1}
      width={width}
    >
      <box
        flexDirection="row"
        flexShrink={0}
        gap={2}
        justifyContent="space-between"
      >
        <WorkspaceHeader
          hosted={hosted}
          onHome={ui.goHome}
          onWorkspaces={ui.workspaces.length ? ui.openWorkspaces : undefined}
          preview={snapshot.mode === "snapshot"}
          workspace={snapshot.workspace}
        />
        <ViewTabs onChange={ui.setView} view={surface} />
      </box>
      {browsing && (
        <DashboardSearch
          filterLabel={describeFilter(snapshot, state.filter)}
          onInput={ui.setQuery}
          onSubmit={ui.finishSearch}
          pane={ui.pane}
          query={ui.pane === "details" ? "" : state.queries[ui.pane]}
          quitting={ui.quit.quitting}
          searching={state.searching}
        />
      )}
      {state.help && <KeyboardHelp active={!ui.quit.quitting} />}
      {(snapshot.notices ?? []).map((notice) => (
        <Text key={notice}>{notice}</Text>
      ))}
      {!state.help && (
        <DashboardBody
          height={dimensions.height}
          onRail={onRail}
          options={options}
          rail={rail}
          ui={ui}
          width={width - 2}
        />
      )}
      {state.prompt && (
        <PromptBar
          draft={state.draft}
          onInput={ui.setDraft}
          onSubmit={ui.submitPrompt}
          prompt={state.prompt}
          quitting={ui.quit.quitting}
        />
      )}
      <WorkStatus
        busy={ui.control.busy}
        error={ui.control.error}
        label="Working…"
      />
      <DashboardFooter ui={ui} />
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
          preview={snapshot.mode === "snapshot"}
        />
      )}
    </box>
  );
}
