import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { dashboardSnapshot } from "../preview/snapshot";
import type { FeedAnswer } from "../src/lib/feed/entry";
import { DashboardView } from "../src/views/dashboard";
import type { DashboardSnapshot } from "../src/views/dashboard-model";
import { flush, frameWith, mount, unmount } from "./helpers/render";

let closed = false;
function close() {
  closed = true;
}

afterEach(unmount);

test("switches tabs with Shift+D / Shift+F and filters the feed by workspace", async () => {
  const ui = await mount(
    <DashboardView onClose={close} snapshot={dashboardSnapshot} />
  );
  let frame = ui.captureCharFrame();
  expect(frame).toContain("Dashboard  3");
  expect(frame).toContain("Feed  4");

  await act(async () => ui.mockInput.pressKey("F"));
  frame = await frameWith(ui, "The docs workflow rewrote");
  // Only the open question carries the pending marker.
  expect(frame).toContain("› ! Merge the docs update?");
  expect(frame).not.toContain("! Codebase summary");
  for (const label of [
    "Feed · All workspaces",
    "needs input · foundry · 14:33",
    "Codebase summary",
    "Docs updated",
    "Workspace set up: foundry",
    "Needs your input",
    "1 merge",
    "2 hold",
    "entries · ↑↓ select · Enter read",
    "w workspace · x all",
    "? help · q / Ctrl+C quit",
  ]) {
    expect(frame).toContain(label);
  }

  await act(async () => ui.mockInput.pressKey("w"));
  await flush(ui);
  frame = ui.captureCharFrame();
  expect(frame).toContain("Feed · This workspace · foundry");
  expect(frame).not.toContain("Docs updated");

  await act(async () => ui.mockInput.pressArrow("down"));
  await act(async () => ui.mockInput.pressEnter());
  frame = await frameWith(ui, "Marbles is a local runner");
  expect(frame).toContain("Entry · ↑↓ scroll · Esc entries");
  expect(frame).toContain("reader · ↑↓ scroll · Esc entries");
  expect(frame).toContain("media/walkthrough.mp4");

  await act(async () => ui.mockInput.pressKey("D"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("3 Runs");
});

test("answers an open question from the feed with a number key", async () => {
  const answers: [string, FeedAnswer][] = [];
  const answer = (id: string, value: FeedAnswer) => {
    answers.push([id, value]);
    return Promise.resolve();
  };
  const ui = await mount(
    <DashboardView
      onAnswer={answer}
      onClose={close}
      snapshot={dashboardSnapshot}
    />
  );
  await act(async () => ui.mockInput.pressKey("F"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("1-2 answer");
  await act(async () => ui.mockInput.pressKey("2"));
  await flush(ui);
  expect(answers).toEqual([["feed-merge", "hold"]]);
});

test("a failed answer stays with its entry and clears on the next try", async () => {
  let calls = 0;
  const answer = () => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error("Run is gone"))
      : Promise.resolve();
  };
  const ui = await mount(
    <DashboardView
      onAnswer={answer}
      onClose={close}
      snapshot={dashboardSnapshot}
    />
  );
  await act(async () => ui.mockInput.pressKey("F"));
  await act(async () => ui.mockInput.pressKey("1"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("Run is gone");
  expect(ui.captureCharFrame()).not.toContain("Error: Run is gone");
  await act(async () => ui.mockInput.pressArrow("down"));
  await flush(ui);
  expect(ui.captureCharFrame()).not.toContain("Run is gone");
  await act(async () => ui.mockInput.pressArrow("up"));
  await act(async () => ui.mockInput.pressKey("1"));
  await flush(ui);
  expect(calls).toBe(2);
  expect(ui.captureCharFrame()).not.toContain("Run is gone");
});

test("an approval takes an optional note after the choice", async () => {
  const answers: FeedAnswer[] = [];
  const approval = {
    ...dashboardSnapshot.feed[0],
    id: "feed-release",
    input: {
      choices: ["approve", "reject"],
      mode: "approval" as const,
      status: "open" as const,
    },
    title: "Release v2?",
  } as DashboardSnapshot["feed"][number];
  const answer = (_id: string, value: FeedAnswer) => {
    answers.push(value);
    return Promise.resolve();
  };
  const ui = await mount(
    <DashboardView
      onAnswer={answer}
      onClose={close}
      snapshot={{ ...dashboardSnapshot, feed: [approval] }}
    />
  );
  await act(async () => ui.mockInput.pressKey("F"));
  await act(async () => ui.mockInput.pressKey("1"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("approve · note");
  expect(answers).toEqual([]);
  await act(async () => ui.mockInput.typeText("ship after the docs land"));
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(answers).toEqual([
    { choice: "approve", note: "ship after the docs land" },
  ]);

  // Esc drops the held choice; a second number key with an empty note sends
  // the bare choice.
  await act(async () => ui.mockInput.pressKey("2"));
  await act(async () => ui.mockInput.pressEscape());
  await act(async () => ui.mockInput.pressKey("2"));
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(answers).toEqual([
    { choice: "approve", note: "ship after the docs land" },
    { choice: "reject" },
  ]);
});

test("types a free-text answer without triggering dashboard keys", async () => {
  const answers: FeedAnswer[] = [];
  const question = {
    ...dashboardSnapshot.feed[0],
    id: "feed-note",
    input: { choices: [], status: "open" as const },
    title: "Anything to add?",
  } as DashboardSnapshot["feed"][number];
  const answer = (_id: string, value: FeedAnswer) => {
    answers.push(value);
    return Promise.resolve();
  };
  const ui = await mount(
    <DashboardView
      onAnswer={answer}
      onClose={close}
      snapshot={{ ...dashboardSnapshot, feed: [question] }}
    />
  );
  await act(async () => ui.mockInput.pressKey("F"));
  await act(async () => ui.mockInput.pressKey("a"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("Enter send · Esc cancel");
  await act(async () => ui.mockInput.typeText("quite a lot"));
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(answers).toEqual(["quite a lot"]);
  expect(ui.captureCharFrame()).not.toContain("Quit Marbles?");
  expect(closed).toBe(false);
});
