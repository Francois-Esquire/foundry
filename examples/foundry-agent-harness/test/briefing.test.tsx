import { act } from "react";
import { afterEach, expect, test } from "vitest";
import { briefingGeometry } from "../src/components/layouts/briefing";
import type { Picks } from "../src/model/rail";
import { AppView } from "../src/views/app";
import { BriefingView } from "../src/views/briefing";
import { context, threads } from "../stories/fixtures/threads";
import { fakeRun } from "./helpers/fake-run";
import { frameWith, mount, press, type, unmount } from "./helpers/render";

const TALL = { height: 44, width: 120 };

const started: Picks[] = [];

function start(picks: Picks) {
  started.push(picks);
}

function briefing() {
  return { node: <BriefingView context={context} onStart={start} /> };
}

afterEach(async () => {
  started.length = 0;
  await unmount();
});

test("the menu lines up every character with the weapon and the loadout", async () => {
  const frame = (await mount(briefing().node, TALL)).captureCharFrame();

  expect(frame).toContain("GET STARTED");
  expect(frame).toContain("SMITH");
  expect(frame).toContain("WELDER");
  expect(frame).toContain("AUTOMATON");
  expect(frame).toContain("◂ 1/3 ▸");
  expect(frame).toContain("GUN  SONNET");
  expect(frame).toContain("01 task-notes");
  expect(frame).toContain("←/→  Character");
  expect(frame).toContain("↑/↓  Move");
  expect(frame).toContain("↵  Start mission");
});

test("Left and Right change the choice, Up and Down move between them, and Enter starts", async () => {
  const { node } = briefing();
  const ui = await mount(node, TALL);

  await press(ui, "ARROW_RIGHT");
  expect(ui.captureCharFrame()).toContain("◂ 2/3 ▸");
  await press(ui, "ARROW_LEFT");
  await press(ui, "ARROW_LEFT");
  expect(ui.captureCharFrame()).toContain("◂ 3/3 ▸");
  await press(ui, "ARROW_DOWN");
  expect(ui.captureCharFrame()).toContain("←/→  Gun");
  await press(ui, "ARROW_RIGHT");
  expect(ui.captureCharFrame()).toContain("▶ GUN  OPUS");
  await press(ui, "TAB");
  await press(ui, "ARROW_RIGHT");
  expect(ui.captureCharFrame()).toContain("▶ AMMO ▮▮▮");
  await press(ui, "ARROW_LEFT");
  await press(ui, "ARROW_LEFT");
  expect(ui.captureCharFrame()).toContain("▶ AMMO ▮▯▯");
  await press(ui, "ARROW_UP");
  await press(ui, "ARROW_UP");
  expect(ui.captureCharFrame()).toContain("←/→  Character");
  expect(started).toEqual([]);

  await press(ui, "RETURN");
  expect(started).toEqual([{ avatar: 2, effort: "low", model: "opus" }]);
});

test("clicking a character picks it", async () => {
  const ui = await mount(briefing().node, TALL);

  await act(async () => {
    await ui.mockMouse.click(50, 12);
  });
  await press(ui, "RETURN");

  expect(started).toEqual([{ avatar: 1, effort: "medium", model: "sonnet" }]);
});

test("a narrow screen shows only the chosen character", async () => {
  const ui = await mount(briefing().node, { height: 30, width: 60 });

  expect(ui.captureCharFrame()).toContain("SMITH");
  expect(ui.captureCharFrame()).not.toContain("WELDER");
  await press(ui, "ARROW_RIGHT");
  expect(ui.captureCharFrame()).toContain("WELDER");
  expect(ui.captureCharFrame()).toContain("◂ 2/3 ▸");
});

test("the geometry picks the biggest line-up that fits, then one character, then drops the extras", () => {
  const at = (width: number, height: number) =>
    briefingGeometry({ height, width }, 3, 2);

  expect(at(200, 60)).toMatchObject({ lineup: true, portrait: "grand" });
  expect(at(120, 44)).toMatchObject({
    block: 110,
    card: 36,
    header: true,
    lineup: true,
    loadout: true,
    portrait: "large",
    stacked: false,
  });
  expect(at(100, 30)).toMatchObject({ lineup: true, portrait: "medium" });
  expect(at(80, 24)).toMatchObject({
    header: true,
    lineup: true,
    portrait: "small",
  });
  expect(at(60, 24)).toMatchObject({
    header: false,
    lineup: false,
    portrait: "medium",
    stacked: true,
  });
  expect(at(40, 20)).toMatchObject({
    header: false,
    lineup: false,
    loadout: false,
  });
});

test("the menu fits the screen at every size without spilling", async () => {
  for (const [width, height] of [
    [200, 60],
    [160, 50],
    [120, 44],
    [100, 30],
    [80, 24],
    [60, 24],
    [40, 20],
  ] as const) {
    const ui = await mount(briefing().node, { height, width });
    const lines = ui.captureCharFrame().trimEnd().split("\n");

    expect(lines.length).toBeLessThanOrEqual(height);
    expect(lines.at(-1)).toContain("←/→  Character");
    expect(ui.captureCharFrame()).toContain("SMITH");
    expect(ui.captureCharFrame()).toContain("GUN  SONNET");
    await unmount();
  }
});

test("the app opens on the menu and carries the picks into the mission", async () => {
  const fake = fakeRun(threads.done);
  const ui = await mount(<AppView context={context} run={fake.run} />, TALL);

  expect(ui.captureCharFrame()).toContain("GET STARTED");
  await press(ui, "ARROW_RIGHT");
  await press(ui, "ARROW_DOWN");
  await press(ui, "ARROW_RIGHT");
  await press(ui, "RETURN");

  const frame = await frameWith(ui, "VITALS");
  expect(frame).not.toContain("GET STARTED");
  expect(frame).toContain("WELDER");
  expect(frame).toContain("GUN  OPUS");
  expect(frame).toContain("locked");
  expect(fake.goals).toEqual([]);

  await type(ui, "explain this example");
  await press(ui, "RETURN");
  expect(fake.weapons).toEqual([{ effort: "medium", model: "opus" }]);
});
