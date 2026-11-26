import { afterEach, expect, test } from "vitest";
import { DashboardMetrics } from "../src/components/blocks/dashboard-metrics";
import { FeedReader } from "../src/components/blocks/feed-reader";
import {
  UsageBreakdown,
  type UsageBreakdownView,
} from "../src/components/blocks/operating-overview";
import { RunStream } from "../src/components/blocks/run-stream";
import { FeedLayout } from "../src/components/layouts/feed";
import { feedItem } from "../src/tui/state/feed-model";
import { answeredEntry, cancelledEntry } from "../stories/blocks/fixtures-a";
import { frameWith, mount, unmount } from "./helpers/render";

afterEach(unmount);

const TIME_ROW_END = /run │$/;
const PLURAL_ONE = /\b1 (turns|usage records)\b/;
const BLANK_PANEL_ROW = /^│ *│$/;

function rows(frame: string): string[] {
  return frame.split("\n").map((row) => row.trimEnd());
}

const metrics = {
  counts: {
    cancelled: 0,
    complete: 4,
    failed: 1,
    queued: 0,
    running: 1,
    waiting: 0,
  },
  notes: [],
  spend: { detail: "7 turns", value: "~$0.1601" },
  successRate: "80%",
};

const rankings = {
  elapsed: [
    {
      id: "summary",
      ms: 95_000,
      name: "summarize-day",
      timing: "1m 35s · 1 run",
    },
    {
      id: "release",
      ms: 64_000,
      name: "draft-release-notes",
      timing: "1m 04s · 1 run",
    },
  ],
  spend: [
    {
      amount: 0.118,
      cost: { priced: true, value: "~$0.1180" },
      id: "review",
      name: "review-changes",
    },
    {
      amount: 0.0712,
      cost: { priced: true, value: "~$0.0712" },
      id: "summary",
      name: "summarize-day",
    },
  ],
};

test("both workflow rankings draw bars at 90 columns and stay inside their panels", async () => {
  const ui = await mount(
    <DashboardMetrics
      height={24}
      metrics={metrics}
      rankings={rankings}
      width={90}
    />,
    { height: 24, width: 90 }
  );
  const ranked = rows(ui.captureCharFrame()).filter(
    (row) => row.includes("review-changes") || row.includes("summarize-day")
  );
  expect(ranked).toHaveLength(2);
  for (const row of ranked) {
    const [spend, time] = row.split("│ │");
    expect(spend).toContain("█");
    expect(time).toContain("█");
    expect(row).toMatch(TIME_ROW_END);
  }
});

const oneEach: UsageBreakdownView = {
  byAgent: [],
  byWorkflow: [],
  recovered: 1,
  total: { cost: "$0.01", tokens: "1k tokens" },
  unattributed: 1,
  unreadable: 1,
  unsaved: 1,
};

test("usage warnings with a count of one read in the singular", async () => {
  const ui = await mount(<UsageBreakdown active={false} usage={oneEach} />, {
    height: 14,
    width: 200,
  });
  const frame = ui.captureCharFrame();
  expect(frame).toContain("1 usage record could not be read;");
  expect(frame).toContain("1 turn had no saved usage; its tokens");
  expect(frame).toContain("1 of those turns is in a session");
  expect(frame).toContain(
    "1 turn's usage could not be saved and no transcript accounts for it yet; it is counted"
  );
  expect(frame).not.toMatch(PLURAL_ONE);
});

test("usage warnings with larger counts stay plural", async () => {
  const ui = await mount(
    <UsageBreakdown
      active={false}
      usage={{
        ...oneEach,
        recovered: 4,
        unattributed: 2,
        unreadable: 3,
        unsaved: 2,
      }}
    />,
    { height: 14, width: 200 }
  );
  const frame = ui.captureCharFrame();
  expect(frame).toContain("3 usage records could not be read;");
  expect(frame).toContain("4 turns had no saved usage; their tokens");
  expect(frame).toContain("2 of those turns are in sessions");
  expect(frame).toContain("2 turns' usage could not be saved");
});

async function streamRows(lines: readonly string[]) {
  const ui = await mount(
    <RunStream stream={{ lines, live: false, received: true }} tail={12} />,
    { height: 12, width: 40 }
  );
  const frame = rows(ui.captureCharFrame());
  return frame.slice(
    0,
    frame.findIndex((row) => row.startsWith("Ended"))
  );
}

test("each stream line takes exactly one row, carriage returns included", async () => {
  expect(await streamRows(["A\r", "\r", "B\r", "C"])).toEqual([
    "A",
    "",
    "B",
    "C",
  ]);
});

test("blank stream lines keep their row", async () => {
  expect(await streamRows(["A", "", "", "B"])).toEqual(["A", "", "", "B"]);
});

test.each([
  ["answered", answeredEntry, "✓ Answered: merge"],
  ["cancelled", cancelledEntry, "No longer waiting:"],
] as const)(
  "the %s line sits one blank row below the body",
  async (_, entry, line) => {
    const answer =
      entry === answeredEntry
        ? ({ answer: "merge", kind: "answered" } as const)
        : ({ kind: "cancelled" } as const);
    const ui = await mount(
      <FeedReader active selected={{ ...feedItem(entry), answer }} />,
      { height: 20, width: 72 }
    );
    const frame = rows(await frameWith(ui, "Merge them into main?"));
    const body = frame.findIndex((row) =>
      row.includes("Merge them into main?")
    );
    expect(frame[body + 1]).toMatch(BLANK_PANEL_ROW);
    expect(frame[body + 2]).toContain(line);
  }
);

test.each([
  [89, 89],
  [90, 34],
  [120, 45],
  [160, 52],
])("at %i columns the feed list is %i columns wide", async (width, list) => {
  const ui = await mount(
    <box flexDirection="column" height={10} width={width}>
      <FeedLayout
        list={<box flexGrow={1} id="feed-list" />}
        reader={<box flexGrow={1} id="feed-reader" />}
        width={width}
      />
    </box>,
    { height: 10, width }
  );
  expect(ui.renderer.root.findDescendantById("feed-list")?.width).toBe(list);
});
