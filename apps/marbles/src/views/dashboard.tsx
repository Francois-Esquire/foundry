import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { DefinitionsBlock, TriggersBlock } from "~/components/blocks/catalog";
import { CatalogPanels } from "~/components/blocks/catalog-panels";
import { DetailsBlock } from "~/components/blocks/details";
import { KeyboardHelp } from "~/components/blocks/keyboard-help";
import { LogsBlock } from "~/components/blocks/logs-panel";
import {
  LatestBlock,
  OperatingSummary,
  OverviewPanels,
  UsageBlock,
  UsageBreakdown,
} from "~/components/blocks/operating-overview";
import { QuitDialog } from "~/components/blocks/quit-dialog";
import { RunsBlock } from "~/components/blocks/runs";
import { SettingsBlock } from "~/components/blocks/settings-panel";
import { ViewTabs } from "~/components/blocks/view-tabs";
import { WorkspaceHeader } from "~/components/blocks/workspace-header";
import { Text } from "~/components/ui/text";
import { TextInput } from "~/components/ui/text-input";
import { theme } from "~/components/ui/theme";
import type { DashboardSnapshot } from "./dashboard-model";
import type { CatalogSelection } from "./dashboard-tree";
import { FeedView } from "./feed";
import { LaunchView } from "./launch";
import {
  latestActivity,
  operatingLogs,
  operatingStats,
} from "./operating-model";
import type { RunActions, RunPrompt } from "./run-actions";
import { type DashboardOptions, useDashboard } from "./use-dashboard";

function describeFilter(
  snapshot: DashboardSnapshot,
  filter?: CatalogSelection
): string | undefined {
  if (!filter) {
    return undefined;
  }
  const items =
    filter.kind === "trigger" ? snapshot.triggers : snapshot.definitions;
  return `${filter.kind}: ${items.find((item) => item.id === filter.id)?.name ?? filter.id}`;
}

/** Room for Runs beside Latest and Usage. */
const WIDE = 110;
const LATEST_ITEMS = 12;

/** The Overview and Catalog run filter and search lines, and the Logs search. */
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

/** One line of text for a steer or a resume prompt on a live step. */
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
    </box>
  );
}

/** Work in flight, or the reason it failed. */
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

/** Overview or Catalog: their lists, or the details opened from one. */
function BrowserContent({
  ui,
  snapshot,
  wide,
  onLaunch,
  stream,
}: {
  readonly ui: DashboardUi;
  readonly snapshot: DashboardSnapshot;
  readonly wide: boolean;
  readonly onLaunch?: (id: string) => void;
  readonly stream?: RunActions["stream"];
}) {
  const { state } = ui;
  const activePane = ui.inputActive ? undefined : ui.pane;
  if (ui.pane === "details") {
    return (
      <DetailsBlock
        active={activePane === "details"}
        onFilter={ui.filterRuns}
        onInspect={ui.inspect}
        onLaunch={onLaunch}
        onTab={ui.changeTab}
        resolved={ui.resolved}
        selection={state.selected}
        snapshot={snapshot}
        stream={stream}
        tab={state.tab}
      />
    );
  }
  if (state.breakdown) {
    return <UsageBreakdown active={!ui.inputActive} usage={snapshot.usage} />;
  }
  if (state.view === "catalog") {
    return (
      <CatalogPanels
        catalog={
          <DefinitionsBlock
            active={activePane === "definition"}
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
            items={ui.triggers}
            onReset={ui.clearFilters}
            onSelect={ui.inspect}
            searching={state.queries.trigger.length > 0}
            selected={state.selected}
          />
        }
      />
    );
  }
  return (
    <>
      <OperatingSummary
        stats={operatingStats(snapshot.runs)}
        usage={snapshot.usage}
      />
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
        usage={<UsageBlock usage={snapshot.usage} />}
        wide={wide}
      />
    </>
  );
}

/** The host owns snapshots, additional toolbar controls, and shutdown. */
export function DashboardView({
  toolbar,
  viewportWidth,
  ...options
}: DashboardOptions & {
  readonly toolbar?: ReactNode;
  /** Narrower than the terminal, for the preview's small-screen scenarios. */
  readonly viewportWidth?: number;
}) {
  const { snapshot, onClose, onLaunch, actions, hosted } = options;
  const dimensions = useTerminalDimensions();
  const width = Math.min(viewportWidth ?? dimensions.width, dimensions.width);
  const ui = useDashboard(options);
  const { state } = ui;
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
  const allLogs = operatingLogs(snapshot);
  let content: ReactNode;
  switch (state.view) {
    case "feed":
      content = <FeedView feed={ui.feed} inputActive={ui.inputActive} />;
      break;
    case "logs":
      content = (
        <LogsBlock
          active={!ui.inputActive}
          filters={state.logs}
          lines={ui.logs}
          onSelect={ui.openLog}
          selected={ui.log}
          total={allLogs.length}
        />
      );
      break;
    case "settings":
      content = (
        <SettingsBlock
          editable={options.onSettings !== undefined}
          settings={snapshot.settings}
        />
      );
      break;
    default:
      content = (
        <BrowserContent
          onLaunch={onLaunch ? ui.launch : undefined}
          snapshot={snapshot}
          stream={actions?.stream}
          ui={ui}
          wide={width >= WIDE}
        />
      );
  }
  const browsing = state.view === "overview" || state.view === "catalog";

  return (
    <box
      backgroundColor={theme.colors.background}
      flexDirection="column"
      height="100%"
      paddingX={1}
      width={width}
    >
      <WorkspaceHeader
        hosted={hosted}
        onHome={ui.goHome}
        preview={snapshot.mode === "snapshot"}
        workspace={snapshot.workspace}
      />
      <ViewTabs
        counts={{
          catalog: snapshot.definitions.length + snapshot.triggers.length,
          feed: ui.feed.total,
          logs: allLogs.length,
          overview: snapshot.runs.length,
        }}
        onChange={ui.setView}
        view={state.view}
      />
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
      {state.view === "logs" && (
        <DashboardSearch
          onInput={ui.setQuery}
          onSubmit={ui.finishSearch}
          pane="logs"
          query={state.logs.query}
          quitting={ui.quit.quitting}
          searching={state.searching}
        />
      )}
      {state.help && <KeyboardHelp active={!ui.quit.quitting} />}
      {(snapshot.notices ?? []).map((notice) => (
        <Text key={notice}>{notice}</Text>
      ))}
      {!state.help && content}
      {state.prompt && (
        <PromptBar
          draft={state.draft}
          onInput={ui.setDraft}
          onSubmit={ui.submitPrompt}
          prompt={state.prompt}
          quitting={ui.quit.quitting}
        />
      )}
      {!state.help && (
        <text fg={theme.colors.mutedForeground} wrapMode="none">
          {ui.footer.hints}
        </text>
      )}
      <WorkStatus
        busy={ui.control.busy}
        error={ui.control.error}
        label="Working…"
      />
      <text fg={theme.colors.mutedForeground} wrapMode="none">
        {ui.footer.lasting}
      </text>
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
