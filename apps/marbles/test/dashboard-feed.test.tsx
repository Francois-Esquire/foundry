import { act, useState } from "react";
import { afterEach, expect, test } from "vitest";
import type { FeedAnswer } from "../src/lib/feed/entry";
import type { DashboardSnapshot } from "../src/tui/state/dashboard-model";
import { feedKey } from "../src/tui/state/feed-model";
import { DashboardView } from "../src/tui/views/dashboard";
import { dashboardSnapshot } from "../stories/fixtures/snapshot";
import {
  click,
  ctrlC,
  flush,
  frameWith,
  mount,
  unmount,
} from "./helpers/render";

let closed = false;
function close() {
  closed = true;
}

afterEach(unmount);

test("switches tabs with Shift+D / Shift+F and filters the feed by workspace", async () => {
  const snapshot: DashboardSnapshot = {
    ...dashboardSnapshot,
    feed: dashboardSnapshot.feed.map((entry) =>
      entry.id === "feed-docs"
        ? { ...entry, workspace: { id: "ws-docs", name: "docs" } }
        : entry
    ),
  };
  const ui = await mount(<DashboardView onClose={close} snapshot={snapshot} />);
  let frame = ui.captureCharFrame();
  expect(frame).toContain("Dashboard");
  expect(frame).toContain("Feed");

  await act(async () => ui.mockInput.pressKey("F"));
  frame = await frameWith(ui, "The docs workflow rewrote");
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
    "Enter read",
    "? help · q / Ctrl+C quit",
  ]) {
    expect(frame).toContain(label);
  }

  await act(async () => ui.mockInput.pressKey("w"));
  await flush(ui);
  frame = ui.captureCharFrame();
  expect(frame).toContain("Feed · This workspace · foundry");
  expect(frame).toContain("Codebase summary");
  expect(frame).not.toContain("Docs updated");

  await act(async () => ui.mockInput.pressArrow("down"));
  await act(async () => ui.mockInput.pressEnter());
  frame = await frameWith(ui, "Marbles is a local runner");
  expect(frame).toContain("Entry · ↑↓ scroll · Esc entries");
  expect(frame).toContain("↑↓ scroll · Esc entries");
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

