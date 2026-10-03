import { expect, it } from "vitest";
import type {
  HarnessActivitySnapshot,
  RunSnapshot,
} from "~/views/dashboard-model";
import { selectionKey } from "~/views/dashboard-model";
import { expandedRun, matchingRuns, runRows } from "~/views/dashboard-tree";

function activity(
  id: string,
  fields: Partial<HarnessActivitySnapshot> = {}
): HarnessActivitySnapshot {
  return {
    agentId: "coder",
    harness: "native",
    id,
    kind: "subagent",
    lifetime: "session",
    revision: 1,
    sessionId: "session",
    status: "running",
    title: id,
    ...fields,
  };
}

const run: RunSnapshot = {
  definitionId: "definition",
  elapsed: "1s",
  id: "run",
  name: "Run",
  started: "now",
  status: "running",
  steps: [{ children: [], id: "write", name: "Write", status: "running" }],
};

it("nests native activities by session under owning steps and preserves distinct selection identities", () => {
  const snapshot = {
    ...run,
    activities: [
      activity("parent", { stepId: "write" }),
      activity("child", {
        attention: "question",
        parentId: "parent",
        stepId: "write",
      }),
      activity("parent", { sessionId: "other", stepId: "unrepresented" }),
    ],
  };
  const rows = runRows([snapshot], new Set(expandedRun(snapshot)));
  expect(rows.map((row) => [row.name, row.depth])).toEqual([
    ["Run", 0],
    ["Write", 1],
    ["subagent: parent", 2],
    ["subagent: child", 3],
    ["subagent: parent", 1],
  ]);
  expect(rows[3]?.attention).toBe("question");
  expect(new Set(rows.map((row) => selectionKey(row.selection))).size).toBe(5);
  expect(matchingRuns([snapshot], "child")).toHaveLength(1);
});

it("renders cycles, missing parents and foreign-session parents without losing activities", () => {
  const snapshot = {
    ...run,
    activities: [
      activity("a", { parentId: "b" }),
      activity("b", { parentId: "a" }),
      activity("orphan", { parentId: "missing" }),
      activity("other", { parentId: "a", sessionId: "other" }),
    ],
  };
  const rows = runRows([snapshot], new Set(), true);
  expect(
    rows.filter(
      (row) =>
        row.selection.kind === "run" && row.selection.activityId !== undefined
    )
  ).toHaveLength(4);
  expect(rows.at(-1)?.depth).toBe(1);
});

it("folds an activity branch independently of its owning workflow step", () => {
  const snapshot = {
    ...run,
    activities: [
      activity("parent", { stepId: "write" }),
      activity("child", { parentId: "parent" }),
    ],
  };
  const rows = runRows([snapshot], new Set(["run:run", "run:run:step:write"]));
  expect(rows.map((row) => row.name)).toEqual([
    "Run",
    "Write",
    "subagent: parent",
  ]);
  expect(rows.at(-1)?.branch).toBe(true);
});
