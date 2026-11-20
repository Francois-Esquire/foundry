import type { DefinitionRow, TriggerRow } from "~/components/blocks/catalog";
import type {
  DashboardMetricsView,
  WorkflowRankingsView,
} from "~/components/blocks/dashboard-metrics";
import type { LogLine } from "~/components/blocks/logs-panel";
import type {
  LatestRow,
  UsageBreakdownView,
} from "~/components/blocks/operating-overview";
import type { RunListRow } from "~/components/blocks/runs";
import type { SettingsView } from "~/components/blocks/settings-panel";
import type {
  WorkspaceDetails,
  WorkspaceRow,
} from "~/components/blocks/workspaces-panel";
import type { DrawerDock } from "~/components/layouts/dashboard";
import type { ThemeName } from "~/model/settings";
import { dashboardMetrics, workflowRankingsView } from "./dashboard-metrics";
import {
  type DashboardSelection,
  type DashboardSnapshot,
  type DefinitionSnapshot,
  selectionKey,
  type TriggerSnapshot,
  triggerSelection,
} from "./dashboard-model";
import {
  definitionRows,
  describeFilter,
  latestRows,
  logLines,
  runListRows,
  triggerRows,
} from "./dashboard-rows";
import { type DashboardState, type Pane, paneOf } from "./dashboard-state";
import type { RunRow } from "./dashboard-tree";
import type { FeedModel } from "./feed-model";
import type { InspectorModel } from "./inspector";
import {
  latestActivity,
  nextSchedule,
  type OperatingLogEntry,
} from "./operating-model";

const LATEST_ITEMS = 12;

export interface SearchModel {
  readonly editing: boolean;
  readonly focused: boolean;
  readonly onInput: (value: string) => void;
  readonly onSubmit: () => void;
  readonly query: string;
  readonly scope: string;
}

export interface BrowseSearchModel {
  readonly bar: SearchModel;
  readonly filterLabel?: string;
}

interface SelectionHandlers {
  readonly onInspect: (selection: DashboardSelection) => void;
  readonly onReset: () => void;
}

interface RunsModel {
  readonly active: boolean;
  readonly filtered: boolean;
  readonly filterLabel?: string;
  readonly rows: readonly RunListRow<DashboardSelection>[];
  readonly selectedId?: string;
  readonly triggerCount: number;
}

export interface OverviewModel extends SelectionHandlers {
  readonly latest: readonly LatestRow<DashboardSelection>[];
  readonly metrics: DashboardMetricsView;
  readonly next?: {
    readonly label: string;
    readonly selection: DashboardSelection;
  };
  readonly onToggle: (selection: DashboardSelection) => void;
  readonly rankWorkflows: () => WorkflowRankingsView;
  readonly runs: RunsModel;
}

interface CatalogList<R> {
  readonly active: boolean;
  readonly items: readonly R[];
  readonly searching: boolean;
}

export interface CatalogModel extends SelectionHandlers {
  readonly definitions: CatalogList<DefinitionRow<DashboardSelection>>;
  readonly selectedId?: string;
  readonly triggers: CatalogList<TriggerRow<DashboardSelection>>;
  readonly workspace: string;
}

export type MainModel =
  | { readonly feed: FeedModel; readonly kind: "feed" }
  | { readonly inspector: InspectorModel; readonly kind: "details" }
  | {
      readonly active: boolean;
      readonly kind: "usage";
      readonly usage?: UsageBreakdownView;
    }
  | {
      readonly catalog: CatalogModel;
      readonly details?: InspectorModel;
      readonly kind: "catalog";
    }
  | { readonly kind: "overview"; readonly overview: OverviewModel };

interface WorkspacesModel {
  readonly current?: string;
  readonly details?: WorkspaceDetails;
  readonly onSelect: (id: string) => void;
  readonly selected: string;
  readonly workspaces: readonly WorkspaceRow[];
}

interface LogsModel {
  readonly active: boolean;
  readonly filters: DashboardState["logs"];
  readonly lines: readonly LogLine<OperatingLogEntry>[];
  readonly onSelect: (entry: OperatingLogEntry) => void;
  readonly selectedId?: string;
  readonly total: number;
}

