import { RGBA } from "@opentui/core";
import { act, useEffect, useState } from "react";
import { afterEach, expect, test } from "vitest";
import type { DashboardSnapshot } from "../src/cli/state/dashboard-model";
import { selectionKey } from "../src/cli/state/dashboard-model";
import { DashboardView } from "../src/cli/views/dashboard";
import { theme } from "../src/components/ui/theme";
import { previewScenarios } from "../stories/fixtures/scenarios";
import { dashboardSnapshot } from "../stories/fixtures/snapshot";
import {
  click,
  flush,
  frameWith,
  mount,
  press,
  unmount,
} from "./helpers/render";

const UTILITY_LABEL = /Settings|Logs|Diagnostics/;
const WRITE_STEP = /Step\s+: write/;
const FAILED_RUN = /Run\s+: run-103/;
const NEXT_TIME = /Next\s+: Today at 17:00/;
const TARGET_NAME = /Target\s+: summarize-day/;
const ACTIVE_RUN = /Run\s+: run-104/;
const REQUEST_STEP = /Step\s+: request/;
const WORKSPACE_PICKER_BORDER = /╭─Workspaces/g;
const REVIEW_SPEND = /review-changes +█{10} +\[~\$0\.1180\]/;
const DOCS_SPEND = /update-documentation +█{4}░{6} +\[~\$0\.0421\+\?\]/;
const COMPACT_SPEND = /update-documentation +\[~\$0\.0421\+\?\]/;
const REVIEW_TIME = /review-changes +41\.0s/;
const STEP_TIME = /check-api +3\.0s/;

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

test("opens a workspace picker from the header and switches directly to the selected floor", async () => {
  const chosen: string[] = [];
  const choose = (id?: string) => {
    if (id) {
      chosen.push(id);
    }
  };
  const ui = await mount(
    <DashboardView
      hosted={{
        state: "ready",
        workspaces: [
          {
            config: null,
            id: "foundry",
            root: "/Users/someone/code/alpha/foundry",
            state: "ready",
          },
          {
            config: null,
            id: "spyglass",
            root: "/Users/someone/code/beta/foundry",
            state: "reloading",
          },
        ],
      }}
      onClose={close}
      onSwitchWorkspace={choose}
      snapshot={{ ...dashboardSnapshot, mode: "live", workspaceId: "foundry" }}
    />
  );
  expect(ui.captureCharFrame()).not.toContain(" live ");
  const [header] = ui.captureCharFrame().split("\n");
  expect(header).toContain("Dashboard");
  expect(header).not.toMatch(UTILITY_LABEL);
  await press(ui, "S");
  await act(async () => ui.mockInput.pressKey("w", { shift: true }));
  await flush(ui);
  await press(ui, "ESCAPE");
  expect(
    ui.renderer.root.findDescendantById("panel:workspace-rail")
  ).toBeDefined();
  const rail = ui.captureCharFrame();
  expect(rail).toContain("alpha/foundry");
  expect(rail).toContain("beta/foundry");
  expect(rail).toContain("current ready");
  await click(ui, "nav:workspaces");
  const picker = ui.captureCharFrame();
  expect(picker).toContain("beta/foundry reloading");
  expect(picker).toContain("Needs attention");
  expect(picker).toContain("Tracked spend");
  expect(picker.match(WORKSPACE_PICKER_BORDER)).toHaveLength(1);
  await press(ui, "?");
  expect(ui.captureCharFrame()).toContain("Keyboard help");
  await press(ui, "ESCAPE");
  await press(ui, "q");
  expect(ui.captureCharFrame()).toContain("Quit");
  await press(ui, "ESCAPE");
  await press(ui, "ARROW_DOWN");
  await press(ui, "RETURN");
  expect(chosen).toEqual(["spyglass"]);
});

test("composes an operating overview with runs, and a separate typed catalog", async () => {
  const ui = await render();
  const frame = ui.captureCharFrame();
  for (const label of [
    "Dashboard",
    "Catalog",
    "3 Runs",
    "[step]",
    "Write changes",
    "run-104",
    "1 running",
    "1 failed",
    "Success rate",
    "50%",
    "Latest",
    "check-api failed",
  ]) {
    expect(frame).toContain(label);
  }
  expect(frame).not.toContain("1 Triggers");
  await press(ui, "m");
  const catalog = ui.captureCharFrame();
  expect(catalog).toContain("1 Triggers");
  expect(catalog).toContain("[schedule]");
  expect(catalog).toContain("[monitor]");
  expect(catalog).toContain("2 Marbles · workflows & steps in foundry");
  expect(catalog).toContain("[workflow]");
  expect(catalog).toContain(".foundry/marbles/docs.ts:12");
  expect(catalog).not.toContain("3 Runs");
});

