import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useMemo, useState } from "react";
import { useAsyncAction } from "~/hooks/use-async-action";
import { useQuitGuard } from "~/hooks/use-quit-guard";
import type { WorkspaceState, WorkspaceSummary } from "~/model/connection";
import type { SettingsChange, ThemeName } from "~/model/settings";
import {
  type CommandContext,
  capturesKeys,
  commandFor,
  footer,
} from "./dashboard-commands";
import {
  type DashboardSelection,
  type DashboardSnapshot,
  resolveSelection,
} from "./dashboard-model";
import {
  type DashboardEvent,
  type DashboardState,
  type DashboardViewKey,
  type InspectorTab,
  initialState,
  launchesDirectly,
  paneOf,
  reduce,
  selectedLog,
  visibleLists,
  visibleLogs,
} from "./dashboard-state";
import type { CatalogSelection } from "./dashboard-tree";
import {
  filterLogs,
  logRun,
  type OperatingLogEntry,
  operatingLogs,
} from "./operating-model";
import type { Launcher, RunActions } from "./run-actions";
import { type AnswerHandler, useFeed } from "./use-feed";
import { showsOthers, workspaceScoped } from "./workspace-scope";

export interface HostedWorkspace {
  readonly count: number;
  readonly error?: string;
  readonly position: number;
  readonly state: WorkspaceState;
  readonly workspaces?: readonly WorkspaceSummary[];
}

export interface DashboardOptions {
  readonly actions?: RunActions;
  readonly hosted?: HostedWorkspace;
  readonly onAnswer?: AnswerHandler;
  readonly onClose: () => void;
  readonly onLaunch?: Launcher;
  readonly onRollSchedule?: (key: string) => Promise<void>;
  readonly onSettings?: (changes: SettingsChange) => Promise<void>;
  readonly onShortcut?: (key: KeyEvent) => void;
  readonly onSwitchWorkspace?: (id?: string) => void;
  readonly onWorkspaceRail?: (show: boolean) => void;
  readonly snapshot: DashboardSnapshot;
  readonly workspaceRail?: boolean;
}

function selectLog(
  previous: DashboardState,
  snapshot: DashboardSnapshot,
  entry: OperatingLogEntry
): DashboardState {
  const lines = visibleLogs(previous, snapshot);
  const target = lines.findIndex((line) => line.id === entry.id);
  if (target === -1) {
    return previous;
  }
  const current = selectedLog(previous, lines);
  const from = current ? lines.indexOf(current) : lines.length - 1;
  return reduce(previous, { by: target - from, type: "log-move" }, snapshot);
}

