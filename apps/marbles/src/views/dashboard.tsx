import type { KeyEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";
import { DefinitionsBlock, TriggersBlock } from "~/components/blocks/catalog";
import { DetailsBlock } from "~/components/blocks/details";
import { ExecutionPanels } from "~/components/blocks/execution-panels";
import { KeyboardHelp } from "~/components/blocks/keyboard-help";
import { QuitDialog } from "~/components/blocks/quit-dialog";
import { RunsBlock } from "~/components/blocks/runs";
import { ViewTabs } from "~/components/blocks/view-tabs";
import { WorkspaceHeader } from "~/components/blocks/workspace-header";
import { Text } from "~/components/ui/text";
import { useTheme } from "~/hooks/use-theme";
import type { DashboardSnapshot } from "./dashboard-model";
import type { CatalogSelection } from "./dashboard-tree";
import { FeedView } from "./feed";
import { LaunchView } from "./launch";
import type { RunActions, RunPrompt } from "./run-actions";
import { useDashboard } from "./use-dashboard";
import { type AnswerHandler, type FeedState, useFeed } from "./use-feed";

const RUN_ACTIONS = "s steer · p pause/resume · k cancel";

function footer(
  pane: string,
  tab: string,
  definition: boolean,
  run: boolean
): string {
  if (pane === "details" && definition) {
    return "l launch · f filter runs · Esc catalog";
  }
  if (pane === "trigger" || pane === "definition") {
    return "↑↓ select · l launch catalog item · f filter runs · / search";
  }
  if (pane === "run") {
    return `↑↓ select · ←→ fold · a active · e failed${run ? ` · ${RUN_ACTIONS}` : ""} · / search`;
  }
  const controls = run ? ` · ${RUN_ACTIONS}` : "";
  if (tab === "logs") {
    return `←→ tabs · ↑↓ scroll · f follow${controls} · b run`;
  }
  if (tab === "input" || tab === "output") {
    return `←→ tabs · ↑↓ browse · Space fold JSON${controls} · b run`;
  }
  return `←→ tabs · ↑↓ scroll${controls} · b run`;
}

function dashboardFooter(
  pane: string,
  tab: string,
  searching: boolean,
  selected?: string,
  actions = false
): string {
  return searching
    ? "Type to search · Enter apply · Esc clear"
    : `${pane} · ${footer(pane, tab, selected === "definition", actions && selected === "run")}`;
}

function feedFooter(feed: FeedState): string {
  const { answer } = feed;
  if (answer.typing) {
    return answer.choosing
      ? `${answer.choosing} · add a note or leave it empty, then Enter send · Esc cancel`
      : "answer · type, then Enter send · Esc cancel";
  }
  const choices = answer.question?.input?.choices.length ?? 0;
  let respond = "";
  if (answer.question) {
    respond = choices > 0 ? ` · 1-${choices} answer` : " · a answer";
  }
  const workspace = feed.scopeCount > 1 ? " · w workspace · x all" : "";
  return feed.focus === "reader"
    ? `reader · ↑↓ scroll · Esc entries${respond}${workspace}`
    : `entries · ↑↓ select · Enter read${respond}${workspace}`;
}

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

/** The Dashboard tab's run filter and search lines. */
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
  const theme = useTheme();
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
          <input
            backgroundColor={theme.colors.background}
            cursorColor={theme.colors.primary}
            flexGrow={1}
            focused={!quitting}
            focusedBackgroundColor={theme.colors.muted}
            focusedTextColor={theme.colors.foreground}
            onInput={onInput}
            onSubmit={onSubmit}
            textColor={theme.colors.foreground}
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
}: {
  readonly prompt: RunPrompt;
  readonly draft: string;
  readonly onInput: (value: string) => void;
  readonly onSubmit: () => void;
}) {
  const theme = useTheme();
  const label =
    prompt.kind === "steer"
      ? `steer ${prompt.stepId} › `
      : `resume ${prompt.stepId} · prompt optional › `;
  return (
    <box flexDirection="row" height={1}>
      <text fg={theme.colors.foreground}>{label}</text>
      <input
        backgroundColor={theme.colors.muted}
        cursorColor={theme.colors.primary}
        flexGrow={1}
        focused
        focusedBackgroundColor={theme.colors.muted}
        focusedTextColor={theme.colors.foreground}
        onInput={onInput}
        onSubmit={onSubmit}
        textColor={theme.colors.foreground}
        value={draft}
      />
    </box>
  );
}