test("shows each workspace usage caveat on Dashboard", async () => {
  const { usage } = dashboardSnapshot;
  if (!usage) {
    throw new Error("Missing usage fixture");
  }
  const ui = await render({
    ...dashboardSnapshot,
    usage: {
      ...usage,
      recovered: 2,
      unattributed: 1,
      unreadable: 1,
      unsaved: 1,
    },
  });
  const frame = ui.captureCharFrame();
  expect(frame).toContain("1 unreadable usage record, totals partial");
  expect(frame).toContain("turns recovered from transcripts");
  expect(frame).toContain("1 unattributed turn");
  expect(frame).toContain("1 unsaved turn");
});

test("ranks tracked spend and elapsed time above the run tree", async () => {
  const { usage } = dashboardSnapshot;
  if (!usage) {
    throw new Error("Missing usage fixture");
  }
  const ui = await render(
    {
      ...dashboardSnapshot,
      usage: { ...usage, byWorkflow: usage.byWorkflow.toReversed() },
    },
    120,
    30
  );
  const frame = ui.captureCharFrame();
  const spend = frame.indexOf("Workflow spend");
  const elapsed = frame.indexOf("Workflow time");
  expect(spend).toBeGreaterThanOrEqual(0);
  expect(elapsed).toBeGreaterThanOrEqual(0);
  expect(frame.indexOf("3 Runs")).toBeGreaterThan(spend);
  expect(frame.indexOf("3 Runs")).toBeGreaterThan(elapsed);
  expect(frame).toMatch(REVIEW_SPEND);
  expect(frame).toMatch(DOCS_SPEND);
  expect(frame.indexOf("~$0.1180")).toBeLessThan(frame.indexOf("~$0.0421"));
  expect(frame).toContain("running 24s [~$0.0421+?] · run-104");
  expect(frame).toContain("Write changes running 18s [~$0.0302]");
  expect(frame).toContain("failed  3s · run-103");
  expect(frame).toMatch(REVIEW_TIME);
  expect(frame).toContain("Median run");
  expect(frame).toContain("Median wait");
  expect(frame).not.toMatch(STEP_TIME);
  await act(async () => ui.renderer.resize(80, 24));
  await flush(ui);
  const compact = ui.captureCharFrame();
  expect(compact).toMatch(COMPACT_SPEND);
  expect(compact).toContain("Write changes running 18s [~$0.0302]");
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
  await click(ui, "view:catalog");
  await click(ui, "trigger:daily");
  expect(ui.captureCharFrame()).toMatch(NEXT_TIME);
  expect(ui.captureCharFrame()).toMatch(TARGET_NAME);
});

test("v toggles trigger configuration and changes only the log level in Diagnostics", async () => {
  const ui = await render();
  await click(ui, "view:catalog");
  await click(ui, "trigger:daily");
  expect(ui.captureCharFrame()).toContain("v Show configuration");
  await press(ui, "v");
  expect(ui.captureCharFrame()).toContain('"time": "17:00"');
  await press(ui, "d");
  expect(ui.captureCharFrame()).toContain("level debug+");
  await press(ui, "v");
  expect(ui.captureCharFrame()).toContain("level info+");
  await press(ui, "ESCAPE");
  expect(ui.captureCharFrame()).toContain('"time": "17:00"');
  await press(ui, "v");
  expect(ui.captureCharFrame()).not.toContain('"time": "17:00"');
});

test("keeps the schedule list beside its inspector and rolls the selected schedule", async () => {
  const rolled: string[] = [];
  const pending = Promise.withResolvers<void>();
  const launched: string[] = [];
  const roll = (id: string) => {
    rolled.push(id);
    return pending.promise;
  };
  async function launch(id: string) {
    launched.push(id);
    return "new-run";
  }
  const ui = await mount(
    <DashboardView
      onClose={close}
      onLaunch={launch}
      onRollSchedule={roll}
      snapshot={{
        ...dashboardSnapshot,
        definitions: dashboardSnapshot.definitions.map((item) => ({
          ...item,
          input: { fields: [], required: false },
        })),
      }}
    />,
    { height: 40, width: 120 }
  );
  await click(ui, "view:catalog");
  await click(ui, "trigger:daily");
  const frame = ui.captureCharFrame();
  expect(frame).toContain("1 Triggers");
  expect(frame).toContain("Schedule / daily-summary");
  expect(frame).toContain("[monitor] update-docs");
  expect(frame).toContain("[workflow] update-documentation");
  expect(frame).not.toContain(".foundry/marbles/docs.ts:12");
  expect(
    frame
      .split("\n")
      .find((line) => line.includes("╰") && line.includes("r run now"))
  ).toBeDefined();
  await press(ui, "r");
  expect(rolled).toEqual(["daily"]);
  await press(ui, "ESCAPE");
  expect(ui.captureCharFrame()).not.toContain("Schedule / daily-summary");
  await press(ui, "2");
  await press(ui, "l");
  expect(launched).toHaveLength(1);
  pending.resolve();
});

