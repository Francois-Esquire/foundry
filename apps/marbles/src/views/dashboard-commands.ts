import {
  actionTarget,
  canStopActivity,
  type ResolvedSelection,
} from "./dashboard-model";
import {
  type BrowserPane,
  type DashboardEvent,
  type DashboardState,
  paneOf,
} from "./dashboard-state";
import type { CatalogSelection } from "./dashboard-tree";
import type { RunActions } from "./run-actions";
import { isPaused, isTerminal } from "./run-status";
import type { AnswerState, FeedState } from "./use-feed";

/** The parts of a key event the table reads. */
export interface KeyPress {
  readonly name: string;
  readonly sequence: string;
  readonly shift: boolean;
}

/** What a command can see: the state, its selection resolved, the feed, and the host's controls. */
export interface CommandContext {
  readonly actions?: RunActions;
  readonly canLaunch: boolean;
  readonly feed: Pick<
    FeedState,
    | "browse"
    | "cycleScope"
    | "focus"
    | "move"
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
  readonly resolved: ResolvedSelection;
  readonly state: DashboardState;
}

/** What a command can do. */
interface CommandEffects {
  /** Run or trigger control work: one at a time, its failure kept on screen. */
  readonly act: (work: () => Promise<void>) => void;
  readonly launch: (definitionId: string) => void;
  readonly quit: () => void;
  readonly send: (event: DashboardEvent) => void;
}

export type Dashboard = CommandContext & CommandEffects;

const SECTIONS = [
  "Anywhere",
  "Dashboard",
  "Run controls",
  "Feed",
  "Typing",
  "Forms",
] as const;
type Section = (typeof SECTIONS)[number];

/**
 * One key binding: the keys it takes, when it applies, what it does, and how
 * the footer and keyboard help describe it. Without `keys`, a focused
 * component (a log, a JSON viewer, a text field, a scrollbox, a form) owns
 * the key and the entry only describes it.
 */
interface Command {
  /** What it does, for keyboard help; absent when the footer label says enough. */
  readonly help?: string;
  /** The key as keyboard help writes it. */
  readonly key: string;
  /** Key names or typed sequences, or a test for anything subtler. */
  readonly keys?: readonly string[] | ((key: KeyPress) => boolean);
  /** Footer text while it applies. */
  readonly label?: string | ((context: CommandContext) => string);
  /** In the bottom line with quit and help, not the pane's line. */
  readonly lasting?: boolean;
  readonly run?: (dashboard: Dashboard, key: KeyPress) => void;
  readonly section: Section;
  readonly when: (context: CommandContext) => boolean;
}

const CHOICE_KEY = /^[1-9]$/;

/** The feed has a text field open for an answer. */
function answering(context: CommandContext): boolean {
  return context.state.view === "feed" && context.feed.answer.typing;
}

/** A text field has the keys: a steer or resume prompt, or a feed answer. */
function writing(context: CommandContext): boolean {
  return answering(context) || context.state.prompt !== undefined;
}

/** Something on top takes every key: a text field, help, or search. */
export function capturesKeys(context: CommandContext): boolean {
  return writing(context) || context.state.help || context.state.searching;
}

function onDashboard(context: CommandContext): boolean {
  return context.state.view === "dashboard" && !capturesKeys(context);
}

function onFeed(context: CommandContext): boolean {
  return context.state.view === "feed" && !capturesKeys(context);
}

function inDetails(context: CommandContext): boolean {
  return onDashboard(context) && context.state.inspecting;
}

function inList(context: CommandContext, pane?: BrowserPane): boolean {
  return (
    onDashboard(context) &&
    !context.state.inspecting &&
    (pane === undefined || context.state.focus === pane)
  );
}

/** Inspecting a run or step (not an activity) on one of these tabs. */
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

/** The run or step under the run controls, and its status. */
function controlled(context: CommandContext) {
  const { actions, resolved } = context;
  if (!(onDashboard(context) && actions && resolved.kind === "run")) {
    return;
  }
  return { actions, run: resolved.run, ...actionTarget(resolved) };
}

function managedTrigger(context: CommandContext) {
  const { actions, resolved } = context;
  if (!(onDashboard(context) && actions && resolved.kind === "trigger")) {
    return;
  }
  return resolved.trigger.managed
    ? { actions, trigger: resolved.trigger }
    : undefined;
}

/** The trigger or definition selected, to filter runs by. */
function catalogSelection(
  context: CommandContext
): CatalogSelection | undefined {
  const { resolved } = context;
  if (resolved.kind === "trigger") {
    return { id: resolved.trigger.id, kind: "trigger" };
  }
  if (resolved.kind === "definition") {
    return { id: resolved.definition.id, kind: "definition" };
  }
  return undefined;
}

/** The run a step or activity belongs to, even one that has since gone. */
function enclosingRun(resolved: ResolvedSelection): string | undefined {
  if (resolved.kind === "run") {
    return resolved.path.length > 0 ? resolved.run.id : undefined;
  }
  if (resolved.kind === "activity" || resolved.kind === "gone") {
    return resolved.run?.id;
  }
  return undefined;
}

/** Shift+D and Shift+F; plain `d` and `f` keep their pane meanings. */
function viewShortcut(key: KeyPress): "dashboard" | "feed" | undefined {
  const letter = key.shift ? key.name : undefined;
  if (key.sequence === "D" || letter === "d") {
    return "dashboard";
  }
  if (key.sequence === "F" || letter === "f") {
    return "feed";
  }
  return undefined;
}