function footerFor(
  ui: ReturnType<typeof useDashboard>,
  feed: FeedState,
  onFeed: boolean,
  actions: boolean
): string {
  if (ui.prompt) {
    return `${ui.prompt.kind} · type, then Enter send · Esc cancel`;
  }
  if (onFeed) {
    return feedFooter(feed);
  }
  const activitySelected =
    ui.selected?.kind === "run" && ui.selected.activityId !== undefined;
  let text = dashboardFooter(
    ui.pane,
    ui.tab,
    ui.searching,
    ui.selected?.kind,
    actions && ui.actionHints === undefined
  );
  if (activitySelected && ui.pane === "details") {
    text = "activity · ↑↓ scroll · b run";
  }
  if (!ui.searching && ui.actionHints) {
    text += ` · ${ui.actionHints}`;
  }
  return text;
}

function ActionStatus({
  busy,
  error,
}: {
  readonly busy: boolean;
  readonly error?: string;
}) {
  if (busy) {
    return <Text>Working…</Text>;
  }
  return error ? <Text>{error}</Text> : null;
}

/** The host owns snapshots, additional toolbar controls, and shutdown. */
export function DashboardView({
  snapshot,
  onClose,
  toolbar,
  onShortcut,
  viewportWidth,
  onLaunch,
  onAnswer,
  actions,
}: {
  readonly snapshot: DashboardSnapshot;
  /** Cancel, pause, resume, and steer live runs; absent in previews. */
  readonly actions?: RunActions;
  /** Answer an open input entry; absent where nothing can resume the run. */
  readonly onAnswer?: AnswerHandler;
  readonly onClose: () => void;
  readonly toolbar?: ReactNode;
  readonly onShortcut?: (key: KeyEvent) => void;
  readonly viewportWidth?: number;
  readonly onLaunch?: (name: string, input: unknown) => Promise<string>;
}) {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const width = Math.min(viewportWidth ?? dimensions.width, dimensions.width);
  const [launchId, setLaunchId] = useState<string>();
  const [launchError, setLaunchError] = useState<string>();
  const [launching, setLaunching] = useState(false);
  const pending = useRef(false);
  async function launch(id: string) {
    if (!onLaunch || pending.current) {
      return;
    }
    const definition = snapshot.definitions.find((item) => item.id === id);
    if (!definition) {
      return;
    }
    setLaunchError(undefined);
    if (!definition.input || definition.input.fields.length > 0) {
      setLaunchId(id);
      return;
    }
    pending.current = true;
    setLaunching(true);
    try {
      ui.showRun(await onLaunch(id, undefined));
    } catch (error) {
      setLaunchError(String(error));
    } finally {
      pending.current = false;
      setLaunching(false);
    }
  }
  const feed = useFeed(snapshot.feed, snapshot.workspaceId, onAnswer);
  const ui = useDashboard(
    snapshot,
    onClose,
    onShortcut,
    Boolean(launchId),
    launch,
    feed.handleKey,
    feed.answer.typing,
    actions
  );
  const cancelLaunch = useCallback(() => setLaunchId(undefined), []);
  const started = useCallback(
    (id: string) => {
      setLaunchId(undefined);
      ui.showRun(id);
    },
    [ui.showRun]
  );
  const launchingDefinition = snapshot.definitions.find(
    (item) => item.id === launchId
  );
  if (launchingDefinition && onLaunch) {
    return (
      <LaunchView
        definition={launchingDefinition}
        onCancel={cancelLaunch}
        onClose={onClose}
        onLaunch={onLaunch}
        onStarted={started}
      />
    );
  }
  const activePane = ui.inputActive ? undefined : ui.pane;
  const filterLabel = describeFilter(snapshot, ui.filter);
  const triggers = (
    <TriggersBlock
      active={activePane === "trigger"}
      items={ui.triggers}
      onReset={ui.clearFilters}
      onSelect={ui.inspect}
      searching={ui.queries.trigger.length > 0}
      selected={ui.selected}
    />
  );
  const definitions = (
    <DefinitionsBlock
      active={activePane === "definition"}
      items={ui.definitions}
      onReset={ui.clearFilters}
      onSelect={ui.inspect}
      searching={ui.queries.definition.length > 0}
      selected={ui.selected}
    />
  );
  const runs = (
    <RunsBlock
      active={activePane === "run"}
      filtered={Boolean(ui.filter || ui.queries.run)}
      filterLabel={filterLabel}
      onReset={ui.clearFilters}
      onSelect={ui.inspect}
      onToggle={ui.toggle}
      rows={ui.rows}
      selected={ui.selected}
      triggerCount={snapshot.triggers.length}
    />
  );
  const details = (
    <DetailsBlock
      active={activePane === "details"}
      onFilter={ui.filterRuns}
      onInspect={ui.inspect}
      onLaunch={onLaunch ? launch : undefined}
      onTab={ui.changeTab}
      selection={ui.selected}
      snapshot={snapshot}
      stream={actions?.stream}
      tab={ui.tab}
    />
  );
  let content = (
    <ExecutionPanels catalog={definitions} runs={runs} triggers={triggers} />
  );
  if (ui.pane === "details") {
    content = details;
  }
  const onFeed = ui.view === "feed";
  if (onFeed) {
    content = <FeedView feed={feed} inputActive={ui.inputActive} />;
  }
  const footerText = footerFor(ui, feed, onFeed, actions !== undefined);

  return (
    <box
      backgroundColor={theme.colors.background}
      flexDirection="column"
      height="100%"
      paddingX={1}
      width={width}
    >
      <WorkspaceHeader
        onHome={ui.goHome}
        preview={snapshot.mode === "snapshot"}
        workspace={snapshot.workspace}
      />
      <ViewTabs
        feedCount={feed.total}
        onChange={ui.setView}
        runCount={snapshot.runs.length}
        view={ui.view}
      />
      {!onFeed && (
        <DashboardSearch
          filterLabel={ui.filter ? filterLabel : undefined}
          onInput={ui.setQuery}
          onSubmit={ui.finishSearch}
          pane={ui.pane}
          query={ui.query}
          quitting={ui.quitting}
          searching={ui.searching}
        />
      )}
      {ui.help && <KeyboardHelp active={!ui.quitting} />}
      {(snapshot.notices ?? []).map((notice) => (
        <Text key={notice}>{notice}</Text>
      ))}
      {!ui.help && content}
      {ui.prompt && (
        <PromptBar
          draft={ui.promptDraft}
          onInput={ui.setPromptDraft}
          onSubmit={ui.submitPrompt}
          prompt={ui.prompt}
        />
      )}
      {!ui.help && (
        <text fg={theme.colors.mutedForeground} wrapMode="none">
          {footerText}
        </text>
      )}
      <ActionStatus busy={ui.actionBusy} error={ui.actionError} />
      <text fg={theme.colors.mutedForeground} wrapMode="none">
        {onFeed
          ? "? help · q / Ctrl+C quit"
          : "Tab focus · Enter details · Esc back · ? help · q / Ctrl+C quit"}
      </text>
      {launching && <Text>Launching...</Text>}
      {launchError && <Text>{launchError}</Text>}
      {!ui.help && toolbar}
      {ui.quitting && (
        <QuitDialog
          onCancel={ui.cancelQuit}
          onConfirm={onClose}
          preview={snapshot.mode === "snapshot"}
        />
      )}
    </box>
  );
}
