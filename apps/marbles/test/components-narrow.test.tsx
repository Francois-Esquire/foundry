import { afterEach, expect, test } from "vitest";
import {
  DefinitionsBlock,
  TriggersBlock,
} from "../src/components/blocks/catalog";
import { DashboardFooter } from "../src/components/blocks/dashboard-footer";
import { type RunListRow, RunsBlock } from "../src/components/blocks/runs";
import { SettingsBlock } from "../src/components/blocks/settings-panel";
import { WorkspaceHeader } from "../src/components/blocks/workspace-header";
import {
  type WorkspaceRow,
  WorkspacesPanel,
} from "../src/components/blocks/workspaces-panel";
import { Action } from "../src/components/ui/action";
import { flush, mount, unmount } from "./helpers/render";

afterEach(async () => {
  await unmount();
});

const ignore = () => undefined;
const SCROLL_MARK = /\s*▀$/;
const RUN_ROW = /^› ▾ \S+ running( |$)/;
const STEP_ROW = /^· \[step\] \S.* complete( |$)/;
const FAILED_ROW = /^▸ check-api +failed( |$)/;
const SPACES = /\s+/;
const NAMED_ROW = /^\[workflow\] \S/;
const NAME_TOUCHES_SOURCE = /\S\.fo/;
const TRIGGER_ROW = /^\[workflow\] \S+ running( \S.*)?$/;
const HEADER_ROW = /^marbles \/ \S.* reloading$/;
const RAIL_ROW = /^› foundry( |$)/;
const LABEL_BEFORE_STATE = /^\S.* reloading$/;

function widths(from: number, to: number, step = 1): number[] {
  const all: number[] = [];
  for (let width = from; width <= to; width += step) {
    all.push(width);
  }
  return all;
}

function lines(frame: string): string[] {
  return frame.split("\n").map((line) => line.trimEnd());
}

function interior(frame: string): string[] {
  return lines(frame)
    .filter((line) => line.startsWith("│"))
    .map((line) => line.slice(1, line.lastIndexOf("│")).trim())
    .map((line) => line.replace(SCROLL_MARK, ""))
    .filter((line) => line !== "");
}

const runRows: readonly RunListRow<string>[] = [
  {
    branch: true,
    cost: { priced: true, value: "~$0.0421+?" },
    depth: 0,
    elapsed: "24s",
    expanded: true,
    key: "run:run-104",
    name: "update-documentation",
    runId: "run-104",
    selected: true,
    selection: "run-104",
    status: { label: "running", tone: "info" },
    step: false,
  },
  {
    branch: false,
    depth: 1,
    elapsed: "2s",
    expanded: false,
    key: "run:run-104:find",
    name: "Find changed files",
    selected: false,
    selection: "find",
    status: { label: "complete", tone: "success" },
    step: true,
  },
  {
    branch: true,
    depth: 0,
    elapsed: "3s",
    expanded: false,
    key: "run:run-103",
    name: "check-api",
    runId: "run-103",
    selected: false,
    selection: "run-103",
    status: { label: "failed", tone: "error" },
    step: false,
  },
];

test("each run row stays on one line with its status whole at any width", async () => {
  for (const width of widths(30, 90, 2)) {
    const ui = await mount(
      <RunsBlock
        active
        filtered={false}
        onSelect={ignore}
        onToggle={ignore}
        rows={runRows}
      />,
      { height: 10, width }
    );
    const rows = interior(ui.captureCharFrame());
    expect(rows, `width ${width}`).toHaveLength(runRows.length);
    expect(rows[0], `width ${width}`).toMatch(RUN_ROW);
    expect(rows[1], `width ${width}`).toMatch(STEP_ROW);
    expect(rows[2], `width ${width}`).toMatch(FAILED_ROW);
  }
}, 30_000);

test("a run row keeps its name before its time, cost and run id", async () => {
  const ui = await mount(
    <RunsBlock
      active
      filtered={false}
      onSelect={ignore}
      onToggle={ignore}
      rows={runRows.slice(0, 1)}
    />,
    { height: 6, width: 40 }
  );
  const [row] = interior(ui.captureCharFrame());
  expect(row).toContain("update-documentation running");
  expect(row).not.toContain("run-104");
});

