import { afterEach, expect, test } from "bun:test";
import { sleep } from "bun";
import { act, useEffect, useState } from "react";
import { dashboardSnapshot } from "../preview/snapshot";
import { PreviewStartup } from "../preview/startup";
import { SplashView } from "../src/views/splash";
import { type SplashState, summarizeConfig } from "../src/views/splash-model";
import { click, ctrlC, flush, mount, press, unmount } from "./helpers/render";

let closed = false;
function close() {
  closed = true;
}
let entered = 0;
function enterSplash() {
  entered += 1;
}

afterEach(unmount);

let updateSplash: ((state: SplashState) => void) | undefined;
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

function ready(
  workspace = "foundry",
  counts = summarizeConfig(dashboardSnapshot)
) {
  return (
    <SplashView
      onClose={close}
      onEnter={enterSplash}
      preview
      state={{ counts, status: "ready" }}
      workspace={workspace}
    />
  );
}

test("splash gates entry until ready and shows counts from the loaded snapshot", async () => {
  entered = 0;
  const ui = await mount(<ControlledSplash />, { height: 24, width: 70 });
  expect(ui.captureCharFrame()).toContain("Loading marbles");
  expect(ui.captureCharFrame()).not.toContain("loaded");
  expect(ui.renderer.root.findDescendantById("splash:enter")).toBeUndefined();
  await press(ui, "RETURN");
  expect(entered).toBe(0);
  await act(async () =>
    updateSplash?.({
      counts: summarizeConfig(dashboardSnapshot),
      status: "ready",
    })
  );
  await flush(ui);
  const frame = ui.captureCharFrame();
  expect(frame).toContain("Marbles loaded");
  expect(frame).toContain("3 loaded");
  expect(frame).toContain("1 schedule · 2 monitors");
  expect(frame).toContain("4 loaded");
  expect(frame).toContain("3 workflows · 1 step");
  expect(frame).toContain("3 runs available");
  expect(frame).toContain("Press Enter to enter");
  expect(entered).toBe(0);
  await press(ui, "RETURN");
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
    const ui = await mount(ready(), { height, width });
    const card = ui.renderer.root.findDescendantById("splash:card");
    if (!card) {
      throw new Error("Missing splash card");
    }
    const logo = ui.renderer.root.findDescendantById("splash:logo");
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
    expect(ui.captureCharFrame()).toContain("Press Enter to enter");
    await click(ui, "splash:enter");
  }
  expect(entered).toBe(5);
});

test("sparkles shimmer without changing silhouettes and pause for the quit dialog", async () => {
  const ui = await mount(ready());
  const first = ui.captureCharFrame();
  const firstColors = JSON.stringify(ui.captureSpans());
  expect(first).toContain("▀");
  expect(first).toContain("▄");
  await act(async () => sleep(650));
  await flush(ui);
  const next = ui.captureCharFrame();
  expect(next).toBe(first);
  expect(JSON.stringify(ui.captureSpans())).not.toBe(firstColors);
  await ctrlC(ui);
  const modal = JSON.stringify(ui.captureSpans());
  await act(async () => sleep(450));
  await flush(ui);
  expect(JSON.stringify(ui.captureSpans())).toBe(modal);
});

test("empty config reports zero counts and still permits entry", async () => {
  entered = 0;
  const counts = summarizeConfig({
    ...dashboardSnapshot,
    definitions: [],
    runs: [],
    triggers: [],
  });
  const ui = await mount(ready("empty", counts), { height: 24, width: 70 });
  expect(ui.captureCharFrame()).toContain("0 schedules · 0 monitors");
  expect(ui.captureCharFrame()).toContain("0 workflows · 0 steps");
  await click(ui, "splash:enter");
  expect(entered).toBe(1);
});

test("splash quit confirmation blocks entry and supports a second Ctrl+C", async () => {
  closed = false;
  entered = 0;
  const ui = await mount(ready(), { height: 24, width: 70 });
  await ctrlC(ui);
  expect(closed).toBe(false);
  expect(ui.captureCharFrame()).toContain("Quit Marbles?");
  await press(ui, "RETURN");
  expect(entered).toBe(0);
  expect(ui.captureCharFrame()).toContain("Press Enter to enter");
  await ctrlC(ui);
  await ctrlC(ui);
  expect(closed).toBe(true);
});

test("preview loads its config, waits for entry, and opens the dashboard once", async () => {
  const ui = await mount(<PreviewStartup onClose={close} />, {
    height: 24,
    width: 70,
  });
  expect(ui.captureCharFrame()).toContain("Loading marbles");
  await press(ui, "RETURN");
  await act(async () => {
    await sleep(1000);
  });
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("Marbles loaded");
  expect(ui.captureCharFrame()).not.toContain("1 Triggers");
  await press(ui, "RETURN");
  expect(ui.captureCharFrame()).toContain("1 Triggers");
  expect(ui.captureCharFrame()).toContain("2 Marbles");
  expect(ui.captureCharFrame()).toContain("3 Runs");
  expect(ui.captureCharFrame()).not.toContain("Overview  Input");
  await click(ui, "nav:home");
  expect(ui.captureCharFrame()).not.toContain("Marbles loaded");
});
