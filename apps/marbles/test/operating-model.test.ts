import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  commandFor,
  type Dashboard,
  footer,
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
  paneOf,
  reduce,
  selectedLog,
  visibleLogs,
} from "~/views/dashboard-state";
import {
  duration,
  latestActivity,
  operatingLogs,
  operatingStats,
} from "~/views/operating-model";
import { Diagnostics, lineLevel } from "~/workspace/diagnostics";
import { dashboardSnapshot } from "../preview/snapshot";

function play(
  events: readonly DashboardEvent[],
  snapshot: DashboardSnapshot = dashboardSnapshot
): DashboardState {
  return events.reduce(
    (current, event) => reduce(current, event, snapshot),
    initialState(snapshot)
  );
}

function key(name: string, extra: Partial<KeyPress> = {}): KeyPress {
  return { name, sequence: name, shift: false, ...extra };
}

/** A command context over the preview snapshot, recording what commands do. */
function commands(
  events: readonly DashboardEvent[],
  extra: Partial<CommandContext> = {}
) {
  const state = play(events);
  const lines = visibleLogs(state, dashboardSnapshot);
  const log = selectedLog(state, lines);
  const calls: unknown[][] = [];
  const context: CommandContext = {
    canLaunch: false,
    canSwitchWorkspace: false,
    feed: {
      answer: {
        cancel: () => undefined,
        choices: [],
        choose: () => undefined,
        choosing: undefined,
        question: undefined,
        start: () => undefined,
        typing: false,
      },
      browse: () => undefined,
      cycleScope: () => undefined,
      focus: "list",
      move: () => undefined,
      read: () => undefined,
      resetScope: () => undefined,
      scopeCount: 1,
    },
    ...(log ? { log } : {}),
    resolved: resolveSelection(dashboardSnapshot, state.selected),
    state,
    ...extra,
  };
  const dashboard: Dashboard = {
    ...context,
    act: (work) => {
      calls.push(["act"]);
      work().catch(() => undefined);
    },
    launch: () => undefined,
    quit: () => undefined,
    send: (event) => calls.push(["send", event]),
    switchWorkspace: () => calls.push(["switch-workspace"]),
  };
  return {
    context,
    press(pressed: KeyPress) {
      const command = commandFor(pressed, context);
      command?.run(dashboard, pressed);
      return command ? calls.splice(0) : undefined;
    },
  };
}

