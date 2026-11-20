import { canRunSchedule } from "~/model/dashboard";
import { isPaused, isTerminal } from "~/model/run-status";
import {
  type SettingsChange,
  type SettingsSnapshot,
  THEME_NAMES,
} from "~/model/settings";
import {
  actionTarget,
  canStopActivity,
  type DashboardSelection,
  type LiveWorkSnapshot,
  type ResolvedSelection,
  runSelection,
  triggerSelection,
  underSelection,
} from "./dashboard-model";
import {
  type BrowserPane,
  type DashboardEvent,
  type DashboardState,
  type DashboardViewKey,
  isBrowserView,
  paneOf,
} from "./dashboard-state";
import type { CatalogSelection } from "./dashboard-tree";
import type { OperatingLogEntry } from "./operating-model";
import { logRun } from "./operating-model";
import {
  inputVerb,
  promptTarget,
  type RunActions,
  type RunPrompt,
} from "./run-actions";
import type { AnswerState, FeedState } from "./use-feed";
import { ownedElsewhere } from "./workspace-scope";

export interface KeyPress {
  readonly name: string;
  readonly sequence: string;
  readonly shift: boolean;
}

export interface CommandContext {
  readonly actions?: RunActions;
  readonly canLaunch: boolean;
  readonly canRollSchedule?: boolean;
  readonly canSwitchWorkspace: boolean;
  readonly canToggleRail?: boolean;
  readonly feed: Pick<
    FeedState,
    | "browse"
    | "cycleScope"
    | "focus"
    | "move"
    | "open"
    | "read"
    | "resetScope"
    | "scopeCount"
  > & {
    readonly answer: Pick<
      AnswerState,
      | "cancel"
      | "choices"
      | "choose"
      | "choosing"
      | "question"
      | "start"
      | "typing"
    >;
  };
  readonly log?: OperatingLogEntry;
  readonly resolved: ResolvedSelection;
  readonly settings?: {
    readonly change?: (changes: SettingsChange) => Promise<void>;
    readonly current: SettingsSnapshot;
  };
  readonly state: DashboardState;
  readonly workspaces: {
    readonly everywhere: boolean;
    readonly ids: readonly string[];
    readonly others: boolean;
  };
}

interface CommandEffects {
  readonly act: (work: () => Promise<void>) => void;
  readonly chooseWorkspace: (id: string) => void;
  readonly launch: (definitionId: string) => void;
  readonly openWorkspaces: () => void;
  readonly quit: () => void;
  readonly rollSchedule?: (key: string) => void;
  readonly send: (event: DashboardEvent) => void;
  readonly toggleRail?: () => void;
  readonly toggleWorkspaces: () => void;
}

export type Dashboard = CommandContext & CommandEffects;

const SECTIONS = [
  "Anywhere",
  "Dashboard",
  "Run controls",
  "Logs",
  "Feed",
  "Settings",
  "Workspaces",
  "Typing",
  "Forms",
] as const;
type Section = (typeof SECTIONS)[number];

interface Described {
  readonly help?: string;
  readonly key: string;
  readonly label?: string | ((context: CommandContext) => string);
  readonly lasting?: boolean;
  readonly priority?: boolean;
  readonly section: Section;
}

interface Binding extends Described {
  readonly keys: readonly string[] | ((key: KeyPress) => boolean);
  readonly run: (dashboard: Dashboard, key: KeyPress) => void;
  readonly when: (context: CommandContext) => boolean;
}

interface Hint extends Described {
  readonly keys?: never;
  readonly run?: never;
  readonly when?: (context: CommandContext) => boolean;
}

type Command = Binding | Hint;

function isBinding(command: Command): command is Binding {
  return command.run !== undefined;
}

const CHOICE_KEY = /^[1-9]$/;

function answering(context: CommandContext): boolean {
  return (
    context.state.view === "feed" &&
    context.state.drawer === undefined &&
    context.state.picker === undefined &&
    context.feed.answer.typing
  );
}

function writing(context: CommandContext): boolean {
  return answering(context) || context.state.prompt !== undefined;
}

export function capturesKeys(context: CommandContext): boolean {
  return (
    writing(context) ||
    context.state.help ||
    context.state.searching ||
    context.state.picker !== undefined
  );
}

function onDashboard(context: CommandContext): boolean {
  return (
    context.state.drawer === undefined &&
    isBrowserView(context.state.view) &&
    !context.state.breakdown &&
    !capturesKeys(context)
  );
}

