import { describe, expect, it } from "vitest";
import type { DashboardSnapshot } from "~/views/dashboard-model";
import {
  type DashboardEvent,
  type DashboardState,
  initialState,
  launchesDirectly,
  paneOf,
  reduce,
  visibleLists,
} from "~/views/dashboard-state";
import { dashboardSnapshot } from "../preview/snapshot";

const empty: DashboardSnapshot = {
  ...dashboardSnapshot,
  definitions: [],
  runs: [],
  triggers: [],
};

/** Apply events in order, as a run of key presses would. */
function play(
  events: readonly DashboardEvent[],
  snapshot = dashboardSnapshot,
  state: DashboardState = initialState(snapshot)
): DashboardState {
  return events.reduce(
    (current, event) => reduce(current, event, snapshot),
    state
  );
}

describe("initialState", () => {
  it("selects the running run with its branches open", () => {
    const state = initialState(dashboardSnapshot);
    expect(state.selected).toEqual({ id: "run-104", kind: "run" });
    expect(paneOf(state)).toBe("run");
    expect(state.expanded.has("run:run-104:step:update")).toBe(true);
    expect(state.remembered.run).toEqual(state.selected);
  });

  it("falls back to the first trigger, then the first definition", () => {
    expect(initialState({ ...dashboardSnapshot, runs: [] }).selected).toEqual({
      id: "docs-monitor",
      kind: "trigger",
    });
    expect(
      initialState({ ...dashboardSnapshot, runs: [], triggers: [] }).selected
    ).toEqual({ id: "docs", kind: "definition" });
  });

  it("focuses Triggers when there is nothing to select", () => {
    const state = initialState(empty);
    expect(state.selected).toBeUndefined();
    expect(paneOf(state)).toBe("trigger");
  });
});

describe("panes", () => {
  it("cycles Triggers, Marbles, Runs, and backwards", () => {
    const panes = [1, 2, 3].map((count) =>
      paneOf(
        play(
          Array.from(
            { length: count },
            () => ({ backwards: false, type: "cycle" }) as const
          )
        )
      )
    );
    expect(panes).toEqual(["trigger", "definition", "run"]);
    expect(paneOf(play([{ backwards: true, type: "cycle" }]))).toBe(
      "definition"
    );
  });

  it("restores each list's last selection when it takes focus again", () => {
    const state = play([
      { pane: "trigger", type: "focus" },
      { by: 1, type: "move" },
      { pane: "definition", type: "focus" },
      { pane: "trigger", type: "focus" },
    ]);
    expect(state.selected).toEqual({ id: "review-monitor", kind: "trigger" });
  });

  it("returns from details to the list that had focus, even with nothing selected", () => {
    const state = play(
      [{ pane: "definition", type: "focus" }, { type: "inspect" }],
      empty
    );
    expect(paneOf(state)).toBe("details");
    expect(paneOf(reduce(state, { type: "back" }, empty))).toBe("definition");
    expect(paneOf(reduce(state, { type: "home" }, empty))).toBe("definition");
    expect(
      paneOf(reduce(state, { backwards: false, type: "cycle" }, empty))
    ).toBe("definition");
  });

  it("selecting from details lands in that selection's list", () => {
    const state = play([
      { pane: "trigger", type: "focus" },
      { type: "inspect" },
      { selection: { id: "run-103", kind: "run" }, type: "inspect" },
      { type: "back" },
    ]);
    expect(paneOf(state)).toBe("run");
    expect(state.remembered.run).toEqual({ id: "run-103", kind: "run" });
  });
});

describe("moving and folding", () => {
  it("moves within the visible rows and stops at the ends", () => {
    const up = play([{ by: -1, type: "move" }]);
    expect(up.selected).toEqual({ id: "run-104", kind: "run" });
    const down = play(
      Array.from({ length: 20 }, () => ({ by: 1, type: "move" }) as const)
    );
    expect(down.selected).toEqual({ id: "run-102", kind: "run" });
  });

  it("ignores moves while details has the keys", () => {
    const state = play([{ type: "inspect" }, { by: 1, type: "move" }]);
    expect(state.selected).toEqual({ id: "run-104", kind: "run" });
  });

  it("folds the selected branch and leaves leaves alone", () => {
    const closed = play([{ open: false, type: "fold" }]);
    expect(closed.expanded.has("run:run-104")).toBe(false);
    expect(visibleLists(closed, dashboardSnapshot).rows).toHaveLength(3);
    expect(
      play([{ open: false, type: "fold" }], dashboardSnapshot, closed)
    ).toBe(closed);
    const reopened = reduce(closed, { type: "fold" }, dashboardSnapshot);
    expect(reopened.expanded.has("run:run-104")).toBe(true);
  });
});