describe("tabs", () => {
  it("opens on Overview with a run, follows focus between Overview and Catalog, and keeps selections", () => {
    expect(initialState(dashboardSnapshot).view).toBe("overview");
    const catalog = play([{ type: "view", view: "catalog" }]);
    expect(catalog.view).toBe("catalog");
    expect(paneOf(catalog)).toBe("trigger");
    const marbles = play([
      { pane: "definition", type: "focus" },
      { by: 2, type: "move" },
      { type: "view", view: "overview" },
    ]);
    expect(marbles).toMatchObject({ focus: "run", view: "overview" });
    // Catalog returns to the list and row it had.
    expect(
      reduce(marbles, { type: "view", view: "catalog" }, dashboardSnapshot)
    ).toMatchObject({
      focus: "definition",
      selected: { id: "summary", kind: "definition" },
      view: "catalog",
    });
  });

  it("filtering from the catalog shows the runs on Overview", () => {
    const state = play([
      { pane: "definition", type: "focus" },
      { filter: { id: "docs", kind: "definition" }, type: "filter" },
    ]);
    expect(state).toMatchObject({ focus: "run", view: "overview" });
    const empty = play([
      { filter: { id: "summary", kind: "definition" }, type: "filter" },
    ]);
    expect(empty).toMatchObject({ selected: undefined, view: "overview" });
  });

  it("Logs, Feed and Settings leave the lists as they were, and home returns to them", () => {
    const state = play([
      { pane: "definition", type: "focus" },
      { type: "view", view: "logs" },
    ]);
    expect(state).toMatchObject({ focus: "definition", view: "logs" });
    expect(reduce(state, { type: "home" }, dashboardSnapshot).view).toBe(
      "catalog"
    );
  });

  it("Shift and a letter opens each tab; plain letters keep their meanings", () => {
    const noop = () => Promise.resolve();
    const { press } = commands([], {
      actions: { cancel: noop, pause: noop, resume: noop, steer: noop },
    });
    for (const [letter, view] of [
      ["D", "overview"],
      ["C", "catalog"],
      ["L", "logs"],
      ["F", "feed"],
      ["S", "settings"],
    ] as const) {
      expect(
        press(key(letter.toLowerCase(), { sequence: letter, shift: true }))
      ).toEqual([["send", { type: "view", view }]]);
    }
    // Plain s still steers the running run on Overview.
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
});

describe("logs", () => {
  it("merges run lines and host lines, attributed, in time order", () => {
    const snapshot: DashboardSnapshot = {
      ...dashboardSnapshot,
      diagnostics: [
        {
          id: "h1",
          level: "warn",
          message: "late",
          timestamp: "2026-01-01T00:00:03Z",
        },
      ],
      runs: [
        {
          ...(dashboardSnapshot.runs[0] as DashboardSnapshot["runs"][number]),
          logs: [
            {
              id: "r1",
              level: "info",
              message: "first",
              stepId: "a",
              timestamp: "2026-01-01T00:00:01Z",
            },
            {
              id: "r2",
              level: "error",
              message: "last",
              timestamp: "2026-01-01T00:00:05Z",
            },
          ],
        },
      ],
    };
    expect(
      operatingLogs(snapshot).map((line) => [line.id, line.source, line.runId])
    ).toEqual([
      ["r1", "run", "run-104"],
      ["h1", "host", undefined],
      ["r2", "run", "run-104"],
    ]);
  });

  it("filters by level, source and search, follows the newest line, and stops following on a move", () => {
    const all = play([{ type: "view", view: "logs" }]);
    const lines = visibleLogs(all, dashboardSnapshot);
    expect(lines).toHaveLength(6);
    expect(selectedLog(all, lines)?.id).toBe(lines.at(-1)?.id);

    const moved = reduce(all, { by: -1, type: "log-move" }, dashboardSnapshot);
    expect(moved.logs.follow).toBe(false);
    expect(selectedLog(moved, lines)?.id).toBe(lines.at(-2)?.id);

    const info = reduce(all, { type: "log-level" }, dashboardSnapshot);
    expect(info.logs.level).toBe("info");
    expect(
      visibleLogs(info, dashboardSnapshot).some(
        (line) => line.level === "debug"
      )
    ).toBe(false);

    const host = reduce(
      reduce(all, { type: "log-source" }, dashboardSnapshot),
      { type: "log-source" },
      dashboardSnapshot
    );
    expect(host.logs.source).toBe("host");
    expect(
      visibleLogs(host, dashboardSnapshot).every(
        (line) => line.source === "host"
      )
    ).toBe(true);

    const searched = reduce(
      all,
      { type: "query", value: "cli" },
      dashboardSnapshot
    );
    expect(searched.queries).toEqual(all.queries);
    expect(
      visibleLogs(searched, dashboardSnapshot).map((line) => line.message)
    ).toEqual([
      "Found src/cli.ts",
      "Loaded cli.md",
      "Writing CLI reference changes.",
    ]);
    expect(
      reduce(searched, { type: "log-clear" }, dashboardSnapshot).logs
    ).toEqual(all.logs);
  });

  it("Enter opens the run a line came from, at its step; host lines open nothing", () => {
    const onRunLine = commands([{ type: "view", view: "logs" }]);
    expect(footer(onRunLine.context).hints).toBe(
      "logs · ↑↓ select · Enter open run · f stop following · v level debug+ · o source all · / search · x clear"
    );
    expect(onRunLine.press(key("return"))).toEqual([
      [
        "send",
        {
          selection: { id: "run-104", kind: "run", stepId: "write" },
          type: "inspect",
        },
      ],
    ]);
    const opened = reduce(
      play([{ type: "view", view: "logs" }]),
      {
        selection: { id: "run-104", kind: "run", stepId: "write" },
        type: "inspect",
      },
      dashboardSnapshot
    );
    expect(opened).toMatchObject({ inspecting: true, view: "overview" });

    const onHost = commands([
      { type: "view", view: "logs" },
      { type: "log-source" },
      { type: "log-source" },
    ]);
    expect(onHost.press(key("return"))).toBeUndefined();
  });
});

describe("settings keys", () => {
  it("cycle the theme through the host, and do nothing where the host cannot save", async () => {
    const saved: unknown[] = [];
    const editable = commands([{ type: "view", view: "settings" }], {
      settings: {
        change: (changes) => {
          saved.push(changes);
          return Promise.resolve();
        },
        current: { path: "/tmp/settings.json", theme: "dark" },
      },
    });
    expect(footer(editable.context).hints).toBe("settings · ←→ theme");
    expect(editable.press(key("right"))).toEqual([["act"]]);
    await Promise.resolve();
    expect(saved).toEqual([{ theme: "light" }]);

    const readOnly = commands([{ type: "view", view: "settings" }], {
      settings: { current: { path: "/tmp/settings.json", theme: "dark" } },
    });
    expect(readOnly.press(key("right"))).toBeUndefined();
  });
});

describe("statistics", () => {
  it("counts runs by what an operator does about them, with medians over real timings only", () => {
    const stats = operatingStats(dashboardSnapshot.runs);
    expect(stats.counts).toEqual({
      cancelled: 0,
      complete: 1,
      failed: 1,
      queued: 0,
      running: 1,
      waiting: 0,
    });
    expect(stats.successRate).toBe(0.5);
    // check-api ran 3s and review-changes 41s; run-104 has not ended.
    expect(stats.medianRunMs).toBe(22_000);
    expect(stats.medianQueueMs).toBe(1000);
    const waiting = operatingStats([
      {
        ...(dashboardSnapshot.runs[0] as DashboardSnapshot["runs"][number]),
        attention: "approval",
      },
      {
        ...(dashboardSnapshot.runs[1] as DashboardSnapshot["runs"][number]),
        status: "suspended",
        timing: undefined,
      },
      {
        ...(dashboardSnapshot.runs[2] as DashboardSnapshot["runs"][number]),
        status: "queued",
        timing: { createdAt: 5 },
      },
    ]);
    expect(waiting.counts).toMatchObject({ queued: 1, running: 0, waiting: 2 });
    expect(waiting.medianRunMs).toBeUndefined();
    expect(operatingStats([]).successRate).toBeUndefined();
  });

  it("lists the latest run changes and this workspace's feed entries, newest first", () => {
    const latest = latestActivity(dashboardSnapshot, 4);
    expect(latest.map((item) => item.text)).toEqual([
      "input: Merge the docs update?",
      "update-documentation started",
      "result: Codebase summary",
      "check-api failed",
    ]);
    expect(latest.every((item) => !item.text.includes("Docs updated"))).toBe(
      true
    );
  });

  it("formats durations", () => {
    expect(duration(850)).toBe("850ms");
    expect(duration(12_300)).toBe("12.3s");
    expect(duration(245_000)).toBe("4m 05s");
  });

  it("carries a duration that rounds up into the next unit", () => {
    expect(duration(999.4)).toBe("999ms");
    expect(duration(999.5)).toBe("1.0s");
    expect(duration(1000)).toBe("1.0s");
    expect(duration(59_949)).toBe("59.9s");
    expect(duration(59_950)).toBe("1m 00s");
    expect(duration(60_000)).toBe("1m 00s");
    expect(duration(60_499)).toBe("1m 00s");
    expect(duration(60_500)).toBe("1m 01s");
    expect(duration(119_499)).toBe("1m 59s");
    expect(duration(119_500)).toBe("2m 00s");
    expect(duration(119_999)).toBe("2m 00s");
    expect(duration(179_500)).toBe("3m 00s");
    expect(duration(3_599_500)).toBe("60m 00s");
  });
});

describe("host diagnostics", () => {
  it("keeps the newest lines in memory with levels and stable ids", () => {
    const diagnostics = new Diagnostics(
      2,
      () => new Date("2026-01-01T00:00:00Z")
    );
    diagnostics.add("[source] loaded");
    diagnostics.add("[state] run r not saved: disk full");
    diagnostics.add("[run] boom", "error");
    expect(diagnostics.entries).toEqual([
      {
        id: "host:2",
        level: "warn",
        message: "[state] run r not saved: disk full",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "host:3",
        level: "error",
        message: "[run] boom",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(lineLevel("Watching triggers")).toBe("info");
    expect(lineLevel("[schedule] daily failed: x")).toBe("warn");
  });
});
