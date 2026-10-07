import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { ArgumentForm } from "../src/components/blocks/argument-form";
import type { SetupDraft } from "../src/onboarding/templates";
import { DashboardView } from "../src/views/dashboard";
import type { DashboardSnapshot } from "../src/views/dashboard-model";
import { OnboardingView } from "../src/views/onboarding";

let ui: Awaited<ReturnType<typeof testRender>>;
afterEach(async () => {
  await act(async () => ui?.renderer.destroy());
});
async function flush() {
  await act(async () => ui.flush());
  await act(async () => ui.flush());
}
async function key(value: string) {
  await act(async () => {
    if (value === "up" || value === "down") {
      ui.mockInput.pressArrow(value);
    } else if (value === "enter") {
      ui.mockInput.pressEnter();
    } else if (value === "escape") {
      ui.mockInput.pressEscape();
    } else {
      ui.mockInput.pressKey(value);
    }
  });
  await flush();
}
async function click(id: string) {
  const target = ui.renderer.root.findDescendantById(id);
  if (!target) {
    throw new Error(`Missing ${id}`);
  }
  await act(async () => ui.mockMouse.click(target.x, target.y));
  await flush();
}
const empty: DashboardSnapshot = {
  definitions: [],
  feed: [],
  mode: "snapshot",
  runs: [],
  status: "Ready",
  triggers: [],
  workspace: "test",
};
const noop = () => undefined;

test("setup reviews the selected step, retains settings on back, and reports write failures", async () => {
  const drafts: SetupDraft[] = [];
  const failCreate = (draft: SetupDraft) => {
    drafts.push(draft);
    return Promise.reject(new Error("Config already exists"));
  };
  ui = await testRender(
    <OnboardingView
      onClose={noop}
      onCreate={failCreate}
      onSkip={noop}
      path="/workspace/marbles.config.ts"
    />,
    { exitOnCtrlC: false, height: 40, kittyKeyboard: true, width: 90 }
  );
  await flush();
  expect(ui.captureCharFrame()).toContain("Product");
  await click("setup:next");
  await click("form:submit");
  expect(ui.captureCharFrame()).toContain("summarizeCodebase");
  expect(drafts).toHaveLength(0);
  await click("setup:back");
  expect(ui.captureCharFrame()).toContain("summarize-codebase");
  await click("form:submit");
  await click("setup:create");
  expect(drafts).toHaveLength(1);
  expect(drafts[0]?.template).toBe("product");
  expect(ui.captureCharFrame()).toContain("Config already exists");
});

test("setup supports keyboard selection, skip, and Ctrl+C confirmation", async () => {
  let skipped = 0;
  let closed = 0;
  const close = () => {
    closed += 1;
  };
  const skip = () => {
    skipped += 1;
  };
  const create = () => Promise.resolve();
  ui = await testRender(
    <OnboardingView
      onClose={close}
      onCreate={create}
      onSkip={skip}
      path="marbles.config.ts"
    />,
    { exitOnCtrlC: false, height: 24, kittyKeyboard: true, width: 65 }
  );
  await flush();
  await key("up");
  expect(ui.captureCharFrame()).toContain("Choose a starter · Design");
  await act(async () => ui.mockInput.pressCtrlC());
  await flush();
  expect(ui.captureCharFrame()).toContain("Quit Marbles?");
  await act(async () => ui.mockInput.pressCtrlC());
  await flush();
  expect(closed).toBe(1);
  expect(skipped).toBe(0);
});

test("a no-argument catalog launch starts once, returns home and clears filters", async () => {
  let launched = 0;
  let accept: (id: string) => void = noop;
  const launch = () => {
    launched += 1;
    return new Promise<string>((resolve) => {
      accept = resolve;
    });
  };
  ui = await testRender(
    <DashboardView
      onClose={noop}
      onLaunch={launch}
      snapshot={{
        ...empty,
        definitions: [
          {
            description: "Summary",
            id: "summary",
            input: { fields: [] },
            kind: "workflow",
            name: "summary",
          },
        ],
      }}
    />,
    { exitOnCtrlC: false, height: 35, kittyKeyboard: true, width: 100 }
  );
  await flush();
  await key("2");
  await key("f");
  expect(ui.captureCharFrame()).toContain("Run filter:");
  await key("2");
  await key("enter");
  await click("catalog:launch");
  await key("l");
  expect(launched).toBe(1);
  await act(async () => accept("manual-1"));
  await flush();
  expect(ui.captureCharFrame()).toContain("3 Runs");
  expect(ui.captureCharFrame()).not.toContain("Details");
  expect(ui.captureCharFrame()).not.toContain("Run filter:");
});