export type DrawerContent =
  | { readonly kind: "workspaces"; readonly workspaces: WorkspacesModel }
  | {
      readonly kind: "settings";
      readonly settings: {
        readonly onRail?: (show: boolean) => void;
        readonly onTheme?: (name: ThemeName) => void;
        readonly rail: boolean;
        readonly settings?: SettingsView;
      };
    }
  | {
      readonly kind: "logs";
      readonly logs: LogsModel;
      readonly runId?: string;
      readonly search: SearchModel;
    };

export interface DrawerModel {
  readonly content: () => DrawerContent;
  readonly dock?: DrawerDock;
}

export type MainContent = MainModel["kind"];

export function drawerDock(
  state: Pick<DashboardState, "drawer" | "picker">
): DrawerDock | undefined {
  if (state.picker !== undefined) {
    return "left";
  }
  return state.drawer === "settings" ? "right" : undefined;
}

export function browsing(state: DashboardState): boolean {
  return (
    (state.view === "overview" || state.view === "catalog") &&
    state.drawer === undefined &&
    state.picker === undefined
  );
}

export function mainContent(state: DashboardState, wide: boolean): MainContent {
  if (state.view === "feed") {
    return "feed";
  }
  if (paneOf(state) === "details" && !(wide && state.view === "catalog")) {
    return "details";
  }
  if (state.breakdown) {
    return "usage";
  }
  return state.view === "catalog" ? "catalog" : "overview";
}

export function browseSearch(
  snapshot: DashboardSnapshot,
  state: DashboardState,
  bar: Omit<SearchModel, "query" | "scope">
): BrowseSearchModel {
  const pane = paneOf(state);
  return {
    bar: {
      ...bar,
      query: pane === "details" ? "" : state.queries[pane],
      scope: pane,
    },
    filterLabel: describeFilter(snapshot, state.filter),
  };
}

export function overviewModel(
  snapshot: DashboardSnapshot,
  state: DashboardState,
  rows: readonly RunRow[],
  activePane: Pane | undefined,
  handlers: SelectionHandlers & Pick<OverviewModel, "onToggle">
): OverviewModel {
  const next = nextSchedule(snapshot.triggers);
  return {
    ...handlers,
    latest: latestRows(latestActivity(snapshot, LATEST_ITEMS)),
    metrics: dashboardMetrics(snapshot),
    next: next && {
      label: `Up next · ${next.name} · ${next.next}`,
      selection: triggerSelection(next),
    },
    rankWorkflows: () => workflowRankingsView(snapshot),
    runs: {
      active: activePane === "run",
      filtered: Boolean(state.filter || state.queries.run),
      filterLabel: describeFilter(snapshot, state.filter),
      rows: runListRows(rows, state.selected),
      selectedId: state.selected && selectionKey(state.selected),
      triggerCount: snapshot.triggers.length,
    },
  };
}

export function catalogModel(
  snapshot: DashboardSnapshot,
  state: DashboardState,
  lists: {
    readonly definitions: readonly DefinitionSnapshot[];
    readonly triggers: readonly TriggerSnapshot[];
  },
  activePane: Pane | undefined,
  handlers: SelectionHandlers
): CatalogModel {
  return {
    ...handlers,
    definitions: {
      active: activePane === "definition",
      items: definitionRows(lists.definitions, state.selected),
      searching: state.queries.definition.length > 0,
    },
    selectedId: state.selected && selectionKey(state.selected),
    triggers: {
      active: activePane === "trigger",
      items: triggerRows(lists.triggers, state.selected),
      searching: state.queries.trigger.length > 0,
    },
    workspace: snapshot.workspace,
  };
}

export function logsDrawer(
  state: DashboardState,
  logs: {
    readonly entries: readonly OperatingLogEntry[];
    readonly selected?: OperatingLogEntry;
    readonly total: number;
  },
  handlers: {
    readonly active: boolean;
    readonly onSelect: (entry: OperatingLogEntry) => void;
    readonly search: Omit<SearchModel, "query" | "scope">;
  }
): DrawerContent {
  return {
    kind: "logs",
    logs: {
      active: handlers.active,
      filters: state.logs,
      lines: logLines(logs.entries),
      onSelect: handlers.onSelect,
      selectedId: logs.selected?.id,
      total: logs.total,
    },
    runId: state.logs.runId,
    search: { ...handlers.search, query: state.logs.query, scope: "logs" },
  };
}
