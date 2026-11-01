import { afterEach, expect, test } from "bun:test";
import { step, workflow } from "../src/authoring/builder";
import { catalog } from "../src/authoring/catalog";
import { agent } from "../src/authoring/resources";
import { DashboardView } from "../src/views/dashboard";
import { dashboardSnapshot } from "../src/workspace/snapshot";
import { startEngine } from "./helpers/engine";
import { mount, press, unmount } from "./helpers/render";

const PANEL_TEXT = /[│█▀▄\s]+/g;

/** The frame's words in order, so a value wrapped inside a panel still reads as one line. */
function words(frame: string): string {
  return frame.replace(PANEL_TEXT, " ");
}

function close() {
  // Quitting is covered in dashboard-quit.test.tsx.
}

afterEach(async () => {
  await unmount();
  catalog.reset();
});

test("a step definition that only ran inside another workflow says where its usage counts, instead of only 'no usage recorded'", async () => {
  const reviewer = agent({ name: "reviewer", prompt: "Review." });
  const shared = step("shared").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    return (await session.generate("shared")).text;
  });
  workflow("flow").do(() => shared({}));
  const engine = await startEngine({ print: () => undefined });
  const launched = await engine.launch("flow", {});
  await launched.result;
  const snapshot = dashboardSnapshot(await engine.runs(), {
    definitions: engine.definitions(),
    lastFinish: new Map(),
    monitors: engine.monitors(),
    root: process.cwd(),
    schedules: [],
    startedAt: 0,
    status: "",
    usage: await engine.readUsage(),
    workspaceId: "test",
  });
  await engine.dispose();
  // Its turn was recorded, under the run of `flow`: no run started from `shared`.
  expect(snapshot.runs[0]?.usage?.turns).toBe(1);
  expect(snapshot.usage?.byWorkflow.map((group) => group.id)).toEqual(["flow"]);
  const ui = await mount(
    <DashboardView onClose={close} snapshot={snapshot} />,
    { height: 40, width: 120 }
  );
  await press(ui, "2");
  await press(ui, "RETURN");
  const frame = words(ui.captureCharFrame());
  expect(frame).toContain("shared");
  expect(frame).toContain("Cost : no usage recorded for runs started here");
  expect(frame).toContain("Tokens : no usage recorded for runs started here");
  expect(frame).toContain(
    "Covers : runs started from shared; inside other runs its usage counts under their steps"
  );
});
