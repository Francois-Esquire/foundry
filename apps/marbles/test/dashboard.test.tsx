import { afterEach, expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import { previewScenarios } from "../preview/scenarios";
import { dashboardSnapshot } from "../preview/snapshot";
import { DashboardView } from "../src/views/dashboard";
import type { DashboardSnapshot } from "../src/views/dashboard-model";
import { click, flush, mount, press, unmount } from "./helpers/render";

const WRITE_STEP = /Step\s+: write/;
const FAILED_RUN = /Run\s+: run-103/;
const NEXT_TIME = /Next\s+: Today at 17:00/;
const TARGET_NAME = /Target\s+: summarize-day/;
const ACTIVE_RUN = /Run\s+: run-104/;
const REQUEST_STEP = /Step\s+: request/;

let closed = false;
function close() {
  closed = true;
}

function render(snapshot = dashboardSnapshot, width = 120, height = 40) {
  closed = false;
  return mount(<DashboardView onClose={close} snapshot={snapshot} />, {
    height,
    width,
  });
}

afterEach(unmount);

test("composes typed catalogs and a nested run browser from a snapshot", async () => {
  const ui = await render();
  const frame = ui.captureCharFrame();
  for (const label of [
    "preview",
    "1 Triggers",
    "Runs",
    "[schedule]",
    "[monitor]",
    "[step]",
    "Write changes",
    "run-104",
  ]) {
    expect(frame).toContain(label);
  }
  expect(frame).toContain("2 Marbles");
  await press(ui, "m");
  expect(ui.captureCharFrame()).toContain("2 Marbles");
  expect(ui.captureCharFrame()).toContain("[workflow]");
});

test("keyboard selection inspects nested steps and a failed run", async () => {
  const ui = await render();
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      ui.mockInput.pressArrow("down");
    });
  }
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("[step] Write changes");
  await press(ui, "RETURN");
  expect(ui.captureCharFrame()).toMatch(WRITE_STEP);
  await act(async () => {
    ui.mockInput.pressArrow("right");
  });
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("Update the CLI reference.");
  await act(async () => {
    ui.mockInput.pressArrow("left");
  });
  await act(async () => {
    ui.mockInput.pressEscape();
  });
  await act(async () => {
    ui.mockInput.pressArrow("down");
  });
  await flush(ui);
  await press(ui, "RETURN");
  expect(ui.captureCharFrame()).toMatch(FAILED_RUN);
  expect(ui.captureCharFrame()).toContain("Error: Connection refused");
});

test("clicking a catalog row shows its target and next scheduled time", async () => {
  const ui = await render();
  await click(ui, "trigger:daily");
  expect(ui.captureCharFrame()).toMatch(NEXT_TIME);
  expect(ui.captureCharFrame()).toMatch(TARGET_NAME);
});

test("narrow terminals switch between the run tree and details", async () => {
  const ui = await render(dashboardSnapshot, 70, 24);
  expect(ui.captureCharFrame()).toContain("Write changes");
  await act(async () => {
    ui.mockInput.pressEnter();
  });
  await flush(ui);
  expect(ui.captureCharFrame()).toMatch(ACTIVE_RUN);
  await act(async () => {
    ui.mockInput.pressEscape();
  });
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("Write changes");
  await act(async () => {
    ui.mockInput.pressKey("q");
  });
  expect(closed).toBe(false);
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("Quit Marbles?");
});

test("empty snapshots remain navigable and explain the waiting state", async () => {
  const empty: DashboardSnapshot = {
    ...dashboardSnapshot,
    definitions: [],
    runs: [],
    triggers: [],
  };
  const ui = await render(empty);
  expect(ui.captureCharFrame()).toContain("No schedules or monitors.");
  expect(ui.captureCharFrame()).toContain(
    "Launch a step or workflow from Marbles."
  );
  await press(ui, "m");
  expect(ui.captureCharFrame()).toContain("No workflows or steps.");
  // Details of nothing, then back to the list that had focus.
  await press(ui, "RETURN");
  await press(ui, "ESCAPE");
  expect(ui.captureCharFrame()).toContain("definition ·");
  await act(async () => {
    ui.mockInput.pressArrow("down");
    ui.mockInput.pressCtrlC();
  });
  expect(closed).toBe(false);
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("Quit Marbles?");
});

