import type { ChannelMessage } from "@foundry/workflows/channels";
import { RGBA } from "@opentui/core";
import { act } from "react";
import { afterEach, expect, test } from "vitest";
import { theme } from "../src/components/ui/theme";
import type { DashboardSnapshot } from "../src/tui/state/dashboard-model";
import { selectionKey } from "../src/tui/state/dashboard-model";
import type { RunActions } from "../src/tui/state/run-actions";
import { DashboardView } from "../src/tui/views/dashboard";
import { dashboardSnapshot } from "../stories/fixtures/snapshot";
import {
  click,
  flush,
  frameWith,
  mount,
  press,
  unmount,
} from "./helpers/render";

const SELECTED_FAILURE = /› ▸ check-api +failed\b/;
const WRITE_STEP = /Step\s+: write/;
const WORKSPACE_PICKER_BORDER = /╭─Workspaces/g;

function close() {
  // Quitting is covered in dashboard-quit.test.tsx.
}

afterEach(unmount);

function recordingActions() {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return Promise.resolve();
    };
  const actions: RunActions = {
    cancel: record("cancel"),
    pause: record("pause"),
    resume: record("resume"),
    send: record("send"),
  };
  return { actions, calls };
}

function render(snapshot: DashboardSnapshot, actions?: RunActions) {
  return mount(
    <DashboardView actions={actions} onClose={close} snapshot={snapshot} />
  );
}

const STEER_WRITE =
  "steer write · #work-w agent claude-code/claude-sonnet-5-5 · session session- ›";

test.each(["approval", "question"] as const)(
  "shows live %s attention in run and step details while keeping pause, steer and cancel enabled",
  async (attention) => {
    const { actions, calls } = recordingActions();
    const attentive: DashboardSnapshot = {
      ...dashboardSnapshot,
      runs: dashboardSnapshot.runs.map((run) =>
        run.id === "run-104"
          ? {
              ...run,
              attention,
              steps: run.steps.map((step) =>
                step.id === "update"
                  ? {
                      ...step,
                      attention,
                      children: step.children.map((child) =>
                        child.id === "write" ? { ...child, attention } : child
                      ),
                    }
                  : step
              ),
            }
          : run
      ),
    };
    const label =
      attention === "approval" ? "Waiting for approval" : "Waiting for answer";
    const ui = await render(attentive, actions);
    expect(ui.captureCharFrame()).toContain(label);
    await press(ui, "RETURN");
    expect(ui.captureCharFrame()).toContain(label);
    await press(ui, "ESCAPE");
    await press(ui, "a");
    await press(ui, "RETURN");
    expect(ui.captureCharFrame()).toMatch(WRITE_STEP);
    expect(ui.captureCharFrame()).toContain(label);
    await act(async () => ui.mockInput.pressKey("p"));
    await flush(ui);
    expect(calls).toEqual([["pause", "run-104", "write"]]);
    await act(async () => ui.mockInput.pressKey("s"));
    await flush(ui);
    expect(ui.captureCharFrame()).toContain(STEER_WRITE);
    await act(async () =>
      ui.mockInput.typeText("summarize the pending action")
    );
    await act(async () => ui.mockInput.pressEnter());
    await flush(ui);
    expect(calls.at(-1)).toEqual([
      "send",
      "run-104",
      "write",
      { target: "work-write", text: "summarize the pending action" },
    ]);
    await act(async () => ui.mockInput.pressKey("k"));
    await flush(ui);
    expect(calls.at(-1)).toEqual(["cancel", "run-104"]);
    expect(attentive.runs[0]?.status).toBe("running");
  }
);

test("attention uses the warning badge colour", async () => {
  const attentive: DashboardSnapshot = {
    ...dashboardSnapshot,
    runs: dashboardSnapshot.runs.map((run) =>
      run.id === "run-104" ? { ...run, attention: "approval" } : run
    ),
  };
  const ui = await render(attentive);
  const span = ui
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((item) => item.text.includes("Waiting for approval"));
  expect(span?.bg.toInts()).toEqual(
    RGBA.fromHex(theme.colors.warning).toInts()
  );
});

