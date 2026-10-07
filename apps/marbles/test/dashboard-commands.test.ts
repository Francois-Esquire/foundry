import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  capturesKeys,
  commandFor,
  type Dashboard,
  footer,
  helpSections,
  type KeyPress,
} from "~/views/dashboard-commands";
import {
  type DashboardSnapshot,
  resolveSelection,
} from "~/views/dashboard-model";
import {
  type DashboardEvent,
  type DashboardState,
  initialState,
  reduce,
} from "~/views/dashboard-state";
import type { RunActions } from "~/views/run-actions";
import { dashboardSnapshot } from "../preview/snapshot";

function key(name: string, extra: Partial<KeyPress> = {}): KeyPress {
  return { name, sequence: name, shift: false, ...extra };
}

const noop = () => Promise.resolve();
const actions: RunActions = {
  cancel: noop,
  deleteTrigger: noop,
  pause: noop,
  resume: noop,
  setTriggerEnabled: noop,
  steer: noop,
  stopActivity: noop,
};

interface Setup {
  /** `null` for a host with no run controls. */
  readonly actions?: RunActions | null;
  readonly canLaunch?: boolean;
  readonly choices?: readonly string[];
  readonly events?: readonly DashboardEvent[];
  readonly snapshot?: DashboardSnapshot;
  readonly typing?: boolean;
}

/** A context as the hook builds it, with a feed stub and a recorder for effects. */
function context({
  actions: controls,
  canLaunch = true,
  choices,
  events = [],
  snapshot = dashboardSnapshot,
  typing = false,
}: Setup = {}) {
  const state: DashboardState = events.reduce(
    (current, event) => reduce(current, event, snapshot),
    initialState(snapshot)
  );
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const built: CommandContext = {
    actions: controls === null ? undefined : (controls ?? actions),
    canLaunch,
    feed: {
      answer: {
        cancel: record("cancel-answer"),
        choices: choices ?? [],
        choose: record("choose"),
        choosing: undefined,
        question: choices ? dashboardSnapshot.feed[0] : undefined,
        start: record("start-answer"),
        typing,
      },
      browse: record("browse"),
      cycleScope: record("cycle-scope"),
      focus: "list",
      move: record("move"),
      read: record("read"),
      resetScope: record("reset-scope"),
      scopeCount: 2,
    },
    resolved: resolveSelection(snapshot, state.selected),
    state,
  };
  const dashboard: Dashboard = {
    ...built,
    act: record("act"),
    launch: record("launch"),
    quit: record("quit"),
    send: (event: DashboardEvent) => calls.push(["send", event]),
  };
  /** Press a key; returns what the command did, or undefined when nothing took it. */
  function press(pressed: KeyPress) {
    const command = commandFor(pressed, built);
    command?.run(dashboard, pressed);
    return command ? calls.splice(0) : undefined;
  }
  return { context: built, press };
}

const paused: DashboardSnapshot = {
  ...dashboardSnapshot,
  runs: dashboardSnapshot.runs.map((run) =>
    run.id === "run-104" ? { ...run, status: "suspended" } : run
  ),
};

describe("run controls follow the target's status", () => {
  it("offers steer, pause, and cancel on a running run", () => {
    const { context: built, press } = context();
    expect(footer(built).hints).toContain("s steer · p pause · k cancel");
    expect(press(key("p"))).toEqual([["act", expect.any(Function)]]);
    expect(press(key("s"))).toEqual([
      [
        "send",
        {
          prompt: { kind: "steer", runId: "run-104", stepId: "docs" },
          type: "prompt",
        },
      ],
    ]);
  });

  it("offers resume and cancel, not steer, on a paused run", () => {
    const { context: built, press } = context({ snapshot: paused });
    expect(footer(built).hints).toContain("p resume · k cancel");
    expect(footer(built).hints).not.toContain("steer");
    expect(press(key("s"))).toBeUndefined();
    expect(press(key("p"))).toEqual([
      [
        "send",
        {
          prompt: { kind: "resume", runId: "run-104", stepId: "docs" },
          type: "prompt",
        },
      ],
    ]);
  });

  it("offers nothing on a settled run", () => {
    const { context: built, press } = context({
      events: [{ selection: { id: "run-103", kind: "run" }, type: "select" }],
    });
    for (const label of ["steer", "pause", "resume", "cancel"]) {
      expect(footer(built).hints).not.toContain(label);
    }
    for (const name of ["s", "p", "k"]) {
      expect(press(key(name))).toBeUndefined();
    }
  });

  it("targets the selected step by its own status", () => {
    const { context: built, press } = context({
      events: [{ status: "running", type: "jump" }],
    });
    expect(footer(built).hints).toContain("s steer · p pause");
    expect(press(key("k"))).toEqual([["act", expect.any(Function)]]);
    const finished = context({
      events: [
        {
          selection: { id: "run-104", kind: "run", stepId: "find" },
          type: "select",
        },
      ],
    });
    // A finished step in a running run: the run can still be cancelled.
    expect(footer(finished.context).hints).toContain("k cancel");
    expect(footer(finished.context).hints).not.toContain("p pause");
  });

  it("offers no controls without host actions", () => {
    const { context: built, press } = context({ actions: null });
    expect(footer(built).hints).not.toContain("k cancel");
    expect(press(key("k"))).toBeUndefined();
  });

  it("names managed trigger controls by the trigger's state", () => {
    const managed: DashboardSnapshot = {
      ...dashboardSnapshot,
      triggers: [
        {
          description: "Agent work",
          id: "agent",
          kind: "schedule",
          managed: true,
          name: "agent",
          status: "paused",
          targetId: "docs",
        },
      ],
    };
    const { context: built } = context({
      events: [{ pane: "trigger", type: "focus" }],
      snapshot: managed,
    });
    expect(footer(built).hints).toContain("p resume · k delete trigger");
    const plain = context({ events: [{ pane: "trigger", type: "focus" }] });
    expect(footer(plain.context).hints).not.toContain("delete trigger");
  });
});

