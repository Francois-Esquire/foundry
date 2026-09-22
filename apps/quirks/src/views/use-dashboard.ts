import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useState } from "react";
import type { DashboardViewKey } from "~/components/blocks/view-tabs";
import {
  type DashboardSelection,
  type DashboardSnapshot,
  flattenSteps,
  selectionKey,
} from "./dashboard-model";
import {
  type CatalogSelection,
  expandedRun,
  matches,
  matchingRuns,
  runRows,
  scopedRuns,
} from "./dashboard-tree";

const INSPECTOR_TABS = ["overview", "input", "output", "logs"] as const;
export type InspectorTab = (typeof INSPECTOR_TABS)[number];
const PANES = ["trigger", "definition", "run"] as const;
type Pane = (typeof PANES)[number] | "details";
type BrowserPane = Exclude<Pane, "details">;

function initial(snapshot: DashboardSnapshot): DashboardSelection | undefined {
  const run =
    snapshot.runs.find((item) => item.status === "running") ?? snapshot.runs[0];
  if (run) {
    return { id: run.id, kind: "run" };
  }
  if (snapshot.triggers[0]) {
    return { id: snapshot.triggers[0].id, kind: "trigger" };
  }
  const [definition] = snapshot.definitions;
  return definition ? { id: definition.id, kind: "definition" } : undefined;
}

/** Shift+D and Shift+F; plain `d` and `f` keep their pane meanings. */
function viewShortcut(key: KeyEvent): DashboardViewKey | undefined {
  const letter = key.shift ? key.name : undefined;
  if (key.sequence === "D" || letter === "d") {
    return "dashboard";
  }
  if (key.sequence === "F" || letter === "f") {
    return "feed";
  }
  return undefined;
}