export function useDashboard({
  actions,
  hosted,
  onAnswer,
  onClose,
  onLaunch,
  onRollSchedule,
  onSettings,
  onShortcut,
  onSwitchWorkspace,
  onWorkspaceRail,
  workspaceRail,
  snapshot: whole,
}: DashboardOptions) {
  const [everywhere, setEverywhere] = useState(false);
  const [picker, setPicker] = useState<string>();
  const workspaces = hosted?.workspaces ?? [];
  const openWorkspaces = () => {
    setPicker(whole.workspaceId ?? workspaces[0]?.id ?? "");
  };
  function chooseWorkspace(id: string) {
    setPicker(undefined);
    if (id !== whole.workspaceId) {
      onSwitchWorkspace?.(id);
    }
  }
  const snapshot = workspaceScoped(whole, everywhere);
  const [state, setState] = useState(() => {
    const initial = initialState(snapshot);
    return hosted
      ? reduce(initial, { type: "view", view: "overview" }, snapshot)
      : initial;
  });
  const send = (event: DashboardEvent) =>
    setState((previous) => reduce(previous, event, snapshot));
  const feed = useFeed(
    snapshot.feed,
    snapshot.workspaceId,
    onAnswer,
    hosted ? snapshot.workspaceId : undefined
  );
  const quit = useQuitGuard(onClose);
  const control = useAsyncAction();
  const starting = useAsyncAction();
  const resolved = resolveSelection(snapshot, state.selected);
  const form = onLaunch
    ? snapshot.definitions.find((item) => item.id === state.launching)
    : undefined;

  function launch(id: string) {
    const definition = snapshot.definitions.find((item) => item.id === id);
    if (!(onLaunch && definition)) {
      return;
    }
    starting.clear();
    if (!launchesDirectly(definition)) {
      send({ id, type: "launch-form" });
      return;
    }
    starting.run(async () => {
      send({ id: await onLaunch(id, undefined), type: "show-run" });
    });
  }

  function rollSchedule(id: string) {
    if (onRollSchedule) {
      starting.run(() => onRollSchedule(id));
    }
  }

  function submitPrompt() {
    const { draft, prompt } = state;
    if (!(prompt && actions)) {
      return;
    }
    const text = draft.trim();
    if (prompt.kind === "steer" && !text) {
      return;
    }
    send({ type: "prompt" });
    control.run(() =>
      prompt.kind === "steer"
        ? actions.steer(prompt.runId, prompt.stepId, text)
        : actions.resume(prompt.runId, prompt.stepId, text || undefined)
    );
  }

  const allLogs = useMemo(() => operatingLogs(snapshot), [snapshot]);
  const logs = filterLogs(allLogs, state.logs);
  const log = selectedLog(state, logs);
  const context: CommandContext = {
    actions,
    canLaunch: onLaunch !== undefined,
    canRollSchedule: onRollSchedule !== undefined,
    canSwitchWorkspace: workspaces.length > 0,
    feed,
    ...(log ? { log } : {}),
    resolved,
    ...(snapshot.settings
      ? {
          settings: {
            current: snapshot.settings,
            ...(onSettings ? { change: onSettings } : {}),
          },
        }
      : {}),
    canToggleRail: workspaces.length > 0 && onWorkspaceRail !== undefined,
    state,
    workspaces: { everywhere, others: showsOthers(whole) },
  };
  function handleWorkspaceKey(key: KeyEvent, highlighted: string) {
    if (key.name === "escape" || key.name === "w") {
      setPicker(undefined);
    } else if (key.name === "up" || key.name === "down") {
      const index = workspaces.findIndex((item) => item.id === highlighted);
      const by = key.name === "up" ? -1 : 1;
      const next =
        workspaces[(index + by + workspaces.length) % workspaces.length];
      if (next) {
        setPicker(next.id);
      }
    } else if (key.name === "return" || key.name === "enter") {
      chooseWorkspace(highlighted);
    }
  }
  useKeyboard((key) => {
    if (form !== undefined || quit.handleKey(key)) {
      return;
    }
    if (picker !== undefined) {
      handleWorkspaceKey(key, picker);
      return;
    }
    const command = commandFor(key, context);
    if (!capturesKeys(context)) {
      onShortcut?.(key);
    }
    command?.run(
      {
        ...context,
        act: control.run,
        launch,
        quit: quit.ask,
        rollSchedule,
        send,
        switchWorkspace: openWorkspaces,
        toggleRail: () => onWorkspaceRail?.(!workspaceRail),
        toggleWorkspaces: () => setEverywhere((all) => !all),
      },
      key
    );
  });

  return {
    ...visibleLists(state, snapshot),
    changeTab: (tab: InspectorTab) => send({ tab, type: "tab" }),
    changeTheme: (theme: ThemeName) => {
      if (onSettings && !quit.quitting && theme !== snapshot.settings?.theme) {
        control.run(() => onSettings({ theme }));
      }
    },
    chooseWorkspace,
    clearFilters: () => send({ type: "clear-filters" }),
    closeUtility: () => send({ type: "close-utility" }),
    closeWorkspaces: () => setPicker(undefined),
    control,
    feed,
    filterRuns: (filter: CatalogSelection) => send({ filter, type: "filter" }),
    finishSearch: () => send({ open: false, type: "search" }),
    footer: footer(context),
    form,
    goHome: () => send({ type: "home" }),
    inputActive:
      picker !== undefined ||
      state.searching ||
      state.help ||
      quit.quitting ||
      state.prompt !== undefined,
    inspect: (selection: DashboardSelection) =>
      send({ selection, type: "inspect" }),
    launch,
    leaveForm: () => send({ type: "launch-form" }),
    log,
    logs,
    logTotal: allLogs.length,
    openLog: (entry: OperatingLogEntry) => {
      if (entry.runId === undefined) {
        setState((previous) => selectLog(previous, snapshot, entry));
        return;
      }
      send({ selection: logRun(entry, entry.runId), type: "inspect" });
    },
    openWorkspaces,
    pane: paneOf(state),
    picker,
    quit,
    resolved,
    rollSchedule,
    setDraft: (value: string) => send({ type: "draft", value }),
    setQuery: (value: string) => send({ type: "query", value }),
    setView: (view: DashboardViewKey) => send({ type: "view", view }),
    showRun: (id: string) => send({ id, type: "show-run" }),
    snapshot,
    starting,
    state,
    submitPrompt,
    toggle: (selection: DashboardSelection) =>
      send({ selection, type: "toggle" }),
    workspaces,
  };
}
