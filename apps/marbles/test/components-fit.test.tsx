import { act } from "react";
import { afterEach, expect, test } from "vitest";
import {
  DefinitionsBlock,
  type TriggerRow,
  TriggersBlock,
} from "../src/components/blocks/catalog";
import { CatalogPanels } from "../src/components/blocks/catalog-panels";
import { PromptBar } from "../src/components/blocks/prompt-bar";
import { QuitDialog } from "../src/components/blocks/quit-dialog";
import { KeyValue } from "../src/components/ui/key-value";
import { Log } from "../src/components/ui/log";
import { Panel } from "../src/components/ui/panel";
import { flush, mount, unmount } from "./helpers/render";

afterEach(unmount);

const ignore = () => undefined;
const TOP_BORDER = /^╭─+╮$/;
const BOTTOM_BORDER = /^╰─+╯$/;
const STEER_WITH_HINT = /^steer write › .+ {2,}Enter send · Esc cancel$/;
const FIRST_NOTICE_LINE = /^│ Quitting closes this dashboard\. +█ │$/;
const SECOND_NOTICE_LINE = /^│ Triggers keep running in the Marbles +█ │$/;

function lines(frame: string): string[] {
  return frame.split("\n").map((line) => line.trimEnd());
}

test("wrapped key-value rows keep their second line when space is short", async () => {
  const ui = await mount(
    <box flexDirection="column" height={3} width={22}>
      <KeyValue
        items={[
          { key: "Run", value: "run-103" },
          { key: "Cost", value: "no usage recorded" },
          { key: "Tokens", value: "no usage recorded" },
          { key: "Steps", value: "1" },
        ]}
      />
    </box>,
    { height: 8, width: 40 }
  );
  const rows = lines(ui.captureCharFrame());
  expect(rows.slice(0, 6)).toEqual([
    "Run     : run-103",
    "Cost    : no usage",
    "          recorded",
    "Tokens  : no usage",
    "          recorded",
    "Steps   : 1",
  ]);
});

test("an empty log shows only its empty message", async () => {
  const ui = await mount(<Log entries={[]} focused={false} />, {
    height: 6,
    width: 60,
  });
  const frame = ui.captureCharFrame();
  expect(frame).toContain("No logs recorded.");
  expect(frame).not.toContain("0–0/0");
  expect(frame).not.toContain("f follow");
});

test("the quit dialog fits a container shorter than the terminal", async () => {
  const ui = await mount(
    <box flexDirection="column" height={10} width={60}>
      <QuitDialog onCancel={ignore} onConfirm={ignore} />
    </box>,
    { height: 40, width: 80 }
  );
  const rows = lines(ui.captureCharFrame());
  expect(rows[0]).toMatch(TOP_BORDER);
  expect(rows[1]).toContain("Quit Marbles?");
  expect(rows[7]).toContain("[ Keep open ]  [ Quit ]");
  expect(rows[9]).toMatch(BOTTOM_BORDER);
  expect(rows.slice(10).join("").trim()).toBe("");
});

test("a panel keeps its selection in view when only its height shrinks", async () => {
  const steps = Array.from({ length: 20 }, (_, index) => `step-${index + 1}`);
  const ui = await mount(
    <box flexDirection="column" height="100%" width="100%">
      <Panel selectedId="row:step-16" title="Steps">
        {steps.map((step) => (
          <box id={`row:${step}`} key={step}>
            <text>{step}</text>
          </box>
        ))}
      </Panel>
    </box>,
    { height: 30, width: 40 }
  );
  expect(ui.captureCharFrame()).toContain("step-16");
  await act(async () => {
    ui.resize(40, 8);
  });
  await flush(ui);
  expect(ui.captureCharFrame()).toContain("step-16");
  expect(ui.captureCharFrame()).not.toContain("step-1 ");
});

const triggers: TriggerRow<string>[] = [
  "update-docs",
  "review-code",
  "daily-summary",
].map((name) => ({
  detail: "",
  id: `trigger:${name}`,
  key: name,
  kind: "monitor",
  name,
  selected: name === "daily-summary",
  selection: name,
  status: { label: "waiting", tone: "neutral" },
}));

test("short catalog panels scroll the selected trigger into view", async () => {
  const ui = await mount(
    <box flexDirection="column" height={10} width={60}>
      <CatalogPanels
        catalog={
          <DefinitionsBlock
            active={false}
            items={[]}
            onSelect={ignore}
            workspace="foundry"
          />
        }
        triggers={
          <TriggersBlock
            active
            items={triggers}
            onSelect={ignore}
            selectedId="trigger:daily-summary"
          />
        }
      />
    </box>,
    { height: 20, width: 60 }
  );
  expect(ui.captureCharFrame()).toContain("› [monitor] daily-summary");
});

test("a prompt bar with a draft keeps its label and whole hint", async () => {
  const ui = await mount(
    <PromptBar
      draft="Keep the existing examples and only add relink."
      focused
      kind="steer"
      onInput={ignore}
      onSubmit={ignore}
      stepId="write"
    />,
    { height: 3, width: 78 }
  );
  const [row] = lines(ui.captureCharFrame());
  expect(row).toMatch(STEER_WITH_HINT);
});

test("a narrow prompt bar drops the hint and the optional note before the step", async () => {
  const ui = await mount(
    <PromptBar
      draft="Skip the changelog"
      focused
      kind="resume"
      onInput={ignore}
      onSubmit={ignore}
      stepId="update.write-changes"
    />,
    { height: 3, width: 58 }
  );
  const [row] = lines(ui.captureCharFrame());
  expect(row).toBe("resume update.write-changes › Skip the changelog");
});

test("dialog body text wraps clear of the scrollbar", async () => {
  const ui = await mount(
    <box flexDirection="column" height={14} width={44}>
      <QuitDialog hosted onCancel={ignore} onConfirm={ignore} />
    </box>,
    { height: 14, width: 44 }
  );
  const rows = lines(ui.captureCharFrame());
  expect(rows[3]).toMatch(FIRST_NOTICE_LINE);
  expect(rows[4]).toMatch(SECOND_NOTICE_LINE);
});

test("a panel title longer than the panel is shortened, not dropped", async () => {
  const ui = await mount(
    <box flexDirection="column" height={3} width={41}>
      <Panel title="2 Marbles · workflows & steps in foundry">
        <text>x</text>
      </Panel>
    </box>,
    { height: 6, width: 60 }
  );
  const [top] = lines(ui.captureCharFrame());
  expect(top).toBe("╭─2 Marbles · workflows & steps in fou…─╮");
});