test("a run row without a cost still shows its run id when there is room", async () => {
  const ui = await mount(
    <RunsBlock
      active
      filtered={false}
      onSelect={ignore}
      onToggle={ignore}
      rows={runRows}
    />,
    { height: 8, width: 80 }
  );
  const rows = interior(ui.captureCharFrame());
  expect(rows[0]).toContain("running 24s [~$0.0421+?] · run-104");
  expect(rows[2]).toContain("failed  3s · run-103");
});

const settings = {
  label: "Dark",
  path: "~/.foundry/marbles/settings.json",
  theme: "dark" as const,
  themes: [],
};

test("the settings preview breaks between words, never inside one", async () => {
  for (const width of widths(14, 60, 2)) {
    const ui = await mount(
      <SettingsBlock onRail={ignore} onTheme={ignore} settings={settings} />,
      { height: 24, width }
    );
    const words = interior(ui.captureCharFrame()).flatMap((row) =>
      row.split(SPACES)
    );
    for (const word of ["Preview", "dreaming", "complete", "Theme:", "Dark"]) {
      expect(words, `width ${width}`).toContain(word);
    }
    for (const word of ["Picker", "Rail", "(wide", "terminals)"]) {
      expect(words, `width ${width}`).toContain(word);
    }
  }
}, 30_000);

interface Item {
  readonly id: string;
  readonly key: string;
  readonly kind: "workflow";
  readonly name: string;
  readonly selected: boolean;
  readonly selection: string;
}

const definition: Item & { readonly origin: string } = {
  id: "definition:docs",
  key: "docs",
  kind: "workflow",
  name: "update-documentation",
  origin: ".foundry/marbles/docs.ts:12",
  selected: false,
  selection: "docs",
};

test("a truncated definition keeps a space between its name and source", async () => {
  for (const width of widths(34, 80)) {
    const ui = await mount(
      <DefinitionsBlock
        active
        items={[definition]}
        onSelect={ignore}
        workspace="foundry"
      />,
      { height: 5, width }
    );
    const [row] = interior(ui.captureCharFrame());
    expect(row, `width ${width}`).toMatch(NAMED_ROW);
    expect(row, `width ${width}`).not.toMatch(NAME_TOUCHES_SOURCE);
  }
}, 30_000);

test("a truncated trigger keeps a space between its status and detail", async () => {
  const trigger = {
    ...definition,
    detail: "Watch src/**/*.ts for documentation changes.",
    status: { label: "running", tone: "info" as const },
  };
  for (const width of widths(34, 80)) {
    const ui = await mount(
      <TriggersBlock active items={[trigger]} onSelect={ignore} />,
      { height: 5, width }
    );
    const [row] = interior(ui.captureCharFrame());
    expect(row, `width ${width}`).toMatch(TRIGGER_ROW);
  }
}, 30_000);

test("the workspace header keeps its whole state label when narrow", async () => {
  for (const width of widths(28, 70)) {
    const ui = await mount(
      <WorkspaceHeader
        onHome={ignore}
        onWorkspaces={ignore}
        state="reloading"
        workspace="handbook/internal-tools"
      />,
      { height: 2, width }
    );
    const [row] = lines(ui.captureCharFrame());
    expect(row, `width ${width}`).toMatch(HEADER_ROW);
  }
}, 30_000);

const workspaces: readonly WorkspaceRow[] = [
  {
    config: ".foundry/marbles",
    id: "ws-foundry",
    label: "foundry",
    qualified: false,
    root: "/Users/sam/code/foundry",
    state: "ready",
  },
  {
    config: ".foundry/marbles",
    id: "ws-handbook",
    label: "handbook",
    qualified: false,
    root: "/Users/sam/code/handbook",
    state: "reloading",
  },
];

test("the rail shows the current workspace's whole name", async () => {
  for (const width of widths(18, 40)) {
    const ui = await mount(
      <WorkspacesPanel
        compact
        current="ws-foundry"
        onSelect={ignore}
        selected="ws-foundry"
        workspaces={workspaces}
      />,
      { height: 10, width }
    );
    const rows = interior(ui.captureCharFrame());
    expect(rows[0], `width ${width}`).toMatch(RAIL_ROW);
    expect(rows.join(" "), `width ${width}`).toContain("current ready");
  }
}, 30_000);

const shortcuts = "? Help · / Search · f Filter runs · x Clear · q Quit";

