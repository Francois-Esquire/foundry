import { useKeyboard } from "@opentui/react";
import { useMemo, useState } from "react";
import { useAsyncAction } from "~/cli/hooks/use-async-action";
import { useQuitGuard } from "~/cli/hooks/use-quit-guard";
import type { WorkspaceState, WorkspaceSummary } from "~/model/connection";
import type { SettingsChange, ThemeName } from "~/model/settings";
import { settingsView } from "../theme";
import {
  type CommandContext,
  capturesKeys,
  commandFor,
  footer,
  goesHome,
  openDiagnostics,
} from "./dashboard-commands";
import {
  type DashboardSelection,
  type DashboardSnapshot,
  resolveSelection,
} from "./dashboard-model";
import { workspaceDetails, workspaceRows } from "./dashboard-rows";
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
  settle,
  visibleLists,
  visibleLogs,
} from "./dashboard-state";
import type { CatalogSelection } from "./dashboard-tree";
import {
  browseSearch,
  browsing,
  catalogModel,
  type DrawerContent,
  type DrawerModel,
  drawerDock,
  logsDrawer,
  type MainModel,
  mainContent,
  overviewModel,
} from "./dashboard-views";
import { feedModel } from "./feed-model";
import type { InspectorModel } from "./inspector";
import {
  filterLogs,
  logRun,
  type OperatingLogEntry,
  operatingLogs,
} from "./operating-model";
import { type Launcher, promptTarget, type RunActions } from "./run-actions";
import { usageBreakdown } from "./usage-format";
import { type AnswerHandler, useFeed } from "./use-feed";
import { showsOthers, workspaceScoped } from "./workspace-scope";

