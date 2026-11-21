import { sleep } from "bun";
import { act } from "react";
import { afterEach, expect, test } from "vitest";
import { useAnimationClock } from "../src/hooks/use-animation-clock";
import { useGoalDraft } from "../src/hooks/use-goal-draft";
import { useRail } from "../src/hooks/use-rail";
import type { RailStop } from "../src/model/rail";
import { context } from "../stories/fixtures/threads";
import { frameWith, mount, press, unmount } from "./helpers/render";

const STOPS: readonly RailStop[] = ["avatar", "model", "effort", "slot"];
const NONE: readonly RailStop[] = [];
const TICKED = /frame (\d+) at (\d+)/;

let draft: ReturnType<typeof useGoalDraft> | undefined;
let goals: string[] = [];

function keep(goal: string) {
  goals.push(goal);
}

function DraftProbe({ busy }: { readonly busy: boolean }) {
  draft = useGoalDraft({ busy, onGoal: keep });
  return <text>{`[${draft.draft}]`}</text>;
}

function RailProbe({ stops }: { readonly stops: readonly RailStop[] }) {
  const rail = useRail(context, 3, stops);
  return (
    <text>{`${rail.focus} ${rail.model} ${rail.effort} ${rail.avatar}`}</text>
  );
}

function ClockProbe({ active }: { readonly active: boolean }) {
  const { frame, now } = useAnimationClock(active);
  return <text>{`frame ${frame} at ${now}`}</text>;
}

async function edit(text: string) {
  await act(async () => draft?.setDraft(text));
}

async function submit() {
  await act(async () => draft?.submit());
}

afterEach(async () => {
  draft = undefined;
  goals = [];
  await unmount();
});

test("a goal draft is handed over trimmed, once, and then cleared", async () => {
  const ui = await mount(<DraftProbe busy={false} />);

  await submit();
  await edit("   ");
  await submit();
  await edit("  list the files  ");
  await submit();
  await submit();

  expect(goals).toEqual(["list the files"]);
  expect(await frameWith(ui, "[]")).toContain("[]");
});

test("a busy goal draft keeps its text and hands nothing over", async () => {
  const ui = await mount(<DraftProbe busy />);

  await edit("next goal");
  await submit();

  expect(goals).toEqual([]);
  expect(await frameWith(ui, "[next goal]")).toContain("[next goal]");
});

test("Tab moves the rail's focus and the arrows change what it is on", async () => {
  const ui = await mount(<RailProbe stops={STOPS} />);

  expect(ui.captureCharFrame()).toContain("model sonnet medium 0");
  await press(ui, "ARROW_DOWN");
  expect(ui.captureCharFrame()).toContain("model opus medium 0");
  await press(ui, "TAB");
  await press(ui, "ARROW_UP");
  expect(ui.captureCharFrame()).toContain("effort opus high 0");
  await press(ui, "TAB", { shift: true });
  await press(ui, "TAB", { shift: true });
  await press(ui, "ARROW_DOWN");
  expect(ui.captureCharFrame()).toContain("avatar opus high 1");
});

test("the rail ignores keys when it has no stops", async () => {
  const ui = await mount(<RailProbe stops={NONE} />);

  await press(ui, "TAB");
  await press(ui, "ARROW_DOWN");
  expect(ui.captureCharFrame()).toContain("model sonnet medium 0");
});

test("an active clock advances its frame and time", async () => {
  const before = Date.now();
  const ui = await mount(<ClockProbe active />);
  await sleep(300);
  const frame = await frameWith(ui, "frame");
  const [, ticks = "0", now = "0"] = frame.match(TICKED) ?? [];

  expect(Number(ticks)).toBeGreaterThan(0);
  expect(Number(now)).toBeGreaterThan(before);
});

test("an idle clock stands still", async () => {
  const ui = await mount(<ClockProbe active={false} />);
  await sleep(300);
  await frameWith(ui, "frame");

  expect(ui.captureCharFrame()).toContain("frame 0 ");
});