test("the footer shows every shortcut and no blank rows when it wraps", async () => {
  for (const width of widths(40, 120, 4)) {
    const ui = await mount(
      <DashboardFooter
        onDiagnostics={ignore}
        onSettings={ignore}
        onWorkspaces={ignore}
        shortcuts={shortcuts}
      />,
      { height: 8, width }
    );
    const rows = lines(ui.captureCharFrame());
    while (rows.at(-1) === "") {
      rows.pop();
    }
    expect(rows, `width ${width}`).not.toContain("");
    const words = rows.join(" ").split(SPACES);
    for (const word of `${shortcuts} S Settings`.split(" ")) {
      expect(words, `width ${width}`).toContain(word);
    }
  }
}, 30_000);

test("a truncated action keeps the gap before the text beside it", async () => {
  for (const width of widths(14, 50)) {
    const ui = await mount(
      <box flexDirection="row" gap={1}>
        <Action
          label="handbook/internal-tools/documentation ▾"
          onAction={ignore}
          truncate
          value="workspace"
        />
        <text flexShrink={0}>reloading</text>
      </box>,
      { height: 2, width }
    );
    const [row] = lines(ui.captureCharFrame());
    expect(row, `width ${width}`).toMatch(LABEL_BEFORE_STATE);
  }
}, 30_000);

function manyRuns(): RunListRow<string>[] {
  return Array.from({ length: 40 }, (_, index) => ({
    branch: false,
    depth: 0,
    elapsed: "3s",
    expanded: false,
    key: `run:job-${index}`,
    name: `job-${index}`,
    runId: `run-${index}`,
    selected: index === 35,
    selection: `job-${index}`,
    status: { label: "complete", tone: "success" as const },
    step: false,
  }));
}

test("a selected run far down the list scrolls into view", async () => {
  const ui = await mount(
    <RunsBlock
      active
      filtered={false}
      onSelect={ignore}
      onToggle={ignore}
      rows={manyRuns()}
      selectedId="run:job-35"
    />,
    { height: 8, width: 60 }
  );
  expect(ui.captureCharFrame()).toContain("› · job-35 complete 3s");
});

test("a selected definition far down the list scrolls into view", async () => {
  const items = Array.from({ length: 40 }, (_, index) => ({
    ...definition,
    id: `definition:${index}`,
    key: `docs-${index}`,
    name: `docs-${index}`,
    selected: index === 35,
    selection: `docs-${index}`,
  }));
  const ui = await mount(
    <DefinitionsBlock
      active
      items={items}
      onSelect={ignore}
      selectedId="definition:35"
      workspace="foundry"
    />,
    { height: 8, width: 60 }
  );
  expect(ui.captureCharFrame()).toContain("› [workflow] docs-35 .foundry");
});

const resized = [
  [
    "runs",
    () => (
      <RunsBlock
        active
        filtered={false}
        onSelect={ignore}
        onToggle={ignore}
        rows={runRows}
      />
    ),
  ],
  [
    "definitions",
    () => (
      <DefinitionsBlock
        active
        items={[definition]}
        onSelect={ignore}
        workspace="foundry"
      />
    ),
  ],
  [
    "triggers",
    () => (
      <TriggersBlock
        active
        items={[
          {
            ...definition,
            detail: "Watch src/**/*.ts for documentation changes.",
            status: { label: "running", tone: "info" as const },
          },
        ]}
        onSelect={ignore}
      />
    ),
  ],
  [
    "header",
    () => (
      <WorkspaceHeader
        onHome={ignore}
        onWorkspaces={ignore}
        state="reloading"
        workspace="handbook/internal-tools"
      />
    ),
  ],
] as const;

async function fresh(
  render: () => ReturnType<(typeof resized)[number][1]>,
  width: number
) {
  const ui = await mount(render(), { height: 8, width });
  return ui.captureCharFrame();
}

test("a resized row looks the same as one first drawn at that size", async () => {
  for (const [name, render] of resized) {
    const narrow = await fresh(render, 36);
    const wide = await fresh(render, 100);
    const ui = await mount(render(), { height: 8, width: 100 });
    ui.resize(36, 8);
    await flush(ui);
    expect(ui.captureCharFrame(), `${name} narrowed`).toBe(narrow);
    ui.resize(100, 8);
    await flush(ui);
    expect(ui.captureCharFrame(), `${name} widened`).toBe(wide);
  }
}, 30_000);
