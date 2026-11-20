import { afterEach, expect, test } from "vitest";
import {
  DashboardMetrics,
  showsWorkflowRankings,
} from "../src/components/blocks/dashboard-metrics";
import { BarChart, chartBarWidth } from "../src/components/ui/bar-chart";
import { mount, unmount } from "./helpers/render";

afterEach(unmount);

const MIDDLE_CUT = /\S\.\.\.\S/;
const BAR = /[█░]+/;
const STACKED_FIRST_ROW = /^ Active runs +Needs attention$/;
const LABELS = [
  "Active runs",
  "Needs attention",
  "Success rate",
  "Tracked spend",
];

function rows(frame: string): string[] {
  return frame.split("\n").map((row) => row.trimEnd());
}

function cardRows(frame: string): string[] {
  return rows(frame).filter(
    (row) => row.trim() !== "" && !"╭│╰".includes(row.trimStart()[0] ?? "")
  );
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
  spend: { detail: "7 turns", value: "~$0.1601+?" },
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

async function metricsFrame(width: number, height: number): Promise<string> {
  const ui = await mount(
    <DashboardMetrics
      height={height}
      metrics={metrics}
      width={width}
      {...(showsWorkflowRankings(width, height) ? { rankings } : {})}
    />,
    { height, width }
  );
  return ui.captureCharFrame();
}

function barLengths(frame: string): (number | undefined)[][] {
  return rows(frame)
    .filter((row) => row.includes("summarize-day") || row.includes("draft"))
    .map((row) => row.split("│ │").map((side) => side.match(BAR)?.[0].length));
}

test("both workflow rankings draw one bar length at 90 columns", async () => {
  const pairs = barLengths(await metricsFrame(90, 24));
  expect(pairs.length).toBeGreaterThan(0);
  for (const [spend, time] of pairs) {
    expect(spend).toBe(5);
    expect(time).toBe(5);
  }
});

const RANKING_WIDTHS = [
  68, 70, 75, 79, 80, 81, 85, 88, 89, 90, 91, 95, 100, 105, 106, 110, 120, 130,
];
const CARD_WIDTHS = [
  24, 30, 33, 34, 40, 47, 48, 55, 60, 63, 64, 65, 66, 67, 68, 69, 70, 80, 90,
  100, 105, 106, 107, 108, 110, 120, 130,
];
const SWEEP_TIMEOUT = 60_000;

test(
  "side-by-side rankings never draw different bar lengths",
  async () => {
    for (const width of RANKING_WIDTHS) {
      for (const height of [24, 30]) {
        for (const [spend, time] of barLengths(
          await metricsFrame(width, height)
        )) {
          expect({ height, spend, width }).toEqual({
            height,
            spend: time,
            width,
          });
        }
      }
    }
  },
  SWEEP_TIMEOUT
);

test(
  "metric cards never cut a label, value, or detail in the middle",
  async () => {
    for (const width of CARD_WIDTHS) {
      for (const height of [12, 24, 30]) {
        const cards = cardRows(await metricsFrame(width, height));
        for (const row of cards) {
          expect({ height, row, width }).not.toEqual({
            height,
            row: expect.stringMatching(MIDDLE_CUT),
            width,
          });
        }
        if (width >= 34) {
          const text = cards.join("\n");
          for (const label of LABELS) {
            expect({
              height,
              label,
              shown: text.includes(label),
              width,
            }).toEqual({ height, label, shown: true, width });
          }
        }
      }
    }
  },
  SWEEP_TIMEOUT
);

test("a short narrow block stacks its cards two by two without details", async () => {
  const frame = await metricsFrame(48, 12);
  expect(cardRows(frame)).toEqual([
    " Active runs             Needs attention",
    " 1                       1",
    " Success rate            Tracked spend",
    " 80%                     ~$0.1601+?",
  ]);
  expect(cardRows(await metricsFrame(48, 21))).toHaveLength(4);
  expect(cardRows(await metricsFrame(48, 22))).toEqual([
    " Active runs             Needs attention",
    " 1                       1",
    " 1 running               1 failed",
    " Success rate            Tracked spend",
    " 80%                     ~$0.1601+?",
    " 4 completed             7 turns",
  ]);
});

test("a card given more width than its box clips its text instead of cutting the middle", async () => {
  const ui = await mount(
    <box flexDirection="column" width={48}>
      <DashboardMetrics height={12} metrics={metrics} width={100} />
    </box>,
    { height: 6, width: 60 }
  );
  for (const row of cardRows(ui.captureCharFrame())) {
    expect(row).not.toMatch(MIDDLE_CUT);
  }
});

test("cards too narrow for their labels end them with an ellipsis", async () => {
  const frame = await metricsFrame(30, 24);
  expect(frame).toContain("Needs attent…");
  expect(frame).not.toContain("...");
});

test("card details take their short form before they would be cut", async () => {
  const shortened = await metricsFrame(106, 24);
  expect(shortened).toContain("4 completed ");
  expect(shortened).not.toContain("cancelled");
  expect(shortened).not.toContain("…");
  const full = await metricsFrame(108, 24);
  expect(full).toContain("1 running · 0 queued");
  expect(full).toContain("4 completed · 0 cancelled");
  const stacked = await metricsFrame(60, 24);
  expect(stacked).toContain("4 completed · 0 cancelled");
  const narrowStacked = await metricsFrame(48, 24);
  expect(narrowStacked).toContain("1 running ");
  expect(narrowStacked).toContain("4 completed ");
  expect(narrowStacked).not.toContain("queued");
  expect(narrowStacked).not.toContain("cancelled");
});

test("rankings show only when the cards sit four across and there are 22 rows", async () => {
  expect(showsWorkflowRankings(67, 30)).toBe(false);
  expect(showsWorkflowRankings(68, 30)).toBe(true);
  expect(showsWorkflowRankings(68, 21)).toBe(false);
  expect(showsWorkflowRankings(68, 22)).toBe(true);
  for (const width of [63, 64, 65, 66, 67]) {
    const frame = await metricsFrame(width, 24);
    expect(frame).not.toContain("Workflow spend");
    expect(cardRows(frame)[0]).toMatch(STACKED_FIRST_ROW);
  }
  const shown = await metricsFrame(68, 24);
  expect(shown).toContain("USD · ~ estimated · +? partial");
  expect(shown).toContain("Total elapsed · finished runs");
});

const chart = [
  {
    id: "a",
    label: "nightly-digest",
    value: 724,
    valueLabel: <text>12m</text>,
    valueWidth: 3,
  },
  {
    id: "b",
    label: "triage-issues",
    value: 390,
    valueLabel: <text>6m</text>,
    valueWidth: 3,
  },
];

test("a bar chart caps its bars at the width it is given", async () => {
  expect(chartBarWidth(chart, 44)).toBe(10);
  expect(chartBarWidth(chart.slice(0, 1), 44)).toBeUndefined();
  const ui = await mount(
    <box flexDirection="column" width={44}>
      <BarChart
        availableWidth={44}
        color="#ffffff"
        data={chart}
        maxBarWidth={6}
      />
    </box>,
    { height: 4, width: 44 }
  );
  const lengths = rows(ui.captureCharFrame())
    .slice(0, 2)
    .map((row) => row.match(BAR)?.[0].length);
  expect(lengths).toEqual([6, 6]);
});
