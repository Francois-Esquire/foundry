import {
  BoxRenderable,
  type CliRenderer,
  type Renderable,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { afterEach, expect, test } from "vitest";
import { EmptyState } from "../src/components/blocks/empty-state";
import { FeedList } from "../src/components/blocks/feed-list";
import { FeedMetaLine } from "../src/components/blocks/feed-meta";
import { FeedReader } from "../src/components/blocks/feed-reader";
import { UsageBreakdown } from "../src/components/blocks/operating-overview";
import { RunOverview } from "../src/components/blocks/run-overview";
import { JSONView } from "../src/components/ui/json";
import { Log } from "../src/components/ui/log";
import { Tabs } from "../src/components/ui/tabs";
import { feedItem, feedMeta } from "../src/tui/state/feed-model";
import { usageBreakdown } from "../src/tui/state/usage-format";
import {
  mediaEntry,
  pendingEntry,
  summaryEntry,
} from "../stories/blocks/fixtures-a";
import { runOverviewView } from "../stories/blocks/fixtures-b";
import { Narrow as NarrowRunOverview } from "../stories/blocks/run-overview.stories";
import { dashboardSnapshot } from "../stories/fixtures/snapshot";
import { mount, unmount } from "./helpers/render";

afterEach(unmount);

const ignore = () => undefined;
const SPACES = /\s+/;
const BORDER = /^│|│$/g;
const SEPARATOR_START = /^·/;
const TOKEN_PART = /tokens|k in|out\)/;
const INDENTED = /^ │ {3}\S/;
const CATALOG_HINTS = [
  "Add schedule() or monitor() in .foundry/marbles when you want automatic runs.",
  "Choose a starter during setup, or add a prebuilt step in .foundry/marbles.",
];

function rows(frame: string): string[] {
  return frame.split("\n").map((row) => row.trimEnd());
}

function inside(frame: string): string[] {
  return rows(frame).map((row) => row.replace(BORDER, "").trim());
}

