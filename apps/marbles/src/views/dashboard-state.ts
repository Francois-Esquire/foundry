import {
  type DashboardSelection,
  type DashboardSnapshot,
  type DefinitionSnapshot,
  flattenSteps,
  runSelection,
  selectionKey,
  triggerSelection,
} from "./dashboard-model";
import {
  type CatalogSelection,
  expandedRun,
  matches,
  matchingRuns,
  type RunRow,
  runRows,
  scopedRuns,
} from "./dashboard-tree";
import {
  filterLogs,
  LOG_LEVELS,
  LOG_SOURCES,
  type LogFilter,
  type OperatingLogEntry,
  operatingLogs,
} from "./operating-model";
import type { RunPrompt } from "./run-actions";

const INSPECTOR_TABS = [
  "overview",
  "input",
  "output",
  "logs",
  "stream",
] as const;
export type InspectorTab = (typeof INSPECTOR_TABS)[number];
const BROWSER_PANES = ["trigger", "definition", "run"] as const;
export type BrowserPane = (typeof BROWSER_PANES)[number];
export type Pane = BrowserPane | "details";
type CatalogPane = Exclude<BrowserPane, "run">;
export type DashboardViewKey =
  | "overview"
  | "catalog"
  | "logs"
  | "feed"
  | "settings";
export type BrowserView = Extract<DashboardViewKey, "overview" | "catalog">;

export interface LogsState extends LogFilter {
  readonly follow: boolean;
  readonly selected?: string;
}

function viewOfPane(pane: BrowserPane): BrowserView {
  return pane === "run" ? "overview" : "catalog";
}

export function isBrowserView(view: DashboardViewKey): view is BrowserView {
  return view === "overview" || view === "catalog";
}

export interface DashboardState {
  readonly breakdown: boolean;
  readonly catalogPane: CatalogPane;
  readonly draft: string;
  readonly expanded: ReadonlySet<string>;
  readonly filter?: CatalogSelection;
  readonly focus: BrowserPane;
  readonly help: boolean;
  readonly inspecting: boolean;
  readonly launching?: string;
  readonly logs: LogsState;
  readonly prompt?: RunPrompt;
  readonly queries: Readonly<Record<BrowserPane, string>>;
  readonly remembered: Readonly<
    Partial<Record<BrowserPane, DashboardSelection>>
  >;
  readonly returnView?: Exclude<DashboardViewKey, "logs" | "settings">;
  readonly searching: boolean;
  readonly selected?: DashboardSelection;
  readonly tab: InspectorTab;
  readonly view: DashboardViewKey;
}

export type DashboardEvent =
  | { readonly type: "view"; readonly view: DashboardViewKey }
  | { readonly type: "focus"; readonly pane: BrowserPane }
  | { readonly type: "cycle"; readonly backwards: boolean }
  | { readonly type: "select"; readonly selection: DashboardSelection }
  | { readonly type: "inspect"; readonly selection?: DashboardSelection }
  | { readonly type: "back" }
  | { readonly type: "close-utility" }
  | { readonly type: "move"; readonly by: number }
  | { readonly type: "fold"; readonly open?: boolean }
  | { readonly type: "toggle"; readonly selection: DashboardSelection }
  | { readonly type: "tab"; readonly tab: InspectorTab }
  | { readonly type: "cycle-tab"; readonly by: number }
  | { readonly type: "jump"; readonly status: "running" | "failed" }
  | { readonly type: "filter"; readonly filter: CatalogSelection }
  | { readonly type: "clear-filters" }
  | { readonly type: "search"; readonly open: boolean }
  | { readonly type: "query"; readonly value: string }
  | { readonly type: "cancel-search" }
  | { readonly type: "help"; readonly open: boolean }
  | { readonly type: "home" }
  | { readonly type: "prompt"; readonly prompt?: RunPrompt }
  | { readonly type: "draft"; readonly value: string }
  | { readonly type: "show-run"; readonly id: string }
  | { readonly type: "launch-form"; readonly id?: string }
  | { readonly type: "log-move"; readonly by: number }
  | { readonly type: "log-run"; readonly id: string }
  | { readonly type: "log-level" }
  | { readonly type: "log-source" }
  | { readonly type: "log-follow" }
  | { readonly type: "log-clear" }
  | { readonly type: "breakdown"; readonly open: boolean };