test("keyboard navigation keeps a selected run visible in a long list", async () => {
  const snapshot: DashboardSnapshot = {
    ...dashboardSnapshot,
    runs: Array.from({ length: 30 }, (_, index) => ({
      definitionId: "review",
      elapsed: "1s",
      id: `history-${index}`,
      name: `Review ${index}`,
      started: "14:00:00",
      status: "complete",
      steps: [],
    })),
  };
  const ui = await render(snapshot, 70, 16);
  for (let index = 0; index < 25; index += 1) {
    await act(async () => {
      ui.mockInput.pressArrow("down");
    });
    await flush(ui);
  }
  expect(ui.captureCharFrame()).toContain("› · Review 25");
});

test("branch toggles and panel focus preserve run selection and expansion", async () => {
  const ui = await render();
  await click(ui, "expand:run:run-104:step:update");
  expect(ui.captureCharFrame()).not.toContain("[step] Write changes");
  await press(ui, "1");
  await press(ui, "TAB");
  await press(ui, "TAB");
  expect(ui.captureCharFrame()).not.toContain("[step] Write changes");
  await press(ui, "a");
  expect(ui.captureCharFrame()).toContain("[step] Write changes");
  await press(ui, "RETURN");
  expect(ui.captureCharFrame()).toMatch(WRITE_STEP);
  await press(ui, "ESCAPE");
  await press(ui, "e");
  await press(ui, "RETURN");
  expect(ui.captureCharFrame()).toMatch(REQUEST_STEP);
  expect(ui.captureCharFrame()).toContain("Connection refused");
});

test("catalog run filters remain explicit and can be cleared", async () => {
  const ui = await render();
  await click(ui, "trigger:docs-monitor");
  await press(ui, "f");
  expect(ui.captureCharFrame()).toContain("Run filter: trigger: update-docs");
  expect(ui.captureCharFrame()).not.toContain("run-103");
  await press(ui, "x");
  expect(ui.captureCharFrame()).not.toContain("Run filter:");
  expect(ui.captureCharFrame()).toContain("run-103");
});

test("search consumes shortcut letters and scopes matches to the focused list", async () => {
  const ui = await render();
  await press(ui, "/");
  await act(async () => {
    await ui.mockInput.typeText("check-api");
  });
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("Search run: check-api");
  expect(ui.captureCharFrame()).not.toContain("· run-104");
  expect(closed).toBe(false);
  await press(ui, "RETURN");
  await press(ui, "ARROW_DOWN");
  await press(ui, "RETURN");
  expect(ui.captureCharFrame()).toMatch(FAILED_RUN);
  await press(ui, "ESCAPE");
  await press(ui, "x");
  expect(ui.captureCharFrame()).toContain("· run-104");
  await press(ui, "?");
  expect(ui.captureCharFrame()).toContain("Keyboard help");
  await press(ui, "ESCAPE");
  expect(ui.captureCharFrame()).not.toContain("Keyboard help");
});

test("keyboard help lists the command table by section", async () => {
  const ui = await render(dashboardSnapshot, 120, 80);
  await press(ui, "?");
  const frame = ui.captureCharFrame();
  for (const text of [
    "Keyboard help",
    "Anywhere",
    "Run controls",
    "Steer the agent running in the step",
    "Cycle the workspace filter",
    "Move focus / submit arguments",
  ]) {
    expect(frame).toContain(text);
  }
});

test("inspector scopes logs to a step and its breadcrumb returns to the run", async () => {
  const ui = await render();
  await press(ui, "a");
  await press(ui, "RETURN");
  await click(ui, "tab:logs");
  expect(ui.captureCharFrame()).toContain("Writing CLI reference changes.");
  expect(ui.captureCharFrame()).not.toContain("Found src/cli.ts");
  await click(ui, "breadcrumb:run");
  expect(ui.captureCharFrame()).toContain("Found src/cli.ts");
  await click(ui, "tab:input");
  expect(ui.captureCharFrame()).toContain('0: "src/cli.ts"');
  await press(ui, " ");
  expect(ui.captureCharFrame()).not.toContain('0: "src/cli.ts"');
});

