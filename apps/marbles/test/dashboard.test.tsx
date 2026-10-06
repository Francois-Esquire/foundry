import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { sleep } from "bun";
import { act, useEffect, useState } from "react";
import { PreviewApp } from "../preview/app";
import { previewScenarios } from "../preview/scenarios";
import { dashboardSnapshot } from "../preview/snapshot";
import { PreviewStartup } from "../preview/startup";
import { JSONView } from "../src/components/ui/json";
import { Log, type LogEntry } from "../src/components/ui/log";
import type { FeedAnswer } from "../src/lib/feed/entry";
import { DashboardView } from "../src/views/dashboard";
import type { DashboardSnapshot } from "../src/views/dashboard-model";
import type { RunActions } from "../src/views/run-actions";
import { SplashView } from "../src/views/splash";
import { type SplashState, summarizeConfig } from "../src/views/splash-model";

const WRITE_STEP = /Step\s+: write/;
const FAILED_RUN = /Run\s+: run-103/;
const NEXT_TIME = /Next\s+: Today at 17:00/;
const TARGET_NAME = /Target\s+: summarize-day/;
const ACTIVE_RUN = /Run\s+: run-104/;
const REQUEST_STEP = /Step\s+: request/;

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let closed = false;
function close() {
  closed = true;
}

async function flush(ui: Awaited<ReturnType<typeof testRender>>) {
  // Layout measurements update panel heights, then React commits the new sizes.
  await act(async () => ui.flush());
  await act(async () => ui.flush());
}

async function render(snapshot = dashboardSnapshot, width = 120, height = 40) {
  closed = false;
  setup = await testRender(
    <DashboardView onClose={close} snapshot={snapshot} />,
    { exitOnCtrlC: false, height, kittyKeyboard: true, width }
  );
  await flush(setup);
  return setup;
}

afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy();
  });
  setup = undefined;
});

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
  const row = ui.renderer.root.findDescendantById("trigger:daily");
  expect(row).toBeDefined();
  if (!row) {
    throw new Error("Missing schedule row");
  }
  await act(async () => {
    await ui.mockMouse.click(row.x + 2, row.y);
  });
  await flush(ui);
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

async function press(ui: Awaited<ReturnType<typeof testRender>>, key: string) {
  await act(async () => {
    ui.mockInput.pressKey(key);
  });
  await flush(ui);
}

async function click(ui: Awaited<ReturnType<typeof testRender>>, id: string) {
  const target = ui.renderer.root.findDescendantById(id);
  if (!target) {
    throw new Error(`Missing ${id}`);
  }
  await act(async () => {
    await ui.mockMouse.click(target.x, target.y);
  });
  await flush(ui);
}

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
  setup = await testRender(<UpdatingDashboard />, {
    height: 40,
    kittyKeyboard: true,
    width: 120,
  });
  await flush(setup);
  await press(setup, "a");
  await press(setup, "RETURN");
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
  await flush(setup);
  expect(setup.captureCharFrame()).toMatch(WRITE_STEP);
  await press(setup, "ESCAPE");
  expect(setup.captureCharFrame()).toContain("New run");
});

test("preview switches scenarios and advances deterministic playback", async () => {
  setup = await testRender(<PreviewApp onClose={close} />, {
    height: 40,
    kittyKeyboard: true,
    width: 120,
  });
  await flush(setup);
  expect(setup.captureCharFrame()).toContain("Frame 3/4");
  await press(setup, "r");
  expect(setup.captureCharFrame()).toContain("Frame 1/4");
  await press(setup, "n");
  expect(setup.captureCharFrame()).toContain("Frame 2/4");
  await press(setup, "]");
  expect(setup.captureCharFrame()).toContain(
    `Scenario 2/${previewScenarios.length}: Idle`
  );
  expect(setup.captureCharFrame()).toContain("No runs yet.");
  await press(setup, "[");
  expect(setup.captureCharFrame()).toContain("Frame 1/4");
  await press(setup, "p");
  expect(setup.captureCharFrame()).toContain("p Pause");
  await act(async () => {
    await sleep(1300);
  });
  await flush(setup);
  expect(setup.captureCharFrame()).toContain("Frame 2/4");
  await press(setup, "p");
  expect(setup.captureCharFrame()).toContain("p Play");
  await act(async () => {
    await sleep(1300);
  });
  await flush(setup);
  expect(setup.captureCharFrame()).toContain("Frame 2/4");
});

