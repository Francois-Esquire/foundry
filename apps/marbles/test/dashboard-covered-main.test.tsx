import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { mainContent, overviewModel } from "~/cli/state/dashboard-views";
import type { HostedWorkspace } from "~/cli/state/use-dashboard";
import { DashboardView } from "~/cli/views/dashboard";
import { dashboardSnapshot } from "../stories/fixtures/snapshot";
import { flush, mount, unmount } from "./helpers/render";

vi.mock("~/cli/state/dashboard-views", async (original) => {
  const actual = await original<typeof import("~/cli/state/dashboard-views")>();
  return {
    ...actual,
    mainContent: vi.fn(actual.mainContent),
    overviewModel: vi.fn(actual.overviewModel),
  };
});

const hosted: HostedWorkspace = {
  state: "ready",
  workspaces: [
    {
      config: "/w/foundry/.foundry/marbles",
      id: "ws-foundry",
      root: "/w/foundry",
      state: "ready",
    },
    {
      config: "/w/handbook/.foundry/marbles",
      id: "ws-handbook",
      root: "/w/handbook",
      state: "ready",
    },
  ],
};

const close = () => undefined;
const saveSettings = () => Promise.resolve();

afterEach(unmount);

async function builtAfter(key: string, width: number) {
  const ui = await mount(
    <DashboardView
      hosted={hosted}
      onClose={close}
      onSettings={saveSettings}
      snapshot={dashboardSnapshot}
    />,
    { height: 34, width }
  );
  expect(vi.mocked(overviewModel)).toHaveBeenCalled();
  vi.mocked(mainContent).mockClear();
  vi.mocked(overviewModel).mockClear();
  await act(async () => ui.mockInput.pressKey(key));
  await flush(ui);
  return {
    built: vi.mocked(mainContent).mock.calls.length > 0,
    frame: ui.captureCharFrame(),
    overview: vi.mocked(overviewModel).mock.calls.length > 0,
  };
}

test.each([
  { drawer: "diagnostics", key: "L", title: "Logs", width: 120 },
  { drawer: "diagnostics", key: "L", title: "Logs", width: 70 },
  { drawer: "settings", key: "S", title: "Settings", width: 70 },
  { drawer: "workspaces", key: "w", title: "Workspaces", width: 70 },
])(
  "the $drawer drawer covering main at $width columns builds no main model",
  async ({ key, title, width }) => {
    const result = await builtAfter(key, width);
    expect(result.frame).toContain(title);
    expect(result.frame).not.toContain("Active runs");
    expect(result).toMatchObject({ built: false, overview: false });
  }
);

test.each([
  { drawer: "settings", key: "S", title: "Settings" },
  { drawer: "workspaces", key: "w", title: "Workspaces" },
])(
  "the $drawer drawer docked beside main builds the main model",
  async ({ key, title }) => {
    const result = await builtAfter(key, 120);
    expect(result.frame).toContain(title);
    expect(result.frame).toContain("Active runs");
    expect(result).toMatchObject({ built: true, overview: true });
  }
);

test("main with no drawer is built", async () => {
  const result = await builtAfter("u", 120);
  expect(result.frame).toContain("Usage");
  expect(result.built).toBe(true);
});
