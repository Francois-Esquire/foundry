import { useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import { afterEach, expect, test } from "vitest";
import {
  DefinitionsBlock,
  TriggersBlock,
} from "../src/components/blocks/catalog";
import { CatalogPanels } from "../src/components/blocks/catalog-panels";
import { QuitDialog } from "../src/components/blocks/quit-dialog";
import { Dialog } from "../src/components/ui/dialog";
import { Text } from "../src/components/ui/text";
import { definitionItems, triggerItems } from "../stories/blocks/fixtures-a";
import { flush, mount, press, unmount } from "./helpers/render";

afterEach(unmount);

const ignore = () => undefined;
const HINT = "Tab choose · Enter select · Esc back · Ctrl+C quit";
const TOP_BORDER = /╭─+╮/;
const BOTTOM_BORDER = /╰─+╯/;
const BUTTONS = "[ Keep open ]  [ Quit ]";
const FULL_WIDTH_LINE = /^│ Running steps are cancelled\. Runs waiting on │$/;
const SPLIT_HEIGHTS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 23, 24, 33, 40];
const selectedTrigger = triggerItems.find((item) => item.selected)?.id;

function lines(frame: string): string[] {
  return frame.split("\n").map((line) => line.trimEnd());
}

function dialogRows(frame: string): string[] {
  const rows = lines(frame);
  const top = rows.findIndex((row) => TOP_BORDER.test(row));
  const bottom = rows.findIndex((row) => BOTTOM_BORDER.test(row));
  return rows.slice(top, bottom + 1);
}

function quitIn(height: number, width: number, hosted = false) {
  return mount(
    <box flexDirection="column" height={height} width={width}>
      <QuitDialog hosted={hosted} onCancel={ignore} onConfirm={ignore} />
    </box>,
    { height, width }
  );
}

function panels(height: number, above = 0) {
  return (
    <box flexDirection="column" height={height + above} width={60}>
      {above > 0 && (
        <box flexShrink={0} height={above}>
          <text>above</text>
        </box>
      )}
      <CatalogPanels
        catalog={
          <DefinitionsBlock
            active={false}
            items={definitionItems}
            onSelect={ignore}
            workspace="foundry"
          />
        }
        triggers={
          <TriggersBlock
            active
            items={triggerItems}
            onSelect={ignore}
            selectedId={selectedTrigger}
          />
        }
      />
    </box>
  );
}

function triggerRows(frame: string, above: number): string[] {
  const rows = lines(frame).slice(above);
  return rows.slice(0, rows.findIndex((row) => row.startsWith("╰")) + 1);
}

test("a dialog with a one-line body is only as tall as its content", async () => {
  const ui = await mount(
    <Dialog onCancel={ignore} onConfirm={ignore} title="Save changes?">
      <Text>Your edits to nightly-digest will be written to disk.</Text>
    </Dialog>,
    { height: 22, width: 80 }
  );
  const rows = dialogRows(ui.captureCharFrame());
  expect(rows).toHaveLength(7);
  expect(rows[1]).toContain("Save changes?");
  expect(rows[3]).toContain("Your edits to nightly-digest");
  expect(rows[5]).toContain("[ Cancel ]  [ OK ]");
});

test("a long dialog body stays at eighteen rows and scrolls to its end", async () => {
  const paragraphs = Array.from(
    { length: 8 },
    (_, index) => `Paragraph ${index + 1} of the long body.`
  );
  const ui = await mount(
    <Dialog onCancel={ignore} onConfirm={ignore} title="Reset?">
      {paragraphs.map((paragraph) => (
        <Text key={paragraph}>{paragraph}</Text>
      ))}
    </Dialog>,
    { height: 22, width: 80 }
  );
  expect(dialogRows(ui.captureCharFrame())).toHaveLength(18);
  expect(ui.captureCharFrame()).not.toContain("Paragraph 8");
  for (const _ of paragraphs) {
    await press(ui, "ARROW_DOWN");
  }
  expect(ui.captureCharFrame()).toContain("Paragraph 8 of the long body.");
  expect(dialogRows(ui.captureCharFrame())).toHaveLength(18);
});

test("a hint that does not fit is left out whole and the buttons stay", async () => {
  const ui = await quitIn(8, 48);
  const frame = ui.captureCharFrame();
  expect(frame).toContain(BUTTONS);
  expect(frame).not.toContain("Tab choose");
  expect(frame).not.toContain("Ctrl+C quit");
  expect(dialogRows(frame)).toHaveLength(8);
});

test("a wrapped hint shows both its lines once there is room", async () => {
  const rows = dialogRows((await quitIn(10, 48)).captureCharFrame());
  expect(rows).toHaveLength(10);
  expect(rows[6]).toContain(BUTTONS);
  expect(rows[7]).toContain("Tab choose · Enter select · Esc back ·");
  expect(rows[8]).toContain("Ctrl+C quit");
});

test("a one-line hint is left out before the buttons are", async () => {
  const short = (await quitIn(7, 60)).captureCharFrame();
  expect(short).toContain(BUTTONS);
  expect(short).not.toContain("Tab choose");
  const roomy = (await quitIn(8, 60)).captureCharFrame();
  expect(roomy).toContain(BUTTONS);
  expect(roomy).toContain(HINT);
});

test("the smallest dialogs drop spacing and body before the buttons", async () => {
  for (const height of [4, 5, 6]) {
    const rows = dialogRows(
      (await quitIn(height, 60, true)).captureCharFrame()
    );
    expect(rows).toHaveLength(height);
    expect(rows[1]).toContain("Quit Marbles?");
    expect(rows.at(-2)).toContain(BUTTONS);
  }
});