test("unknown arguments explain the missing contract and never dispatch", async () => {
  let launched = false;
  const launch = () => {
    launched = true;
    return Promise.resolve("bad");
  };
  ui = await testRender(
    <DashboardView
      onClose={noop}
      onLaunch={launch}
      snapshot={{
        ...empty,
        definitions: [
          {
            description: "Legacy",
            id: "unknown",
            kind: "workflow",
            name: "unknown",
          },
        ],
      }}
    />,
    { exitOnCtrlC: false, height: 30, kittyKeyboard: true, width: 100 }
  );
  await flush();
  await key("2");
  await key("l");
  expect(ui.captureCharFrame()).toContain("Arguments are not declared");
  expect(launched).toBe(false);
  await key("escape");
  expect(ui.captureCharFrame()).toContain("2 Marbles");
});

test("forms validate fields, keep false and zero, and isolate input shortcuts", async () => {
  let submitted: unknown;
  const submit = (value: unknown) => {
    submitted = value;
  };
  ui = await testRender(
    <ArgumentForm
      fields={[
        { label: "Name", name: "name", required: true, type: "text" },
        {
          default: "one\ntwo",
          label: "Notes",
          name: "notes",
          type: "multiline",
        },
        { default: 0, label: "Count", name: "count", type: "number" },
        { default: false, label: "Enabled", name: "enabled", type: "boolean" },
        {
          default: "fast",
          label: "Mode",
          name: "mode",
          options: [{ label: "Fast", value: "fast" }],
          type: "select",
        },
      ]}
      onCancel={noop}
      onSubmit={submit}
    />,
    { exitOnCtrlC: false, height: 35, kittyKeyboard: true, width: 80 }
  );
  await flush();
  await click("form:submit");
  expect(ui.captureCharFrame()).toContain("Name is required");
  await act(async () => ui.mockInput.typeText("quiet"));
  await flush();
  await click("form:submit");
  expect(submitted).toEqual({
    count: 0,
    enabled: false,
    mode: "fast",
    name: "quiet",
    notes: "one\ntwo",
  });
});

test("launch errors preserve typed arguments and pending submissions cannot duplicate a run", async () => {
  let calls = 0;
  let received: unknown;
  let accept: (id: string) => void = noop;
  const launch = (_name: string, input: unknown) => {
    calls += 1;
    received = input;
    if (calls === 1) {
      return Promise.reject(new Error("Executor unavailable"));
    }
    return new Promise<string>((resolve) => {
      accept = resolve;
    });
  };
  ui = await testRender(
    <DashboardView
      onClose={noop}
      onLaunch={launch}
      snapshot={{
        ...empty,
        definitions: [
          {
            description: "Test launch",
            id: "task",
            input: {
              fields: [
                {
                  label: "Message",
                  name: "message",
                  required: true,
                  type: "text",
                },
              ],
            },
            kind: "workflow",
            name: "Task",
          },
        ],
      }}
    />,
    { exitOnCtrlC: false, height: 25, kittyKeyboard: true, width: 80 }
  );
  await flush();
  await key("2");
  await key("l");
  await act(async () => ui.mockInput.typeText("quiet home"));
  await flush();
  expect(ui.captureCharFrame()).toContain("Launch Task");
  await click("form:submit");
  expect(ui.captureCharFrame()).toContain("Executor unavailable");
  expect(ui.captureCharFrame()).toContain("quiet home");
  await click("form:submit");
  await click("form:submit");
  expect(calls).toBe(2);
  expect(received).toEqual({ message: "quiet home" });
  await act(async () => accept("accepted"));
  await flush();
  expect(ui.captureCharFrame()).toContain("3 Runs");
});

test("short setup forms scroll keyboard focus to their submit action", async () => {
  const create = () => Promise.resolve();
  ui = await testRender(
    <OnboardingView
      onClose={noop}
      onCreate={create}
      onSkip={noop}
      path="marbles.config.ts"
    />,
    { exitOnCtrlC: false, height: 18, kittyKeyboard: true, width: 55 }
  );
  await flush();
  await key("enter");
  await act(async () => {
    ui.mockInput.pressTab();
  });
  await flush();
  await act(async () => {
    ui.mockInput.pressTab();
  });
  await flush();
  await act(async () => {
    ui.mockInput.pressTab();
  });
  await flush();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  await flush();
  const submit = ui.renderer.root.findDescendantById("form:submit");
  expect(submit).toBeDefined();
  expect(submit?.y).toBeLessThan(17);
  await key("enter");
  expect(ui.captureCharFrame()).toContain("summarizeCodebase");
});
