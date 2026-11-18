import { describe, expect, it } from "vitest";
import { dashboardSnapshot } from "../preview/snapshot";
import type { DashboardSnapshot } from "../src/views/dashboard-model";
import {
  resolveSelection,
  runSelection,
  selectionKey,
  triggerSelection,
} from "../src/views/dashboard-model";
import { scopedRuns } from "../src/views/dashboard-tree";
import { showsOthers, workspaceScoped } from "../src/views/workspace-scope";

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

  it("tells two workspaces' runs and triggers of one id apart, whatever the id holds", () => {
    const id = "recent:99";
    const mine = { ...first, id, status: "complete" as const, triggerId: id };
    const theirs = {
      ...first,
      id,
      status: "failed" as const,
      triggerId: id,
      workspace: docs,
    };
    const colliding: DashboardSnapshot = {
      ...dashboardSnapshot,
      runs: [mine, theirs],
      triggers: [
        { ...trigger, id },
        { ...trigger, id, workspace: docs },
      ],
    };
    const resolvedMine = resolveSelection(colliding, runSelection(mine));
    const resolvedTheirs = resolveSelection(colliding, runSelection(theirs));
    expect(resolvedMine).toMatchObject({ run: { status: "complete" } });
    expect(resolvedTheirs).toMatchObject({ run: { status: "failed" } });
    expect(selectionKey(runSelection(mine))).not.toBe(
      selectionKey(runSelection(theirs))
    );
    expect(selectionKey({ id: `ws-docs:${id}`, kind: "run" })).not.toBe(
      selectionKey(runSelection(theirs))
    );
    const [own, other] = colliding.triggers;
    if (own === undefined || other === undefined) {
      throw new Error("two triggers");
    }
    expect(resolveSelection(colliding, triggerSelection(other))).toMatchObject({
      trigger: { workspace: docs },
    });
    expect(
      scopedRuns(colliding, triggerSelection(own)).map((run) => run.status)
    ).toEqual(["complete"]);
    expect(
      scopedRuns(colliding, triggerSelection(other)).map((run) => run.status)
    ).toEqual(["failed"]);
  });
});