describe("jumps, filters, and search", () => {
  it("jumps to the latest failure, opening its run and clearing the run search", () => {
    const state = play([
      { open: true, type: "search" },
      { type: "query", value: "zzz" },
      { open: false, type: "search" },
      { type: "inspect" },
      { status: "failed", type: "jump" },
    ]);
    expect(state.queries.run).toBe("");
    expect(state.selected).toEqual({
      id: "run-103",
      kind: "run",
      stepId: "request",
    });
    expect(paneOf(state)).toBe("run");
    expect(state.expanded.has("run:run-103")).toBe(true);
    expect(state.tab).toBe("overview");
  });

  it("filters runs to a catalog item, or empties Runs when it has none", () => {
    const docs = play([
      { filter: { id: "docs", kind: "definition" }, type: "filter" },
    ]);
    expect(docs.selected).toEqual({ id: "run-104", kind: "run" });
    const summary = play([
      { pane: "trigger", type: "focus" },
      { filter: { id: "daily", kind: "trigger" }, type: "filter" },
    ]);
    expect(summary.selected).toBeUndefined();
    expect(paneOf(summary)).toBe("run");
    expect(visibleLists(summary, dashboardSnapshot).rows).toEqual([]);
    const cleared = reduce(
      summary,
      { type: "clear-filters" },
      dashboardSnapshot
    );
    expect(
      visibleLists(cleared, dashboardSnapshot).rows.length
    ).toBeGreaterThan(0);
  });

  it("searches the focused list only, and Esc clears that search", () => {
    const searching = play([
      { pane: "definition", type: "focus" },
      { open: true, type: "search" },
      { type: "query", value: "review" },
    ]);
    expect(visibleLists(searching, dashboardSnapshot).definitions).toEqual([
      expect.objectContaining({ id: "review" }),
    ]);
    expect(visibleLists(searching, dashboardSnapshot).triggers).toHaveLength(3);
    const cancelled = reduce(
      searching,
      { type: "cancel-search" },
      dashboardSnapshot
    );
    expect(cancelled.searching).toBe(false);
    expect(cancelled.queries.definition).toBe("");
  });
});

describe("prompts, home, and launches", () => {
  it("opens a prompt with an empty draft and closes it again", () => {
    const prompt = { kind: "steer", runId: "run-104", stepId: "docs" } as const;
    const typed = play([
      { prompt, type: "prompt" },
      { type: "draft", value: "summarise" },
    ]);
    expect(typed.prompt).toEqual(prompt);
    expect(typed.draft).toBe("summarise");
    const closed = reduce(typed, { type: "prompt" }, dashboardSnapshot);
    expect(closed.prompt).toBeUndefined();
    expect(closed.draft).toBe("");
  });

  it("goes home from help, search, details, and the feed without losing the selection", () => {
    const state = play([
      { status: "running", type: "jump" },
      { type: "inspect" },
      { open: true, type: "help" },
      { type: "view", view: "feed" },
      { type: "home" },
    ]);
    expect(state).toMatchObject({
      help: false,
      searching: false,
      selected: { id: "run-104", kind: "run", stepId: "write" },
      view: "dashboard",
    });
    expect(paneOf(state)).toBe("run");
  });

  it("closes the argument form and shows a started run with filters cleared", () => {
    const state = play([
      { filter: { id: "api", kind: "definition" }, type: "filter" },
      { id: "docs", type: "launch-form" },
      { tab: "logs", type: "tab" },
      { id: "run-new", type: "show-run" },
    ]);
    expect(state).toMatchObject({
      filter: undefined,
      inspecting: false,
      launching: undefined,
      selected: { id: "run-new", kind: "run" },
      tab: "overview",
    });
    expect(state.expanded.has("run:run-new")).toBe(true);
  });

  it("launches only definitions with no arguments to ask for directly", () => {
    const [docs] = dashboardSnapshot.definitions;
    if (!docs) {
      throw new Error("Missing definition fixture");
    }
    expect(launchesDirectly(docs)).toBe(false);
    expect(launchesDirectly({ ...docs, input: { fields: [] } })).toBe(true);
    expect(
      launchesDirectly({
        ...docs,
        input: {
          fields: [{ label: "Message", name: "message", type: "text" }],
        },
      })
    ).toBe(false);
  });

  it("never changes the state it was given", () => {
    const before = initialState(dashboardSnapshot);
    const copy = structuredClone(before);
    play(
      [
        { status: "failed", type: "jump" },
        { open: false, type: "fold" },
        { type: "query", value: "x" },
        { id: "run-1", type: "show-run" },
      ],
      dashboardSnapshot,
      before
    );
    expect(before).toEqual(copy);
  });
});