export function useDashboard(
  snapshot: DashboardSnapshot,
  onClose: () => void,
  onShortcut?: (key: KeyEvent) => void,
  blocked = false,
  onLaunch?: (id: string) => void,
  onFeedKey?: (key: KeyEvent) => void,
  /** The feed is taking typed text: every key but Ctrl+C goes to it. */
  feedCapturesKeys = false
) {
  const [view, setView] = useState<DashboardViewKey>("dashboard");
  const [selected, setSelected] = useState(() => initial(snapshot));
  const [pane, setPane] = useState<Pane>(
    () => initial(snapshot)?.kind ?? "trigger"
  );
  const [remembered, setRemembered] = useState<
    Partial<Record<BrowserPane, DashboardSelection>>
  >(() => {
    const selection = initial(snapshot);
    return selection ? { [selection.kind]: selection } : {};
  });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    const run = snapshot.runs.find((item) => item.id === initial(snapshot)?.id);
    return new Set(run ? expandedRun(run) : []);
  });
  const [filter, setFilter] = useState<CatalogSelection>();
  const [queries, setQueries] = useState({
    definition: "",
    run: "",
    trigger: "",
  });
  const [searching, setSearching] = useState(false);
  const [help, setHelp] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const cancelQuit = useCallback(() => setQuitting(false), []);
  const [tab, setTab] = useState<InspectorTab>("overview");
  const triggers = snapshot.triggers.filter((item) =>
    matches(`${item.name} ${item.kind} ${item.status}`, queries.trigger)
  );
  const definitions = snapshot.definitions.filter((item) =>
    matches(`${item.name} ${item.kind}`, queries.definition)
  );
  const runs = matchingRuns(scopedRuns(snapshot, filter), queries.run);
  const rows = runRows(runs, expanded);

  const goHome = useCallback(() => {
    setHelp(false);
    setSearching(false);
    setView("dashboard");
    setPane(selected?.kind ?? "run");
  }, [selected?.kind]);
  const select = useCallback((selection: DashboardSelection) => {
    const next = selection.kind;
    setSelected(selection);
    setRemembered((previous) => ({ ...previous, [next]: selection }));
    setPane(next);
  }, []);
  const inspect = useCallback(
    (selection: DashboardSelection) => {
      select(selection);
      setPane("details");
    },
    [select]
  );
  const toggle = useCallback((selection: DashboardSelection) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      const key = selectionKey(selection);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);
  const changeTab = useCallback((value: InspectorTab) => {
    setTab(value);
    setPane("details");
  }, []);
  const setQuery = useCallback(
    (value: string) => {
      if (pane !== "details") {
        setQueries((previous) => ({ ...previous, [pane]: value }));
      }
    },
    [pane]
  );
  const finishSearch = useCallback(() => setSearching(false), []);
  const clearFilters = useCallback(() => {
    setFilter(undefined);
    setQueries({ definition: "", run: "", trigger: "" });
  }, []);
  const filterRuns = useCallback(
    (value: CatalogSelection) => {
      setFilter(value);
      setQueries((previous) => ({ ...previous, run: "" }));
      const [run] = scopedRuns(snapshot, value);
      if (run) {
        select({ id: run.id, kind: "run" });
      } else {
        setPane("run");
        setSelected(undefined);
      }
    },
    [select, snapshot]
  );

  function entries(target: Pane): DashboardSelection[] {
    if (target === "trigger") {
      return triggers.map(({ id }) => ({ id, kind: "trigger" }));
    }
    if (target === "definition") {
      return definitions.map(({ id }) => ({ id, kind: "definition" }));
    }
    if (target === "run") {
      return rows.map((row) => row.selection);
    }
    return [];
  }
  function focusPane(next: Pane) {
    setSearching(false);
    setPane(next);
    if (next === "details") {
      return;
    }
    const saved = remembered[next];
    const available = entries(next);
    const value =
      available.find(
        (item) => saved && selectionKey(item) === selectionKey(saved)
      ) ?? available[0];
    if (value) {
      select(value);
    } else {
      setSelected(undefined);
    }
  }
  function back() {
    setPane(selected?.kind ?? "trigger");
  }
  function changePane(backwards: boolean) {
    if (pane === "details") {
      back();
      return;
    }
    const next =
      PANES[
        (PANES.indexOf(pane) + (backwards ? PANES.length - 1 : 1)) %
          PANES.length
      ];
    if (next) {
      focusPane(next);
    }
  }
  function move(direction: number) {
    const available = entries(pane);
    const index = available.findIndex(
      (item) => selected && selectionKey(item) === selectionKey(selected)
    );
    const next =
      available[Math.max(0, Math.min(available.length - 1, index + direction))];
    if (next) {
      select(next);
    }
  }
  function expand(open?: boolean) {
    const row = rows.find(
      (item) =>
        selected && selectionKey(item.selection) === selectionKey(selected)
    );
    if (row?.branch && (open === undefined || row.expanded !== open)) {
      toggle(row.selection);
    }
  }
  function horizontal(direction: number) {
    if (pane === "run") {
      expand(direction > 0);
    }
    if (pane === "details") {
      const next =
        INSPECTOR_TABS[
          (INSPECTOR_TABS.indexOf(tab) + direction + INSPECTOR_TABS.length) %
            INSPECTOR_TABS.length
        ];
      if (next) {
        setTab(next);
      }
    }
  }
  function jump(status: "running" | "failed") {
    const candidates = scopedRuns(snapshot, filter);
    const run = candidates.find(
      (item) =>
        item.status === status ||
        flattenSteps(item.steps).some((entry) => entry.step.status === status)
    );
    if (!run) {
      return;
    }
    const step = flattenSteps(run.steps).findLast(
      (entry) => entry.step.status === status
    )?.step;
    setExpanded((previous) => new Set([...previous, ...expandedRun(run)]));
    setQueries((previous) => ({ ...previous, run: "" }));
    select({ id: run.id, kind: "run", stepId: step?.id });
    setTab("overview");
  }
  function navigate(key: KeyEvent) {
    switch (key.name) {
      case "1":
        focusPane("trigger");
        break;
      case "3":
        focusPane("run");
        break;
      case "2":
      case "c":
        focusPane("definition");
        break;
      case "tab":
        changePane(key.shift);
        break;
      case "return":
      case "enter":
        setPane("details");
        break;
      case "escape":
        back();
        break;
      case "up":
        if (pane !== "details") {
          move(-1);
        }
        break;
      case "down":
        if (pane !== "details") {
          move(1);
        }
        break;
      case "left":
        horizontal(-1);
        break;
      case "right":
        horizontal(1);
        break;
      case "space":
        if (pane === "run") {
          expand();
        }
        break;
      default:
        break;
    }
  }
  function commands(key: KeyEvent) {
    if (key.name === "l" && selected?.kind === "definition") {
      onLaunch?.(selected.id);
    }
    if (key.name === "b" && pane === "details" && selected?.kind === "run") {
      inspect({ id: selected.id, kind: "run" });
    }
    if (key.sequence === "/" && pane !== "details") {
      setSearching(true);
    }
    if (key.sequence === "?") {
      setHelp(true);
    }
    if (key.name === "a") {
      jump("running");
    }
    if (key.name === "e") {
      jump("failed");
    }
    if (key.name === "x") {
      clearFilters();
    }
    if (key.name === "f" && selected && selected.kind !== "run") {
      filterRuns(selected);
    }
  }
  function handleGlobalKey(key: KeyEvent): boolean {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (key.repeated) {
        return true;
      }
      if (quitting) {
        onClose();
      } else {
        setQuitting(true);
      }
      return true;
    }
    if (quitting) {
      return true;
    }
    if (key.name === "q" && !searching) {
      setQuitting(true);
      return true;
    }
    if (key.name === "h" && !searching) {
      goHome();
      return true;
    }
    return false;
  }
  /** Typing into the feed: every key but Ctrl+C belongs to it. */
  function feedTakesKey(key: KeyEvent): boolean {
    const interrupt = key.ctrl && key.name === "c";
    return view === "feed" && feedCapturesKeys && !interrupt;
  }
  /** Tab switching, and every key while the Feed tab is showing. */
  function handleViewKey(key: KeyEvent): boolean {
    const target = viewShortcut(key);
    if (target) {
      setView(target);
      return true;
    }
    if (view !== "feed") {
      return false;
    }
    if (key.sequence === "?") {
      setHelp(true);
    } else {
      onFeedKey?.(key);
    }
    return true;
  }
  useKeyboard((key) => {
    if (blocked) {
      return;
    }
    if (feedTakesKey(key)) {
      onFeedKey?.(key);
      return;
    }
    if (handleGlobalKey(key)) {
      return;
    }
    if (help) {
      if (key.name === "escape" || key.sequence === "?") {
        setHelp(false);
      }
      return;
    }
    if (searching) {
      if (key.name === "escape") {
        setQuery("");
        setSearching(false);
      }
      return;
    }
    onShortcut?.(key);
    if (handleViewKey(key)) {
      return;
    }
    navigate(key);
    commands(key);
  });
  return {
    cancelQuit,
    changeTab,
    clearFilters,
    definitions,
    filter,
    filterRuns,
    finishSearch,
    goHome,
    help,
    inputActive: searching || help || quitting,
    inspect,
    pane,
    queries,
    query: pane === "details" ? "" : queries[pane],
    quitting,
    rows,
    runs,
    searching,
    select,
    selected,
    setQuery,
    setView,
    showRun(id: string) {
      clearFilters();
      setHelp(false);
      setSearching(false);
      select({ id, kind: "run" });
      setTab("overview");
      setExpanded((previous) => new Set([...previous, `run:${id}`]));
    },
    tab,
    toggle,
    triggers,
    view,
  };
}