export function launchesDirectly(definition: DefinitionSnapshot): boolean {
  return definition.input !== undefined && definition.input.fields.length === 0;
}

export function paneOf(state: DashboardState): Pane {
  return state.inspecting ? "details" : state.focus;
}

export function visibleLists(
  state: DashboardState,
  snapshot: DashboardSnapshot
) {
  return {
    definitions: snapshot.definitions.filter((item) =>
      matches(`${item.name} ${item.kind}`, state.queries.definition)
    ),
    rows: runRows(
      matchingRuns(scopedRuns(snapshot, state.filter), state.queries.run),
      state.expanded
    ),
    triggers: snapshot.triggers.filter((item) =>
      matches(`${item.name} ${item.kind} ${item.status}`, state.queries.trigger)
    ),
  };
}

function entries(
  state: DashboardState,
  snapshot: DashboardSnapshot,
  pane: BrowserPane
): DashboardSelection[] {
  const lists = visibleLists(state, snapshot);
  if (pane === "trigger") {
    return lists.triggers.map(triggerSelection);
  }
  if (pane === "definition") {
    return lists.definitions.map(({ id }) => ({ id, kind: "definition" }));
  }
  return lists.rows.map((row) => row.selection);
}

function same(
  a: DashboardSelection | undefined,
  b: DashboardSelection | undefined
): boolean {
  return (
    a !== undefined && b !== undefined && selectionKey(a) === selectionKey(b)
  );
}

export function initialState(snapshot: DashboardSnapshot): DashboardState {
  const run =
    snapshot.runs.find((item) => item.status === "running") ?? snapshot.runs[0];
  const [trigger] = snapshot.triggers;
  const [definition] = snapshot.definitions;
  let selected: DashboardSelection | undefined;
  if (run) {
    selected = runSelection(run);
  } else if (trigger) {
    selected = triggerSelection(trigger);
  } else if (definition) {
    selected = { id: definition.id, kind: "definition" };
  }
  const focused = selected?.kind ?? "trigger";
  return {
    breakdown: false,
    catalogPane: focused === "run" ? "trigger" : focused,
    draft: "",
    expanded: new Set(run ? expandedRun(run) : []),
    focus: focused,
    help: false,
    inspecting: false,
    logs: NO_LOG_FILTERS,
    queries: { definition: "", run: "", trigger: "" },
    remembered: selected ? { [selected.kind]: selected } : {},
    searching: false,
    selected,
    tab: "overview",
    view: viewOfPane(focused),
  };
}

const NO_LOG_FILTERS: LogsState = {
  follow: true,
  level: "debug",
  query: "",
  source: "all",
};

export function visibleLogs(
  state: DashboardState,
  snapshot: DashboardSnapshot
): readonly OperatingLogEntry[] {
  return filterLogs(operatingLogs(snapshot), state.logs);
}

export function selectedLog(
  state: DashboardState,
  lines: readonly OperatingLogEntry[]
): OperatingLogEntry | undefined {
  const chosen = state.logs.follow
    ? undefined
    : lines.find((line) => line.id === state.logs.selected);
  return chosen ?? lines.at(-1);
}

function moveLog(
  state: DashboardState,
  snapshot: DashboardSnapshot,
  by: number
): DashboardState {
  const lines = visibleLogs(state, snapshot);
  const current = selectedLog(state, lines);
  const index = current ? lines.indexOf(current) : lines.length - 1;
  const next = lines[Math.max(0, Math.min(lines.length - 1, index + by))];
  return next
    ? { ...state, logs: { ...state.logs, follow: false, selected: next.id } }
    : state;
}

function cycled<T>(values: readonly T[], value: T): T {
  return values[(values.indexOf(value) + 1) % values.length] ?? value;
}

function select(
  state: DashboardState,
  selection: DashboardSelection
): DashboardState {
  return {
    ...state,
    breakdown: false,
    catalogPane: selection.kind === "run" ? state.catalogPane : selection.kind,
    focus: selection.kind,
    inspecting: false,
    remembered: { ...state.remembered, [selection.kind]: selection },
    selected: selection,
    view: viewOfPane(selection.kind),
  };
}