let updateSnapshot: ((snapshot: DashboardSnapshot) => void) | undefined;
function UpdatingDashboard() {
  const [snapshot, setSnapshot] = useState(dashboardSnapshot);
  useEffect(() => {
    updateSnapshot = setSnapshot;
    return () => {
      updateSnapshot = undefined;
    };
  }, []);
  return <DashboardView onClose={close} snapshot={snapshot} />;
}

test("new snapshots preserve the inspected step when new runs arrive", async () => {
  const ui = await mount(<UpdatingDashboard />);
  await press(ui, "a");
  await press(ui, "RETURN");
  await act(async () => {
    updateSnapshot?.({
      ...dashboardSnapshot,
      runs: [
        {
          definitionId: "api",
          elapsed: "0s",
          id: "new-run",
          name: "New run",
          started: "14:33:00",
          status: "running",
          steps: [],
        },
        ...dashboardSnapshot.runs,
      ],
    });
  });
  await flush(ui);
  expect(ui.captureCharFrame()).toMatch(WRITE_STEP);
  await press(ui, "ESCAPE");
  expect(ui.captureCharFrame()).toContain("New run");
});

test("short terminals can page the inspector and changing tabs resets its scroll", async () => {
  const scenario = previewScenarios.find((item) => item.id === "output");
  const snapshot = scenario?.frames[0];
  if (!snapshot) {
    throw new Error("Missing long-output scenario");
  }
  const ui = await render(snapshot, 120, 24);
  await press(ui, "RETURN");
  await press(ui, "ARROW_RIGHT");
  await press(ui, "ARROW_RIGHT");
  expect(ui.captureCharFrame()).toContain("Line 1:");
  await act(async () => {
    await ui.mockInput.pressKeys(["\u001b[6~"]);
    await ui.mockInput.pressKeys(["\u001b[6~"]);
  });
  await flush(ui);
  expect(ui.captureCharFrame()).not.toContain("Line 1:");
  await press(ui, "ARROW_LEFT");
  expect(ui.captureCharFrame()).toContain("Overview  Input  Output  Logs");
});

test("Triggers, Marbles, and larger Runs stack at both widths", async () => {
  for (const width of [70, 120]) {
    const ui = await render(dashboardSnapshot, width, 24);
    const frame = ui.captureCharFrame();
    expect(frame).toContain("[monitor] update-docs");
    expect(frame).toContain("running Watch");
    expect(frame).toContain("[monitor] review-code");
    expect(frame).toContain("[schedule] daily-summary");
    expect(frame).toContain("Next: Today");
    expect(frame).toContain("Write changes");
    expect(frame).not.toContain("Schedules & monitors");
    expect(frame).not.toContain("captured at");
    const triggers = ui.renderer.root.findDescendantById("panel:trigger");
    const run = ui.renderer.root.findDescendantById("panel:run");
    const catalog = ui.renderer.root.findDescendantById("panel:definition");
    if (!(triggers && run && catalog)) {
      throw new Error("Missing dashboard panel");
    }
    expect(triggers.height).toBe(catalog.height);
    expect(run.height).toBeGreaterThan(triggers.height);
    expect(catalog.y).toBe(triggers.y + triggers.height);
    expect(run.y).toBe(catalog.y + catalog.height);
    expect(run.width).toBe(triggers.width);
    expect(catalog.width).toBe(run.width);
    expect(
      ui.renderer.root.findDescendantById("panel:schedule")
    ).toBeUndefined();
    expect(
      ui.renderer.root.findDescendantById("panel:monitor")
    ).toBeUndefined();
    await act(async () => ui.renderer.resize(width, 16));
    await flush(ui);
    expect(triggers.height).toBe(catalog.height);
    expect(run.height).toBeGreaterThan(triggers.height);
    expect(run.y + run.height).toBeLessThanOrEqual(14);
  }
});

test("Tab focuses the three visible dashboard panels", async () => {
  const ui = await render(dashboardSnapshot, 70, 24);
  for (const name of ["trigger", "definition", "run", "trigger"]) {
    await press(ui, "TAB");
    const frame = ui.captureCharFrame();
    expect(frame).toContain(`${name} ·`);
    expect(frame).toContain("1 Triggers");
    expect(frame).toContain("3 Runs");
    expect(frame).toContain("2 Marbles");
    expect(frame).not.toContain("Overview  Input");
  }
});