function widths(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

async function frameOf(
  node: Parameters<typeof mount>[0],
  width: number,
  height: number
): Promise<string> {
  const ui = await mount(
    <box flexDirection="column" height={height} padding={1} width={width}>
      {node}
    </box>,
    { height, width }
  );
  return ui.captureCharFrame();
}

async function storyFrame(
  render: (renderer: CliRenderer) => Renderable | Promise<Renderable>
): Promise<string> {
  const ui = await createTestRenderer({ height: 40, width: 100 });
  try {
    const canvas = new BoxRenderable(ui.renderer, {
      height: "100%",
      width: "100%",
    });
    ui.renderer.root.add(canvas);
    canvas.add(await render(ui.renderer));
    await ui.renderOnce();
    await ui.renderOnce();
    return ui.captureCharFrame();
  } finally {
    ui.renderer.destroy();
  }
}

const levels = (["debug", "info", "warn", "error"] as const).map(
  (level, index) => ({
    id: String(index),
    level,
    message: `Message at ${level}`,
    timestamp: `09:14:0${index}`,
  })
);

test.each([24, 28, 32, 40])(
  "the log footer stays on one row at %i columns",
  async (width) => {
    const frame = rows(
      await frameOf(<Log entries={levels} focused={false} />, width, 14)
    );
    const footer = frame.findIndex((row) => row.includes("1–4/4"));
    expect(frame[footer]).toContain("1–4/4 · Paused");
    expect(frame[footer + 1]?.trim()).toBe("");
    expect(frame.some((row) => row.trim() === "scroll")).toBe(false);
    expect(frame[footer]?.trim().endsWith("·")).toBe(false);
  }
);

test("the log footer drops the scroll hint first and keeps the rest", async () => {
  const narrow = rows(
    await frameOf(<Log entries={levels} focused={false} />, 32, 14)
  );
  expect(narrow.some((row) => row.trim() === "1–4/4 · Paused · f follow")).toBe(
    true
  );
  const wide = rows(
    await frameOf(<Log entries={levels} focused={false} />, 72, 14)
  );
  expect(
    wide.some((row) => row.trim() === "1–4/4 · Paused · f follow · ↑↓ scroll")
  ).toBe(true);
});

test("wrapped tab rows sit on consecutive rows above one gap", async () => {
  const tabs = [
    "Overview",
    "Input",
    "Result",
    "Logs",
    "Usage",
    "Configuration",
  ].map((label) => ({
    content: <text>{`${label} body`}</text>,
    key: label,
    label,
  }));
  const frame = inside(
    await frameOf(
      <Tabs activeTab="Usage" onTabChange={ignore} tabs={tabs} />,
      28,
      10
    )
  );
  const first = frame.indexOf("Overview  Input  Result");
  expect(first).toBeGreaterThan(-1);
  expect(frame[first + 1]).toBe("Logs  Usage  Configuration");
  expect(frame[first + 2]).toBe("");
  expect(frame[first + 3]).toBe("Usage body");
});

test("the needs-input badge text lines up with plain labels", async () => {
  const frame = rows(
    await frameOf(
      <box flexDirection="column">
        <FeedMetaLine
          details={["foundry", "14:33"]}
          meta={feedMeta(pendingEntry)}
        />
        <FeedMetaLine
          details={["foundry", "14:31"]}
          meta={feedMeta(summaryEntry)}
        />
      </box>,
      60,
      6
    )
  );
  const badge = frame.find((row) => row.includes("needs input")) ?? "";
  const plain = frame.find((row) => row.includes("result")) ?? "";
  expect(badge.indexOf("needs input")).toBe(plain.indexOf("result"));
  expect(badge).toContain("needs input · foundry · 14:33");
});

test.each(widths(20, 40))(
  "a wrapped feed meta line never starts with a separator at %i columns",
  async (width) => {
    const frame = inside(
      await frameOf(
        <FeedMetaLine
          details={["foundry", "14:33", "run-104", "docs.merge"]}
          meta={feedMeta(pendingEntry)}
        />,
        width,
        8
      )
    );
    const shown = frame.filter((row) => row !== "");
    expect(shown.join(" ")).toBe(
      "needs input · foundry · 14:33 · run-104 · docs.merge"
    );
    for (const row of shown) {
      expect(row).not.toMatch(SEPARATOR_START);
    }
  }
);

test.each(
  widths(44, 50).flatMap((width) =>
    CATALOG_HINTS.map((hint) => [width, hint] as const)
  )
)("an empty-state path stays whole at %i columns", async (width, hint) => {
  const frame = inside(
    await frameOf(
      <EmptyState description={hint} title="Nothing here." />,
      width,
      8
    )
  );
  expect(frame.some((row) => row.includes(".foundry/marbles"))).toBe(true);
  expect(frame.some((row) => row.endsWith(".foundry/"))).toBe(false);
});

test.each([30, 36, 40])(
  "run timing values break only at spaces at %i columns",
  async (width) => {
    const run = runOverviewView("run-103");
    const frame = await frameOf(<RunOverview run={run} />, width, 30);
    const times = [run.timing?.createdAt, run.timing?.startedAt]
      .filter((ms): ms is number => ms !== undefined)
      .map((ms) => new Date(ms).toLocaleString());
    for (const time of times) {
      for (const token of time.split(SPACES)) {
        expect(frame).toContain(token);
      }
    }
  }
);

test("the narrow run overview story shows its whole error", async () => {
  const frame = await storyFrame(NarrowRunOverview.render);
  expect(frame).toContain("disconnected.");
});

test.each([36, 40, 44])(
  "wrapped usage token lines keep their indent at %i columns",
  async (width) => {
    const { usage } = dashboardSnapshot;
    if (!usage) {
      throw new Error("The snapshot has usage");
    }
    const frame = rows(
      await frameOf(
        <UsageBreakdown active={false} usage={usageBreakdown(usage)} />,
        width,
        30
      )
    );
    const tokenRows = frame.filter((row) => TOKEN_PART.test(row));
    expect(tokenRows.length).toBeGreaterThanOrEqual(5);
    for (const row of tokenRows) {
      expect(row).toMatch(INDENTED);
    }
  }
);

test("media are listed on consecutive rows", async () => {
  const ui = await mount(
    <FeedReader active selected={feedItem(mediaEntry)} />,
    { height: 24, width: 72 }
  );
  const frame = inside(ui.captureCharFrame());
  const heading = frame.indexOf("Media");
  expect(frame.slice(heading, heading + 5)).toEqual([
    "Media",
    "▣ media/chart.png",
    "▶ media/walkthrough.mp4",
    "♪ media/standup.m4a",
    "□ media/runs.csv",
  ]);
});

test("an empty workspace feed names showing every workspace once", async () => {
  const frame = await frameOf(
    <FeedList
      active
      filtered
      onReset={ignore}
      onSelect={ignore}
      rows={[]}
      scopeLabel="handbook"
    />,
    56,
    10
  );
  expect(frame).toContain("Nothing from this workspace yet.");
  expect(frame).toContain("x Show all workspaces");
  expect(frame).not.toContain("shows all workspaces");
  expect(frame).not.toContain("Clear filters");
});

test("JSON summaries count one field and one item in the singular", async () => {
  const frame = await frameOf(
    <JSONView
      data={{ options: { check: true }, pair: [1, 2], paths: ["a"] }}
      focused={false}
    />,
    40,
    12
  );
  expect(frame).toContain("root {3 fields}");
  expect(frame).toContain("options {1 field}");
  expect(frame).toContain("paths [1 item]");
  expect(frame).toContain("pair [2 items]");
});
