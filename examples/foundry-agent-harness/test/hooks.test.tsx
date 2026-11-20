import { sleep } from "bun";
import { act } from "react";
import { afterEach, expect, test } from "vitest";
import { useAnimationClock } from "../src/hooks/use-animation-clock";
import { useGoalDraft } from "../src/hooks/use-goal-draft";
import { nextTab, useTabCycle } from "../src/hooks/use-tab-cycle";
import { frameWith, mount, press, unmount } from "./helpers/render";

const KEYS = ["todos", "notes", "skills"] as const;
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

function TabProbe({ enabled }: { readonly enabled: boolean }) {
  return <text>{`tab ${useTabCycle([...KEYS], enabled)}`}</text>;
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

test("the next tab wraps around both ways", () => {
  expect(nextTab(KEYS, "todos", false)).toBe("notes");
  expect(nextTab(KEYS, "skills", false)).toBe("todos");
  expect(nextTab(KEYS, "todos", true)).toBe("skills");
  expect(nextTab(KEYS, "notes", true)).toBe("todos");
});

test("Tab and Shift+Tab cycle the tabs while enabled", async () => {
  const ui = await mount(<TabProbe enabled />);

  expect(ui.captureCharFrame()).toContain("tab todos");
  await press(ui, "TAB");
  expect(ui.captureCharFrame()).toContain("tab notes");
  await press(ui, "TAB", { shift: true });
  await press(ui, "TAB", { shift: true });
  expect(ui.captureCharFrame()).toContain("tab skills");
});

test("Tab does nothing while the tabs are disabled", async () => {
  const ui = await mount(<TabProbe enabled={false} />);

  await press(ui, "TAB");
  expect(ui.captureCharFrame()).toContain("tab todos");
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