test("every preview scenario renders at narrow and wide dimensions", async () => {
  for (const scenario of previewScenarios) {
    for (const width of [70, 120]) {
      const [snapshot] = scenario.frames;
      if (!snapshot) {
        throw new Error("Scenario is missing a frame");
      }
      const ui = await render(snapshot, width, 30);
      expect(ui.captureCharFrame()).toContain("preview");
      expect(ui.captureCharFrame()).toContain("Ctrl+C quit");
      await act(async () => {
        ui.renderer.destroy();
      });
      setup = undefined;
    }
  }
});

test("JSON array items collapse independently and inactive viewers ignore keys", async () => {
  setup = await testRender(
    <JSONView data={[{ item: "first" }, { item: "second" }]} focused />,
    { height: 15, kittyKeyboard: true, width: 80 }
  );
  await flush(setup);
  await press(setup, "ARROW_DOWN");
  await press(setup, " ");
  expect(setup.captureCharFrame()).not.toContain('item: "first"');
  expect(setup.captureCharFrame()).toContain('item: "second"');
  await act(async () => {
    setup?.renderer.destroy();
  });
  setup = await testRender(
    <JSONView data={[{ item: "first" }, { item: "second" }]} focused={false} />,
    { height: 15, kittyKeyboard: true, width: 80 }
  );
  await flush(setup);
  await press(setup, " ");
  expect(setup.captureCharFrame()).toContain('item: "first"');
  expect(setup.captureCharFrame()).toContain('item: "second"');
});

const logEntries: readonly LogEntry[] = Array.from(
  { length: 12 },
  (_, index) => ({
    id: `log-${index}`,
    level: "info",
    message: `Message ${index}`,
    timestamp: "14:00:00",
  })
);
let appendLogs: (() => void) | undefined;
function UpdatingLogs() {
  const [entries, setEntries] = useState(logEntries);
  useEffect(() => {
    appendLogs = () =>
      setEntries((previous) => [
        ...previous,
        {
          id: "new-log",
          level: "info",
          message: "Newest message",
          timestamp: "14:00:01",
        },
      ]);
    return () => {
      appendLogs = undefined;
    };
  }, []);
  return <Log entries={entries} focused />;
}

