import type { ReactNode } from "react";
import { afterEach, expect, test } from "vitest";
import { RunsBlock } from "../src/components/blocks/runs";
import { StatusLabel } from "../src/components/blocks/status-label";
import { Text } from "../src/components/ui/text";
import { type RunStatus, statusDisplay } from "../src/model/run-status";
import type { RunSnapshot } from "../src/tui/state/dashboard-model";
import { runListRows } from "../src/tui/state/dashboard-rows";
import { expandedRun, runRows } from "../src/tui/state/dashboard-tree";
import { fixtureRun, scenarioSnapshot } from "../stories/blocks/fixtures-b";
import { dashboardSnapshot } from "../stories/fixtures/snapshot";
import { mount, unmount } from "./helpers/render";

afterEach(unmount);

const ignore = () => undefined;
const TREE_MARK = /[▾▸·]/;
const STEP_ROW = /[▾·] \[step\] (.*?) +running +│$/;
const STATUS_GAP = /running +│$/;
const FULL_BADGE = "Waiting for approval";
const SHORT_WAITING_ROW = /▸ (\S+) {2}approval +│$/;

const { runs: deepRuns } = scenarioSnapshot("deep");
const docsRun = fixtureRun("run-104");
const waitingRuns: readonly RunSnapshot[] = [
  {
    ...docsRun,
    attention: "approval",
    id: "run-105",
    name: "update-documentation",
    status: "suspended",
  },
  ...dashboardSnapshot.runs,
];

function frameBox(width: number, height: number, content: ReactNode) {
  return (
    <box flexDirection="column" height={height} padding={1} width={width}>
      {content}
    </box>
  );
}

async function runsFrame(
  runs: readonly RunSnapshot[],
  expanded: readonly string[],
  { height, width }: { readonly height: number; readonly width: number }
): Promise<string[]> {
  const rows = runListRows(runRows(runs, new Set(expanded)));
  const ui = await mount(
    frameBox(
      width,
      height,
      <RunsBlock
        active
        filtered={false}
        onSelect={ignore}
        onToggle={ignore}
        rows={rows}
      />
    ),
    { height, width }
  );
  await ui.renderOnce();
  return ui
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd());
}

function deepStepRows(frame: readonly string[]): string[] {
  return frame.filter(
    (line) => line.includes("[step]") && line.includes("running")
  );
}

function indents(rows: readonly string[]): number[] {
  return rows.map((row) => row.search(TREE_MARK));
}

test("deep steps at 42 columns keep a readable name and a whole status", async () => {
  const frame = await runsFrame(deepRuns, deepRuns.flatMap(expandedRun), {
    height: 20,
    width: 42,
  });
  const rows = deepStepRows(frame);
  expect(rows).toHaveLength(9);
  for (const row of rows) {
    expect(row, row).toMatch(STATUS_GAP);
    const name = row.match(STEP_ROW)?.[1] ?? "";
    expect(name.trim().length, row).toBeGreaterThanOrEqual(10);
  }
  const columns = indents(rows);
  for (let index = 1; index < columns.length; index += 1) {
    expect(columns[index]).toBeGreaterThanOrEqual(columns[index - 1] ?? 0);
  }
});

test("deep steps at 90 columns indent one level per depth", async () => {
  const frame = await runsFrame(deepRuns, deepRuns.flatMap(expandedRun), {
    height: 24,
    width: 90,
  });
  const rows = deepStepRows(frame);
  expect(rows).toHaveLength(9);
  const columns = indents(rows);
  for (let index = 1; index < columns.length; index += 1) {
    expect(columns[index]).toBe((columns[index - 1] ?? 0) + 2);
  }
  expect(rows.at(-1)).toContain("Validate generated output running 3s");
});

test("a waiting run at 38 columns or less shortens its badge to keep its name", async () => {
  for (const width of [36, 38]) {
    const frame = await runsFrame(waitingRuns, [], { height: 10, width });
    const waiting = frame.find((line) => line.includes("approval")) ?? "";
    expect(waiting, `width ${width}`).not.toContain(FULL_BADGE);
    const name = waiting.match(SHORT_WAITING_ROW)?.[1] ?? "";
    expect(name.length, waiting).toBeGreaterThanOrEqual(10);
  }
});

test("a waiting run in a wide panel keeps the full badge", async () => {
  const frame = await runsFrame(waitingRuns, [], { height: 14, width: 80 });
  expect(frame.join("\n")).toContain(
    `update-documentation  ${FULL_BADGE}  24s`
  );
});

const plainStatuses: readonly RunStatus[] = [
  "queued",
  "running",
  "complete",
  "cancelled",
  "skipped",
];

test("a plain status keeps its width beside a name too long for the row", async () => {
  const ui = await mount(
    <box flexDirection="column" width={24}>
      {plainStatuses.map((status) => (
        <box flexDirection="row" gap={1} key={status}>
          <Text flexShrink={1} minWidth={0} truncate wrapMode="none">
            summarize-repository-changes
          </Text>
          <StatusLabel status={statusDisplay({ status })} />
        </box>
      ))}
    </box>,
    { height: 8, width: 24 }
  );
  const lines = ui
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd());
  plainStatuses.forEach((status, index) => {
    expect(lines[index], status).toMatch(new RegExp(`\\S ${status}$`));
  });
});