describe("footer", () => {
  it("names the pane, then its keys, with the lasting keys on their own line", () => {
    const { context: built } = context({
      events: [{ pane: "definition", type: "focus" }],
    });
    expect(footer(built)).toEqual({
      hints:
        "definition · ↑↓ select · l launch · f filter runs · / search · a active · e failed",
      lasting: "Tab focus · Enter details · ? help · q / Ctrl+C quit",
    });
  });

  it("describes details by tab and drops what the selection cannot do", () => {
    const logs = context({
      events: [
        { status: "running", type: "jump" },
        { tab: "logs", type: "tab" },
      ],
    });
    expect(footer(logs.context).hints).toBe(
      "details · ←→ tabs · ↑↓ scroll · f follow · s steer · p pause · k cancel · b run · a active · e failed"
    );
    expect(footer(logs.context).lasting).toBe(
      "Esc back · ? help · q / Ctrl+C quit"
    );
    const input = context({ events: [{ tab: "input", type: "tab" }] });
    expect(footer(input.context).hints).toContain(
      "↑↓ browse · Space fold JSON"
    );
    expect(footer(input.context).hints).not.toContain("b run");
  });

  it("shows only the text field's keys while one is open", () => {
    const search = context({ events: [{ open: true, type: "search" }] });
    expect(footer(search.context)).toEqual({
      hints: "Type to search · Enter apply · Esc clear",
      lasting: "Ctrl+C quit",
    });
    const prompt = context({
      events: [
        {
          prompt: { kind: "steer", runId: "run-104", stepId: "docs" },
          type: "prompt",
        },
      ],
    });
    expect(footer(prompt.context).hints).toBe(
      "steer · Enter send · Esc cancel"
    );
  });

  it("lists the feed's keys on the Feed tab", () => {
    const { context: built } = context({
      choices: ["merge", "hold"],
      events: [{ type: "view", view: "feed" }],
    });
    expect(footer(built)).toEqual({
      hints:
        "entries · ↑↓ select · Enter read · 1-2 answer · w workspace · x all",
      lasting: "? help · q / Ctrl+C quit",
    });
  });
});

describe("key dispatch", () => {
  it("lets text fields and overlays keep their keys", () => {
    const search = context({ events: [{ open: true, type: "search" }] });
    expect(capturesKeys(search.context)).toBe(true);
    expect(search.press(key("q"))).toBeUndefined();
    expect(search.press(key("h"))).toBeUndefined();
    expect(search.press(key("escape"))).toEqual([
      ["send", { type: "cancel-search" }],
    ]);
    const typing = context({
      choices: [],
      events: [{ type: "view", view: "feed" }],
      typing: true,
    });
    expect(typing.press(key("q"))).toBeUndefined();
    expect(typing.press(key("escape"))).toEqual([["cancel-answer"]]);
  });

  it("keeps quit and home working over help, and closes help with Esc or ?", () => {
    const help = context({ events: [{ open: true, type: "help" }] });
    expect(help.press(key("q"))).toEqual([["quit"]]);
    expect(help.press(key("h"))).toEqual([["send", { type: "home" }]]);
    expect(help.press(key("?"))).toEqual([
      ["send", { open: false, type: "help" }],
    ]);
    expect(help.press(key("a"))).toBeUndefined();
  });

  it("reads Shift+F as the Feed tab before f filters runs", () => {
    const catalog = context({
      events: [{ pane: "definition", type: "focus" }],
    });
    expect(catalog.press(key("f", { sequence: "F", shift: true }))).toEqual([
      ["send", { type: "view", view: "feed" }],
    ]);
    expect(catalog.press(key("f"))).toEqual([
      ["send", { filter: { id: "docs", kind: "definition" }, type: "filter" }],
    ]);
  });

  it("answers by number on the Feed tab and leaves numbers to panes on the dashboard", () => {
    const feed = context({
      choices: ["merge", "hold"],
      events: [{ type: "view", view: "feed" }],
    });
    expect(feed.press(key("2"))).toEqual([["choose", "hold"]]);
    expect(feed.press(key("9"))).toEqual([]);
    const dashboard = context({ choices: ["merge", "hold"] });
    expect(dashboard.press(key("2"))).toEqual([
      ["send", { pane: "definition", type: "focus" }],
    ]);
  });

  it("launches a definition only when the host can", () => {
    const events = [{ pane: "definition", type: "focus" }] as const;
    expect(context({ events }).press(key("l"))).toEqual([["launch", "docs"]]);
    expect(
      context({ canLaunch: false, events }).press(key("l"))
    ).toBeUndefined();
  });
});

describe("keyboard help", () => {
  it("documents every section from the table", () => {
    const sections = helpSections();
    expect(sections.map((section) => section.title)).toEqual([
      "Anywhere",
      "Dashboard",
      "Run controls",
      "Feed",
      "Typing",
      "Forms",
    ]);
    for (const section of sections) {
      expect(section.items.length).toBeGreaterThan(0);
      const keys = section.items.map((item) => item.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