test("shows a question shared from another workspace, and answers it only there", async () => {
  const answers: [string, FeedAnswer][] = [];
  const answer = (id: string, value: FeedAnswer) => {
    answers.push([id, value]);
    return Promise.resolve();
  };
  const snapshot: DashboardSnapshot = {
    ...dashboardSnapshot,
    feed: dashboardSnapshot.feed.map((entry) =>
      entry.id === "feed-merge"
        ? {
            ...entry,
            workspace: { id: "ws-docs", name: "docs" },
            workspaces: ["ws-docs", "ws-foundry"],
          }
        : entry
    ),
  };
  const ui = await mount(
    <DashboardView onAnswer={answer} onClose={close} snapshot={snapshot} />
  );
  await act(async () => ui.mockInput.pressKey("F"));
  await act(async () => ui.mockInput.pressKey("w"));
  await flush(ui);
  const frame = ui.captureCharFrame();
  expect(frame).toContain("Feed · This workspace · foundry");
  expect(frame).toContain("Merge the docs update?");
  expect(frame).not.toContain("1-2 answer");
  await act(async () => ui.mockInput.pressKey("2"));
  await flush(ui);
  expect(answers).toEqual([]);
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

type FeedEntry = DashboardSnapshot["feed"][number];

function openQuestion(
  id: string,
  title: string,
  input: FeedEntry["input"] = { choices: [], status: "open" }
): FeedEntry {
  return { ...dashboardSnapshot.feed[0], id, input, title } as FeedEntry;
}

let post: ((entry: FeedEntry) => void) | undefined;

function FeedHost({
  feed,
  onAnswer,
}: {
  readonly feed: readonly FeedEntry[];
  readonly onAnswer: (id: string, value: FeedAnswer) => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>({
    ...dashboardSnapshot,
    feed: [...feed],
  });
  post = (entry) =>
    setSnapshot((previous) => ({
      ...previous,
      feed: [entry, ...previous.feed],
    }));
  return (
    <DashboardView onAnswer={onAnswer} onClose={close} snapshot={snapshot} />
  );
}

function recordAnswers() {
  const answers: [string, FeedAnswer][] = [];
  const onAnswer = (id: string, value: FeedAnswer) => {
    answers.push([id, value]);
    return Promise.resolve();
  };
  return { answers, onAnswer };
}

test("a draft stays with its question when a newer question arrives", async () => {
  const { answers, onAnswer } = recordAnswers();
  const first = openQuestion("feed-first", "First question?");
  const ui = await mount(<FeedHost feed={[first]} onAnswer={onAnswer} />);
  await act(async () => ui.mockInput.pressKey("F"));
  await act(async () => ui.mockInput.pressKey("a"));
  await act(async () => ui.mockInput.typeText("for the first"));
  await flush(ui);
  await act(async () => post?.(openQuestion("feed-later", "Later question?")));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("Later question?");
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(answers).toEqual([["feed-first", "for the first"]]);
});

test("an approval choice stays with its question when a newer question arrives", async () => {
  const { answers, onAnswer } = recordAnswers();
  const approval = {
    choices: ["approve", "reject"],
    mode: "approval" as const,
    status: "open" as const,
  };
  const first = openQuestion("feed-first", "Release v2?", approval);
  const ui = await mount(<FeedHost feed={[first]} onAnswer={onAnswer} />);
  await act(async () => ui.mockInput.pressKey("F"));
  await act(async () => ui.mockInput.pressKey("1"));
  await flush(ui);
  await act(async () =>
    post?.(openQuestion("feed-later", "Release v3?", approval))
  );
  await flush(ui);
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(answers).toEqual([["feed-first", { choice: "approve" }]]);
});

test("choosing another entry while typing drops the draft instead of sending it there", async () => {
  const { answers, onAnswer } = recordAnswers();
  const first = openQuestion("feed-first", "First question?");
  const second = openQuestion("feed-second", "Second question?");
  const ui = await mount(
    <FeedHost feed={[first, second]} onAnswer={onAnswer} />
  );
  await act(async () => ui.mockInput.pressKey("F"));
  await act(async () => ui.mockInput.pressKey("a"));
  await act(async () => ui.mockInput.typeText("for the first"));
  await flush(ui);
  await click(ui, `feed:${feedKey(second)}`);
  const frame = ui.captureCharFrame();
  expect(frame).not.toContain("for the first");
  expect(frame).not.toContain("Enter send · Esc cancel");
  await act(async () => ui.mockInput.pressKey("a"));
  await act(async () => ui.mockInput.typeText("fresh"));
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(answers).toEqual([["feed-second", "fresh"]]);
});

test("the answer keeps its keys after Keep open on the quit dialog", async () => {
  const { answers, onAnswer } = recordAnswers();
  const question = openQuestion("feed-note", "Anything to add?");
  const ui = await mount(<FeedHost feed={[question]} onAnswer={onAnswer} />);
  await act(async () => ui.mockInput.pressKey("F"));
  await act(async () => ui.mockInput.pressKey("a"));
  await act(async () => ui.mockInput.typeText("quite"));
  await flush(ui);
  await ctrlC(ui);
  expect(ui.captureCharFrame()).toContain("Quit Marbles?");
  await click(ui, "dialog:cancel");
  await act(async () => ui.mockInput.typeText(" a lot"));
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(answers).toEqual([["feed-note", "quite a lot"]]);
  expect(closed).toBe(false);
});

test("the Feed list shows the command table's hints, answer included", async () => {
  const { onAnswer } = recordAnswers();
  const question = openQuestion("feed-note", "Anything to add?");
  const ui = await mount(<FeedHost feed={[question]} onAnswer={onAnswer} />, {
    height: 40,
    width: 160,
  });
  await act(async () => ui.mockInput.pressKey("F"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain(
    "entries · Enter read · ↑↓ select · a answer"
  );
});