test("Marbles remains visible and its details return to the same panel", async () => {
  const ui = await render(dashboardSnapshot, 70, 24);
  await press(ui, "m");
  expect(ui.captureCharFrame()).toContain("2 Marbles");
  expect(ui.captureCharFrame()).toContain("[workflow] update-documentation");
  expect(ui.captureCharFrame()).toContain("3 Runs");
  await press(ui, "RETURN");
  expect(ui.captureCharFrame()).toContain("Find changes, update documentation");
  await press(ui, "ESCAPE");
  expect(ui.captureCharFrame()).toContain("2 Marbles");
  await press(ui, "ARROW_DOWN");
  await press(ui, "ARROW_DOWN");
  await press(ui, "ARROW_DOWN");
  expect(ui.captureCharFrame()).toContain("[step] check-api");
  await press(ui, "3");
  expect(ui.captureCharFrame()).toContain("[schedule] daily-summary");
  expect(ui.captureCharFrame()).toContain("[monitor] update-docs");
  await press(ui, "a");
  await press(ui, "RETURN");
  expect(ui.captureCharFrame()).toMatch(WRITE_STEP);
  expect(ui.captureCharFrame()).not.toContain("1 Triggers");
  await press(ui, "ESCAPE");
  expect(ui.captureCharFrame()).toContain("3 Runs");
});

test("Triggers searches both kinds and remembers selection when returning from Marbles", async () => {
  const ui = await render(dashboardSnapshot, 70, 30);
  await press(ui, "1");
  expect(ui.captureCharFrame()).toContain("› [monitor] update-docs");
  await press(ui, "ARROW_DOWN");
  await press(ui, "/");
  await act(async () => ui.mockInput.typeText("review"));
  await flush(ui);
  expect(ui.captureCharFrame()).not.toContain("daily-summary");
  expect(ui.captureCharFrame()).not.toContain("[monitor] update-docs");
  expect(ui.captureCharFrame()).toContain("[monitor] review-code");
  await press(ui, "RETURN");
  await press(ui, "2");
  await press(ui, "1");
  await press(ui, "RETURN");
  expect(ui.captureCharFrame()).toContain("Watch src/**/* for code changes.");
  await press(ui, "ESCAPE");
  await press(ui, "x");
  await press(ui, "/");
  await act(async () => ui.mockInput.typeText("schedule"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("[schedule] daily-summary");
  expect(ui.captureCharFrame()).not.toContain("[monitor]");
  await press(ui, "RETURN");
  await press(ui, "ARROW_DOWN");
  await press(ui, "RETURN");
  expect(ui.captureCharFrame()).toMatch(TARGET_NAME);
});

test("Marbles filtering scopes Runs without replacing any dashboard panels", async () => {
  const ui = await render();
  await press(ui, "2");
  await press(ui, "f");
  const frame = ui.captureCharFrame();
  expect(frame).toContain("Run filter: definition: update-documentation");
  expect(frame).toContain("1 Triggers");
  expect(frame).toContain("2 Marbles");
  expect(frame).toContain("3 Runs");
  expect(frame).toContain("run-104");
  expect(frame).not.toContain("run-103");
  await press(ui, "2");
  await press(ui, "RETURN");
  expect(ui.captureCharFrame()).toContain("Find changes, update documentation");
  await press(ui, "ESCAPE");
  expect(ui.captureCharFrame()).toContain("definition ·");
});

test("clicking marbles and the h shortcut return home without losing run selection", async () => {
  const ui = await render();
  await press(ui, "a");
  const before = ui.captureCharFrame();
  await press(ui, "RETURN");
  expect(ui.captureCharFrame()).toMatch(WRITE_STEP);
  await click(ui, "nav:home");
  expect(ui.captureCharFrame()).toBe(before);
  await press(ui, "RETURN");
  await press(ui, "h");
  expect(ui.captureCharFrame()).toBe(before);
  await press(ui, "?");
  await click(ui, "nav:home");
  expect(ui.captureCharFrame()).toBe(before);
});
