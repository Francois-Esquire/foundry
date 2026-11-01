import { afterEach, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { act, useCallback, useState } from "react";
import { dashboardSnapshot } from "../preview/snapshot";
import { applyTheme, theme } from "../src/components/ui/theme";
import type { SettingsChange } from "../src/model/settings";
import { DashboardView } from "../src/views/dashboard";
import type { DashboardSnapshot } from "../src/views/dashboard-model";
import { click, flush, mount, press, unmount } from "./helpers/render";

const ACTIVE_STEP = /Step\s+: write/;
const RUN_COST = /Cost\s+: \$0\.0421 est\. · partial: 1 of 3 turns unpriced/;
const STEP_COST = /Cost here\s+: \$0\.0302 est\./;
const WORKFLOW_SOURCE = /Source\s+: \.foundry\/marbles\/docs\.ts:12/;
const WORKFLOW_AVAILABLE = /Available\s+: throughout foundry/;
const WORKFLOW_COST = /Cost\s+: \$0\.0421 est\./;
const UNPRICED_RUN = /Cost\s+: no usage recorded/;

function close() {
  // Quitting is covered in dashboard-quit.test.tsx.
}

afterEach(async () => {
  await unmount();
  applyTheme("dark");
});

function render(snapshot: DashboardSnapshot = dashboardSnapshot) {
  return mount(<DashboardView onClose={close} snapshot={snapshot} />, {
    height: 34,
    width: 120,
  });
}

async function shift(ui: Awaited<ReturnType<typeof render>>, letter: string) {
  await act(async () => ui.mockInput.pressKey(letter));
  await flush(ui);
}

test("Logs lists run and Marbles lines, filters them, and opens a line's run at its step", async () => {
  const ui = await render();
  await shift(ui, "L");
  let frame = ui.captureCharFrame();
  expect(frame).toContain("Logs · runs and Marbles");
  expect(frame).toContain("6 of 6 lines · level debug+ · source all");
  expect(frame).toContain("marbles");
  expect(frame).toContain("[agents] no list price for openai/gpt-local");
  expect(frame).toContain("run-104 write");
  expect(frame).toContain("Following");
  expect(frame).toContain("logs · ↑↓ select · Enter open run");

  await press(ui, "v");
  await press(ui, "v");
  frame = ui.captureCharFrame();
  expect(frame).toContain("1 of 6 lines · level warn+");
  expect(frame).not.toContain("Writing CLI reference changes.");

  await press(ui, "x");
  await press(ui, "/");
  await act(async () => ui.mockInput.typeText("cli.ts"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("Search logs: ");
  await press(ui, "RETURN");
  frame = ui.captureCharFrame();
  expect(frame).toContain(
    '1 of 6 lines · level debug+ · source all · search "cli.ts"'
  );
  expect(frame).toContain("Found src/cli.ts");

  await press(ui, "x");
  await press(ui, "ARROW_UP");
  expect(ui.captureCharFrame()).toContain("Paused");
  await press(ui, "ARROW_DOWN");
  await press(ui, "RETURN");
  frame = ui.captureCharFrame();
  expect(frame).toMatch(ACTIVE_STEP);
  expect(frame).toMatch(STEP_COST);
});

test("run and catalog details show attributed cost, unknowns, and where a definition was built", async () => {
  const ui = await render();
  await press(ui, "RETURN");
  expect(ui.captureCharFrame()).toMatch(RUN_COST);
  await press(ui, "ESCAPE");
  await press(ui, "ARROW_DOWN");
  await press(ui, "ARROW_DOWN");
  await press(ui, "ARROW_DOWN");
  await press(ui, "ARROW_DOWN");
  await press(ui, "ARROW_DOWN");
  await press(ui, "RETURN");
  // check-api recorded no agent turns: that is not a zero cost.
  expect(ui.captureCharFrame()).toMatch(UNPRICED_RUN);
  await press(ui, "2");
  await press(ui, "RETURN");
  const frame = ui.captureCharFrame();
  expect(frame).toMatch(WORKFLOW_SOURCE);
  expect(frame).toMatch(WORKFLOW_AVAILABLE);
  expect(frame).toMatch(WORKFLOW_COST);
});

test("clicking a Marbles line in Logs selects it and stops following, without leaving the tab", async () => {
  const ui = await render();
  await shift(ui, "L");
  expect(ui.captureCharFrame()).toContain("Following");
  await click(ui, "log:host:1");
  const frame = ui.captureCharFrame();
  expect(frame).toContain("Logs · runs and Marbles");
  expect(frame).toContain("Paused");
  const row = frame.split("\n").find((line) => line.includes("[source]"));
  expect(row).toContain("›");
  await press(ui, "ARROW_DOWN");
  const next = ui
    .captureCharFrame()
    .split("\n")
    .find((line) => line.includes("›"));
  expect(next).not.toContain("[source]");
});

test("clicking a run's line in Logs still opens its run", async () => {
  const ui = await render();
  await shift(ui, "L");
  const run = ui.renderer.root
    .findDescendantById("panel:logs")
    ?.getChildren()
    .flatMap((child) => [child, ...child.getChildren()])
    .find(
      (child) =>
        child.id.startsWith("log:") && !child.id.startsWith("log:host:")
    );
  if (!run) {
    throw new Error("The preview snapshot has a run's log line");
  }
  await click(ui, run.id);
  expect(ui.captureCharFrame()).not.toContain("Logs · runs and Marbles");
});

/** The foreground of the first span reading exactly `text`, as RGBA ints. */
function foreground(ui: Awaited<ReturnType<typeof render>>, text: string) {
  return ui
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.trim() === text)
    ?.fg.toInts();
}

test("kind badges and status labels draw in the light palette once it is applied", async () => {
  applyTheme("light");
  const ui = await render();
  expect(foreground(ui, "failed")).toEqual(RGBA.fromHex("#9d0006").toInts());
  await press(ui, "2");
  expect(foreground(ui, "[workflow]")).toEqual(
    RGBA.fromHex("#b57614").toInts()
  );
});

function SettingsHost() {
  const [snapshot, setSnapshot] = useState(dashboardSnapshot);
  const onSettings = useCallback((changes: SettingsChange) => {
    const { theme: chosen } = changes;
    if (chosen) {
      applyTheme(chosen);
      setSnapshot((previous) => ({
        ...previous,
        settings: {
          path: previous.settings?.path ?? "",
          theme: chosen,
        },
      }));
    }
    return Promise.resolve();
  }, []);
  return (
    <DashboardView
      onClose={close}
      onSettings={onSettings}
      snapshot={snapshot}
    />
  );
}

test("Settings changes the theme through the host and redraws in its palette", async () => {
  const ui = await mount(<SettingsHost />, { height: 30, width: 120 });
  await click(ui, "view:settings");
  let frame = ui.captureCharFrame();
  expect(frame).toContain("Settings · every workspace");
  expect(frame).toContain("Theme [dark] light ←→ change");
  expect(frame).toContain("~/.foundry/marbles/settings.json");
  expect(frame).toContain("Nothing is sent");
  expect(frame).toContain("settings · ←→ theme");
  await press(ui, "ARROW_RIGHT");
  frame = ui.captureCharFrame();
  expect(frame).toContain("Theme dark [light]");
  const background = ui
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes("Settings · every workspace"));
  expect(background?.bg.toInts()).toEqual(
    RGBA.fromHex(theme.colors.background).toInts()
  );
  expect(theme.colors.background).toBe("#fbf1c7");
});

/**
 * A host whose first save rejects, as the dashboard command's settings
 * action does for a file it cannot use (dashboard-settings-production.test.ts).
 */
function FailingSettingsHost() {
  const [snapshot, setSnapshot] = useState(dashboardSnapshot);
  const [failed, setFailed] = useState(false);
  const onSettings = useCallback(
    async (changes: SettingsChange) => {
      await Promise.resolve();
      if (!failed) {
        setFailed(true);
        throw new Error("settings.json is not valid JSON; fix or remove it");
      }
      const { theme: chosen } = changes;
      if (chosen) {
        setSnapshot((previous) => ({
          ...previous,
          settings: { path: previous.settings?.path ?? "", theme: chosen },
        }));
      }
    },
    [failed]
  );
  return (
    <DashboardView
      onClose={close}
      onSettings={onSettings}
      snapshot={snapshot}
    />
  );
}

test("a rejected settings save is reported, leaves nothing busy, and the next change goes through", async () => {
  const ui = await mount(<FailingSettingsHost />, { height: 30, width: 120 });
  await click(ui, "view:settings");
  await press(ui, "ARROW_RIGHT");
  let frame = ui.captureCharFrame();
  expect(frame).toContain("fix or remove it");
  expect(frame).not.toContain("Working…");
  expect(frame).toContain("Theme [dark] light");
  await press(ui, "ARROW_RIGHT");
  frame = ui.captureCharFrame();
  expect(frame).toContain("Theme dark [light]");
  expect(frame).not.toContain("fix or remove it");
});

test("Settings is read-only where the host cannot save, and says why a file was ignored", async () => {
  const ui = await render({
    ...dashboardSnapshot,
    settings: {
      path: "/tmp/settings.json",
      problem: "/tmp/settings.json is not valid JSON; using defaults",
      theme: "dark",
    },
  });
  await shift(ui, "S");
  const frame = ui.captureCharFrame();
  expect(frame).toContain("read-only here");
  expect(frame).toContain("is not valid JSON; using defaults");
  await press(ui, "ARROW_RIGHT");
  expect(ui.captureCharFrame()).toContain("Theme [dark] light");
});

const AGENT_NAMES = [
  "planner",
  "coder",
  "reviewer",
  "tester",
  "writer",
  "triager",
  "releaser",
];

function manyAgents(): DashboardSnapshot {
  const { usage } = dashboardSnapshot;
  if (!usage) {
    throw new Error("The preview snapshot records usage");
  }
  const [first] = usage.byAgent;
  if (!first) {
    throw new Error("The preview snapshot has an agent");
  }
  return {
    ...dashboardSnapshot,
    usage: {
      ...usage,
      byAgent: AGENT_NAMES.map((id, index) => ({
        id,
        total: {
          ...first.total,
          estimated: [{ amount: (index + 1) / 100, currency: "USD" }],
        },
      })),
    },
  };
}

test("at 80 columns, u opens every agent's and workflow's cost, more than five included, and Esc returns", async () => {
  const ui = await mount(
    <DashboardView onClose={close} snapshot={manyAgents()} />,
    { height: 40, width: 80 }
  );
  let frame = ui.captureCharFrame();
  expect(frame).not.toContain("By agent");
  expect(frame).toContain("u usage");
  await press(ui, "u");
  frame = ui.captureCharFrame();
  expect(frame).toContain("Usage · every workflow and agent");
  expect(frame).toContain("By workflow");
  expect(frame).toContain("review: $0.1180 est.");
  for (const [index, name] of AGENT_NAMES.entries()) {
    expect(frame).toContain(`${name}: $${((index + 1) / 100).toFixed(4)} est.`);
  }
  expect(frame).toContain("usage · ↑↓ scroll");
  expect(frame).toContain("Esc back");
  await press(ui, "ESCAPE");
  frame = ui.captureCharFrame();
  expect(frame).toContain("3 Runs");
  expect(frame).not.toContain("Usage · every workflow and agent");
});

test("the wide Usage panel says how many agents it leaves out, and u shows them", async () => {
  const ui = await mount(
    <DashboardView onClose={close} snapshot={manyAgents()} />,
    { height: 40, width: 120 }
  );
  expect(ui.captureCharFrame()).toContain("+2 more · u shows all");
  await press(ui, "u");
  expect(ui.captureCharFrame()).toContain("releaser: $0.0700 est.");
});

test("in a short 80-column terminal the breakdown scrolls with the keyboard to the last agent", async () => {
  const ui = await mount(
    <DashboardView onClose={close} snapshot={manyAgents()} />,
    { height: 24, width: 80 }
  );
  await press(ui, "u");
  expect(ui.captureCharFrame()).not.toContain("releaser:");
  for (let line = 0; line < 12; line += 1) {
    await act(async () => ui.mockInput.pressArrow("down"));
  }
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("releaser: $0.0700 est.");
});