function inBreakdown(context: CommandContext): boolean {
  return (
    context.state.drawer === undefined &&
    context.state.view === "overview" &&
    context.state.breakdown &&
    !capturesKeys(context)
  );
}

function onLogs(context: CommandContext): boolean {
  return context.state.drawer === "logs" && !capturesKeys(context);
}

function onSettings(context: CommandContext): boolean {
  return context.state.drawer === "settings" && !capturesKeys(context);
}

function nextTheme(context: CommandContext, by: number) {
  const { settings } = context;
  if (!(settings?.change && onSettings(context))) {
    return;
  }
  const count = THEME_NAMES.length;
  const index = THEME_NAMES.indexOf(settings.current.theme);
  return {
    change: settings.change,
    theme: THEME_NAMES[(index + by + count) % count] ?? settings.current.theme,
  };
}

function onFeed(context: CommandContext): boolean {
  return (
    context.state.view === "feed" &&
    context.state.drawer === undefined &&
    !capturesKeys(context)
  );
}

function inDetails(context: CommandContext): boolean {
  return onDashboard(context) && context.state.inspecting;
}

export function openDiagnostics(
  dashboard: CommandContext & Pick<CommandEffects, "send">
): void {
  if (onLogs(dashboard)) {
    return;
  }
  const { resolved } = dashboard;
  dashboard.send(
    inDetails(dashboard) && resolved.kind === "run"
      ? { id: resolved.run.id, type: "log-run" }
      : { type: "view", view: "logs" }
  );
}

function inList(context: CommandContext, pane?: BrowserPane): boolean {
  return (
    onDashboard(context) &&
    !context.state.inspecting &&
    (pane === undefined || context.state.focus === pane)
  );
}

function inspectingRun(
  context: CommandContext,
  tabs?: readonly string[]
): boolean {
  return (
    inDetails(context) &&
    context.resolved.kind === "run" &&
    (tabs === undefined || tabs.includes(context.state.tab))
  );
}

function feedList(context: CommandContext): boolean {
  return onFeed(context) && context.feed.focus === "list";
}

function feedReader(context: CommandContext): boolean {
  return onFeed(context) && context.feed.focus === "reader";
}

function controlled(context: CommandContext) {
  const { actions, resolved } = context;
  if (
    !(onDashboard(context) && actions && resolved.kind === "run") ||
    ownedElsewhere(resolved.run)
  ) {
    return;
  }
  return { actions, run: resolved.run, ...actionTarget(resolved) };
}

function interactive(context: CommandContext): readonly LiveWorkSnapshot[] {
  const { resolved } = context;
  if (controlled(context)?.status !== "running" || resolved.kind !== "run") {
    return [];
  }
  return underSelection(resolved).flatMap((step) =>
    (step.work ?? []).filter((work) => work.input !== "none")
  );
}

function interactLabel(targets: readonly LiveWorkSnapshot[]): string {
  return targets.length > 1 ? "s interact" : `s ${inputVerb(targets[0])}`;
}

function awaited(context: CommandContext): readonly string[] {
  const { resolved } = context;
  if (!controlled(context) || resolved.kind !== "run") {
    return [];
  }
  return underSelection(resolved).flatMap((step) => step.awaiting ?? []);
}

function managedTrigger(context: CommandContext) {
  const { actions, resolved } = context;
  if (!(onDashboard(context) && actions && resolved.kind === "trigger")) {
    return;
  }
  return resolved.trigger.managed && !ownedElsewhere(resolved.trigger)
    ? { actions, trigger: resolved.trigger }
    : undefined;
}

function catalogSelection(
  context: CommandContext
): CatalogSelection | undefined {
  const { resolved } = context;
  if (resolved.kind === "trigger") {
    return triggerSelection(resolved.trigger);
  }
  if (resolved.kind === "definition") {
    return { id: resolved.definition.id, kind: "definition" };
  }
  return undefined;
}

function enclosingRun(
  resolved: ResolvedSelection
): DashboardSelection | undefined {
  if (resolved.kind === "run") {
    return resolved.path.length > 0 ? runSelection(resolved.run) : undefined;
  }
  if (resolved.kind === "activity" || resolved.kind === "gone") {
    return resolved.run === undefined ? undefined : runSelection(resolved.run);
  }
  return undefined;
}

const VIEW_LETTERS: Readonly<Record<string, DashboardViewKey>> = {
  c: "catalog",
  d: "overview",
  f: "feed",
  l: "logs",
  s: "settings",
};

