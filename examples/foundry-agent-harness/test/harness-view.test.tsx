import { afterEach, expect, test } from "vitest";
import type { Thread } from "../src/model/thread";
import { HarnessView } from "../src/views/harness";
import { context, threads } from "../stories/fixtures/threads";
import { fakeRun } from "./helpers/fake-run";

import { frameWith, mount, press, type, unmount } from "./helpers/render";

function view(thread: Thread) {
  const fake = fakeRun(thread);
  return { fake, node: <HarnessView context={context} run={fake.run} /> };
}

async function asked(thread: Thread, size?: { height: number; width: number }) {
  const { fake, node } = view(thread);
  const ui = await mount(node, size);
  await type(ui, "explain this example");
  await press(ui, "RETURN");
  return { fake, ui };
}

const PAGE_UP = "\u001B[5~";
const PAGE_DOWN = "\u001B[6~";

afterEach(unmount);

test("a new view shows the welcome and an empty panel", async () => {
  const frame = (await mount(view(threads.idle).node)).captureCharFrame();

  expect(frame).toContain("Give the harness a goal. It will:");
  expect(frame).toContain("To-dos 0/0");
  expect(frame).toContain("New thread · claude-code/sonnet");
});

test("Enter hands over a trimmed goal once and clears the field", async () => {
  const { fake, node } = view(threads.done);
  const ui = await mount(node);

  await press(ui, "RETURN");
  await type(ui, "  list the files  ");
  expect(ui.captureCharFrame()).toContain("list the files");
  await press(ui, "RETURN");
  await press(ui, "RETURN");

  expect(fake.goals).toEqual(["list the files"]);
  expect(ui.captureCharFrame()).toContain("Give the harness a goal");
  expect(ui.captureCharFrame()).toContain("18.4k in · 912 out");
});

test("Enter does nothing while a goal is running", async () => {
  const { fake, ui } = await asked(threads.planning);

  expect(ui.captureCharFrame()).toContain("Planning the goal into to-dos");
  await type(ui, "another goal");
  await press(ui, "RETURN");

  expect(fake.goals).toEqual(["explain this example"]);
  expect(ui.captureCharFrame()).toContain("another goal");
});

test("Tab and Shift+Tab move through the panel's tabs", async () => {
  const { ui } = await asked(threads.done);

  await press(ui, "TAB");
  expect(ui.captureCharFrame()).toContain("version 3f9a1c2e · 1 kept");
  await press(ui, "TAB");
  expect(ui.captureCharFrame()).toContain("◆ task-notes");
  await press(ui, "TAB");
  expect(ui.captureCharFrame()).toContain("› add_todo");
  await press(ui, "TAB");
  expect(ui.captureCharFrame()).toContain("✓ Write the run instructions");
  await press(ui, "TAB", { shift: true });
  expect(ui.captureCharFrame()).toContain("› add_todo");
});

test("PgUp and PgDn scroll the conversation", async () => {
  const { ui } = await asked(threads.done, { height: 12, width: 120 });
  const top = "│ You ";
  const bottom = await frameWith(ui, "bun run start");

  expect(bottom).not.toContain(top);
  for (let page = 0; page < 6; page += 1) {
    await press(ui, PAGE_UP);
  }
  const scrolled = await frameWith(ui, top);
  expect(scrolled).toContain(top);
  expect(scrolled).not.toContain("bun run start");
  for (let page = 0; page < 6; page += 1) {
    await press(ui, PAGE_DOWN);
  }
  const back = await frameWith(ui, "bun run start");
  expect(back).toContain("bun run start");
  expect(back).not.toContain(top);
});

test("a narrow terminal drops the panel and ignores Tab", async () => {
  const { ui } = await asked(threads.done, { height: 24, width: 60 });
  const before = await frameWith(ui, "bun run start");
  await press(ui, "TAB");

  expect(before).not.toContain("To-dos");
  expect(before).not.toContain("Tab panel");
  expect(before.trimEnd().split("\n")).toHaveLength(24);
  expect(ui.captureCharFrame()).toBe(before);
});

test("the view lays out against its own box inside a larger terminal", async () => {
  const ui = await mount(
    <box height={24} width={100}>
      {view(threads.done).node}
    </box>,
    { height: 40, width: 140 }
  );
  await type(ui, "explain this example");
  await press(ui, "RETURN");
  const lines = (await frameWith(ui, "bun run start")).split("\n");

  expect(lines.slice(24).join("").trim()).toBe("");
  expect(Math.max(...lines.map((line) => line.trimEnd().length))).toBe(100);
  expect(lines.join("\n")).toContain("To-dos 3/3");
});