export interface HostedWorkspace {
  readonly error?: string;
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
  readonly onSwitchWorkspace?: (id: string) => void;
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
  onSwitchWorkspace,
  onWorkspaceRail,
  workspaceRail,
  snapshot: whole,
}: DashboardOptions) {
  const [everywhere, setEverywhere] = useState(false);
  const workspaces = hosted?.workspaces ?? [];
  const snapshot = workspaceScoped(whole, everywhere);
  const [stored, setState] = useState(() => {
    const initial = initialState(snapshot);
    return hosted
      ? reduce(initial, { type: "view", view: "overview" }, snapshot)
      : initial;
  });
  const state = settle(stored, snapshot);
  const send = (event: DashboardEvent) =>
    setState((previous) => reduce(settle(previous, snapshot), event, snapshot));
  const openWorkspaces = () => {
    const id = whole.workspaceId ?? workspaces[0]?.id;
    if (id !== undefined) {
      send({ id, type: "picker" });
    }
  };
  function chooseWorkspace(id: string) {
    send({ type: "picker" });
    if (id !== whole.workspaceId && workspaces.some((item) => item.id === id)) {
      onSwitchWorkspace?.(id);
    }
  }
  const feed = useFeed(
    snapshot.feed,
    snapshot.workspaceId,
    onAnswer,
    hosted ? snapshot.workspaceId : undefined
  );
  const quit = useQuitGuard(onClose);
  const control = useAsyncAction();
  const starting = useAsyncAction();
  const schedule = useAsyncAction();
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
      schedule.run(() => onRollSchedule(id));
    }
  }

  function submitPrompt() {
    const { draft, prompt } = state;
    if (!(prompt && actions)) {
      return;
    }
    const text = draft.trim();
    if (prompt.kind === "resume") {
      control.run(async () => {
        await actions.resume(prompt.runId, prompt.stepId, text || undefined);
        send({ draft, prompt, type: "prompt-sent" });
      });
      return;
    }
    const target = promptTarget(prompt);
    if (!target || (target.input === "steer" && !text)) {
      return;
    }
    control.run(async () => {
      await actions.send(prompt.runId, target.stepId, {
        target: target.id,
        text: target.input === "stdin" ? draft : text,
      });
      send({ draft, prompt, type: "prompt-sent" });
    });
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
    workspaces: {
      everywhere,
      ids: workspaces.map(({ id }) => id),
      others: showsOthers(whole),
    },
  };
  const free = !(quit.quitting || capturesKeys(context));
  const unlessModal =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      if (free) {
        action(...args);
      }
    };

  useKeyboard((key) => {
    if (form !== undefined || quit.handleKey(key)) {
      return;
    }
    const command = commandFor(key, context);
    command?.run(
      {
        ...context,
        act: control.run,
        chooseWorkspace,
        launch,
        openWorkspaces,
        quit: quit.ask,
        rollSchedule,
        send,
        toggleRail: () => onWorkspaceRail?.(!workspaceRail),
        toggleWorkspaces: () => setEverywhere((all) => !all),
      },
      key
    );
  });

  const lists = visibleLists(state, snapshot);
  const pane = paneOf(state);
  const inspect = (selection: DashboardSelection) =>
    send({ selection, type: "inspect" });
  const clearFilters = () => send({ type: "clear-filters" });
  const setDraft = (value: string) => send({ type: "draft", value });
  const setQuery = (value: string) => send({ type: "query", value });
  const finishSearch = () => send({ open: false, type: "search" });
  const inputActive =
    state.picker !== undefined ||
    state.searching ||
    state.help ||
    quit.quitting ||
    state.prompt !== undefined;
  const utility = state.drawer !== undefined || state.picker !== undefined;
  const searchBar = {
    editing: state.searching,
    focused: !quit.quitting,
    onInput: setQuery,
    onSubmit: finishSearch,
  };

  function openLog(entry: OperatingLogEntry) {
    if (entry.runId === undefined) {
      setState((previous) =>
        selectLog(settle(previous, snapshot), snapshot, entry)
      );
      return;
    }
    send({ selection: logRun(entry, entry.runId), type: "inspect" });
  }

  function changeTheme(theme: ThemeName) {
    if (onSettings && !quit.quitting && theme !== snapshot.settings?.theme) {
      control.run(() => onSettings({ theme }));
    }
  }

  function drawerContent(): DrawerContent {
    if (state.picker !== undefined) {
      return {
        kind: "workspaces",
        workspaces: {
          current: snapshot.workspaceId,
          details: workspaceDetails(workspaces, state.picker),
          onSelect: chooseWorkspace,
          selected: state.picker,
          workspaces: workspaceRows(workspaces),
        },
      };
    }
    if (state.drawer === "settings") {
      return {
        kind: "settings",
        settings: {
          onRail: workspaces.length ? onWorkspaceRail : undefined,
          onTheme: onSettings ? changeTheme : undefined,
          rail: workspaceRail ?? false,
          settings: snapshot.settings && settingsView(snapshot.settings),
        },
      };
    }
    return logsDrawer(
      state,
      { entries: logs, selected: log, total: allLogs.length },
      { active: !inputActive, onSelect: openLog, search: searchBar }
    );
  }

  function inspector(active: boolean): InspectorModel {
    return {
      active,
      configurationShown: state.configuration,
      onFilter: (filter: CatalogSelection) => send({ filter, type: "filter" }),
      onInspect: inspect,
      onLaunch: onLaunch ? unlessModal(launch) : undefined,
      onRollSchedule: onRollSchedule ? unlessModal(rollSchedule) : undefined,
      onTab: (tab: InspectorTab) => send({ tab, type: "tab" }),
      onToggleConfiguration: () => send({ type: "configuration" }),
      resolved,
      selection: state.selected,
      snapshot,
      stream: actions?.stream,
      tab: state.tab,
    };
  }

  function main({ wide }: { readonly wide: boolean }): MainModel {
    const covered = inputActive || utility;
    const activePane = covered ? undefined : pane;
    const handlers = { onInspect: inspect, onReset: clearFilters };
    switch (mainContent(state, wide)) {
      case "feed":
        return { feed: feedModel(feed, covered), kind: "feed" };
      case "details":
        return {
          inspector: inspector(activePane === "details"),
          kind: "details",
        };
      case "usage":
        return {
          active: !covered,
          kind: "usage",
          usage: snapshot.usage && usageBreakdown(snapshot.usage),
        };
      case "catalog":
        return {
          catalog: catalogModel(snapshot, state, lists, activePane, handlers),
          details:
            pane === "details"
              ? inspector(activePane === "details")
              : undefined,
          kind: "catalog",
        };
      default:
        return {
          kind: "overview",
          overview: overviewModel(snapshot, state, lists.rows, activePane, {
            ...handlers,
            onToggle: (selection: DashboardSelection) =>
              send({ selection, type: "toggle" }),
          }),
        };
    }
  }

  const drawer: DrawerModel | undefined = utility
    ? { content: drawerContent, dock: drawerDock(state) }
    : undefined;

  return {
    control,
    drawer,
    footer: footer(context),
    form,
    goHome: () => {
      if (!quit.quitting && goesHome(context)) {
        send({ type: "home" });
      }
    },
    leaveForm: () => send({ type: "launch-form" }),
    main,
    openDiagnostics: unlessModal(() => openDiagnostics({ ...context, send })),
    openSettings: unlessModal(() => send({ type: "view", view: "settings" })),
    openWorkspaces: unlessModal(openWorkspaces),
    quit,
    rail:
      workspaceRail && workspaces.length > 0
        ? {
            current: snapshot.workspaceId,
            onSelect: unlessModal(chooseWorkspace),
            selected: snapshot.workspaceId ?? "",
            workspaces: workspaceRows(workspaces),
          }
        : undefined,
    schedule,
    search: browsing(state)
      ? browseSearch(snapshot, state, searchBar)
      : undefined,
    setDraft,
    setView: unlessModal((view: DashboardViewKey) =>
      send({ type: "view", view })
    ),
    showRun: (id: string) => send({ id, type: "show-run" }),
    snapshot,
    starting,
    state,
    submitPrompt,
    workspaces,
  };
}