const PANE_KEYS: Readonly<Record<string, BrowserPane>> = {
  1: "trigger",
  2: "definition",
  3: "run",
  m: "definition",
};

function never(): boolean {
  return false;
}

/**
 * Every key the dashboard and feed answer to, first match first. Entries
 * that share a key apply in different states, except Shift+F, which comes
 * before plain `f`.
 */
const COMMANDS: readonly Command[] = [
  // Text fields: the field owns typing and Enter; Esc gives up.
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
    help: "Show the Dashboard / Feed tab",
    key: "Shift+D / Shift+F",
    keys: (key) => viewShortcut(key) !== undefined,
    run: (dashboard, key) =>
      dashboard.send({ type: "view", view: viewShortcut(key) ?? "dashboard" }),
    section: "Anywhere",
    when: (context) => !capturesKeys(context),
  },
  {
    help: "Return to the dashboard; clicking marbles does too",
    key: "h",
    keys: ["h"],
    run: (dashboard) => dashboard.send({ type: "home" }),
    section: "Anywhere",
    when: (context) => !(writing(context) || context.state.searching),
  },

  // Feed tab.
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
    help: "Cycle the workspace filter",
    key: "w",
    keys: ["w"],
    label: "w workspace",
    run: (dashboard) => dashboard.feed.cycleScope(),
    section: "Feed",
    when: (context) => onFeed(context) && context.feed.scopeCount > 1,
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

  // Dashboard tab: panes and details.
  {
    help: "Focus Triggers / Marbles / Runs",
    key: "1 / 2 / 3",
    keys: ["1", "2", "3"],
    run: (dashboard, key) =>
      dashboard.send({ pane: PANE_KEYS[key.name] ?? "run", type: "focus" }),
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
    help: "Move focus through the three dashboard panels",
    key: "Tab / Shift+Tab",
    keys: ["tab"],
    label: "Tab focus",
    lasting: true,
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
    lasting: true,
    run: (dashboard) => dashboard.send({ type: "inspect" }),
    section: "Dashboard",
    when: (context) => inList(context),
  },
  {
    help: "Return from details to the selected pane",
    key: "Esc",
    keys: ["escape", "tab"],
    label: "Esc back",
    lasting: true,
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

  // Run and trigger controls: only what the selection's status allows.
  {
    help: "Steer the agent running in the step",
    key: "s",
    keys: ["s"],
    label: "s steer",
    run: (dashboard) => {
      const target = controlled(dashboard);
      if (target) {
        dashboard.send({
          prompt: {
            kind: "steer",
            runId: target.run.id,
            stepId: target.stepId,
          },
          type: "prompt",
        });
      }
    },
    section: "Run controls",
    when: (context) => controlled(context)?.status === "running",
  },
  {
    help: "Pause the running step, or resume a paused one with an optional prompt",
    key: "p",
    keys: ["p"],
    label: "p pause",
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
      const id = enclosingRun(dashboard.resolved);
      if (id !== undefined) {
        dashboard.send({ selection: { id, kind: "run" }, type: "inspect" });
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

  // The bottom line.
  {
    help: "Show this help",
    key: "?",
    keys: ["?"],
    label: "? help",
    lasting: true,
    run: (dashboard) => dashboard.send({ open: true, type: "help" }),
    section: "Anywhere",
    when: (context) => !capturesKeys(context),
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

  // Argument forms own these while open.
  {
    help: "Move focus / submit arguments",
    key: "Tab / Ctrl+Enter",
    section: "Forms",
    when: never,
  },
];

function takes(command: Command, key: KeyPress): boolean {
  const { keys } = command;
  if (keys === undefined) {
    return false;
  }
  if (typeof keys === "function") {
    return keys(key);
  }
  return keys.includes(key.name) || keys.includes(key.sequence);
}

/** The command this key runs here, if any. */
export function commandFor(
  key: KeyPress,
  context: CommandContext
): Command | undefined {
  return COMMANDS.find(
    (command) =>
      command.run !== undefined && takes(command, key) && command.when(context)
  );
}

function labels(context: CommandContext, lasting: boolean): string[] {
  return COMMANDS.flatMap((command) => {
    const { label } = command;
    if (label === undefined || Boolean(command.lasting) !== lasting) {
      return [];
    }
    if (!command.when(context)) {
      return [];
    }
    return [typeof label === "string" ? label : label(context)];
  });
}

/** Whatever has the keys, named first in its footer line. */
function focusName(context: CommandContext): string {
  const { feed, resolved, state } = context;
  if (state.prompt) {
    return state.prompt.kind;
  }
  if (answering(context)) {
    return feed.answer.choosing
      ? `${feed.answer.choosing} · note optional`
      : "answer";
  }
  if (state.searching) {
    return "Type to search";
  }
  if (state.view === "feed") {
    return feed.focus === "reader" ? "reader" : "entries";
  }
  if (state.inspecting && resolved.kind === "activity") {
    return "activity";
  }
  return paneOf(state);
}

/** The footer: what has the keys and what they do there, then the lasting keys. */
export function footer(context: CommandContext): {
  readonly hints: string;
  readonly lasting: string;
} {
  return {
    hints: [focusName(context), ...labels(context, false)].join(" · "),
    lasting: labels(context, true).join(" · "),
  };
}

/** Keyboard help, a section at a time. */
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
