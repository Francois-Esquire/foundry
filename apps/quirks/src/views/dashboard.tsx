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
import { WorkspaceHeader } from "~/components/blocks/workspace-header";
import { Text } from "~/components/ui/text";
import { useTheme } from "~/hooks/use-theme";
import type { DashboardSnapshot } from "./dashboard-model";
import type { CatalogSelection } from "./dashboard-tree";
import { LaunchView } from "./launch";
import { useDashboard } from "./use-dashboard";

function footer(pane: string, tab: string, definition: boolean): string {
  if (pane === "details" && definition) {
    return "l launch · f filter runs · Esc catalog";
  }
  if (pane === "trigger" || pane === "definition") {
    return "↑↓ select · l launch catalog item · f filter runs · / search";
  }
  if (pane === "run") {
    return "↑↓ select · ←→ fold · a active · e failed · / search";
  }
  if (tab === "logs") {
    return "←→ tabs · ↑↓ scroll · f follow · b run";
  }
  if (tab === "input" || tab === "output") {
    return "←→ tabs · ↑↓ browse · Space fold JSON · b run";
  }
  return "←→ tabs · ↑↓ scroll · b run";
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

/** The host owns snapshots, additional toolbar controls, and shutdown. */
export function DashboardView({
  snapshot,
  onClose,
  toolbar,
  onShortcut,
  viewportWidth,
  onLaunch,
}: {
  readonly snapshot: DashboardSnapshot;
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
  const ui = useDashboard(
    snapshot,
    onClose,
    onShortcut,
    Boolean(launchId),
    launch
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
      tab={ui.tab}
    />
  );
  let content = (
    <ExecutionPanels catalog={definitions} runs={runs} triggers={triggers} />
  );
  if (ui.pane === "details") {
    content = details;
  }
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
      {ui.filter && (
        <text fg={theme.colors.info}>
          Run filter: {filterLabel} · x all runs
        </text>
      )}
      {ui.searching ? (
        <box flexDirection="row" height={1}>
          <Text>Search {ui.pane}: </Text>
          <input
            backgroundColor={theme.colors.background}
            cursorColor={theme.colors.primary}
            flexGrow={1}
            focused={!ui.quitting}
            focusedBackgroundColor={theme.colors.muted}
            focusedTextColor={theme.colors.foreground}
            onInput={ui.setQuery}
            onSubmit={ui.finishSearch}
            textColor={theme.colors.foreground}
            value={ui.query}
          />
        </box>
      ) : (
        ui.query && (
          <Text>
            Search {ui.pane}: {ui.query} · / edit · x clear
          </Text>
        )
      )}
      {ui.help && <KeyboardHelp active={!ui.quitting} />}
      {!ui.help && content}
      {!ui.help && (
        <text fg={theme.colors.mutedForeground} wrapMode="none">
          {ui.searching
            ? "Type to search · Enter apply · Esc clear"
            : `${ui.pane} · ${footer(ui.pane, ui.tab, ui.selected?.kind === "definition")}`}
        </text>
      )}
      <text fg={theme.colors.mutedForeground} wrapMode="none">
        Tab focus · Enter details · Esc back · ? help · q / Ctrl+C quit
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
