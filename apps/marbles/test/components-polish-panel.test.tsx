import { useKeyboard } from "@opentui/react";
import { act, useState } from "react";
import { afterEach, expect, test } from "vitest";
import { settingsView } from "../src/cli/theme";
import { SettingsBlock } from "../src/components/blocks/settings-panel";
import { cellWidth } from "../src/components/ui/cells";
import { Panel } from "../src/components/ui/panel";
import {
  flush,
  frameWith,
  mount,
  press,
  type Rendered,
  unmount,
} from "./helpers/render";

afterEach(unmount);

const ignore = () => undefined;
const BORDER = /^[╭│╰]/;
const BOTTOM_BORDER = /^╰─+╯$/;
const SCROLLBAR = /[█▀▄]/;
const THUMB = /[█▀▄]/gu;
const settings = settingsView({
  path: "~/.foundry/marbles/settings.json",
  theme: "dark",
});
const rows = Array.from({ length: 20 }, (_, index) => `row-${index + 1}`);
const paragraph =
  "Workspace usage is estimated from every recorded turn, and partial totals say which turns were not priced.";

async function settle(ui: Rendered) {
  for (let frame = 0; frame < 4; frame += 1) {
    await flush(ui);
  }
}

function lines(frame: string): string[] {
  return frame.split("\n").map((line) => line.trimEnd());
}

function Settings() {
  return (
    <box flexDirection="column" height="100%" width="100%">
      <SettingsBlock
        onRail={ignore}
        onTheme={ignore}
        rail
        settings={settings}
      />
    </box>
  );
}

function Shrinking() {
  const [height, setHeight] = useState(22);
  useKeyboard((key) => {
    if (key.name === "s") {
      setHeight(10);
    }
  });
  return (
    <box flexDirection="column" height={height} width={44}>
      <SettingsBlock
        onRail={ignore}
        onTheme={ignore}
        rail
        settings={settings}
      />
    </box>
  );
}

function pinnedRows(frame: string): string {
  const drawn = lines(frame.replace(THUMB, " "));
  return drawn[1]?.includes("Theme:") ? drawn.join("\n") : "scrolled";
}

function textBesideScrollbar(frame: string): string[] {
  return lines(frame).filter((line) => {
    const chars = [...line];
    const bar = chars.at(-2) ?? "";
    const before = chars.at(-3) ?? "";
    return SCROLLBAR.test(bar) && before !== " ";
  });
}

function Toggle({ text }: { readonly text: string }) {
  const [count, setCount] = useState(0);
  useKeyboard((key) => {
    if (key.name === "t") {
      setCount((previous) => (previous === 0 ? rows.length : 0));
    }
  });
  return (
    <Panel title="Rows">
      <text>{text}</text>
      {rows.slice(0, count).map((row) => (
        <text key={row}>{row}</text>
      ))}
    </Panel>
  );
}

test("a short settings panel draws nothing below its border", async () => {
  const ui = await mount(
    <box flexDirection="column" height={10} width={44}>
      <SettingsBlock
        onRail={ignore}
        onTheme={ignore}
        rail
        settings={settings}
      />
    </box>,
    { height: 14, width: 46 }
  );
  for (let frame = 0; frame < 4; frame += 1) {
    const drawn = lines(ui.captureCharFrame());
    expect(drawn[9]).toMatch(BOTTOM_BORDER);
    expect(drawn.slice(0, 10).every((line) => BORDER.test(line))).toBe(true);
    expect(drawn.slice(10).join("").trim()).toBe("");
    await flush(ui);
  }
  const drawn = lines(await frameWith(ui, "› Dark"));
  expect(drawn.slice(1, 9).some((line) => line.includes("› Dark"))).toBe(true);
});

test("a settings panel resized a row at a time matches a fresh one", async () => {
  for (const width of [44, 24]) {
    const fresh: string[] = [];
    for (let height = 10; height <= 22; height += 1) {
      const ui = await mount(<Settings />, { height, width });
      await settle(ui);
      fresh.push(pinnedRows(ui.captureCharFrame()));
    }
    const ui = await mount(<Settings />, { height: 10, width });
    await settle(ui);
    for (let height = 10; height <= 22; height += 1) {
      await act(async () => {
        ui.resize(width, height);
      });
      await settle(ui);
      expect(pinnedRows(ui.captureCharFrame())).toBe(fresh[height - 10]);
    }
  }
}, 30_000);

test("a settings panel shrunk from tall keeps inside its border", async () => {
  const ui = await mount(<Shrinking />, { height: 26, width: 46 });
  await settle(ui);
  await press(ui, "s");
  await settle(ui);
  const drawn = lines(await frameWith(ui, "› Dark"));
  expect(drawn[9]).toMatch(BOTTOM_BORDER);
  expect(drawn.slice(10).join("").trim()).toBe("");
  expect(drawn.slice(1, 9).some((line) => line.includes("› Dark"))).toBe(true);
});

