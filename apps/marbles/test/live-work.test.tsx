import { Sessions } from "@foundry/agents/session";
import { InMemorySessionStore } from "@foundry/agents/store/memory";
import type { RunRecord } from "@foundry/workflows/schema";
import { act } from "react";
import { afterEach, expect, test } from "vitest";
import type { FeedAnswer } from "~/lib/feed/entry";
import type { FeedEntrySnapshot } from "~/lib/feed/read";
import { RunScope } from "~/lib/run-scope";
import type { LiveWork } from "~/lib/step-work";
import { DashboardView } from "~/views/dashboard";
import type { DashboardSnapshot } from "~/views/dashboard-model";
import type { RunActions } from "~/views/run-actions";
import { questionOwners } from "~/workspace/live-work";
import { dashboardSnapshot } from "~/workspace/snapshot";
import { flush, mount, press, unmount } from "./helpers/render";

afterEach(unmount);

function close() {
  // Quitting is covered in dashboard-quit.test.tsx.
}

const record: RunRecord = {
  error: null,
  extensions: {},
  id: "run-live",
  input: null,
  metadata: {
    workflow: {
      steps: {
        review: {
          attempt: 1,
          name: "Review",
          namespace: "",
          status: "running",
        },
      },
    },
  },
  output: null,
  queueId: "queue",
  snapshot: {
    cursor: null,
    input: null,
    name: "Review",
    steps: [{ children: [], index: 0, key: "review", name: "Review" }],
  },
  status: "running",
  step: "review",
  tags: {},
  timestamps: {
    completedAt: null,
    createdAt: 100,
    failedAt: null,
    startedAt: 100,
  },
};

const question: FeedEntrySnapshot = {
  body: "Which branch should the helper rebase onto?",
  definition: "review",
  id: "input-child",
  input: {
    choices: ["main", "next"],
    delivery: "live",
    mode: "question",
    sessionId: "child-a",
    status: "open",
  },
  kind: "input",
  media: [],
  posted: "now",
  postedAt: new Date(100).toISOString(),
  run: record.id,
  step: "review",
  title: "Rebase onto?",
  workspace: { id: "workspace", name: "workspace" },
};

function snapshotOf(
  work: readonly LiveWork[],
  extra: Partial<Parameters<typeof dashboardSnapshot>[1]> = {}
): DashboardSnapshot {
  return dashboardSnapshot([record], {
    definitions: [],
    feed: [],
    lastFinish: new Map(),
    live: new Map([[record.id, work]]),
    monitors: new Map(),
    now: 200,
    root: "/workspace",
    schedules: [],
    startedAt: 100,
    status: "Ready",
    workspaceId: "workspace",
    ...extra,
  });
}

function recordingActions() {
  const calls: unknown[][] = [];
  const recorder =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return Promise.resolve();
    };
  const actions: RunActions = {
    cancel: recorder("cancel"),
    pause: recorder("pause"),
    resume: recorder("resume"),
    send: recorder("send"),
  };
  return { actions, calls };
}

function lineWith(frame: string, text: string): string {
  return frame.split("\n").find((line) => line.includes(text)) ?? "";
}

test("two turns of the same agent and model in one step each carry their own identifier, in the list and in the prompt", async () => {
  const twin = (id: string, sessionId: string): LiveWork => ({
    agent: "reviewer",
    id,
    input: "steer",
    kind: "agent",
    model: "claude-sonnet-5-5",
    provider: "claude-code",
    sessionId,
    stepId: "review",
  });
  const first = twin("3f2a9c10-0000-4000-8000-000000000001", "session-1111");
  const second = twin("8be71d42-0000-4000-8000-000000000002", "session-2222");
  const { actions, calls } = recordingActions();
  const ui = await mount(
    <DashboardView
      actions={actions}
      onClose={close}
      snapshot={snapshotOf([first, second])}
    />,
    { width: 200 }
  );
  await press(ui, "RETURN");
  const listed = ui.captureCharFrame();
  expect(lineWith(listed, "#3f2a9c")).toContain(
    "#3f2a9c agent reviewer claude-code/claude-sonnet-5-5 · session session-"
  );
  expect(lineWith(listed, "#8be71d")).toContain(
    "#8be71d agent reviewer claude-code/claude-sonnet-5-5 · session session-"
  );

  await press(ui, "s");
  expect(lineWith(ui.captureCharFrame(), "steer review")).toContain(
    "steer review · #3f2a9c agent reviewer"
  );
  await act(async () => ui.mockInput.pressTab());
  await flush(ui);
  expect(lineWith(ui.captureCharFrame(), "steer review")).toContain(
    "steer review · #8be71d agent reviewer"
  );
  await act(async () => ui.mockInput.typeText("wrap up"));
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(calls.at(-1)).toEqual([
    "send",
    record.id,
    "review",
    { target: second.id, text: "wrap up" },
  ]);
});

test("a question from a child session waits on the turn that delegated it, not on the other turn in the step, and is answered from there", async () => {
  const store = new InMemorySessionStore();
  const sessions = new Sessions({ store });
  await sessions.createSession({ id: "run-session" });
  for (const parent of ["parent-a", "parent-b"]) {
    await sessions.createSession({
      id: parent,
      parentSessionId: "run-session",
    });
  }
  await sessions.createSession({ id: "child-a", parentSessionId: "parent-a" });
  const scope = new RunScope(record.id, "/workspace");
  const frame = scope.frame(["review"]);
  for (const sessionId of ["parent-a", "parent-b"]) {
    frame.work.begin({ kind: "agent", sessionId, steer: () => undefined });
  }
  const live = new Map([[record.id, scope.work()]]);
  const feed = [question];

  const snapshot = snapshotOf(scope.work(), {
    feed,
    live,
    questionOwners: await questionOwners(store, feed, live),
  });
  const [step] = snapshot.runs[0]?.steps ?? [];
  expect(step?.awaiting).toEqual([question.id]);
  expect(
    step?.work?.map((work) =>
      work.kind === "agent" ? [work.sessionId, work.attention] : []
    )
  ).toEqual([
    ["parent-a", "question"],
    ["parent-b", undefined],
  ]);

  const answers: [string, FeedAnswer][] = [];
  const answer = (id: string, value: FeedAnswer) => {
    answers.push([id, value]);
    return Promise.resolve();
  };
  const ui = await mount(
    <DashboardView
      actions={recordingActions().actions}
      onAnswer={answer}
      onClose={close}
      snapshot={snapshot}
    />,
    { width: 200 }
  );
  await press(ui, "RETURN");
  const frameText = ui.captureCharFrame();
  expect(lineWith(frameText, "session parent-a")).toContain("i answer");
  expect(lineWith(frameText, "session parent-b")).toContain("s steer");
  await press(ui, "i");
  expect(ui.captureCharFrame()).toContain("Rebase onto?");
  await press(ui, "2");
  expect(answers).toEqual([[question.id, "next"]]);
});
