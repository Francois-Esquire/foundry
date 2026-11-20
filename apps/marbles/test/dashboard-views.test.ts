import { describe, expect, it } from "vitest";
import { selectionKey } from "~/cli/state/dashboard-model";
import {
  type DashboardEvent,
  type DashboardState,
  initialState,
  reduce,
  visibleLists,
} from "~/cli/state/dashboard-state";
import {
  browseSearch,
  browsing,
  catalogModel,
  drawerDock,
  logsDrawer,
  mainContent,
  overviewModel,
} from "~/cli/state/dashboard-views";
import { operatingLogs } from "~/cli/state/operating-model";
import { dashboardSnapshot } from "../stories/fixtures/snapshot";

function stateAfter(...events: DashboardEvent[]): DashboardState {
  return events.reduce(
    (state, event) => reduce(state, event, dashboardSnapshot),
    initialState(dashboardSnapshot)
  );
}

const onInspect = () => undefined;
const onReset = () => undefined;
const onToggle = () => undefined;
const search = {
  editing: false,
  focused: true,
  onInput: () => undefined,
  onSubmit: () => undefined,
};

describe("drawerDock and browsing", () => {
  it("docks the workspace picker left and settings right, and logs nowhere", () => {
    expect(drawerDock(stateAfter())).toBeUndefined();
    expect(drawerDock(stateAfter({ id: "foundry", type: "picker" }))).toBe(
      "left"
    );
    expect(drawerDock(stateAfter({ type: "view", view: "settings" }))).toBe(
      "right"
    );
    expect(
      drawerDock(stateAfter({ type: "view", view: "logs" }))
    ).toBeUndefined();
  });

  it("browses the overview and catalog only while no drawer is open", () => {
    expect(browsing(stateAfter())).toBe(true);
    expect(browsing(stateAfter({ type: "view", view: "catalog" }))).toBe(true);
    expect(browsing(stateAfter({ type: "view", view: "feed" }))).toBe(false);
    expect(browsing(stateAfter({ type: "view", view: "logs" }))).toBe(false);
    expect(browsing(stateAfter({ id: "foundry", type: "picker" }))).toBe(false);
  });
});

describe("mainContent", () => {
  it("shows the feed, the overview, or the catalog for their views", () => {
    expect(mainContent(stateAfter({ type: "view", view: "feed" }), true)).toBe(
      "feed"
    );
    expect(mainContent(stateAfter(), false)).toBe("overview");
    expect(
      mainContent(stateAfter({ type: "view", view: "catalog" }), false)
    ).toBe("catalog");
  });

  it("puts details beside a wide catalog and in place of anything else", () => {
    const catalogDetails = stateAfter(
      { type: "view", view: "catalog" },
      { type: "inspect" }
    );
    expect(mainContent(catalogDetails, true)).toBe("catalog");
    expect(mainContent(catalogDetails, false)).toBe("details");
    expect(mainContent(stateAfter({ type: "inspect" }), true)).toBe("details");
  });

  it("shows the usage breakdown over the overview but not over details", () => {
    expect(
      mainContent(stateAfter({ open: true, type: "breakdown" }), true)
    ).toBe("usage");
    expect(
      mainContent({ ...stateAfter({ type: "inspect" }), breakdown: true }, true)
    ).toBe("details");
  });
});

describe("browseSearch", () => {
  it("searches the focused pane and names the run filter", () => {
    const state = stateAfter(
      { filter: { id: "docs", kind: "definition" }, type: "filter" },
      { open: true, type: "search" },
      { type: "query", value: "upd" }
    );
    expect(browseSearch(dashboardSnapshot, state, search)).toEqual({
      bar: { ...search, query: "upd", scope: "run" },
      filterLabel: "definition: update-documentation",
    });
  });

  it("has no query while details are focused", () => {
    expect(
      browseSearch(dashboardSnapshot, stateAfter({ type: "inspect" }), search)
    ).toEqual({
      bar: { ...search, query: "", scope: "details" },
      filterLabel: undefined,
    });
  });
});

describe("overviewModel", () => {
  it("prepares metrics, the next schedule, latest activity, and runs", () => {
    const state = stateAfter();
    const { rows } = visibleLists(state, dashboardSnapshot);
    const model = overviewModel(dashboardSnapshot, state, rows, "run", {
      onInspect,
      onReset,
      onToggle,
    });
    expect(model.next).toEqual({
      label: "Up next · daily-summary · Today at 17:00",
      selection: { id: "daily", kind: "trigger" },
    });
    expect(model.metrics.counts).toMatchObject({ failed: 1, running: 1 });
    expect(model.rankWorkflows().spend.map(({ id }) => id)).toEqual([
      "review",
      "docs",
    ]);
    expect(model.latest.length).toBeGreaterThan(0);
    expect(model.latest.length).toBeLessThanOrEqual(12);
    expect(model.runs).toMatchObject({
      active: true,
      filtered: false,
      selectedId: state.selected && selectionKey(state.selected),
      triggerCount: dashboardSnapshot.triggers.length,
    });
    expect(model.runs.rows.length).toBe(rows.length);
    expect(
      overviewModel(dashboardSnapshot, state, rows, undefined, {
        onInspect,
        onReset,
        onToggle,
      }).runs.active
    ).toBe(false);
  });
});

describe("catalogModel", () => {
  it("lists definitions and triggers with focus, search, and the selection", () => {
    const state = stateAfter(
      { type: "view", view: "catalog" },
      { open: true, type: "search" },
      { type: "query", value: "daily" }
    );
    const model = catalogModel(
      dashboardSnapshot,
      state,
      visibleLists(state, dashboardSnapshot),
      "trigger",
      { onInspect, onReset }
    );
    expect(model.workspace).toBe(dashboardSnapshot.workspace);
    expect(model.triggers).toMatchObject({ active: true, searching: true });
    expect(model.triggers.items.map(({ name }) => name)).toEqual([
      "daily-summary",
    ]);
    expect(model.definitions).toMatchObject({
      active: false,
      searching: false,
    });
    expect(model.definitions.items).toHaveLength(
      dashboardSnapshot.definitions.length
    );
  });
});

describe("logsDrawer", () => {
  it("searches log lines and keeps the selected line and run filter", () => {
    const [run] = dashboardSnapshot.runs;
    if (!run) {
      throw new Error("fixture has no runs");
    }
    const state = stateAfter(
      { type: "view", view: "logs" },
      { id: run.id, type: "log-run" }
    );
    const entries = operatingLogs(dashboardSnapshot);
    const [selected] = entries;
    const onSelect = () => undefined;
    const drawer = logsDrawer(
      state,
      { entries, selected, total: entries.length },
      { active: true, onSelect, search }
    );
    expect(drawer).toMatchObject({
      kind: "logs",
      logs: {
        active: true,
        filters: state.logs,
        onSelect,
        selectedId: selected?.id,
        total: entries.length,
      },
      runId: run.id,
      search: { ...search, query: "", scope: "logs" },
    });
    if (drawer.kind !== "logs") {
      throw new Error(`expected logs, got ${drawer.kind}`);
    }
    expect(drawer.logs.lines).toHaveLength(entries.length);
  });
});