test("following logs advances to new entries and pausing retains the visible position", async () => {
  setup = await testRender(<UpdatingLogs />, {
    height: 15,
    kittyKeyboard: true,
    width: 80,
  });
  await flush(setup);
  expect(setup.captureCharFrame()).toContain("Message 0");
  await press(setup, "f");
  expect(setup.captureCharFrame()).toContain("Message 11");
  await act(async () => {
    appendLogs?.();
  });
  await flush(setup);
  expect(setup.captureCharFrame()).toContain("Newest message");
  await press(setup, "f");
  expect(setup.captureCharFrame()).toContain("Newest message");
  expect(setup.captureCharFrame()).not.toContain("Message 0");
  await press(setup, "ARROW_UP");
  expect(setup.captureCharFrame()).not.toContain("Newest message");
  expect(setup.captureCharFrame()).toContain("Paused");
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

async function ctrlC(ui: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => ui.mockInput.pressCtrlC());
  await flush(ui);
}

test("quit defaults to cancel and restores the selected step", async () => {
  const ui = await render();
  await press(ui, "a");
  const before = ui.captureCharFrame();
  await press(ui, "q");
  const frame = ui.captureCharFrame();
  expect(frame).toContain("Quit Marbles?");
  expect(frame).toContain("Quitting stops schedules and monitoring");
  expect(frame).toContain("Running steps are cancelled.");
  expect(frame).toContain("Preview only:");
  expect(closed).toBe(false);
  await press(ui, "RETURN");
  expect(closed).toBe(false);
  expect(ui.captureCharFrame()).toBe(before);
  await press(ui, "q");
  await press(ui, "TAB");
  await press(ui, "RETURN");
  expect(closed).toBe(true);
});

test("Ctrl+C opens confirmation and a second Ctrl+C quits", async () => {
  const ui = await render();
  await ctrlC(ui);
  expect(closed).toBe(false);
  expect(ui.captureCharFrame()).toContain("Quit Marbles?");
  await ctrlC(ui);
  expect(closed).toBe(true);
});

test("Ctrl+C also confirms a dialog opened with q", async () => {
  const ui = await render();
  await press(ui, "q");
  await ctrlC(ui);
  expect(closed).toBe(true);
});

test("quit isolates search input and Escape restores its query and focus", async () => {
  const ui = await render();
  await press(ui, "/");
  await press(ui, "q");
  expect(ui.captureCharFrame()).not.toContain("Quit Marbles?");
  const before = ui.captureCharFrame();
  await ctrlC(ui);
  await press(ui, "x");
  await press(ui, "ESCAPE");
  expect(closed).toBe(false);
  expect(ui.captureCharFrame()).toBe(before);
  await press(ui, "u");
  expect(ui.captureCharFrame()).toContain("Search run: qu");
});

test("modal mouse actions work and background controls cannot change selection", async () => {
  const ui = await render();
  const before = ui.captureCharFrame();
  await press(ui, "q");
  await click(ui, "trigger:daily");
  await press(ui, "ARROW_DOWN");
  await press(ui, "a");
  await click(ui, "dialog:cancel");
  expect(closed).toBe(false);
  expect(ui.captureCharFrame()).toBe(before);
  await press(ui, "q");
  await click(ui, "dialog:confirm");
  expect(closed).toBe(true);
});

test("quitting from help preserves help and resets the default choice on reopen", async () => {
  const ui = await render();
  await press(ui, "?");
  const before = ui.captureCharFrame();
  await press(ui, "q");
  await press(ui, "TAB");
  await press(ui, "ESCAPE");
  expect(ui.captureCharFrame()).toBe(before);
  await ctrlC(ui);
  await press(ui, "RETURN");
  expect(closed).toBe(false);
  expect(ui.captureCharFrame()).toBe(before);
});

test("quit controls remain visible in a narrow short terminal", async () => {
  const ui = await render(dashboardSnapshot, 40, 16);
  await press(ui, "q");
  const frame = ui.captureCharFrame();
  expect(frame).toContain("Quit Marbles?");
  expect(frame).toContain("[ Keep open ]");
  expect(frame).toContain("[ Quit ]");
  expect(frame).toContain("Ctrl+C quit");
  await click(ui, "dialog:cancel");
  expect(ui.captureCharFrame()).not.toContain("Quit Marbles?");
});

test("preview scenario shortcuts are blocked while the quit dialog is open", async () => {
  closed = false;
  setup = await testRender(<PreviewApp onClose={close} />, {
    height: 40,
    kittyKeyboard: true,
    width: 120,
  });
  const ui = setup;
  await flush(ui);
  const before = ui.captureCharFrame();
  await press(ui, "q");
  await press(ui, "]");
  await press(ui, "n");
  await press(ui, "ESCAPE");
  expect(ui.captureCharFrame()).toBe(before);
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
    expect(frame).not.toContain(dashboardSnapshot.root);
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
    await act(async () => ui.renderer.destroy());
    setup = undefined;
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

let entered = 0;
let updateSplash: ((state: SplashState) => void) | undefined;
function enterSplash() {
  entered += 1;
}
function ControlledSplash() {
  const [state, setState] = useState<SplashState>({ status: "loading" });
  useEffect(() => {
    updateSplash = setState;
    return () => {
      updateSplash = undefined;
    };
  }, []);
  return (
    <SplashView
      onClose={close}
      onEnter={enterSplash}
      preview
      state={state}
      workspace="foundry"
    />
  );
}

test("splash gates entry until ready and shows counts from the loaded snapshot", async () => {
  entered = 0;
  setup = await testRender(<ControlledSplash />, {
    exitOnCtrlC: false,
    height: 24,
    kittyKeyboard: true,
    width: 70,
  });
  await flush(setup);
  expect(setup.captureCharFrame()).toContain("Loading marbles");
  expect(setup.captureCharFrame()).not.toContain("loaded");
  expect(
    setup.renderer.root.findDescendantById("splash:enter")
  ).toBeUndefined();
  await press(setup, "RETURN");
  expect(entered).toBe(0);
  await act(async () =>
    updateSplash?.({
      counts: summarizeConfig(dashboardSnapshot),
      status: "ready",
    })
  );
  await flush(setup);
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Marbles loaded");
  expect(frame).toContain("3 loaded");
  expect(frame).toContain("1 schedule · 2 monitors");
  expect(frame).toContain("4 loaded");
  expect(frame).toContain("3 workflows · 1 step");
  expect(frame).toContain("3 runs available");
  expect(frame).toContain("Press Enter to enter");
  expect(entered).toBe(0);
  await press(setup, "RETURN");
  expect(entered).toBe(1);
});

test("ready splash stays centered, fits small terminals, and accepts clicks", async () => {
  entered = 0;
  for (const [width, height] of [
    [40, 16],
    [60, 20],
    [70, 16],
    [70, 24],
    [120, 40],
  ] as const) {
    setup = await testRender(
      <SplashView
        onClose={close}
        onEnter={enterSplash}
        preview
        state={{ counts: summarizeConfig(dashboardSnapshot), status: "ready" }}
        workspace="foundry"
      />,
      { exitOnCtrlC: false, height, kittyKeyboard: true, width }
    );
    await flush(setup);
    const card = setup.renderer.root.findDescendantById("splash:card");
    if (!card) {
      throw new Error("Missing splash card");
    }
    const logo = setup.renderer.root.findDescendantById("splash:logo");
    if (!logo) {
      throw new Error("Missing splash logo");
    }
    expect(logo.x).toBeGreaterThan(card.x);
    expect(logo.x + logo.width).toBeLessThan(card.x + card.width);
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.y).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(width);
    expect(card.y + card.height).toBeLessThanOrEqual(height);
    expect(Math.abs(card.x * 2 + card.width - width)).toBeLessThanOrEqual(1);
    expect(Math.abs(card.y * 2 + card.height - height)).toBeLessThanOrEqual(1);
    expect(setup.captureCharFrame()).toContain("Press Enter to enter");
    await click(setup, "splash:enter");
    await act(async () => setup?.renderer.destroy());
    setup = undefined;
  }
  expect(entered).toBe(5);
});

test("sparkles shimmer without changing silhouettes and pause for the quit dialog", async () => {
  setup = await testRender(
    <SplashView
      onClose={close}
      onEnter={enterSplash}
      preview
      state={{ counts: summarizeConfig(dashboardSnapshot), status: "ready" }}
      workspace="foundry"
    />,
    { exitOnCtrlC: false, height: 40, kittyKeyboard: true, width: 120 }
  );
  await flush(setup);
  const first = setup.captureCharFrame();
  const firstColors = JSON.stringify(setup.captureSpans());
  expect(first).toContain("▀");
  expect(first).toContain("▄");
  await act(async () => sleep(650));
  await flush(setup);
  const next = setup.captureCharFrame();
  expect(next).toBe(first);
  expect(JSON.stringify(setup.captureSpans())).not.toBe(firstColors);
  await ctrlC(setup);
  const modal = JSON.stringify(setup.captureSpans());
  await act(async () => sleep(450));
  await flush(setup);
  expect(JSON.stringify(setup.captureSpans())).toBe(modal);
});

test("empty config reports zero counts and still permits entry", async () => {
  entered = 0;
  const counts = summarizeConfig({
    ...dashboardSnapshot,
    definitions: [],
    runs: [],
    triggers: [],
  });
  setup = await testRender(
    <SplashView
      onClose={close}
      onEnter={enterSplash}
      preview
      state={{ counts, status: "ready" }}
      workspace="empty"
    />,
    { height: 24, kittyKeyboard: true, width: 70 }
  );
  await flush(setup);
  expect(setup.captureCharFrame()).toContain("0 schedules · 0 monitors");
  expect(setup.captureCharFrame()).toContain("0 workflows · 0 steps");
  await click(setup, "splash:enter");
  expect(entered).toBe(1);
});

test("splash quit confirmation blocks entry and supports a second Ctrl+C", async () => {
  closed = false;
  entered = 0;
  setup = await testRender(
    <SplashView
      onClose={close}
      onEnter={enterSplash}
      preview
      state={{ counts: summarizeConfig(dashboardSnapshot), status: "ready" }}
      workspace="foundry"
    />,
    { exitOnCtrlC: false, height: 24, kittyKeyboard: true, width: 70 }
  );
  await flush(setup);
  await ctrlC(setup);
  expect(closed).toBe(false);
  expect(setup.captureCharFrame()).toContain("Quit Marbles?");
  await press(setup, "RETURN");
  expect(entered).toBe(0);
  expect(setup.captureCharFrame()).toContain("Press Enter to enter");
  await ctrlC(setup);
  await ctrlC(setup);
  expect(closed).toBe(true);
});

test("preview loads its config, waits for entry, and opens the dashboard once", async () => {
  setup = await testRender(<PreviewStartup onClose={close} />, {
    exitOnCtrlC: false,
    height: 24,
    kittyKeyboard: true,
    width: 70,
  });
  await flush(setup);
  expect(setup.captureCharFrame()).toContain("Loading marbles");
  await press(setup, "RETURN");
  await act(async () => {
    await sleep(1000);
  });
  await flush(setup);
  expect(setup.captureCharFrame()).toContain("Marbles loaded");
  expect(setup.captureCharFrame()).not.toContain("1 Triggers");
  await press(setup, "RETURN");
  expect(setup.captureCharFrame()).toContain("1 Triggers");
  expect(setup.captureCharFrame()).toContain("2 Marbles");
  expect(setup.captureCharFrame()).toContain("3 Runs");
  expect(setup.captureCharFrame()).not.toContain("Overview  Input");
  await click(setup, "nav:home");
  expect(setup.captureCharFrame()).not.toContain("Marbles loaded");
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

/** Markdown highlighting settles asynchronously after the first frame. */
async function frameWith(
  ui: Awaited<ReturnType<typeof testRender>>,
  text: string
): Promise<string> {
  const deadline = Date.now() + 3000;
  for (;;) {
    await flush(ui);
    const frame = ui.captureCharFrame();
    if (frame.includes(text) || Date.now() > deadline) {
      return frame;
    }
    await sleep(25);
  }
}

test("switches tabs with Shift+D / Shift+F and filters the feed by workspace", async () => {
  const ui = await render();
  let frame = ui.captureCharFrame();
  expect(frame).toContain("Dashboard  3");
  expect(frame).toContain("Feed  4");

  await act(async () => ui.mockInput.pressKey("F"));
  frame = await frameWith(ui, "The docs workflow rewrote");
  // Only the open question carries the pending marker.
  expect(frame).toContain("› ! Merge the docs update?");
  expect(frame).not.toContain("! Codebase summary");
  for (const label of [
    "Feed · All workspaces",
    "needs input · foundry · 14:33",
    "Codebase summary",
    "Docs updated",
    "Workspace set up: foundry",
    "Needs your input",
    "1 merge",
    "2 hold",
  ]) {
    expect(frame).toContain(label);
  }

  await act(async () => ui.mockInput.pressKey("w"));
  await flush(ui);
  frame = ui.captureCharFrame();
  expect(frame).toContain("Feed · This workspace · foundry");
  expect(frame).not.toContain("Docs updated");

  await act(async () => ui.mockInput.pressArrow("down"));
  await act(async () => ui.mockInput.pressEnter());
  frame = await frameWith(ui, "Marbles is a local runner");
  expect(frame).toContain("Entry · ↑↓ scroll · Esc entries");
  expect(frame).toContain("media/walkthrough.mp4");

  await act(async () => ui.mockInput.pressKey("D"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("3 Runs");
});

test("answers an open question from the feed with a number key", async () => {
  const answers: [string, FeedAnswer][] = [];
  const answer = (id: string, value: FeedAnswer) => {
    answers.push([id, value]);
    return Promise.resolve();
  };
  closed = false;
  setup = await testRender(
    <DashboardView
      onAnswer={answer}
      onClose={close}
      snapshot={dashboardSnapshot}
    />,
    { exitOnCtrlC: false, height: 40, kittyKeyboard: true, width: 120 }
  );
  const ui = setup;
  await flush(ui);
  await act(async () => ui.mockInput.pressKey("F"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("1-2 answer");
  await act(async () => ui.mockInput.pressKey("2"));
  await flush(ui);
  expect(answers).toEqual([["feed-merge", "hold"]]);
});

test("an approval takes an optional note after the choice", async () => {
  const answers: FeedAnswer[] = [];
  const approval = {
    ...dashboardSnapshot.feed[0],
    id: "feed-release",
    input: {
      choices: ["approve", "reject"],
      mode: "approval" as const,
      status: "open" as const,
    },
    title: "Release v2?",
  } as DashboardSnapshot["feed"][number];
  const answer = (_id: string, value: FeedAnswer) => {
    answers.push(value);
    return Promise.resolve();
  };
  closed = false;
  setup = await testRender(
    <DashboardView
      onAnswer={answer}
      onClose={close}
      snapshot={{ ...dashboardSnapshot, feed: [approval] }}
    />,
    { exitOnCtrlC: false, height: 40, kittyKeyboard: true, width: 120 }
  );
  const ui = setup;
  await flush(ui);
  await act(async () => ui.mockInput.pressKey("F"));
  await act(async () => ui.mockInput.pressKey("1"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("approve · note");
  expect(answers).toEqual([]);
  await act(async () => ui.mockInput.typeText("ship after the docs land"));
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(answers).toEqual([
    { choice: "approve", note: "ship after the docs land" },
  ]);

  // Esc drops the held choice; a second number key with an empty note sends
  // the bare choice.
  await act(async () => ui.mockInput.pressKey("2"));
  await act(async () => ui.mockInput.pressEscape());
  await act(async () => ui.mockInput.pressKey("2"));
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(answers).toEqual([
    { choice: "approve", note: "ship after the docs land" },
    { choice: "reject" },
  ]);
});

test("types a free-text answer without triggering dashboard keys", async () => {
  const answers: FeedAnswer[] = [];
  const question = {
    ...dashboardSnapshot.feed[0],
    id: "feed-note",
    input: { choices: [], status: "open" as const },
    title: "Anything to add?",
  } as DashboardSnapshot["feed"][number];
  const answer = (_id: string, value: FeedAnswer) => {
    answers.push(value);
    return Promise.resolve();
  };
  closed = false;
  setup = await testRender(
    <DashboardView
      onAnswer={answer}
      onClose={close}
      snapshot={{ ...dashboardSnapshot, feed: [question] }}
    />,
    { exitOnCtrlC: false, height: 40, kittyKeyboard: true, width: 120 }
  );
  const ui = setup;
  await flush(ui);
  await act(async () => ui.mockInput.pressKey("F"));
  await act(async () => ui.mockInput.pressKey("a"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("Enter send · Esc cancel");
  await act(async () => ui.mockInput.typeText("quite a lot"));
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(answers).toEqual(["quite a lot"]);
  expect(ui.captureCharFrame()).not.toContain("Quit Marbles?");
});

function recordingActions() {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return Promise.resolve();
    };
  const actions: RunActions = {
    cancel: record("cancel"),
    pause: record("pause"),
    resume: record("resume"),
    steer: record("steer"),
  };
  return { actions, calls };
}

test.each(["approval", "question"] as const)(
  "shows live %s attention in run and step details while keeping pause, steer and cancel enabled",
  async (attention) => {
    const { actions, calls } = recordingActions();
    const attentive: DashboardSnapshot = {
      ...dashboardSnapshot,
      runs: dashboardSnapshot.runs.map((run) =>
        run.id === "run-104"
          ? {
              ...run,
              attention,
              steps: run.steps.map((step) =>
                step.id === "update"
                  ? {
                      ...step,
                      attention,
                      children: step.children.map((child) =>
                        child.id === "write" ? { ...child, attention } : child
                      ),
                    }
                  : step
              ),
            }
          : run
      ),
    };
    const label =
      attention === "approval" ? "Waiting for approval" : "Waiting for answer";
    setup = await testRender(
      <DashboardView actions={actions} onClose={close} snapshot={attentive} />,
      { exitOnCtrlC: false, height: 40, kittyKeyboard: true, width: 120 }
    );
    const ui = setup;
    await flush(ui);
    expect(ui.captureCharFrame()).toContain(label);
    await press(ui, "RETURN");
    expect(ui.captureCharFrame()).toContain(label);
    await press(ui, "ESCAPE");
    await press(ui, "a");
    await press(ui, "RETURN");
    expect(ui.captureCharFrame()).toMatch(WRITE_STEP);
    expect(ui.captureCharFrame()).toContain(label);
    await act(async () => ui.mockInput.pressKey("p"));
    await flush(ui);
    expect(calls).toEqual([["pause", "run-104", "write"]]);
    await act(async () => ui.mockInput.pressKey("s"));
    await flush(ui);
    expect(ui.captureCharFrame()).toContain("steer write ›");
    await act(async () =>
      ui.mockInput.typeText("summarize the pending action")
    );
    await act(async () => ui.mockInput.pressEnter());
    await flush(ui);
    expect(calls.at(-1)).toEqual([
      "steer",
      "run-104",
      "write",
      "summarize the pending action",
    ]);
    await act(async () => ui.mockInput.pressKey("k"));
    await flush(ui);
    expect(calls.at(-1)).toEqual(["cancel", "run-104"]);
    expect(attentive.runs[0]?.status).toBe("running");
  }
);

test("run keys pause, steer, and cancel the selected step", async () => {
  const { actions, calls } = recordingActions();
  closed = false;
  setup = await testRender(
    <DashboardView
      actions={actions}
      onClose={close}
      snapshot={dashboardSnapshot}
    />,
    { exitOnCtrlC: false, height: 40, kittyKeyboard: true, width: 120 }
  );
  const ui = setup;
  await flush(ui);
  // The running run is selected first; its root frame, keyed by the
  // definition's name, is the target.
  expect(ui.captureCharFrame()).toContain(
    "s steer · p pause/resume · k cancel"
  );
  await act(async () => ui.mockInput.pressKey("p"));
  await flush(ui);
  expect(calls).toEqual([["pause", "run-104", "docs"]]);

  // Steer opens a prompt; typing does not reach the dashboard keys.
  await act(async () => ui.mockInput.pressKey("s"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("steer docs ›");
  await act(async () => ui.mockInput.typeText("stop and summarise"));
  await flush(ui);
  expect(ui.captureCharFrame()).not.toContain("Quit Marbles?");
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(calls.at(-1)).toEqual([
    "steer",
    "run-104",
    "docs",
    "stop and summarise",
  ]);

  // Esc drops a prompt without sending anything.
  await act(async () => ui.mockInput.pressKey("s"));
  await act(async () => ui.mockInput.typeText("nothing"));
  await act(async () => ui.mockInput.pressEscape());
  await flush(ui);
  expect(ui.captureCharFrame()).not.toContain("steer docs ›");
  await act(async () => ui.mockInput.pressKey("k"));
  await flush(ui);
  expect(calls.at(-1)).toEqual(["cancel", "run-104"]);
});

test("a paused step resumes with an optional prompt", async () => {
  const { actions, calls } = recordingActions();
  const paused = {
    ...dashboardSnapshot,
    runs: dashboardSnapshot.runs.map((run) =>
      run.id === "run-104"
        ? {
            ...run,
            status: "suspended" as const,
            steps: run.steps.map((step) =>
              step.id === "find"
                ? { ...step, status: "suspended" as const }
                : step
            ),
          }
        : run
    ),
  };
  closed = false;
  setup = await testRender(
    <DashboardView actions={actions} onClose={close} snapshot={paused} />,
    { exitOnCtrlC: false, height: 40, kittyKeyboard: true, width: 120 }
  );
  const ui = setup;
  await flush(ui);
  await act(async () => ui.mockInput.pressKey("p"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("resume docs · prompt optional ›");
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(calls).toEqual([["resume", "run-104", "docs", undefined]]);
  await act(async () => ui.mockInput.pressKey("p"));
  await act(async () => ui.mockInput.typeText("focus on the tests"));
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(calls.at(-1)).toEqual([
    "resume",
    "run-104",
    "docs",
    "focus on the tests",
  ]);
  // Without actions the keys and the footer hint are absent.
  await ui.renderer.destroy();
  closed = false;
  setup = await testRender(
    <DashboardView onClose={close} snapshot={paused} />,
    { exitOnCtrlC: false, height: 40, kittyKeyboard: true, width: 120 }
  );
  await flush(setup);
  expect(setup.captureCharFrame()).not.toContain("p pause/resume");
});

test.each([
  { status: "running", stoppable: true, supported: true },
  { status: "running", stoppable: false, supported: false },
  { status: "complete", stoppable: false, supported: true },
  { status: "unknown", stoppable: false, supported: true },
] as const)(
  "native activity controls stop only the selected supported child ($status, $supported)",
  async ({ supported, status, stoppable }) => {
    const { actions, calls } = recordingActions();
    actions.stopActivity = async (...args) => {
      calls.push(["stopActivity", ...args]);
    };
    const activeRun = dashboardSnapshot.runs.find(
      (run) => run.id === "run-104"
    );
    if (!activeRun) {
      throw new Error("Missing active fixture");
    }
    const snapshot: DashboardSnapshot = {
      ...dashboardSnapshot,
      runs: [
        {
          ...activeRun,
          activities: [
            {
              actions: supported ? ["stop"] : [],
              agentId: "coder",
              harness: "claude-code",
              id: "child",
              kind: "task",
              lifetime: "sandbox",
              revision: 1,
              sessionId: "child-session",
              status,
              title: "Background test run",
            },
          ],
        },
      ],
    };
    setup = await testRender(
      <DashboardView actions={actions} onClose={close} snapshot={snapshot} />,
      { exitOnCtrlC: false, height: 40, kittyKeyboard: true, width: 120 }
    );
    const ui = setup;
    await flush(ui);
    const frame = ui.captureCharFrame();
    expect(frame).toContain("task: Background test run");
    expect(frame).not.toContain("[step] task:");
    await click(ui, 'run:run-104:activity:["child-session","child"]');
    expect(ui.captureCharFrame()).toContain("Background test run");
    expect(ui.captureCharFrame()).not.toContain("s steer");
    await press(ui, "p");
    await press(ui, "s");
    expect(calls).toEqual([]);
    await press(ui, "k");
    expect(calls).toEqual(
      stoppable ? [["stopActivity", "child-session", "child"]] : []
    );
  }
);

test.each(["running", "paused"] as const)(
  "managed trigger %s offers pause/resume and delete controls",
  async (status) => {
    const { actions, calls } = recordingActions();
    actions.setTriggerEnabled = async (...args) => {
      calls.push(["setTriggerEnabled", ...args]);
    };
    actions.deleteTrigger = async (...args) => {
      calls.push(["deleteTrigger", ...args]);
    };
    const snapshot: DashboardSnapshot = {
      ...dashboardSnapshot,
      triggers: [
        {
          description: "Scheduled agent work",
          id: "managed-trigger",
          kind: "schedule",
          lifetime: "durable",
          managed: true,
          name: "Daily checks",
          owner: "coder",
          status,
          targetId: "agent-task",
        },
      ],
    };
    setup = await testRender(
      <DashboardView actions={actions} onClose={close} snapshot={snapshot} />,
      { exitOnCtrlC: false, height: 40, kittyKeyboard: true, width: 120 }
    );
    const ui = setup;
    await flush(ui);
    await click(ui, "trigger:managed-trigger");
    const frame = ui.captureCharFrame();
    expect(frame).toContain(status === "paused" ? "p resume" : "p pause");
    expect(frame).toContain("k delete trigger");
    await press(ui, "p");
    await press(ui, "k");
    expect(calls).toEqual([
      ["setTriggerEnabled", "managed-trigger", status === "paused"],
      ["deleteTrigger", "managed-trigger"],
    ]);
  }
);
