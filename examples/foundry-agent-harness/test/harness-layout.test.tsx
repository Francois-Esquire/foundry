import { afterEach, expect, test } from "vitest";
import type { SideTab } from "../src/components/blocks/side-panel";
import { HarnessLayout } from "../src/components/layouts/harness";
import type { Size } from "../src/model/screen";
import type { Thread } from "../src/model/thread";
import { clock, context, threads } from "../stories/fixtures/threads";
import { frameWith, mount, unmount } from "./helpers/render";

const SHORTENED_HEADER = /Foundry Agent Harness · .*… · claude-code\/sonnet$/;
const DEFAULT_SIZE = { height: 32, width: 120 };

const ignore = () => undefined;

function layout(
  thread: Thread,
  {
    activeTab = "todos",
    draft = "",
    size = DEFAULT_SIZE,
  }: { activeTab?: SideTab; draft?: string; size?: Size } = {}
) {
  return mount(
    <HarnessLayout
      activeTab={activeTab}
      clock={clock}
      context={context}
      draft={draft}
      onDraft={ignore}
      onResize={ignore}
      onSubmit={ignore}
      size={size}
      thread={thread}
    />,
    size
  );
}

afterEach(unmount);

test("an idle thread invites a goal and shows nothing in the panel", async () => {
  const frame = (await layout(threads.idle)).captureCharFrame();

  expect(frame).toContain("Give the harness a goal. It will:");
  expect(frame).toContain("To-dos 0/0");
  expect(frame).toContain("No to-dos yet.");
  expect(frame).toContain("New thread · claude-code/sonnet");
  expect(frame).toContain("0 in · 0 out");
  expect(frame).toContain("Give the harness a goal");
});

test("a draft shows in the goal field", async () => {
  const frame = (
    await layout(threads.idle, { draft: "list the files" })
  ).captureCharFrame();

  expect(frame).toContain("› list the files");
});

test("a planning thread says so in the panel and the goal field", async () => {
  const frame = (await layout(threads.planning)).captureCharFrame();

  expect(frame).toContain("⠸ Planning the goal into to-dos");
  expect(frame).toContain("Working. The next goal can go in");
});

test("a working thread shows its to-dos, tool calls and the reply so far", async () => {
  const frame = (await layout(threads.working)).captureCharFrame();

  expect(frame).toContain("To-dos 1/4");
  expect(frame).toContain("✓ Read package.json in this directory");
  expect(frame).toContain("⠸ Identify the scripts");
  expect(frame).toContain("○ Write the run instructions");
  expect(frame).toContain("added by the worker");
  expect(frame).toContain("Task 1 · Read package.json in this directory");
  expect(frame).toContain("Read package.json");
  expect(frame).toContain("Task 2 · Identify the scripts");
  expect(frame).toContain("⠸ Bash (4.2s) bun run --help");
});

test("a failed thread shows the tool's error and why the harness stopped", async () => {
  const frame = await frameWith(
    await layout(threads.failed),
    "Claude Code stopped before the turn finished."
  );

  expect(frame).toContain("✗ Read package.json in this directory");
  expect(frame).toContain("File does not exist.");
  expect(frame).toContain("The harness stopped");
  expect(frame).toContain("Claude Code stopped before the turn finished.");
});

test("each tab shows its own list", async () => {
  expect(
    (await layout(threads.done, { activeTab: "notes" })).captureCharFrame()
  ).toContain("version 3f9a1c2e · 1 kept");
  expect(
    (await layout(threads.done, { activeTab: "skills" })).captureCharFrame()
  ).toContain("◆ task-notes");
  expect(
    (await layout(threads.done, { activeTab: "mcp" })).captureCharFrame()
  ).toContain("› add_todo");
});

test("an 80 by 24 screen keeps the panel and gives up the title", async () => {
  const frame = (
    await layout(threads.working, { size: { height: 24, width: 80 } })
  ).captureCharFrame();
  const [header = ""] = frame.split("\n");

  expect(frame).toContain("To-dos 1/4");
  expect(frame).toContain("Tab panel");
  expect(header.trimEnd().endsWith("Foundry Agent Harness")).toBe(true);
  expect(frame.trimEnd().split("\n")).toHaveLength(24);
});

test("a title too long for the header ends with an ellipsis", async () => {
  const frame = (
    await layout(threads.working, { size: { height: 24, width: 110 } })
  ).captureCharFrame();
  const [header = ""] = frame.split("\n");

  expect(header.trimEnd()).toMatch(SHORTENED_HEADER);
  expect(header.trimEnd()).toHaveLength(109);
});

test("a narrow screen drops the panel and keeps the conversation", async () => {
  const frame = await frameWith(
    await layout(threads.done, { size: { height: 24, width: 60 } }),
    "bun run start"
  );

  expect(frame).not.toContain("To-dos");
  expect(frame.trimEnd().split("\n")).toHaveLength(24);
  expect(frame).toContain("18.4k in · 912 out · Enter run · PgUp/PgDn scroll");
  expect(frame).toContain("Task 1 · Read package.json in this directory");
  expect(frame).toContain("claude-code/sonnet");
});