test("a body that does not scroll uses the full dialog width", async () => {
  const rows = lines((await quitIn(24, 48)).captureCharFrame());
  expect(rows).toContainEqual(expect.stringMatching(FULL_WIDTH_LINE));
});

test("a body that does not scroll is full width in the first frame", async () => {
  let ui: Awaited<ReturnType<typeof testRender>> | undefined;
  await act(async () => {
    ui = await testRender(
      <box flexDirection="column" height={24} width={48}>
        <QuitDialog onCancel={ignore} onConfirm={ignore} />
      </box>,
      { height: 24, width: 48 }
    );
  });
  if (!ui) {
    throw new Error("The dialog did not render.");
  }
  await ui.renderOnce();
  expect(lines(ui.captureCharFrame())).toContainEqual(
    expect.stringMatching(FULL_WIDTH_LINE)
  );
  await act(async () => {
    ui?.renderer.destroy();
  });
});

test("changing the choice leaves the dialog layout alone", async () => {
  const ui = await quitIn(12, 48);
  const before = ui.captureCharFrame();
  await press(ui, "TAB");
  expect(ui.captureCharFrame()).toBe(before);
});

test("catalog panels split the spare rows as before, two rows minimum from eight", async () => {
  for (const above of [0, 3]) {
    for (const height of SPLIT_HEIGHTS) {
      const ui = await mount(panels(height, above), {
        height: height + above,
        width: 60,
      });
      const shared = 3 + Math.floor(((height - 6) * 2) / 5);
      const expected = height === 8 ? 4 : shared;
      expect(triggerRows(ui.captureCharFrame(), above)).toHaveLength(expected);
    }
  }
});

test("catalog panels at eight and ten rows show the selected trigger", async () => {
  for (const height of [8, 10]) {
    const ui = await mount(panels(height), { height, width: 60 });
    expect(triggerRows(ui.captureCharFrame(), 0).join("\n")).toContain(
      "› [schedule] daily-summary"
    );
  }
});

function Reselecting() {
  const [selected, setSelected] = useState(selectedTrigger);
  useKeyboard((key) => {
    if (key.name === "x") {
      setSelected(triggerItems[0]?.id);
    }
  });
  return (
    <box flexDirection="column" height={10} width={60}>
      <CatalogPanels
        catalog={
          <DefinitionsBlock
            active={false}
            items={definitionItems}
            onSelect={ignore}
            workspace="foundry"
          />
        }
        triggers={
          <TriggersBlock
            active
            items={triggerItems}
            onSelect={ignore}
            selectedId={selected}
          />
        }
      />
    </box>
  );
}

test("catalog panels keep their split when the view renders again", async () => {
  const ui = await mount(<Reselecting />, { height: 10, width: 60 });
  expect(triggerRows(ui.captureCharFrame(), 0)).toHaveLength(4);
  await press(ui, "x");
  expect(triggerRows(ui.captureCharFrame(), 0)).toHaveLength(4);
});

test("the hint is whole or absent at every width", async () => {
  for (const height of [12, 30]) {
    for (let width = 28; width <= 80; width += 1) {
      const rows = dialogRows((await quitIn(height, width)).captureCharFrame());
      expect(rows.length).toBeLessThanOrEqual(Math.min(18, height));
      if (height === 12) {
        expect(rows).toHaveLength(12);
      }
      expect(rows.at(-1)).toMatch(BOTTOM_BORDER);
      expect(rows.join("\n")).toContain(BUTTONS);
      const hinted = rows.some((row) => row.includes("Tab choose"));
      if (hinted) {
        expect(rows.at(-2)).toContain("quit");
      }
    }
  }
}, 60_000);

test("a dialog comes back whole after the terminal shrinks and grows", async () => {
  const ui = await mount(
    <box flexDirection="column" height="100%" width="100%">
      <QuitDialog onCancel={ignore} onConfirm={ignore} />
    </box>,
    { height: 24, width: 48 }
  );
  const original = ui.captureCharFrame();
  await act(async () => {
    ui.resize(48, 4);
  });
  await flush(ui);
  expect(dialogRows(ui.captureCharFrame()).join("\n")).toContain(BUTTONS);
  await act(async () => {
    ui.resize(48, 24);
  });
  await flush(ui);
  expect(ui.captureCharFrame()).toBe(original);
  await act(async () => {
    ui.resize(48, 12);
  });
  await flush(ui);
  for (let step = 0; step < 12; step += 1) {
    await press(ui, "ARROW_DOWN");
  }
  expect(ui.captureCharFrame()).toContain("resume on the next launch.");
});

function OpensLater() {
  const [open, setOpen] = useState(false);
  useKeyboard((key) => {
    if (key.name === "q") {
      setOpen(true);
    }
  });
  return (
    <box flexDirection="column" height={8} width={48}>
      <text>backdrop</text>
      {open && <QuitDialog onCancel={ignore} onConfirm={ignore} />}
    </box>
  );
}

test("a dialog opened in a short container leaves the hint out in its first frame", async () => {
  let ui: Awaited<ReturnType<typeof testRender>> | undefined;
  await act(async () => {
    ui = await testRender(<OpensLater />, { height: 8, width: 48 });
  });
  if (!ui) {
    throw new Error("The view did not render.");
  }
  await ui.renderOnce();
  const rendered = ui;
  await act(async () => {
    rendered.mockInput.pressKey("q");
  });
  await rendered.renderOnce();
  const frame = rendered.captureCharFrame();
  expect(frame).toContain(BUTTONS);
  expect(frame).not.toContain("Tab choose");
  await act(async () => {
    rendered.renderer.destroy();
  });
});
