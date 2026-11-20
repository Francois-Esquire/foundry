import { afterEach, expect, test } from "vitest";
import type { Thread } from "../src/model/thread";
import { HarnessView } from "../src/views/harness";
import { context, threads } from "../stories/fixtures/threads";
import { frameWith, mount, press, type, unmount } from "./helpers/render";

const SHORTENED_HEADER = /Foundry Agent Harness · .*… · claude-code\/sonnet$/;

let goals: string[] = [];
function keep(goal: string) {
  goals.push(goal);
}

function view(thread: Thread) {
  return <HarnessView context={context} onGoal={keep} thread={thread} />;
}

afterEach(async () => {
  goals = [];
  await unmount();
});

test("an idle thread invites a goal and shows nothing in the panel", async () => {
  const frame = (await mount(view(threads.idle))).captureCharFrame();

  expect(frame).toContain("Give the harness a goal. It will:");
  expect(frame).toContain("To-dos 0/0");
  expect(frame).toContain("No to-dos yet.");
  expect(frame).toContain("New thread · claude-code/sonnet");
  expect(frame).toContain("0 in · 0 out");
});

test("a planning thread says so in the panel and holds the next goal", async () => {
  const ui = await mount(view(threads.planning));

  expect(ui.captureCharFrame()).toContain("Planning the goal into to-dos");
  expect(ui.captureCharFrame()).toContain("Working. The next goal can go in");
  await type(ui, "another goal");
  await press(ui, "RETURN");
  expect(goals).toEqual([]);
});

test("a working thread shows its to-dos, tool calls and the reply so far", async () => {
  const frame = (await mount(view(threads.working))).captureCharFrame();

  expect(frame).toContain("To-dos 1/4");
  expect(frame).toContain("✓ Read package.json in this directory");
  expect(frame).toContain("○ Write the run instructions");
  expect(frame).toContain("added by the worker");
  expect(frame).toContain("Task 1 · Read package.json in this directory");
  expect(frame).toContain("Read package.json");
  expect(frame).toContain("Task 2 · Identify the scripts");
  expect(frame).toContain("Bash");
  expect(frame).toContain("bun run --help");
});

test("a failed thread shows the tool's error and why the harness stopped", async () => {
  const frame = await frameWith(
    await mount(view(threads.failed)),
    "Claude Code stopped before the turn finished."
  );

  expect(frame).toContain("✗ Read package.json in this directory");
  expect(frame).toContain("File does not exist.");
  expect(frame).toContain("The harness stopped");
  expect(frame).toContain("Claude Code stopped before the turn finished.");
});

test("Tab moves through the panel's notes, skills and servers", async () => {
  const ui = await mount(view(threads.done));

  expect(ui.captureCharFrame()).toContain("18.4k in · 912 out");
  await press(ui, "TAB");
  expect(ui.captureCharFrame()).toContain("version 3f9a1c2e · 1 kept");
  expect(ui.captureCharFrame()).toContain("1-read-package-json.md");
  await press(ui, "TAB");
  expect(ui.captureCharFrame()).toContain("◆ task-notes");
  await press(ui, "TAB");
  expect(ui.captureCharFrame()).toContain("› add_todo");
});

test("Enter hands over a trimmed goal once and clears the field", async () => {
  const ui = await mount(view(threads.idle));

  await press(ui, "RETURN");
  await type(ui, "  list the files  ");
  await press(ui, "RETURN");
  await press(ui, "RETURN");

  expect(goals).toEqual(["list the files"]);
  expect(ui.captureCharFrame()).toContain("Give the harness a goal");
});

test("an 80 by 24 terminal keeps the panel and gives up the title", async () => {
  const frame = (
    await mount(view(threads.working), { height: 24, width: 80 })
  ).captureCharFrame();
  const [header = ""] = frame.split("\n");

  expect(frame).toContain("To-dos 1/4");
  expect(frame).toContain("Tab panel");
  expect(header.trimEnd().endsWith("Foundry Agent Harness")).toBe(true);
  expect(frame.trimEnd().split("\n")).toHaveLength(24);
});

test("a title too long for the header ends with an ellipsis", async () => {
  const frame = (
    await mount(view(threads.working), { height: 24, width: 110 })
  ).captureCharFrame();
  const [header = ""] = frame.split("\n");

  expect(header.trimEnd()).toMatch(SHORTENED_HEADER);
  expect(header.trimEnd()).toHaveLength(109);
});

test("a narrow terminal drops the panel and keeps the conversation", async () => {
  const frame = await frameWith(
    await mount(view(threads.done), { height: 24, width: 60 }),
    "bun run start"
  );

  expect(frame).not.toContain("To-dos");
  expect(frame.trimEnd().split("\n")).toHaveLength(24);
  expect(frame).toContain("18.4k in · 912 out · Enter run · PgUp/PgDn scroll");
  expect(frame).toContain("Task 1 · Read package.json in this directory");
  expect(frame).toContain("claude-code/sonnet");
});

test("the view lays out against its own box inside a larger terminal", async () => {
  const ui = await mount(
    <box height={24} width={100}>
      {view(threads.done)}
    </box>,
    { height: 40, width: 140 }
  );
  const lines = ui.captureCharFrame().split("\n");

  expect(lines.slice(24).join("").trim()).toBe("");
  expect(Math.max(...lines.map((line) => line.trimEnd().length))).toBe(100);
});