function viewShortcut(key: KeyPress): DashboardViewKey | undefined {
  const typed =
    key.sequence.length === 1 && key.sequence !== key.sequence.toLowerCase()
      ? key.sequence.toLowerCase()
      : undefined;
  const letter = typed ?? (key.shift ? key.name : undefined);
  return letter !== undefined && Object.hasOwn(VIEW_LETTERS, letter)
    ? VIEW_LETTERS[letter]
    : undefined;
}

function workspaceShortcut(key: KeyPress, shifted: boolean): boolean {
  const letter = key.name === "w" || key.sequence === "W";
  return letter && (key.shift || key.sequence === "W") === shifted;
}

function onPicker(context: CommandContext): boolean {
  return context.state.picker !== undefined && !context.state.help;
}

const PANE_KEYS: Readonly<Record<"1" | "2" | "3", BrowserPane>> = {
  1: "trigger",
  2: "definition",
  3: "run",
};

function isPaneKey(name: string): name is keyof typeof PANE_KEYS {
  return Object.hasOwn(PANE_KEYS, name);
}

const COMMANDS: readonly Command[] = [
  {
    help: "Move the prompt to the next live target in the step",
    key: "Tab",
    keys: ["tab"],
    label: "Tab next",
    run: (dashboard) => dashboard.send({ by: 1, type: "prompt-target" }),
    section: "Typing",
    when: (context) =>
      context.state.prompt?.kind === "send" &&
      context.state.prompt.targets.length > 1,
  },
  {
    key: "Enter",
    label: "Enter send",
    section: "Typing",
    when: writing,
  },
  {
    help: "Drop a prompt or an answer without sending it",
    key: "Esc",
    keys: ["escape"],
    label: "Esc cancel",
    run: (dashboard) => {
      if (answering(dashboard)) {
        dashboard.feed.answer.cancel();
      } else {
        dashboard.send({ type: "prompt" });
      }
    },
    section: "Typing",
    when: writing,
  },
  {
    help: "Keep the search",
    key: "Enter in search",
    label: "Enter apply",
    section: "Typing",
    when: (context) => context.state.searching && !writing(context),
  },
  {
    help: "Clear the search",
    key: "Esc in search",
    keys: ["escape"],
    label: "Esc clear",
    run: (dashboard) => dashboard.send({ type: "cancel-search" }),
    section: "Typing",
    when: (context) => context.state.searching && !writing(context),
  },
  {
    help: "Close keyboard help",
    key: "Esc / ? in help",
    keys: ["escape", "?"],
    run: (dashboard) => dashboard.send({ open: false, type: "help" }),
    section: "Anywhere",
    when: (context) => context.state.help && !writing(context),
  },
  {
    help: "Open Dashboard, Catalog, Feed, Diagnostics, or Settings",
    key: "Shift+D / C / L / F / S",
    keys: (key) => viewShortcut(key) !== undefined,
    run: (dashboard, key) =>
      dashboard.send({ type: "view", view: viewShortcut(key) ?? "overview" }),
    section: "Anywhere",
    when: (context) => !capturesKeys(context),
  },
  {
    help: "Open Diagnostics",
    key: "d",
    keys: ["d"],
    run: openDiagnostics,
    section: "Anywhere",
    when: (context) => !capturesKeys(context),
  },
  {
    help: "Run the selected schedule now",
    key: "r on a schedule",
    keys: ["r"],
    label: "r run now",
    priority: true,
    run: ({ resolved, rollSchedule }) => {
      if (resolved.kind === "trigger") {
        rollSchedule?.(resolved.trigger.id);
      }
    },
    section: "Dashboard",
    when: (context) =>
      Boolean(
        context.canRollSchedule &&
          inDetails(context) &&
          context.resolved.kind === "trigger" &&
          canRunSchedule(context.resolved.trigger)
      ),
  },
  {
    help: "Close Diagnostics or Settings",
    key: "Esc",
    keys: ["escape"],
    label: "Esc close",
    run: (dashboard) => dashboard.send({ type: "close-utility" }),
    section: "Anywhere",
    when: (context) => onLogs(context) || onSettings(context),
  },
  {
    help: "Return to the Dashboard or Catalog list with focus; clicking marbles does too",
    key: "h",
    keys: ["h"],
    run: (dashboard) => dashboard.send({ type: "home" }),
    section: "Anywhere",
    when: (context) =>
      !(writing(context) || context.state.searching || onPicker(context)),
  },

  {
    help: "Select an entry",
    key: "↑ / ↓",
    keys: ["up", "down", "k", "j"],
    label: "↑↓ select",
    run: (dashboard, key) =>
      dashboard.feed.move(key.name === "up" || key.name === "k" ? -1 : 1),
    section: "Feed",
    when: feedList,
  },
  {
    help: "Read the selected entry",
    key: "Enter",
    keys: ["return", "enter", "right", "tab"],
    label: "Enter read",
    priority: true,
    run: (dashboard) => dashboard.feed.read(),
    section: "Feed",
    when: feedList,
  },
  {
    help: "Scroll the entry you are reading",
    key: "↑ / ↓ in an entry",
    label: "↑↓ scroll",
    section: "Feed",
    when: feedReader,
  },
  {
    help: "Back to the entries",
    key: "Esc",
    keys: ["escape", "left", "tab"],
    label: "Esc entries",
    run: (dashboard) => dashboard.feed.browse(),
    section: "Feed",
    when: feedReader,
  },
  {
    help: "Answer by choice; an approval then takes an optional note",
    key: "1-9",
    keys: (key) => CHOICE_KEY.test(key.sequence),
    label: (context) => `1-${context.feed.answer.choices.length} answer`,
    priority: true,
    run: (dashboard, key) => {
      const choice = dashboard.feed.answer.choices[Number(key.sequence) - 1];
      if (choice !== undefined) {
        dashboard.feed.answer.choose(choice);
      }
    },
    section: "Feed",
    when: (context) =>
      onFeed(context) &&
      context.feed.answer.question !== undefined &&
      context.feed.answer.choices.length > 0,
  },
  {
    help: "Type a free-text answer",
    key: "a",
    keys: ["a"],
    label: "a answer",
    run: (dashboard) => dashboard.feed.answer.start(),
    section: "Feed",
    when: (context) =>
      onFeed(context) &&
      context.feed.answer.question !== undefined &&
      context.feed.answer.choices.length === 0,
  },
  {
    help: "Cycle the Feed workspace filter (Shift+W when hosted)",
    key: "w / Shift+W",
    keys: (key) => workspaceShortcut(key, true),
    label: "W feed scope",
    run: (dashboard) => dashboard.feed.cycleScope(),
    section: "Feed",
    when: (context) =>
      onFeed(context) &&
      context.canSwitchWorkspace &&
      context.feed.scopeCount > 1,
  },
  {
    key: "w in the standalone Feed",
    keys: (key) =>
      workspaceShortcut(key, false) || workspaceShortcut(key, true),
    label: "w feed scope",
    run: (dashboard) => dashboard.feed.cycleScope(),
    section: "Feed",
    when: (context) =>
      onFeed(context) &&
      !context.canSwitchWorkspace &&
      context.feed.scopeCount > 1,
  },
  {
    help: "Show all workspaces",
    key: "x",
    keys: ["x"],
    label: "x all",
    run: (dashboard) => dashboard.feed.resetScope(),
    section: "Feed",
    when: (context) => onFeed(context) && context.feed.scopeCount > 1,
  },

  {
    help: "Select a log line; selecting stops following",
    key: "↑ / ↓ in logs",
    keys: ["up", "down"],
    label: "↑↓ select",
    run: (dashboard, key) =>
      dashboard.send({ by: key.name === "up" ? -1 : 1, type: "log-move" }),
    section: "Logs",
    when: onLogs,
  },
  {
    help: "Open the run the selected line came from",
    key: "Enter in logs",
    keys: ["return", "enter"],
    label: "Enter open run",
    run: (dashboard) => {
      const { log } = dashboard;
      if (log?.runId !== undefined) {
        dashboard.send({ selection: logRun(log, log.runId), type: "inspect" });
      }
    },
    section: "Logs",
    when: (context) => onLogs(context) && context.log?.runId !== undefined,
  },
  {
    help: "Follow new lines, or stop following",
    key: "f in logs",
    keys: ["f"],
    label: (context) =>
      context.state.logs.follow ? "f stop following" : "f follow",
    run: (dashboard) => dashboard.send({ type: "log-follow" }),
    section: "Logs",
    when: onLogs,
  },
  {
    help: "Raise the minimum level: debug, info, warn, error",
    key: "v",
    keys: ["v"],
    label: (context) => `v level ${context.state.logs.level}+`,
    run: (dashboard) => dashboard.send({ type: "log-level" }),
    section: "Logs",
    when: onLogs,
  },
  {
    help: "Show all lines, only runs' lines, or only Marbles' own",
    key: "o",
    keys: ["o"],
    label: (context) => `o source ${context.state.logs.source}`,
    run: (dashboard) => dashboard.send({ type: "log-source" }),
    section: "Logs",
    when: onLogs,
  },
  {
    help: "Search log lines",
    key: "/ in logs",
    keys: ["/"],
    label: "/ search",
    run: (dashboard) => dashboard.send({ open: true, type: "search" }),
    section: "Logs",
    when: onLogs,
  },
  {
    help: "Clear the log filters and follow again",
    key: "x in logs",
    keys: ["x"],
    label: "x clear",
    run: (dashboard) => dashboard.send({ type: "log-clear" }),
    section: "Logs",
    when: onLogs,
  },

  {
    help: "Show every workflow's and agent's usage on Dashboard",
    key: "u",
    keys: ["u"],
    label: "u usage",
    priority: true,
    run: (dashboard) => dashboard.send({ open: true, type: "breakdown" }),
    section: "Dashboard",
    when: (context) =>
      inList(context, "run") && context.state.view === "overview",
  },
  {
    key: "↑ / ↓ in usage",
    label: "↑↓ scroll",
    section: "Dashboard",
    when: inBreakdown,
  },
  {
    help: "Close the usage breakdown",
    key: "Esc / u in usage",
    keys: ["escape", "u"],
    label: "Esc back",
    run: (dashboard) => dashboard.send({ open: false, type: "breakdown" }),
    section: "Dashboard",
    when: inBreakdown,
  },

  {
    help: "Choose the theme; it is saved for every workspace",
    key: "↑ / ↓ or ← / → in Settings",
    keys: ["down", "left", "right", "up"],
    label: "↑↓ theme",
    run: (dashboard, key) => {
      const previous = key.name === "left" || key.name === "up";
      const next = nextTheme(dashboard, previous ? -1 : 1);
      if (next) {
        const { change, theme } = next;
        dashboard.act(() => change({ theme }));
      }
    },
    section: "Settings",
    when: (context) => nextTheme(context, 1) !== undefined,
  },

  {
    help: "Toggle the workspace rail",
    key: "Shift+W in Settings",
    keys: (key) => workspaceShortcut(key, true),
    label: "W rail",
    run: (dashboard) => dashboard.toggleRail?.(),
    section: "Settings",
    when: (context) => context.canToggleRail === true && onSettings(context),
  },

  {
    help: "Focus Triggers / Marbles on Catalog, or Runs on Dashboard",
    key: "1 / 2 / 3",
    keys: (key) => isPaneKey(key.name),
    run: (dashboard, key) => {
      if (isPaneKey(key.name)) {
        dashboard.send({ pane: PANE_KEYS[key.name], type: "focus" });
      }
    },
    section: "Dashboard",
    when: onDashboard,
  },
  {
    help: "Focus Marbles",
    key: "m",
    keys: ["m"],
    run: (dashboard) => dashboard.send({ pane: "definition", type: "focus" }),
    section: "Dashboard",
    when: onDashboard,
  },
  {
    help: "Move focus through Triggers, Marbles, and Runs, changing tab with it",
    key: "Tab / Shift+Tab",
    keys: ["tab"],
    label: "Tab focus",
    run: (dashboard, key) =>
      dashboard.send({ backwards: key.shift, type: "cycle" }),
    section: "Dashboard",
    when: (context) => inList(context),
  },
  {
    help: "Open details",
    key: "Enter",
    keys: ["return", "enter"],
    label: "Enter details",
    run: (dashboard) => dashboard.send({ type: "inspect" }),
    section: "Dashboard",
    when: (context) => inList(context),
  },
  {
    help: "Return from details to the selected pane",
    key: "Esc",
    keys: ["escape", "tab"],
    label: "Esc back",
    run: (dashboard) => dashboard.send({ type: "back" }),
    section: "Dashboard",
    when: inDetails,
  },
  {
    help: "Select rows, or scroll details",
    key: "↑ / ↓",
    keys: ["up", "down"],
    label: "↑↓ select",
    run: (dashboard, key) =>
      dashboard.send({ by: key.name === "up" ? -1 : 1, type: "move" }),
    section: "Dashboard",
    when: (context) => inList(context),
  },
  {
    help: "Collapse / expand run branches",
    key: "← / →",
    keys: ["left", "right"],
    label: "←→ fold",
    run: (dashboard, key) =>
      dashboard.send({ open: key.name === "right", type: "fold" }),
    section: "Dashboard",
    when: (context) => inList(context, "run"),
  },
  {
    help: "Change the details tab",
    key: "← / → in details",
    keys: ["left", "right"],
    label: "←→ tabs",
    run: (dashboard, key) =>
      dashboard.send({ by: key.name === "left" ? -1 : 1, type: "cycle-tab" }),
    section: "Dashboard",
    when: (context) => inspectingRun(context),
  },
  {
    key: "↑ / ↓",
    label: (context) =>
      inspectingRun(context, ["input", "output"]) ? "↑↓ browse" : "↑↓ scroll",
    section: "Dashboard",
    when: inDetails,
  },
  {
    help: "Scroll the whole of details in short terminals",
    key: "PgUp / PgDn",
    section: "Dashboard",
    when: inDetails,
  },
  {
    help: "Toggle a run branch, or the selected JSON node",
    key: "Space",
    keys: ["space"],
    run: (dashboard) => dashboard.send({ type: "fold" }),
    section: "Dashboard",
    when: (context) => inList(context, "run"),
  },
  {
    key: "Space",
    label: "Space fold JSON",
    section: "Dashboard",
    when: (context) => inspectingRun(context, ["input", "output"]),
  },
  {
    help: "Toggle following new logs; scrolling pauses follow",
    key: "f in logs",
    label: "f follow",
    section: "Dashboard",
    when: (context) => inspectingRun(context, ["logs"]),
  },
  {
    help: "Launch the selected step or workflow",
    key: "l",
    keys: ["l"],
    label: "l launch",
    run: (dashboard) => {
      if (dashboard.resolved.kind === "definition") {
        dashboard.launch(dashboard.resolved.definition.id);
      }
    },
    section: "Dashboard",
    when: (context) =>
      onDashboard(context) &&
      context.canLaunch &&
      context.resolved.kind === "definition",
  },
  {
    help: "Show only the runs of the selected trigger, workflow, or step",
    key: "f",
    keys: ["f"],
    label: "f filter runs",
    run: (dashboard) => {
      const filter = catalogSelection(dashboard);
      if (filter) {
        dashboard.send({ filter, type: "filter" });
      }
    },
    section: "Dashboard",
    when: (context) =>
      onDashboard(context) && catalogSelection(context) !== undefined,
  },

  {
    help: "Steer the agent or type into the command live in the step",
    key: "s",
    keys: ["s"],
    label: (context) => interactLabel(interactive(context)),
    priority: true,
    run: (dashboard) => {
      const target = controlled(dashboard);
      const targets = interactive(dashboard);
      if (target && targets.length > 0) {
        dashboard.send({
          prompt: { chosen: 0, kind: "send", runId: target.run.id, targets },
          type: "prompt",
        });
      }
    },
    section: "Run controls",
    when: (context) => interactive(context).length > 0,
  },
  {
    help: "Open the Feed on the question or approval the step waits for",
    key: "i",
    keys: ["i"],
    label: "i answer",
    priority: true,
    run: (dashboard) => {
      const [entry] = awaited(dashboard);
      if (entry) {
        dashboard.send({ type: "view", view: "feed" });
        dashboard.feed.open(entry);
      }
    },
    section: "Run controls",
    when: (context) => awaited(context).length > 0,
  },
  {
    help: "Pause the running step, or resume a paused one with an optional prompt",
    key: "p",
    keys: ["p"],
    label: "p pause",
    priority: true,
    run: (dashboard) => {
      const target = controlled(dashboard);
      if (target) {
        dashboard.act(() => target.actions.pause(target.run.id, target.stepId));
      }
    },
    section: "Run controls",
    when: (context) => controlled(context)?.status === "running",
  },
  {
    key: "p",
    keys: ["p"],
    label: "p resume",
    priority: true,
    run: (dashboard) => {
      const target = controlled(dashboard);
      if (target) {
        dashboard.send({
          prompt: {
            kind: "resume",
            runId: target.run.id,
            stepId: target.stepId,
          },
          type: "prompt",
        });
      }
    },
    section: "Run controls",
    when: (context) => {
      const target = controlled(context);
      return target !== undefined && isPaused(target.status);
    },
  },
  {
    help: "Cancel the run",
    key: "k",
    keys: ["k"],
    label: "k cancel",
    priority: true,
    run: (dashboard) => {
      const target = controlled(dashboard);
      if (target) {
        dashboard.act(() => target.actions.cancel(target.run.id));
      }
    },
    section: "Run controls",
    when: (context) => {
      const target = controlled(context);
      return target !== undefined && !isTerminal(target.run.status);
    },
  },
  {
    help: "Stop the selected harness activity",
    key: "k on an activity",
    keys: ["k"],
    label: "k stop activity",
    priority: true,
    run: (dashboard) => {
      const { actions, resolved } = dashboard;
      const stop = actions?.stopActivity;
      if (stop && resolved.kind === "activity") {
        const { activity } = resolved;
        dashboard.act(() => stop(activity.sessionId, activity.id));
      }
    },
    section: "Run controls",
    when: (context) =>
      onDashboard(context) &&
      context.actions?.stopActivity !== undefined &&
      context.resolved.kind === "activity" &&
      canStopActivity(context.resolved.activity),
  },
  {
    help: "Pause or resume a trigger an agent created",
    key: "p on a trigger",
    keys: ["p"],
    label: (context) =>
      managedTrigger(context)?.trigger.status === "paused"
        ? "p resume"
        : "p pause",
    priority: true,
    run: (dashboard) => {
      const managed = managedTrigger(dashboard);
      const toggle = managed?.actions.setTriggerEnabled;
      if (managed && toggle) {
        const { trigger } = managed;
        dashboard.act(() => toggle(trigger.id, trigger.status === "paused"));
      }
    },
    section: "Run controls",
    when: (context) =>
      managedTrigger(context)?.actions.setTriggerEnabled !== undefined,
  },
  {
    help: "Delete a trigger an agent created",
    key: "k on a trigger",
    keys: ["k"],
    label: "k delete trigger",
    priority: true,
    run: (dashboard) => {
      const managed = managedTrigger(dashboard);
      const remove = managed?.actions.deleteTrigger;
      if (managed && remove) {
        const { id } = managed.trigger;
        dashboard.act(() => remove(id));
      }
    },
    section: "Run controls",
    when: (context) =>
      managedTrigger(context)?.actions.deleteTrigger !== undefined,
  },
  {
    help: "Return from step or activity details to its run",
    key: "b",
    keys: ["b"],
    label: "b run",
    run: (dashboard) => {
      const selection = enclosingRun(dashboard.resolved);
      if (selection !== undefined) {
        dashboard.send({ selection, type: "inspect" });
      }
    },
    section: "Dashboard",
    when: (context) =>
      inDetails(context) && enclosingRun(context.resolved) !== undefined,
  },
  {
    help: "Search the focused list",
    key: "/",
    keys: ["/"],
    label: "/ search",
    run: (dashboard) => dashboard.send({ open: true, type: "search" }),
    section: "Dashboard",
    when: (context) => inList(context),
  },
  {
    help: "Jump to the active step within the run filter",
    key: "a",
    keys: ["a"],
    label: "a active",
    run: (dashboard) => dashboard.send({ status: "running", type: "jump" }),
    section: "Dashboard",
    when: onDashboard,
  },
  {
    help: "Jump to the latest failure within the run filter",
    key: "e",
    keys: ["e"],
    label: "e failed",
    run: (dashboard) => dashboard.send({ status: "failed", type: "jump" }),
    section: "Dashboard",
    when: onDashboard,
  },
  {
    help: "Clear every search and the run filter",
    key: "x",
    keys: ["x"],
    run: (dashboard) => dashboard.send({ type: "clear-filters" }),
    section: "Dashboard",
    when: onDashboard,
  },
  {
    help: "Show or hide the selected trigger's configuration",
    key: "v on a trigger",
    keys: ["v"],
    label: (context) =>
      context.state.configuration
        ? "v hide configuration"
        : "v show configuration",
    run: (dashboard) => dashboard.send({ type: "configuration" }),
    section: "Dashboard",
    when: (context) =>
      inDetails(context) &&
      context.resolved.kind === "trigger" &&
      context.resolved.trigger.configuration !== undefined,
  },
  {
    help: "Select a workspace in the picker",
    key: "↑ / ↓",
    keys: ["up", "down"],
    label: "↑↓ select",
    run: (dashboard, key) =>
      dashboard.send({
        by: key.name === "up" ? -1 : 1,
        ids: dashboard.workspaces.ids,
        type: "picker-move",
      }),
    section: "Workspaces",
    when: onPicker,
  },
  {
    help: "Switch to the selected workspace",
    key: "Enter",
    keys: ["return", "enter"],
    label: "Enter switch",
    run: (dashboard) => {
      if (dashboard.state.picker !== undefined) {
        dashboard.chooseWorkspace(dashboard.state.picker);
      }
    },
    section: "Workspaces",
    when: onPicker,
  },
  {
    help: "Close the workspace picker",
    key: "Esc / w",
    keys: (key) => key.name === "escape" || workspaceShortcut(key, false),
    label: "Esc close",
    run: (dashboard) => dashboard.send({ type: "picker" }),
    section: "Workspaces",
    when: onPicker,
  },
  {
    help: "Open the workspace picker",
    key: "w",
    keys: (key) => workspaceShortcut(key, false),
    label: "w workspace",
    run: (dashboard) => dashboard.openWorkspaces(),
    section: "Workspaces",
    when: (context) => !capturesKeys(context) && context.canSwitchWorkspace,
  },

  {
    help: "Show every workspace's runs and triggers, or this workspace's again; another workspace's are shown, not controlled",
    key: "g",
    keys: ["g"],
    label: (context) =>
      context.workspaces.everywhere ? "g this workspace" : "g all workspaces",
    run: (dashboard) => dashboard.toggleWorkspaces(),
    section: "Dashboard",
    when: (context) =>
      onDashboard(context) &&
      (context.workspaces.others || context.workspaces.everywhere),
  },

  {
    help: "Show this help",
    key: "?",
    keys: ["?"],
    label: "? help",
    lasting: true,
    run: (dashboard) => dashboard.send({ open: true, type: "help" }),
    section: "Anywhere",
    when: (context) => onPicker(context) || !capturesKeys(context),
  },
  {
    help: "Ask to quit; Ctrl+C again quits",
    key: "q / Ctrl+C",
    keys: ["q"],
    label: "q / Ctrl+C quit",
    lasting: true,
    run: (dashboard) => dashboard.quit(),
    section: "Anywhere",
    when: (context) => !(writing(context) || context.state.searching),
  },
  {
    key: "Ctrl+C",
    label: "Ctrl+C quit",
    lasting: true,
    section: "Anywhere",
    when: (context) => writing(context) || context.state.searching,
  },

  {
    help: "Move focus / submit arguments",
    key: "Tab / Ctrl+Enter",
    section: "Forms",
  },
];