test("a border hint longer than the panel is shortened, not dropped", async () => {
  const hint = " Enter open · Esc back ";
  const bottom = async (width: number) => {
    const ui = await mount(
      <box flexDirection="column" height={4} width={width}>
        <Panel active borderHint={hint} title="Marbles">
          <text>x</text>
        </Panel>
      </box>,
      { height: 4, width }
    );
    return lines(ui.captureCharFrame())[3];
  };
  expect(await bottom(18)).toBe("╰─ Enter open… ──╯");
  expect(await bottom(27)).toBe("╰─ Enter open · Esc back ─╯");
  expect(await bottom(40)).toBe(`╰─${hint}${"─".repeat(14)}╯`);
  expect(await bottom(9)).toBe("╰───────╯");
});

test("scrolling text keeps a column clear of the scrollbar", async () => {
  for (const width of [12, 30, 42]) {
    const ui = await mount(
      <box flexDirection="column" height={10} width={width}>
        <Panel active scrollable title="Usage">
          <text>{paragraph}</text>
          <text>{paragraph}</text>
          {rows.map((row) => (
            <text key={row}>{row}</text>
          ))}
        </Panel>
      </box>,
      { height: 10, width }
    );
    const frame = ui.captureCharFrame();
    expect(frame).toMatch(SCROLLBAR);
    expect(textBesideScrollbar(frame)).toEqual([]);
  }
});

test("a panel's text width returns when its scrollbar goes away", async () => {
  const full = "x".repeat(16);
  const ui = await mount(
    <box flexDirection="column" height={8} width={20}>
      <Toggle text={full} />
    </box>,
    { height: 8, width: 20 }
  );
  const still = lines(ui.captureCharFrame());
  expect(still[1]).toBe(`│ ${full} │`);
  await press(ui, "t");
  const scrolling = ui.captureCharFrame();
  expect(scrolling).toMatch(SCROLLBAR);
  expect(textBesideScrollbar(scrolling)).toEqual([]);
  await press(ui, "t");
  expect(lines(ui.captureCharFrame())).toEqual(still);
});

function ShrinkingHeader() {
  const [tall, setTall] = useState(true);
  useKeyboard((key) => {
    if (key.name === "h") {
      setTall(false);
    }
  });
  const header = (
    <box flexDirection="column">
      {(tall ? rows.slice(0, 9) : ["only-header"]).map((row) => (
        <text key={row}>{`head ${row}`}</text>
      ))}
    </box>
  );
  return (
    <box flexDirection="column" height={10} width={44}>
      <Panel header={header} selectedId="row-20" title="Rows">
        {rows.map((row) => (
          <text id={row} key={row}>
            {row}
          </text>
        ))}
      </Panel>
    </box>
  );
}

test("a header that shrinks while scrolled away is pinned again", async () => {
  const ui = await mount(<ShrinkingHeader />, { height: 12, width: 46 });
  await settle(ui);
  expect(ui.captureCharFrame()).not.toContain("head row-1");
  await press(ui, "h");
  await settle(ui);
  const drawn = lines(ui.captureCharFrame());
  expect(drawn[1]).toContain("head only-header");
  expect(drawn.join("\n")).toContain("row-20");
});

test("a wide-character title is shortened by cells, not dropped", async () => {
  const ui = await mount(
    <box flexDirection="column" height={6} width={30}>
      <Panel title={"界".repeat(30)}>
        <text>body</text>
      </Panel>
    </box>,
    { height: 8, width: 32 }
  );
  await settle(ui);
  const top = lines(ui.captureCharFrame())[0] ?? "";
  expect(top).toContain("界界");
  expect(top).toContain("…");
  expect(cellWidth(top)).toBe(30);
});

const wrappingHeader = Array.from({ length: 20 }, () => "word").join(" ");
let headerRenders = 0;

function CountedHeader() {
  headerRenders += 1;
  return <text wrapMode="word">{wrappingHeader}</text>;
}

function WrappingHeader({
  size,
}: {
  readonly size: readonly [number, number];
}) {
  return (
    <box flexDirection="column" height={size[1]} width={size[0]}>
      <Panel header={<CountedHeader />} selectedId="row-20" title="Rows">
        {rows.map((row) => (
          <text id={row} key={row}>
            {row}
          </text>
        ))}
      </Panel>
    </box>
  );
}

test("a header that wraps taller beside the scrollbar settles", async () => {
  for (const size of [
    [18, 6],
    [23, 9],
    [28, 8],
    [38, 5],
    [43, 7],
  ] as const) {
    const ui = await mount(<WrappingHeader size={size} />, {
      height: 20,
      width: 50,
    });
    await settle(ui);
    await settle(ui);
    headerRenders = 0;
    await settle(ui);
    await settle(ui);
    expect(headerRenders, size.join("x")).toBe(0);
    expect(ui.captureCharFrame(), size.join("x")).toContain("row-20");
  }
}, 30_000);
