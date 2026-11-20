import { describe, expect, it } from "vitest";
import type { LiveWork } from "~/lib/step-work";
import {
  type CommandContext,
  capturesKeys,
  footer as commandFooter,
  commandFor,
  type Dashboard,
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

function footer(commandContext: CommandContext) {
  const { hints, lasting } = commandFooter(commandContext);
  return {
    hints: [hints.focus, ...hints.actions.map(({ label }) => label)].join(
      " · "
    ),
    lasting,
  };
}

function key(name: string, extra: Partial<KeyPress> = {}): KeyPress {
  return { name, sequence: name, shift: false, ...extra };
}

const noop = () => Promise.resolve();
const actions: RunActions = {
  cancel: noop,
  deleteTrigger: noop,
  pause: noop,
  resume: noop,
  send: noop,
  setTriggerEnabled: noop,
  stopActivity: noop,
};

const SEND_KEY = /\bs (steer|input|interact)\b/;

const WRITE_AGENT: LiveWork = {
  id: "work-write",
  input: "steer",
  kind: "agent",
  model: "claude-sonnet-5-5",
  provider: "claude-code",
  sessionId: "session-write",
  stepId: "write",
};

function withWork(
  work: readonly LiveWork[],
  awaiting?: readonly string[]
): DashboardSnapshot {
  return {
    ...dashboardSnapshot,
    runs: dashboardSnapshot.runs.map((run) =>
      run.id === "run-104"
        ? {
            ...run,
            steps: run.steps.map((step) =>
              step.id === "update"
                ? {
                    ...step,
                    children: step.children.map((child) =>
                      child.id === "write"
                        ? {
                            ...child,
                            ...(awaiting ? { awaiting } : {}),
                            work,
                          }
                        : child
                    ),
                  }
                : step
            ),
          }
        : run
    ),
  };
}

const onWrite: DashboardEvent = {
  selection: { id: "run-104", kind: "run", stepId: "write" },
  type: "select",
};

interface Setup {
  readonly actions?: RunActions | null;
  readonly canLaunch?: boolean;
  readonly canSwitchWorkspace?: boolean;
  readonly choices?: readonly string[];
  readonly events?: readonly DashboardEvent[];
  readonly snapshot?: DashboardSnapshot;
  readonly typing?: boolean;
  readonly workspaces?: Omit<CommandContext["workspaces"], "ids">;
}

function context({
  actions: controls,
  canLaunch = true,
  canSwitchWorkspace = false,
  choices,
  events = [],
  snapshot = dashboardSnapshot,
  typing = false,
  workspaces = { everywhere: false, others: false },
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
    canSwitchWorkspace,
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
      open: record("open"),
      read: record("read"),
      resetScope: record("reset-scope"),
      scopeCount: 2,
    },
    resolved: resolveSelection(snapshot, state.selected),
    state,
    workspaces: { ...workspaces, ids: [] },
  };
  const dashboard: Dashboard = {
    ...built,
    act: record("act"),
    chooseWorkspace: record("choose-workspace"),
    launch: record("launch"),
    openWorkspaces: record("switch-workspace"),
    quit: record("quit"),
    send: (event: DashboardEvent) => calls.push(["send", event]),
    toggleWorkspaces: record("toggle-workspaces"),
  };
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

describe("another workspace's runs and triggers", () => {
  const elsewhere = { id: "ws-docs", name: "docs" };
  const shown: DashboardSnapshot = {
    ...dashboardSnapshot,
    runs: dashboardSnapshot.runs.map((run) =>
      run.status === "running" ? { ...run, workspace: elsewhere } : run
    ),
    triggers: dashboardSnapshot.triggers.map((trigger) => ({
      ...trigger,
      managed: true,
      workspace: elsewhere,
    })),
  };

  it("are shown with no control", () => {
    const running = shown.runs.find((run) => run.status === "running");
    const { context: built, press } = context({
      events: [
        { selection: { id: running?.id ?? "", kind: "run" }, type: "select" },
      ],
      snapshot: shown,
    });
    expect(footer(built).hints).not.toContain("k cancel");
    expect(footer(built).hints).not.toContain("p pause");
    for (const name of ["s", "p", "k"]) {
      expect(press(key(name))).toBeUndefined();
    }
    const [trigger] = shown.triggers;
    const onTrigger = context({
      events: [
        {
          selection: { id: trigger?.id ?? "", kind: "trigger" },
          type: "select",
        },
      ],
      snapshot: shown,
    });
    expect(footer(onTrigger.context).hints).not.toContain("delete trigger");
    expect(onTrigger.press(key("k"))).toBeUndefined();
  });

  it("are toggled into the lists with g, once there are any", () => {
    expect(footer(context().context).hints).not.toContain("g all workspaces");
    const some = context({ workspaces: { everywhere: false, others: true } });
    expect(footer(some.context).hints).toContain("g all workspaces");
    expect(some.press(key("g"))).toEqual([["toggle-workspaces"]]);
    const all = context({ workspaces: { everywhere: true, others: true } });
    expect(footer(all.context).hints).toContain("g this workspace");
  });
});

describe("run controls follow the target's status", () => {
  it("offers steer, pause, and cancel on a running run", () => {
    const { context: built, press } = context();
    expect(footer(built).hints).toContain("s steer · p pause · k cancel");
    expect(press(key("p"))).toEqual([["act", expect.any(Function)]]);
    expect(press(key("s"))).toEqual([
      [
        "send",
        {
          prompt: {
            chosen: 0,
            kind: "send",
            runId: "run-104",
            targets: [WRITE_AGENT],
          },
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

describe("live work in the selected step", () => {
  const COMMAND: LiveWork = {
    command: "npm test",
    id: "work-test",
    input: "stdin",
    kind: "command",
    stepId: "write",
  };

  it("offers no steer on a running step with nothing live in it", () => {
    const { context: built, press } = context({
      events: [onWrite],
      snapshot: withWork([]),
    });
    expect(footer(built).hints).toContain("p pause");
    expect(footer(built).hints).not.toMatch(SEND_KEY);
    expect(press(key("s"))).toBeUndefined();
  });

  it("names terminal input for a command, apart from agent steering", () => {
    const { context: built, press } = context({
      events: [onWrite],
      snapshot: withWork([COMMAND]),
    });
    expect(footer(built).hints).toContain("s input · p pause");
    expect(press(key("s"))).toEqual([
      [
        "send",
        {
          prompt: {
            chosen: 0,
            kind: "send",
            runId: "run-104",
            targets: [COMMAND],
          },
          type: "prompt",
        },
      ],
    ]);
  });

  it("leaves out work that takes no input", () => {
    const { context: built } = context({
      events: [onWrite],
      snapshot: withWork([{ ...COMMAND, input: "none" }]),
    });
    expect(footer(built).hints).not.toMatch(SEND_KEY);
  });

  it("asks which target when a step holds several, and Tab moves between them", () => {
    const snapshot = withWork([WRITE_AGENT, COMMAND]);
    const { context: built, press } = context({ events: [onWrite], snapshot });
    expect(footer(built).hints).toContain("s interact");
    const opened = press(key("s"));
    const prompt = {
      chosen: 0,
      kind: "send",
      runId: "run-104",
      targets: [WRITE_AGENT, COMMAND],
    } as const;
    expect(opened).toEqual([["send", { prompt, type: "prompt" }]]);
    const typing = context({
      events: [onWrite, { prompt, type: "prompt" }],
      snapshot,
    });
    expect(footer(typing.context).hints).toBe(
      "steer 1/2 · Tab next · Enter send · Esc cancel"
    );
    expect(typing.press(key("tab"))).toEqual([
      ["send", { by: 1, type: "prompt-target" }],
    ]);
    const moved = context({
      events: [
        onWrite,
        { prompt, type: "prompt" },
        { by: 1, type: "prompt-target" },
      ],
      snapshot,
    });
    expect(moved.context.state.prompt).toMatchObject({ chosen: 1 });
    expect(footer(moved.context).hints).toBe(
      "input 2/2 · Tab next · Enter send · Esc cancel"
    );
  });

  it("collects the live work of the steps under the selection", () => {
    const { context: built } = context({ snapshot: withWork([COMMAND]) });
    expect(footer(built).hints).toContain("s input");
  });

  it("opens the Feed on the step's waiting question", () => {
    const { context: built, press } = context({
      events: [onWrite],
      snapshot: withWork([WRITE_AGENT], ["feed-merge"]),
    });
    expect(footer(built).hints).toContain("i answer");
    expect(press(key("i"))).toEqual([
      ["send", { type: "view", view: "feed" }],
      ["open", "feed-merge"],
    ]);
    const quiet = context({ events: [onWrite], snapshot: withWork([]) });
    expect(footer(quiet.context).hints).not.toContain("i answer");
  });
});

describe("footer", () => {
  it("names the pane, then its keys, with the lasting keys on their own line", () => {
    const { context: built } = context({
      events: [{ pane: "definition", type: "focus" }],
    });
    expect(footer(built)).toEqual({
      hints:
        "definition · Tab focus · Enter details · ↑↓ select · l launch · f filter runs · / search · a active · e failed",
      lasting: "? help · q / Ctrl+C quit",
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
      "details · Esc back · ←→ tabs · ↑↓ scroll · f follow · s steer · p pause · k cancel · b run · a active · e failed"
    );
    expect(footer(logs.context).lasting).toBe("? help · q / Ctrl+C quit");
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
          prompt: {
            chosen: 0,
            kind: "send",
            runId: "run-104",
            targets: [WRITE_AGENT],
          },
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
        "entries · ↑↓ select · Enter read · 1-2 answer · w feed scope · x all",
      lasting: "? help · q / Ctrl+C quit",
    });
  });
});

describe("key dispatch", () => {
  it("switches workspaces only where the Marbles process hosts more than one", () => {
    expect(context().press(key("w"))).toBeUndefined();
    const hosted = context({ canSwitchWorkspace: true });
    expect(hosted.press(key("w"))).toEqual([["switch-workspace"]]);
    const feed = context({
      canSwitchWorkspace: true,
      events: [{ type: "view", view: "feed" }],
    });
    expect(feed.press(key("w"))).toEqual([["switch-workspace"]]);
    expect(feed.press(key("W"))).toEqual([["cycle-scope"]]);
    expect(feed.press(key("w", { shift: true }))).toEqual([["cycle-scope"]]);
  });

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
      "Logs",
      "Feed",
      "Settings",
      "Workspaces",
      "Typing",
      "Forms",
    ]);
    for (const section of sections) {
      expect(section.items.length).toBeGreaterThan(0);
      const keys = section.items.map((item) => item.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(
      sections.find(({ title }) => title === "Dashboard")?.items
    ).toContainEqual({
      key: "v on a trigger",
      value: "Show or hide the selected trigger's configuration",
    });
  });
});
