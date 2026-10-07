import { afterEach, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { act } from "react";
import { dashboardSnapshot } from "../preview/snapshot";
import { theme } from "../src/components/ui/theme";
import { DashboardView } from "../src/views/dashboard";
import type { DashboardSnapshot } from "../src/views/dashboard-model";
import type { RunActions } from "../src/views/run-actions";
import { click, flush, mount, press, unmount } from "./helpers/render";

const WRITE_STEP = /Step\s+: write/;

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
    steer: record("steer"),
  };
  return { actions, calls };
}

function render(snapshot: DashboardSnapshot, actions?: RunActions) {
  return mount(
    <DashboardView actions={actions} onClose={close} snapshot={snapshot} />
  );
}

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
    expect(ui.captureCharFrame()).toContain("steer write ›");
    await act(async () =>
      ui.mockInput.typeText("summarize the pending action")
    );
    await act(async () => ui.mockInput.pressEnter());
    await flush(ui);
    expect(calls.at(-1)).toEqual([
      "steer",
      "run-104",
      "write",
      "summarize the pending action",
    ]);
    await act(async () => ui.mockInput.pressKey("k"));
    await flush(ui);
    expect(calls.at(-1)).toEqual(["cancel", "run-104"]);
    expect(attentive.runs[0]?.status).toBe("running");
  }
);

test("attention reads in the warning colour, not the grey of other statuses", async () => {
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
  expect(span?.fg.toInts()).toEqual(
    RGBA.fromHex(theme.colors.warning).toInts()
  );
});

test("run keys pause, steer, and cancel the selected step", async () => {
  const { actions, calls } = recordingActions();
  const ui = await render(dashboardSnapshot, actions);
  // The running run is selected first; its root frame, keyed by the
  // definition's name, is the target.
  expect(ui.captureCharFrame()).toContain("s steer · p pause · k cancel");
  await act(async () => ui.mockInput.pressKey("p"));
  await flush(ui);
  expect(calls).toEqual([["pause", "run-104", "docs"]]);

  // Steer opens a prompt; typing does not reach the dashboard keys.
  await act(async () => ui.mockInput.pressKey("s"));
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("steer docs ›");
  await act(async () => ui.mockInput.typeText("stop and summarise"));
  await flush(ui);
  expect(ui.captureCharFrame()).not.toContain("Quit Marbles?");
  await act(async () => ui.mockInput.pressEnter());
  await flush(ui);
  expect(calls.at(-1)).toEqual([
    "steer",
    "run-104",
    "docs",
    "stop and summarise",
  ]);

  // Esc drops a prompt without sending anything.
  await act(async () => ui.mockInput.pressKey("s"));
  await act(async () => ui.mockInput.typeText("nothing"));
  await act(async () => ui.mockInput.pressEscape());
  await flush(ui);
  expect(ui.captureCharFrame()).not.toContain("steer docs ›");
  await act(async () => ui.mockInput.pressKey("k"));
  await flush(ui);
  expect(calls.at(-1)).toEqual(["cancel", "run-104"]);
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
  expect(frame).toContain("› ▸ check-api failed");
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
  // Without actions the keys and the footer hint are absent.
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
    await click(ui, 'run:run-104:activity:["child-session","child"]');
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