test.each(["keyboard", "click"] as const)(
  "Run now through %s is available only for an enabled managed schedule",
  async (interaction) => {
    const rolled: string[] = [];
    async function roll(id: string) {
      rolled.push(id);
    }
    for (const status of ["waiting", "paused"] as const) {
      const ui = await mount(
        <DashboardView
          onClose={close}
          onRollSchedule={roll}
          snapshot={{
            ...dashboardSnapshot,
            triggers: [
              {
                description: "Scheduled agent work",
                id: "managed-trigger",
                kind: "schedule",
                managed: true,
                name: "Daily checks",
                status,
                targetId: "summarize-day",
              },
            ],
          }}
        />
      );
      await click(ui, "view:catalog");
      await click(ui, "trigger:managed-trigger");
      const runNow = ui.renderer.root.findDescendantById("schedule:run");
      const footerOffersRun = ui.captureCharFrame().includes("r run now");
      if (interaction === "keyboard") {
        await press(ui, "r");
      } else if (runNow) {
        await click(ui, "schedule:run");
      }
      expect(rolled.splice(0)).toEqual(
        status === "waiting" ? ["managed-trigger"] : []
      );
      expect(footerOffersRun).toBe(status === "waiting");
      expect(Boolean(runNow)).toBe(status === "waiting");
    }
  }
);

test.each(["keyboard", "click"] as const)(
  "Diagnostics via %s scopes to the inspected run and Escape restores the inspector",
  async (interaction) => {
    const ui = await render();
    await press(ui, "L");
    await press(ui, "v");
    await press(ui, "o");
    await press(ui, "ESCAPE");
    await press(ui, "RETURN");
    if (interaction === "keyboard") {
      await press(ui, "d");
    } else {
      await click(ui, "view:logs");
    }
    const frame = ui.captureCharFrame();
    expect(frame).toContain("Run run-104 · x clear");
    expect(frame).toContain("level info+ · source run");
    expect(frame).not.toContain("[agents] no list price");
    expect(
      ui.renderer.root.findDescendantById("panel:details")
    ).toBeUndefined();
    expect(frame.split("\n").filter((line) => line.includes("╮"))).toHaveLength(
      1
    );
    await press(ui, "d");
    expect(ui.captureCharFrame()).toContain("Run run-104 · x clear");
    await press(ui, "ESCAPE");
    expect(ui.captureCharFrame()).toContain("Run / update-documentation");
    expect(ui.captureCharFrame()).not.toContain("Logs · runs and Marbles");
    await press(ui, "L");
    expect(ui.captureCharFrame()).not.toContain("Run run-104 · x clear");
    expect(ui.captureCharFrame()).toContain("level info+ · source run");
  }
);

test("Settings reserves a column beside Feed and gives the full frame back on Escape", async () => {
  const ui = await render();
  await click(ui, "view:feed");
  await frameWith(ui, "The docs workflow rewrote");
  await press(ui, "S");
  const { root } = ui.renderer;
  const settings = root.findDescendantById("panel:settings");
  const feed = root.findDescendantById("panel:feed");
  const entry = root.findDescendantById("panel:entry");
  if (!(settings && feed && entry)) {
    throw new Error("Missing Settings or Feed entry");
  }
  expect(entry.x + entry.width).toBeLessThan(settings.x);
  expect(entry.width).toBe(feed.width);
  await press(ui, "ESCAPE");
  expect(await frameWith(ui, "The docs workflow rewrote")).toContain(
    "Merge the docs update?"
  );
});

