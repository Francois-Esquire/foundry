import { describe, expect, it } from "vitest";
import { dashboardSnapshot } from "../preview/snapshot";
import type { DashboardSnapshot } from "../src/views/dashboard-model";
import { showsOthers, workspaceScoped } from "../src/views/workspace-scope";

/**
 * The run and trigger lists show this workspace's view (its own, and what
 * is shared with it) until every workspace's is asked for.
 */

const [first, second] = dashboardSnapshot.runs;
const [trigger] = dashboardSnapshot.triggers;
if (first === undefined || second === undefined || trigger === undefined) {
  throw new Error("the preview snapshot has two runs and a trigger");
}
const docs = { id: "ws-docs", name: "docs" };
const snapshot: DashboardSnapshot = {
  ...dashboardSnapshot,
  runs: [
    ...dashboardSnapshot.runs,
    { ...first, id: "elsewhere", workspace: docs },
    {
      ...second,
      id: "shared",
      workspace: docs,
      workspaces: ["ws-docs", dashboardSnapshot.workspaceId ?? ""],
    },
  ],
  triggers: [
    ...dashboardSnapshot.triggers,
    { ...trigger, id: "ws-docs:watch", workspace: docs },
  ],
};

describe("the dashboard's workspace scope", () => {
  it("shows this workspace's own and shared runs and triggers, and every workspace's when asked", () => {
    const here = workspaceScoped(snapshot, false);
    expect(here.runs.map((run) => run.id)).toEqual([
      ...dashboardSnapshot.runs.map((run) => run.id),
      "shared",
    ]);
    expect(here.triggers).toEqual(dashboardSnapshot.triggers);
    expect(workspaceScoped(snapshot, true)).toBe(snapshot);
    expect(showsOthers(snapshot)).toBe(true);
    expect(showsOthers(dashboardSnapshot)).toBe(false);
  });
});