test("run keys pause, steer, and cancel the selected step", async () => {
  const { actions, calls } = recordingActions();
  const ui = await render(dashboardSnapshot, actions);
  expect(ui.captureCharFrame()).toContain("s steer · p pause · k cancel");
  await act(async () => ui.mockInput.pressKey("p"));
  await flush(ui);
  expect(calls).toEqual([["pause", "run-104", "docs"]]);

  await act(async () => ui.mockInput.pressKey("s"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain(STEER_WRITE);
  await act(async () => ui.mockInput.typeText("stop and summarise"));
  await flush(ui);
  expect(ui.captureCharFrame()).not.toContain("Quit Marbles?");
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(calls.at(-1)).toEqual([
    "send",
    "run-104",
    "write",
    { target: "work-write", text: "stop and summarise" },
  ]);

  await act(async () => ui.mockInput.pressKey("s"));
  await act(async () => ui.mockInput.typeText("nothing"));
  await act(async () => ui.mockInput.pressEscape());
  await flush(ui);
  expect(ui.captureCharFrame()).not.toContain(STEER_WRITE);
  await act(async () => ui.mockInput.pressKey("k"));
  await flush(ui);
  expect(calls.at(-1)).toEqual(["cancel", "run-104"]);
});

test("a command live in a step takes a typed line, apart from steering its agent", async () => {
  const { actions, calls } = recordingActions();
  const command = {
    command: "npm test",
    id: "work-test",
    input: "stdin",
    kind: "command",
    stepId: "write",
  } as const;
  const both: DashboardSnapshot = {
    ...dashboardSnapshot,
    runs: dashboardSnapshot.runs.map((run) =>
      run.id === "run-104"
        ? {
            ...run,
            steps: run.steps.map((step) => ({
              ...step,
              children: step.children.map((child) =>
                child.id === "write"
                  ? { ...child, work: [...(child.work ?? []), command] }
                  : child
              ),
            })),
          }
        : run
    ),
  };
  const ui = await render(both, actions);
  expect(ui.captureCharFrame()).toContain("s interact");
  await act(async () => ui.mockInput.pressKey("s"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain(STEER_WRITE);
  await act(async () => ui.mockInput.pressTab());
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("input write · #work-t $ npm test ›");
  await act(async () => ui.mockInput.typeText("y"));
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(calls.at(-1)).toEqual([
    "send",
    "run-104",
    "write",
    { target: "work-test", text: "y" },
  ]);
});

test("a step names its live agent, the input it waits for, and opens that question in the Feed", async () => {
  const waiting: DashboardSnapshot = {
    ...dashboardSnapshot,
    runs: dashboardSnapshot.runs.map((run) =>
      run.id === "run-104"
        ? {
            ...run,
            steps: run.steps.map((step) => ({
              ...step,
              children: step.children.map((child) =>
                child.id === "write"
                  ? {
                      ...child,
                      attention: "question" as const,
                      awaiting: ["feed-merge"],
                      work: (child.work ?? []).map((work) => ({
                        ...work,
                        attention: "question" as const,
                      })),
                    }
                  : child
              ),
            })),
          }
        : run
    ),
  };
  const ui = await render(waiting, recordingActions().actions);
  await press(ui, "RETURN");
  const frame = ui.captureCharFrame();
  expect(frame).toContain("Live now");
  expect(frame).toContain(
    "#work-w agent claude-code/claude-sonnet-5-5 · session session-"
  );
  expect(frame).toContain("Waiting for answer · i answer");
  await press(ui, "i");
  expect(ui.captureCharFrame()).toContain("Merge the docs update?");
  expect(ui.captureCharFrame()).toContain("reader");
});

test("a settled run offers no controls and its keys do nothing", async () => {
  const { actions, calls } = recordingActions();
  const ui = await render(dashboardSnapshot, actions);
  await press(ui, "ARROW_DOWN");
  await press(ui, "ARROW_DOWN");
  await press(ui, "ARROW_DOWN");
  await press(ui, "ARROW_DOWN");
  await press(ui, "ARROW_DOWN");
  const frame = ui.captureCharFrame();
  expect(frame).toMatch(SELECTED_FAILURE);
  expect(frame).not.toContain("s steer");
  expect(frame).not.toContain("p pause");
  expect(frame).not.toContain("k cancel");
  await press(ui, "p");
  await press(ui, "s");
  await press(ui, "k");
  expect(calls).toEqual([]);
});

test("a run control failure shows its message without an Error prefix", async () => {
  const { actions } = recordingActions();
  actions.pause = () => Promise.reject(new Error("Step is not running here"));
  const ui = await render(dashboardSnapshot, actions);
  await press(ui, "p");
  expect(ui.captureCharFrame()).toContain("Step is not running here");
  expect(ui.captureCharFrame()).not.toContain("Error: Step");
});

test("a steer keeps its prompt and draft until it has been sent", async () => {
  const { actions, calls } = recordingActions();
  let release: () => void = () => undefined;
  actions.pause = (runId, stepId) => {
    calls.push(["pause", runId, stepId]);
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  actions.send = (runId, stepId, input) => {
    calls.push(["send", runId, stepId, input]);
    return Promise.reject(new Error("Step is not listening"));
  };
  const ui = await render(dashboardSnapshot, actions);
  await press(ui, "p");
  await press(ui, "s");
  await act(async () => ui.mockInput.typeText("keep this"));
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(calls).toEqual([["pause", "run-104", "docs"]]);
  expect(ui.captureCharFrame()).toContain(STEER_WRITE);
  expect(ui.captureCharFrame()).toContain("keep this");
  await act(async () => release());
  await flush(ui);
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(calls.at(-1)).toEqual([
    "send",
    "run-104",
    "write",
    { target: "work-write", text: "keep this" },
  ]);
  const frame = ui.captureCharFrame();
  expect(frame).toContain("Step is not listening");
  expect(frame).toContain(STEER_WRITE);
  expect(frame).toContain("keep this");
});

test("header, tab, and footer clicks wait while a prompt is open", async () => {
  const { actions, calls } = recordingActions();
  const chosen: string[] = [];
  const choose = (id: string) => {
    chosen.push(id);
  };
  const ui = await mount(
    <DashboardView
      actions={actions}
      hosted={{
        state: "ready",
        workspaces: [
          {
            config: null,
            id: "foundry",
            root: "/Users/someone/code/alpha/foundry",
            state: "ready",
          },
          {
            config: null,
            id: "spyglass",
            root: "/Users/someone/code/beta/foundry",
            state: "ready",
          },
        ],
      }}
      onClose={close}
      onSwitchWorkspace={choose}
      snapshot={{ ...dashboardSnapshot, mode: "live", workspaceId: "foundry" }}
    />
  );
  await press(ui, "s");
  await act(async () => ui.mockInput.typeText("go on"));
  await flush(ui);
  const before = ui.captureCharFrame();
  for (const id of [
    "nav:workspaces",
    "view:settings",
    "view:logs",
    "view:catalog",
    "view:feed",
  ]) {
    await click(ui, id);
    expect(ui.captureCharFrame()).toBe(before);
  }
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(chosen).toEqual([]);
  expect(calls).toEqual([
    ["send", "run-104", "write", { target: "work-write", text: "go on" }],
  ]);
  expect(ui.captureCharFrame().match(WORKSPACE_PICKER_BORDER)).toBeNull();
});

test("details buttons wait while a prompt is open", async () => {
  const { actions, calls } = recordingActions();
  const rolled: string[] = [];
  const roll = (id: string) => {
    rolled.push(id);
    return Promise.resolve();
  };
  const ui = await mount(
    <DashboardView
      actions={actions}
      onClose={close}
      onRollSchedule={roll}
      snapshot={dashboardSnapshot}
    />
  );
  await press(ui, "s");
  await act(async () => ui.mockInput.typeText("go on"));
  await flush(ui);
  const lines = ui.captureCharFrame().split("\n");
  const row = lines.findIndex((line) => line.includes("Up next"));
  const column = lines[row]?.indexOf("Up next") ?? -1;
  await act(async () => {
    await ui.mockMouse.click(column + 1, row);
  });
  await flush(ui);
  expect(ui.renderer.root.findDescendantById("schedule:run")).toBeDefined();
  await click(ui, "schedule:run");
  expect(rolled).toEqual([]);
  expect(calls).toEqual([]);
  expect(ui.captureCharFrame()).toContain(STEER_WRITE);
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(calls).toEqual([
    ["send", "run-104", "write", { target: "work-write", text: "go on" }],
  ]);
});

test("a paused step resumes with an optional prompt", async () => {
  const { actions, calls } = recordingActions();
  const paused = {
    ...dashboardSnapshot,
    runs: dashboardSnapshot.runs.map((run) =>
      run.id === "run-104"
        ? {
            ...run,
            status: "suspended" as const,
            steps: run.steps.map((step) =>
              step.id === "find"
                ? { ...step, status: "suspended" as const }
                : step
            ),
          }
        : run
    ),
  };
  const ui = await render(paused, actions);
  expect(ui.captureCharFrame()).toContain("p resume · k cancel");
  expect(ui.captureCharFrame()).not.toContain("s steer");
  await act(async () => ui.mockInput.pressKey("p"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("resume docs · prompt optional ›");
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(calls).toEqual([["resume", "run-104", "docs", undefined]]);
  await act(async () => ui.mockInput.pressKey("p"));
  await act(async () => ui.mockInput.typeText("focus on the tests"));
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(calls.at(-1)).toEqual([
    "resume",
    "run-104",
    "docs",
    "focus on the tests",
  ]);
  const bare = await render(paused);
  expect(bare.captureCharFrame()).not.toContain("p resume");
});

test.each([
  { status: "running", stoppable: true, supported: true },
  { status: "running", stoppable: false, supported: false },
  { status: "complete", stoppable: false, supported: true },
  { status: "unknown", stoppable: false, supported: true },
] as const)(
  "native activity controls stop only the selected supported child ($status, $supported)",
  async ({ supported, status, stoppable }) => {
    const { actions, calls } = recordingActions();
    actions.stopActivity = async (...args) => {
      calls.push(["stopActivity", ...args]);
    };
    const activeRun = dashboardSnapshot.runs.find(
      (run) => run.id === "run-104"
    );
    if (!activeRun) {
      throw new Error("Missing active fixture");
    }
    const snapshot: DashboardSnapshot = {
      ...dashboardSnapshot,
      runs: [
        {
          ...activeRun,
          activities: [
            {
              actions: supported ? ["stop"] : [],
              agentId: "coder",
              harness: "claude-code",
              id: "child",
              kind: "task",
              lifetime: "sandbox",
              revision: 1,
              sessionId: "child-session",
              status,
              title: "Background test run",
            },
          ],
        },
      ],
    };
    const ui = await render(snapshot, actions);
    const frame = ui.captureCharFrame();
    expect(frame).toContain("task: Background test run");
    expect(frame).not.toContain("[step] task:");
    await click(
      ui,
      selectionKey({
        activityId: "child",
        id: "run-104",
        kind: "run",
        sessionId: "child-session",
      })
    );
    expect(ui.captureCharFrame()).toContain("Background test run");
    expect(ui.captureCharFrame()).not.toContain("s steer");
    expect(ui.captureCharFrame().includes("k stop activity")).toBe(stoppable);
    await press(ui, "p");
    await press(ui, "s");
    expect(calls).toEqual([]);
    await press(ui, "k");
    expect(calls).toEqual(
      stoppable ? [["stopActivity", "child-session", "child"]] : []
    );
  }
);

test.each(["running", "paused"] as const)(
  "managed trigger %s offers pause/resume and delete controls",
  async (status) => {
    const { actions, calls } = recordingActions();
    actions.setTriggerEnabled = async (...args) => {
      calls.push(["setTriggerEnabled", ...args]);
    };
    actions.deleteTrigger = async (...args) => {
      calls.push(["deleteTrigger", ...args]);
    };
    const snapshot: DashboardSnapshot = {
      ...dashboardSnapshot,
      triggers: [
        {
          description: "Scheduled agent work",
          id: "managed-trigger",
          kind: "schedule",
          lifetime: "durable",
          managed: true,
          name: "Daily checks",
          owner: "coder",
          status,
          targetId: "agent-task",
        },
      ],
    };
    const ui = await render(snapshot, actions);
    await press(ui, "1");
    await click(ui, "trigger:managed-trigger");
    const frame = ui.captureCharFrame();
    expect(frame).toContain(status === "paused" ? "p resume" : "p pause");
    expect(frame).toContain("k delete trigger");
    await press(ui, "p");
    await press(ui, "k");
    expect(calls).toEqual([
      ["setTriggerEnabled", "managed-trigger", status === "paused"],
      ["deleteTrigger", "managed-trigger"],
    ]);
  }
);

function textChunk(path: readonly string[], text: string): ChannelMessage {
  return {
    _tag: "chunk",
    chunk: {
      at: "2026-09-22T14:32:09.000Z",
      path,
      payload: { kind: "text", text },
      stepId: path.join("."),
    },
  };
}

function streamingActions() {
  const opened: string[] = [];
  const pushes: ((message: ChannelMessage) => void)[] = [];
  let aborted = 0;
  const stream: RunActions["stream"] = (runId, signal) => {
    opened.push(runId);
    signal?.addEventListener("abort", () => {
      aborted += 1;
    });
    return new ReadableStream<ChannelMessage>({
      start(controller) {
        pushes.push((message) => controller.enqueue(message));
      },
    });
  };
  return {
    aborted: () => aborted,
    actions: { ...recordingActions().actions, stream },
    opened,
    push: (message: ChannelMessage) => pushes.at(-1)?.(message),
  };
}

test("the stream tab opens the run's live stream only while it is shown", async () => {
  const live = streamingActions();
  const ui = await render(dashboardSnapshot, live.actions);
  await click(ui, selectionKey({ id: "run-104", kind: "run" }));
  await click(ui, "tab:overview");
  expect(live.opened).toEqual([]);
  await click(ui, "tab:stream");
  expect(live.opened).toEqual(["run-104"]);
  const waiting = await frameWith(ui, "Waiting for output");
  expect(waiting).toContain("Waiting for output");
  expect(waiting).toContain("Live · last 12 lines");
  await act(async () => live.push(textChunk(["update"], "drafting docs")));
  expect(await frameWith(ui, "drafting docs")).toContain("drafting docs");
  await click(ui, "tab:overview");
  expect(live.aborted()).toBe(1);
  expect(ui.captureCharFrame()).not.toContain("drafting docs");
});