function takes(command: Binding, key: KeyPress): boolean {
  const { keys } = command;
  if (typeof keys === "function") {
    return keys(key);
  }
  return keys.includes(key.name) || keys.includes(key.sequence);
}

export function commandFor(
  key: KeyPress,
  context: CommandContext
): Binding | undefined {
  return COMMANDS.filter(isBinding).find(
    (command) => takes(command, key) && command.when(context)
  );
}

function labels(context: CommandContext, lasting: boolean) {
  return COMMANDS.flatMap((command) => {
    const { label } = command;
    if (label === undefined || Boolean(command.lasting) !== lasting) {
      return [];
    }
    if (!command.when?.(context)) {
      return [];
    }
    return [
      {
        label: typeof label === "string" ? label : label(context),
        priority: command.priority,
      },
    ];
  });
}

function promptName(prompt: RunPrompt): string {
  if (prompt.kind === "resume") {
    return "resume";
  }
  const verb = inputVerb(promptTarget(prompt));
  return prompt.targets.length > 1
    ? `${verb} ${String(prompt.chosen + 1)}/${String(prompt.targets.length)}`
    : verb;
}

function focusName(context: CommandContext): string {
  const { feed, resolved, state } = context;
  if (state.prompt) {
    return promptName(state.prompt);
  }
  if (answering(context)) {
    return feed.answer.choosing
      ? `${feed.answer.choosing} · note optional`
      : "answer";
  }
  if (state.searching) {
    return "Type to search";
  }
  if (state.picker !== undefined) {
    return "workspaces";
  }
  if (state.drawer) {
    return state.drawer;
  }
  if (state.view === "feed") {
    return feed.focus === "reader" ? "reader" : "entries";
  }
  if (state.breakdown) {
    return "usage";
  }
  if (state.inspecting && resolved.kind === "activity") {
    return "activity";
  }
  return paneOf(state);
}

export function footer(context: CommandContext) {
  return {
    hints: { actions: labels(context, false), focus: focusName(context) },
    lasting: labels(context, true)
      .map(({ label }) => label)
      .join(" · "),
  };
}

export function helpSections(): readonly {
  readonly title: Section;
  readonly items: readonly { readonly key: string; readonly value: string }[];
}[] {
  return SECTIONS.map((title) => ({
    items: COMMANDS.flatMap((command) =>
      command.section === title && command.help
        ? [{ key: command.key, value: command.help }]
        : []
    ),
    title,
  }));
}
