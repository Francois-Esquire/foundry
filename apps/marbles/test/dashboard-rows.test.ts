import { describe, expect, it } from "vitest";
import {
  runSelection,
  selectionKey,
  type TriggerSnapshot,
} from "~/cli/state/dashboard-model";
import {
  definitionRows,
  latestRows,
  logLines,
  logLocation,
  runListRows,
  triggerRows,
  workspaceDetails,
  workspaceRows,
} from "~/cli/state/dashboard-rows";
import { runRows } from "~/cli/state/dashboard-tree";
import type { OperatingLogEntry } from "~/cli/state/operating-model";
import type { WorkspaceSummary } from "~/model/connection";
import { dashboardSnapshot } from "../stories/fixtures/snapshot";

const remoteTrigger: TriggerSnapshot = {
  description: "Nightly in another workspace.",
  id: "nightly",
  kind: "schedule",
  name: "nightly",
  status: "failed",
  targetId: "summary",
  workspace: { id: "ws-other", name: "other" },
};

describe("triggerRows", () => {
  it("carries ids, details, status display, and selection", () => {
    const [docs, , daily] = triggerRows(dashboardSnapshot.triggers, {
      id: "daily",
      kind: "trigger",
    });
    expect(docs).toMatchObject({
      detail: "Watch src/**/*.ts for documentation changes.",
      id: "trigger:docs-monitor",
      kind: "monitor",
      selected: false,
      status: { label: "running", tone: "info" },
    });
    expect(daily).toMatchObject({
      detail: "Next: Today at 17:00",
      key: selectionKey({ id: "daily", kind: "trigger" }),
      selected: true,
      selection: { id: "daily", kind: "trigger" },
    });
  });

  it("names a trigger from another workspace by its selection key", () => {
    const [row] = triggerRows([remoteTrigger], {
      id: "nightly",
      kind: "trigger",
    });
    const key = selectionKey({
      id: "nightly",
      kind: "trigger",
      workspace: "ws-other",
    });
    expect(row).toMatchObject({
      id: `trigger:${key}`,
      key,
      selected: false,
      status: { label: "failed", tone: "error" },
    });
  });
});

describe("definitionRows", () => {
  it("labels origins and marks the selected definition", () => {
    const rows = definitionRows(
      [
        ...dashboardSnapshot.definitions.slice(0, 1),
        {
          description: "Elsewhere.",
          id: "outside",
          kind: "step",
          name: "outside",
          origin: { external: true, source: "/elsewhere/step.ts" },
        },
        { description: "Unknown.", id: "bare", kind: "step", name: "bare" },
      ],
      { id: "outside", kind: "definition" }
    );
    expect(
      rows.map(({ id, origin, selected }) => [id, origin, selected])
    ).toEqual([
      ["definition:docs", ".foundry/marbles/docs.ts:12", false],
      ["definition:outside", "outside workspace", true],
      ["definition:bare", undefined, false],
    ]);
    expect(rows[0]?.selection).toEqual({ id: "docs", kind: "definition" });
  });
});

describe("runListRows", () => {
  it("adds keys, cost display, step badges, and run ids at the root", () => {
    const [run] = dashboardSnapshot.runs;
    if (!run) {
      throw new Error("fixture has no runs");
    }
    const rows = runListRows(
      runRows([run], new Set([selectionKey(runSelection(run))])),
      runSelection(run, { stepId: "find" })
    );
    const [root, step] = rows;
    expect(root).toMatchObject({
      cost: { priced: true, value: "~$0.0421+?" },
      depth: 0,
      key: selectionKey(runSelection(run)),
      runId: "run-104",
      selected: false,
      status: { label: "running", tone: "info" },
      step: false,
    });
    expect(step).toMatchObject({
      depth: 1,
      key: selectionKey(runSelection(run, { stepId: "find" })),
      selected: true,
      step: true,
    });
    expect(step?.runId).toBeUndefined();
    expect(rows.find((row) => row.name === "Update documentation")?.cost).toBe(
      undefined
    );
  });
});

describe("latestRows", () => {
  it("selects the run an item belongs to", () => {
    expect(
      latestRows([
        { at: 2, id: "a", run: { id: "run-1" }, text: "started" },
        { at: 1, id: "b", text: "note" },
      ])
    ).toEqual([
      {
        at: 2,
        id: "a",
        selection: { id: "run-1", kind: "run" },
        text: "started",
      },
      { at: 1, id: "b", text: "note" },
    ]);
  });
});

describe("logLines", () => {
  const base = {
    id: "1",
    level: "info",
    message: "hello",
    timestamp: "10:00",
  } as const;

  it("names where each line came from", () => {
    const entries: OperatingLogEntry[] = [
      { ...base, source: "host" },
      { ...base, runId: "run-1", setup: true, source: "run" },
      { ...base, runId: "run-1", source: "run", stepId: "write" },
      { ...base, runId: "run-1", source: "run" },
    ];
    expect(entries.map(logLocation)).toEqual([
      "marbles",
      "run-1 setup",
      "run-1 write",
      "run-1",
    ]);
  });

  it("keeps each entry with its display fields", () => {
    const entry: OperatingLogEntry = { ...base, source: "host" };
    expect(logLines([entry])).toEqual([
      {
        entry,
        id: "1",
        level: "info",
        location: "marbles",
        message: "hello",
        timestamp: "10:00",
      },
    ]);
  });
});

describe("workspaceRows", () => {
  const summary = (id: string, root: string): WorkspaceSummary => ({
    config: null,
    id,
    root,
    state: "ready",
  });

  it("qualifies a label only while another root shares its name", () => {
    const rows = workspaceRows([
      summary("a", "/code/one/app"),
      summary("b", "/code/two/app"),
      summary("c", "/code/site"),
    ]);
    expect(rows.map(({ label, qualified }) => [label, qualified])).toEqual([
      ["one/app", true],
      ["two/app", true],
      ["site", false],
    ]);
  });
});

describe("workspaceDetails", () => {
  const workspaces: WorkspaceSummary[] = [
    { config: null, id: "alpha", root: "/code/alpha", state: "ready" },
    {
      config: null,
      error: "config failed",
      id: "beta",
      root: "/code/beta",
      state: "failed",
    },
  ];

  it("gives the selected workspace's root and error", () => {
    expect(workspaceDetails(workspaces, "alpha")).toEqual({
      root: "/code/alpha",
    });
    expect(workspaceDetails(workspaces, "beta")).toEqual({
      error: "config failed",
      root: "/code/beta",
    });
  });

  it("has nothing for a workspace that is not listed", () => {
    expect(workspaceDetails(workspaces, "gamma")).toBeUndefined();
  });
});