test("Settings uses the body at narrow widths and Escape restores the run list", async () => {
  const ui = await render(dashboardSnapshot, 70, 24);
  await press(ui, "S");
  expect(ui.captureCharFrame()).toContain("Theme:");
  expect(ui.captureCharFrame()).not.toContain("3 Runs");
  expect(ui.captureCharFrame()).not.toContain("Write changes");
  await press(ui, "ESCAPE");
  expect(ui.captureCharFrame()).toContain("Write changes");
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
    usage: undefined,
  };
  const ui = await render(empty);
  expect(ui.captureCharFrame()).toContain("No schedules or monitors.");
  await press(ui, "3");
  expect(ui.captureCharFrame()).toContain(
    "Launch a step or workflow from Marbles."
  );
  expect(ui.captureCharFrame()).toContain("No usage recorded");
  await press(ui, "m");
  expect(ui.captureCharFrame()).toContain("No workflows or steps.");
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
  await click(
    ui,
    `expand:${selectionKey({ id: "run-104", kind: "run", stepId: "update" })}`
  );
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
  await click(ui, "view:catalog");
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
    "Cycle the Feed workspace filter",
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

test("Catalog stacks Triggers over a larger Marbles list at both widths", async () => {
  for (const width of [70, 120]) {
    const ui = await render(dashboardSnapshot, width, 24);
    await press(ui, "1");
    const frame = ui.captureCharFrame();
    expect(frame).toContain("[monitor] update-docs");
    expect(frame).toContain("running Watch");
    expect(frame).toContain("[monitor] review-code");
    expect(frame).toContain("[schedule] daily-summary");
    expect(frame).toContain("Next: Today");
    expect(frame).not.toContain("Schedules & monitors");
    expect(frame).not.toContain("captured at");
    const triggers = ui.renderer.root.findDescendantById("panel:trigger");
    const catalog = ui.renderer.root.findDescendantById("panel:definition");
    if (!(triggers && catalog)) {
      throw new Error("Missing catalog panel");
    }
    expect(ui.renderer.root.findDescendantById("panel:run")).toBeUndefined();
    expect(catalog.height).toBeGreaterThan(triggers.height);
    expect(catalog.y).toBe(triggers.y + triggers.height);
    expect(catalog.width).toBe(triggers.width);
    await act(async () => ui.renderer.resize(width, 16));
    await flush(ui);
    expect(catalog.height).toBeGreaterThanOrEqual(triggers.height);
    expect(catalog.y + catalog.height).toBeLessThanOrEqual(15);
  }
});

test("Dashboard puts Latest beside Runs when wide, and below when narrow", async () => {
  const wide = await render(dashboardSnapshot, 120, 30);
  const runs = wide.renderer.root.findDescendantById("panel:run");
  const latest = wide.renderer.root.findDescendantById("panel:latest");
  if (!(runs && latest)) {
    throw new Error("Missing overview panel");
  }
  expect(latest.x).toBeGreaterThan(runs.x + runs.width - 1);
  expect(latest.y).toBe(runs.y);
  const narrow = await render(dashboardSnapshot, 70, 24);
  const narrowRuns = narrow.renderer.root.findDescendantById("panel:run");
  const narrowLatest = narrow.renderer.root.findDescendantById("panel:latest");
  if (!(narrowRuns && narrowLatest)) {
    throw new Error("Missing overview panel");
  }
  expect(narrowLatest.y).toBeGreaterThan(narrowRuns.y);
});

test("Tab focuses Triggers, Marbles, and Runs, switching between Catalog and Overview", async () => {
  const ui = await render(dashboardSnapshot, 70, 24);
  for (const name of ["trigger", "definition", "run", "trigger"]) {
    await press(ui, "TAB");
    const frame = ui.captureCharFrame();
    const active = ui.renderer.root.findDescendantById(`panel:${name}`);
    expect(active).toHaveProperty(
      "borderColor",
      RGBA.fromHex(theme.border.focusColor)
    );
    if (name === "run") {
      expect(frame).toContain("3 Runs");
      expect(frame).not.toContain("1 Triggers");
    } else {
      expect(frame).toContain("1 Triggers");
      expect(frame).toContain("2 Marbles");
      expect(frame).not.toContain("3 Runs");
    }
    expect(frame).not.toContain("Overview  Input");
  }
});

test("Marbles remains visible and its details return to the same panel", async () => {
  const ui = await render(dashboardSnapshot, 70, 24);
  await press(ui, "m");
  expect(ui.captureCharFrame()).toContain("2 Marbles");
  expect(ui.captureCharFrame()).toContain("[workflow] update-documentation");
  await press(ui, "RETURN");
  expect(ui.captureCharFrame()).toContain("Find changes, update documentation");
  await press(ui, "ESCAPE");
  expect(ui.captureCharFrame()).toContain("2 Marbles");
  await press(ui, "ARROW_DOWN");
  await press(ui, "ARROW_DOWN");
  await press(ui, "ARROW_DOWN");
  expect(ui.captureCharFrame()).toContain("[step] check-api");
  await press(ui, "3");
  expect(ui.captureCharFrame()).toContain("3 Runs");
  await press(ui, "2");
  expect(ui.captureCharFrame()).toContain("› [step] check-api");
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

test("Marbles filtering opens the filtered runs on Overview and returns to the catalog", async () => {
  const ui = await render();
  await press(ui, "2");
  await press(ui, "f");
  const frame = ui.captureCharFrame();
  expect(frame).toContain("Run filter: definition: update-documentation");
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
