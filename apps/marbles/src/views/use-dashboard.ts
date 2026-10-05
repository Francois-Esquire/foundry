import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useState } from "react";
import type { DashboardViewKey } from "~/components/blocks/view-tabs";
import {
  canStopActivity,
  type DashboardSelection,
  type DashboardSnapshot,
  flattenSteps,
  type RunSnapshot,
  selectedActivity,
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
import type { RunActions, RunPrompt } from "./run-actions";

const INSPECTOR_TABS = [
  "overview",
  "input",
  "output",
  "logs",
  "stream",
] as const;
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

/**
 * The step a run action applies to: the selected step, else the run's root,
 * whose frame is keyed by the definition's name.
 */
function actionTarget(
  run: RunSnapshot,
  stepId: string | undefined
): { readonly stepId: string; readonly status: string } {
  if (stepId === undefined) {
    return { status: run.status, stepId: run.definitionId };
  }
  const step = flattenSteps(run.steps).find(
    (entry) => entry.step.id === stepId
  );
  return { status: step?.step.status ?? run.status, stepId };
}

const PAUSED = new Set(["suspended", "paused"]);

export function useDashboard(
  snapshot: DashboardSnapshot,
  onClose: () => void,
  onShortcut?: (key: KeyEvent) => void,
  blocked = false,
  onLaunch?: (id: string) => void,
  onFeedKey?: (key: KeyEvent) => void,
  /** The feed is taking typed text: every key but Ctrl+C goes to it. */
  feedCapturesKeys = false,
  actions?: RunActions
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
  const [prompt, setPrompt] = useState<RunPrompt>();
  const [promptDraft, setPromptDraft] = useState("");
  const [actionError, setActionError] = useState<string>();
  const [actionBusy, setActionBusy] = useState(false);
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
        flattenSteps(item.steps).some(
          (entry) => entry.step.status === status
        ) ||
        item.activities?.some((candidate) => candidate.status === status)
    );
    if (!run) {
      return;
    }
    const step = flattenSteps(run.steps).findLast(
      (entry) => entry.step.status === status
    )?.step;
    setExpanded((previous) => new Set([...previous, ...expandedRun(run)]));
    setQueries((previous) => ({ ...previous, run: "" }));
    const activity = run.activities?.findLast((item) => item.status === status);
    select(
      activity
        ? {
            activityId: activity.id,
            id: run.id,
            kind: "run",
            sessionId: activity.sessionId,
          }
        : { id: run.id, kind: "run", stepId: step?.id }
    );
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
      case "m":
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
  /** Run an action, keeping its failure on screen instead of in the log. */
  function act(work: () => Promise<void>) {
    if (actionBusy) {
      return;
    }
    setActionBusy(true);
    setActionError(undefined);
    work()
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setActionBusy(false));
  }
  const cancelPrompt = useCallback(() => {
    setPrompt(undefined);
    setPromptDraft("");
  }, []);
  const submitPrompt = useCallback(() => {
    if (!(prompt && actions)) {
      return;
    }
    const text = promptDraft.trim();
    if (prompt.kind === "steer" && !text) {
      return;
    }
    const { kind, runId, stepId } = prompt;
    setPrompt(undefined);
    setPromptDraft("");
    act(() =>
      kind === "steer"
        ? actions.steer(runId, stepId, text)
        : actions.resume(runId, stepId, text || undefined)
    );
  }, [prompt, promptDraft, actions]);
  function runCommands(key: KeyEvent) {
    if (!(actions && selected?.kind === "run")) {
      return;
    }
    const run = snapshot.runs.find((item) => item.id === selected.id);
    if (!run) {
      return;
    }
    if (selected.activityId !== undefined) {
      activityCommands(key, run, selected, actions, act);
      return;
    }
    const { status, stepId } = actionTarget(run, selected.stepId);
    if (key.name === "k") {
      act(() => actions.cancel(run.id));
    }
    if (key.name === "p" && status === "running") {
      act(() => actions.pause(run.id, stepId));
    }
    if (key.name === "p" && PAUSED.has(status)) {
      setPrompt({ kind: "resume", runId: run.id, stepId });
    }
    if (key.name === "s" && status === "running") {
      setPrompt({ kind: "steer", runId: run.id, stepId });
    }
  }
  function triggerCommands(key: KeyEvent) {
    if (!(actions && selected?.kind === "trigger")) {
      return;
    }
    const trigger = snapshot.triggers.find((item) => item.id === selected.id);
    if (!trigger?.managed) {
      return;
    }
    const toggleEnabled = actions.setTriggerEnabled;
    const remove = actions.deleteTrigger;
    if (key.name === "p" && toggleEnabled) {
      act(() => toggleEnabled(trigger.id, trigger.status === "paused"));
    }
    if (key.name === "k" && remove) {
      act(() => remove(trigger.id));
    }
  }
  function commands(key: KeyEvent) {
    runCommands(key);
    triggerCommands(key);
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
  /** The help and search overlays take every key while showing. */
  function overlayTakesKey(key: KeyEvent): boolean {
    if (help) {
      if (key.name === "escape" || key.sequence === "?") {
        setHelp(false);
      }
      return true;
    }
    if (searching) {
      if (key.name === "escape") {
        setQuery("");
        setSearching(false);
      }
      return true;
    }
    return false;
  }
  /** Keys owned by a text field or an overlay; true when the key is spent. */
  function captured(key: KeyEvent): boolean {
    if (feedTakesKey(key)) {
      onFeedKey?.(key);
      return true;
    }
    // A steer or resume prompt has the keys; only Esc and Ctrl+C belong here.
    if (prompt && !(key.ctrl && key.name === "c")) {
      if (key.name === "escape") {
        cancelPrompt();
      }
      return true;
    }
    return handleGlobalKey(key) || overlayTakesKey(key);
  }
  useKeyboard((key) => {
    if (blocked || captured(key)) {
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
    actionBusy,
    actionError,
    actionHints: actionHints(snapshot, selected, actions),
    cancelPrompt,
    cancelQuit,
    changeTab,
    clearFilters,
    definitions,
    filter,
    filterRuns,
    finishSearch,
    goHome,
    help,
    inputActive: searching || help || quitting || prompt !== undefined,
    inspect,
    pane,
    prompt,
    promptDraft,
    queries,
    query: pane === "details" ? "" : queries[pane],
    quitting,
    rows,
    runs,
    searching,
    select,
    selected,
    setPromptDraft,
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
    submitPrompt,
    tab,
    toggle,
    triggers,
    view,
  };
}

function actionHints(
  snapshot: DashboardSnapshot,
  selection?: DashboardSelection,
  actions?: RunActions
): string | undefined {
  if (!(actions && selection)) {
    return undefined;
  }
  if (selection.kind === "run" && selection.activityId !== undefined) {
    const run = snapshot.runs.find((item) => item.id === selection.id);
    const activity = run && selectedActivity(run, selection);
    return activity && actions.stopActivity && canStopActivity(activity)
      ? "k stop activity"
      : "";
  }
  if (selection.kind === "trigger") {
    const trigger = snapshot.triggers.find((item) => item.id === selection.id);
    if (!trigger?.managed) {
      return "";
    }
    return [
      ...(actions.setTriggerEnabled
        ? [trigger.status === "paused" ? "p resume" : "p pause"]
        : []),
      ...(actions.deleteTrigger ? ["k delete trigger"] : []),
    ].join(" · ");
  }
  return undefined;
}

function activityCommands(
  key: KeyEvent,
  run: RunSnapshot,
  selection: DashboardSelection,
  actions: RunActions,
  act: (work: () => Promise<void>) => void
): void {
  const activity = selectedActivity(run, selection);
  const stop = actions.stopActivity;
  if (key.name === "k" && activity && stop && canStopActivity(activity)) {
    act(() => stop(activity.sessionId, activity.id));
  }
}
