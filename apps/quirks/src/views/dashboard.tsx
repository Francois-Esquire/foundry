import type { KeyEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
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
import { useDashboard } from "./use-dashboard";

function footer(pane: string, tab: string): string {
  if (pane === "trigger" || pane === "definition") {
    return "↑↓ select · f filter runs · / search";
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
}: {
  readonly snapshot: DashboardSnapshot;
  readonly onClose: () => void;
  readonly toolbar?: ReactNode;
  readonly onShortcut?: (key: KeyEvent) => void;
  readonly viewportWidth?: number;
}) {
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const width = Math.min(viewportWidth ?? dimensions.width, dimensions.width);
  const ui = useDashboard(snapshot, onClose, onShortcut);
  const activePane = ui.inputActive ? undefined : ui.pane;
  const filterLabel = describeFilter(snapshot, ui.filter);
  const triggers = (
    <TriggersBlock
      active={activePane === "trigger"}
      items={ui.triggers}
      onSelect={ui.inspect}
      searching={ui.queries.trigger.length > 0}
      selected={ui.selected}
    />
  );
  const definitions = (
    <DefinitionsBlock
      active={activePane === "definition"}
      items={ui.definitions}
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
      onSelect={ui.inspect}
      onToggle={ui.toggle}
      rows={ui.rows}
      selected={ui.selected}
    />
  );
  const details = (
    <DetailsBlock
      active={activePane === "details"}
      onFilter={ui.filterRuns}
      onInspect={ui.inspect}
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
            : `${ui.pane} · ${footer(ui.pane, ui.tab)}`}
        </text>
      )}
      <text fg={theme.colors.mutedForeground} wrapMode="none">
        Tab focus · Enter details · Esc back · ? help · q / Ctrl+C quit
      </text>
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
