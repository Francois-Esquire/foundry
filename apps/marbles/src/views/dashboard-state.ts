import {
  type DashboardSelection,
  type DashboardSnapshot,
  type DefinitionSnapshot,
  flattenSteps,
  selectionKey,
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
/** The three lists; details opens from one of them. */
export type BrowserPane = (typeof BROWSER_PANES)[number];
export type Pane = BrowserPane | "details";
export type DashboardViewKey = "dashboard" | "feed";

/**
 * Everything the dashboard remembers between keys. The host's snapshot is not
 * here: it arrives with each event, and selections are looked up in it.
 */
export interface DashboardState {
  readonly draft: string;
  /** Selection keys of open run branches. */
  readonly expanded: ReadonlySet<string>;
  /** Runs shown only for this trigger or definition. */
  readonly filter?: CatalogSelection;
  /** The list with the keyboard, or the one details opened from. A selection is always of its kind. */
  readonly focus: BrowserPane;
  readonly help: boolean;
  /** Details has the keyboard instead of `focus`. */
  readonly inspecting: boolean;
  /** The definition whose argument form is open; the dashboard keys wait for it. */
  readonly launching?: string;
  /** A steer or resume prompt taking a line of text. */
  readonly prompt?: RunPrompt;
  readonly queries: Readonly<Record<BrowserPane, string>>;
  /** Each list's last selection, restored when the list takes focus again. */
  readonly remembered: Readonly<
    Partial<Record<BrowserPane, DashboardSelection>>
  >;
  readonly searching: boolean;
  readonly selected?: DashboardSelection;
  readonly tab: InspectorTab;
  readonly view: DashboardViewKey;
}

export type DashboardEvent =
  | { readonly type: "view"; readonly view: DashboardViewKey }
  | { readonly type: "focus"; readonly pane: BrowserPane }
  /** Tab: the next list, or back out of details. */
  | { readonly type: "cycle"; readonly backwards: boolean }
  | { readonly type: "select"; readonly selection: DashboardSelection }
  /** Open details, on `selection` when given. */
  | { readonly type: "inspect"; readonly selection?: DashboardSelection }
  | { readonly type: "back" }
  | { readonly type: "move"; readonly by: number }
  /** Open, close, or (undefined) flip the selected run branch. */
  | { readonly type: "fold"; readonly open?: boolean }
  | { readonly type: "toggle"; readonly selection: DashboardSelection }
  | { readonly type: "tab"; readonly tab: InspectorTab }
  | { readonly type: "cycle-tab"; readonly by: number }
  /** Select the latest running or failed step in the filtered runs. */
  | { readonly type: "jump"; readonly status: "running" | "failed" }
  | { readonly type: "filter"; readonly filter: CatalogSelection }
  | { readonly type: "clear-filters" }
  | { readonly type: "search"; readonly open: boolean }
  | { readonly type: "query"; readonly value: string }
  /** Esc while searching: drop the focused list's query too. */
  | { readonly type: "cancel-search" }
  | { readonly type: "help"; readonly open: boolean }
  | { readonly type: "home" }
  | { readonly type: "prompt"; readonly prompt?: RunPrompt }
  | { readonly type: "draft"; readonly value: string }
  /** Close any argument form, clear filters, and select a run that just started. */
  | { readonly type: "show-run"; readonly id: string }
  | { readonly type: "launch-form"; readonly id?: string };

/** A definition with no arguments to ask for starts on `l`; the rest open the argument form. */
export function launchesDirectly(definition: DefinitionSnapshot): boolean {
  return definition.input !== undefined && definition.input.fields.length === 0;
}

export function paneOf(state: DashboardState): Pane {
  return state.inspecting ? "details" : state.focus;
}

/** The three lists after search and the run filter. */
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
    return lists.triggers.map(({ id }) => ({ id, kind: "trigger" }));
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

/** The running run, else the newest, else the first trigger or definition. */
export function initialState(snapshot: DashboardSnapshot): DashboardState {
  const run =
    snapshot.runs.find((item) => item.status === "running") ?? snapshot.runs[0];
  const [trigger] = snapshot.triggers;
  const [definition] = snapshot.definitions;
  let selected: DashboardSelection | undefined;
  if (run) {
    selected = { id: run.id, kind: "run" };
  } else if (trigger) {
    selected = { id: trigger.id, kind: "trigger" };
  } else if (definition) {
    selected = { id: definition.id, kind: "definition" };
  }
  return {
    draft: "",
    expanded: new Set(run ? expandedRun(run) : []),
    focus: selected?.kind ?? "trigger",
    help: false,
    inspecting: false,
    queries: { definition: "", run: "", trigger: "" },
    remembered: selected ? { [selected.kind]: selected } : {},
    searching: false,
    selected,
    tab: "overview",
    view: "dashboard",
  };
}

function select(
  state: DashboardState,
  selection: DashboardSelection
): DashboardState {
  return {
    ...state,
    focus: selection.kind,
    inspecting: false,
    remembered: { ...state.remembered, [selection.kind]: selection },
    selected: selection,
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

/** Focus a list, back on its remembered row while that row is still listed. */
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
    focus: pane,
    inspecting: false,
    searching: false,
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
    ? {
        activityId: activity.id,
        id: run.id,
        kind: "run",
        sessionId: activity.sessionId,
      }
    : { id: run.id, kind: "run", stepId: step?.id };
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
    ? select(filtered, { id: run.id, kind: "run" })
    : { ...filtered, focus: "run", inspecting: false, selected: undefined };
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

/** Every dashboard state change, with no rendering or I/O. */
export function reduce(
  state: DashboardState,
  event: DashboardEvent,
  snapshot: DashboardSnapshot
): DashboardState {
  switch (event.type) {
    case "view":
      return { ...state, view: event.view };
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
      return state.inspecting
        ? state
        : {
            ...state,
            queries: { ...state.queries, [state.focus]: event.value },
          };
    case "cancel-search":
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
        help: false,
        inspecting: false,
        searching: false,
        view: "dashboard",
      };
    case "prompt":
      return { ...state, draft: "", prompt: event.prompt };
    case "draft":
      return { ...state, draft: event.value };
    case "show-run":
      return select(
        {
          ...state,
          expanded: new Set([...state.expanded, `run:${event.id}`]),
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
    default:
      return state;
  }
}