function toggled(expanded: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

function focus(
  state: DashboardState,
  snapshot: DashboardSnapshot,
  pane: BrowserPane
): DashboardState {
  const available = entries(state, snapshot, pane);
  const saved = state.remembered[pane];
  const value = available.find((item) => same(item, saved)) ?? available[0];
  const focused = {
    ...state,
    breakdown: false,
    catalogPane: pane === "run" ? state.catalogPane : pane,
    focus: pane,
    inspecting: false,
    searching: false,
    view: viewOfPane(pane),
  };
  return value ? select(focused, value) : { ...focused, selected: undefined };
}

function move(
  state: DashboardState,
  snapshot: DashboardSnapshot,
  by: number
): DashboardState {
  if (state.inspecting) {
    return state;
  }
  const available = entries(state, snapshot, state.focus);
  const index = available.findIndex((item) => same(item, state.selected));
  const next =
    available[Math.max(0, Math.min(available.length - 1, index + by))];
  return next ? select(state, next) : state;
}

function fold(
  state: DashboardState,
  snapshot: DashboardSnapshot,
  open: boolean | undefined
): DashboardState {
  const row: RunRow | undefined = visibleLists(state, snapshot).rows.find(
    (item) => same(item.selection, state.selected)
  );
  if (!row?.branch || (open !== undefined && row.expanded === open)) {
    return state;
  }
  return {
    ...state,
    expanded: toggled(state.expanded, selectionKey(row.selection)),
  };
}

function jump(
  state: DashboardState,
  snapshot: DashboardSnapshot,
  status: "running" | "failed"
): DashboardState {
  const run = scopedRuns(snapshot, state.filter).find(
    (item) =>
      item.status === status ||
      flattenSteps(item.steps).some((entry) => entry.step.status === status) ||
      item.activities?.some((candidate) => candidate.status === status)
  );
  if (!run) {
    return state;
  }
  const step = flattenSteps(run.steps).findLast(
    (entry) => entry.step.status === status
  )?.step;
  const activity = run.activities?.findLast((item) => item.status === status);
  const selection: DashboardSelection = activity
    ? runSelection(run, {
        activityId: activity.id,
        sessionId: activity.sessionId,
      })
    : runSelection(run, step === undefined ? {} : { stepId: step.id });
  return select(
    {
      ...state,
      expanded: new Set([...state.expanded, ...expandedRun(run)]),
      queries: { ...state.queries, run: "" },
      tab: "overview",
    },
    selection
  );
}

function filter(
  state: DashboardState,
  snapshot: DashboardSnapshot,
  value: CatalogSelection
): DashboardState {
  const filtered = {
    ...state,
    filter: value,
    queries: { ...state.queries, run: "" },
  };
  const [run] = scopedRuns(snapshot, value);
  return run
    ? select(filtered, runSelection(run))
    : {
        ...filtered,
        focus: "run",
        inspecting: false,
        selected: undefined,
        view: "overview",
      };
}

function cycleTab(state: DashboardState, by: number): DashboardState {
  const count = INSPECTOR_TABS.length;
  const index = INSPECTOR_TABS.indexOf(state.tab);
  return {
    ...state,
    tab: INSPECTOR_TABS[(index + by + count) % count] ?? state.tab,
  };
}

function cyclePane(
  state: DashboardState,
  snapshot: DashboardSnapshot,
  backwards: boolean
): DashboardState {
  if (state.inspecting) {
    return { ...state, inspecting: false };
  }
  const count = BROWSER_PANES.length;
  const index = BROWSER_PANES.indexOf(state.focus);
  const next = BROWSER_PANES[(index + (backwards ? count - 1 : 1)) % count];
  return next ? focus(state, snapshot, next) : state;
}

const NO_QUERIES = { definition: "", run: "", trigger: "" } as const;

function showView(
  state: DashboardState,
  snapshot: DashboardSnapshot,
  view: DashboardViewKey
): DashboardState {
  if (view === "overview") {
    return focus({ ...state, returnView: undefined }, snapshot, "run");
  }
  if (view === "catalog") {
    return focus(
      { ...state, returnView: undefined },
      snapshot,
      state.catalogPane
    );
  }
  if (view === "logs" || view === "settings") {
    const prior =
      state.view === "logs" || state.view === "settings"
        ? state.returnView
        : state.view;
    return { ...state, returnView: prior, searching: false, view };
  }
  return { ...state, returnView: undefined, searching: false, view };
}

export function reduce(
  state: DashboardState,
  event: DashboardEvent,
  snapshot: DashboardSnapshot
): DashboardState {
  switch (event.type) {
    case "view":
      return showView(state, snapshot, event.view);
    case "focus":
      return focus(state, snapshot, event.pane);
    case "cycle":
      return cyclePane(state, snapshot, event.backwards);
    case "select":
      return select(state, event.selection);
    case "inspect": {
      const next = event.selection ? select(state, event.selection) : state;
      return { ...next, inspecting: true };
    }
    case "close-utility":
      return {
        ...state,
        returnView: undefined,
        view: state.returnView ?? "overview",
      };
    case "back":
      return { ...state, inspecting: false };
    case "move":
      return move(state, snapshot, event.by);
    case "fold":
      return fold(state, snapshot, event.open);
    case "toggle":
      return {
        ...state,
        expanded: toggled(state.expanded, selectionKey(event.selection)),
      };
    case "tab":
      return { ...state, inspecting: true, tab: event.tab };
    case "cycle-tab":
      return cycleTab(state, event.by);
    case "jump":
      return jump(state, snapshot, event.status);
    case "filter":
      return filter(state, snapshot, event.filter);
    case "clear-filters":
      return { ...state, filter: undefined, queries: NO_QUERIES };
    case "search":
      return { ...state, searching: event.open };
    case "query":
      if (state.view === "logs") {
        return { ...state, logs: { ...state.logs, query: event.value } };
      }
      return state.inspecting
        ? state
        : {
            ...state,
            queries: { ...state.queries, [state.focus]: event.value },
          };
    case "cancel-search":
      if (state.view === "logs") {
        return {
          ...state,
          logs: { ...state.logs, query: "" },
          searching: false,
        };
      }
      return {
        ...state,
        queries: state.inspecting
          ? state.queries
          : { ...state.queries, [state.focus]: "" },
        searching: false,
      };
    case "help":
      return { ...state, help: event.open };
    case "home":
      return {
        ...state,
        breakdown: false,
        help: false,
        inspecting: false,
        searching: false,
        view: viewOfPane(state.focus),
      };
    case "prompt":
      return { ...state, draft: "", prompt: event.prompt };
    case "draft":
      return { ...state, draft: event.value };
    case "show-run":
      return select(
        {
          ...state,
          expanded: new Set([
            ...state.expanded,
            selectionKey({ id: event.id, kind: "run" }),
          ]),
          filter: undefined,
          help: false,
          launching: undefined,
          queries: NO_QUERIES,
          searching: false,
          tab: "overview",
        },
        { id: event.id, kind: "run" }
      );
    case "launch-form":
      return { ...state, launching: event.id };
    case "log-run":
      return {
        ...showView(state, snapshot, "logs"),
        logs: { ...NO_LOG_FILTERS, runId: event.id },
      };
    case "log-move":
      return moveLog(state, snapshot, event.by);
    case "log-level":
      return {
        ...state,
        logs: { ...state.logs, level: cycled(LOG_LEVELS, state.logs.level) },
      };
    case "log-source":
      return {
        ...state,
        logs: {
          ...state.logs,
          source: cycled(LOG_SOURCES, state.logs.source),
        },
      };
    case "log-follow":
      return {
        ...state,
        logs: { ...state.logs, follow: !state.logs.follow },
      };
    case "log-clear":
      return { ...state, logs: NO_LOG_FILTERS };
    case "breakdown":
      return event.open
        ? {
            ...state,
            breakdown: true,
            inspecting: false,
            searching: false,
            view: "overview",
          }
        : { ...state, breakdown: false };
    default:
      return state;
  }
}
