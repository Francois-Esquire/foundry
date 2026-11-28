import { describe, expect, it } from "vitest";
import type { DashboardSnapshot } from "../src/tui/state/dashboard-model";
import {
  resolveSelection,
  runSelection,
  selectionKey,
  triggerSelection,
} from "../src/tui/state/dashboard-model";
import { scopedRuns } from "../src/tui/state/dashboard-tree";
import { showsOthers, workspaceScoped } from "../src/tui/state/workspace-scope";
import { dashboardSnapshot } from "../stories/fixtures/snapshot";

const [first] = dashboardSnapshot.runs;
const [trigger] = dashboardSnapshot.triggers;
if (first === undefined || trigger === undefined) {
  throw new Error("the preview snapshot has a run and a trigger");
}
const docs = { id: "ws-docs", name: "docs" };
const snapshot: DashboardSnapshot = {
  ...dashboardSnapshot,
  runs: [
    ...dashboardSnapshot.runs,
    { ...first, id: "elsewhere", workspace: docs },
  ],
  triggers: [
    ...dashboardSnapshot.triggers,
    { ...trigger, id: "ws-docs:watch", workspace: docs },
  ],
};

describe("the dashboard's workspace scope", () => {
  it("shows this workspace's own runs and triggers, and every workspace's when asked", () => {
    const here = workspaceScoped(snapshot, false);
    expect(here.runs).toEqual(dashboardSnapshot.runs);
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
