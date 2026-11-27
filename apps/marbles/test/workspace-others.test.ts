import { describe, expect, it } from "vitest";
import { initializeDatabase } from "~/database/open";
import { resourceAssociations } from "~/database/resources";
import { marblesMonitorStates } from "~/database/tables";
import { stateDatabase } from "~/layout";
import { insideState } from "~/lib/state/workspace";
import { otherWorkspaces } from "~/workspace/others";
import { seedWorkspace } from "./helpers/registry";
import { seedRuns, seedSchedules } from "./helpers/stored-runs";
import { temporaryDirectory } from "./helpers/temporary";

const SEEN = "2026-11-01T00:00:00.000Z";

async function machine() {
  const state = temporaryDirectory("marbles-others-");
  for (const id of ["ws1", "ws2"]) {
    await seedWorkspace(state, {
      config: null,
      firstSeen: SEEN,
      hosted: false,
      id,
      lastSeen: SEEN,
      root: `/repo/${id === "ws1" ? "one" : "two"}`,
    });
  }
  await seedRuns(state, "ws1", [
    { createdAt: 1, id: "rn-own", owner: null, status: "complete" },
  ]);
  await seedRuns(state, "ws2", [
    { createdAt: 2, id: "rn-two", owner: null, status: "failed" },
    { createdAt: 3, id: "rn-shared", owner: null, status: "complete" },
  ]);
  await seedSchedules(state, "ws2", [
    {
      key: "watch",
      kind: "monitor",
      label: "watch docs",
      last: { outcome: "complete", settledAt: SEEN },
      nextDue: "2026-11-01T01:00:00.000Z",
      owner: null,
    },
  ]);
  return state;
}

describe("other workspaces on the dashboard", () => {
  it("lists another workspace's runs and triggers, each carrying its owner, a shared run naming this workspace", async () => {
    const state = await machine();
    const opened = await initializeDatabase(stateDatabase(state));
    try {
      const { database } = opened;
      await database.insert(marblesMonitorStates).values({
        key: "watch",
        observed: {},
        pending: { input: null, workflow: "refresh" },
        scope: "ws2",
      });
      await resourceAssociations(database, {
        acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
      }).share({ id: "rn-shared", kind: "run", owner: "ws2" }, "ws1");
      const read = otherWorkspaces({ database, state, workspace: "ws1" });
      const { runs, triggers } = await read(Date.now());
      expect(runs.map((run) => run.id)).toEqual(["rn-shared", "rn-two"]);
      expect(runs[0]).toMatchObject({
        definitionId: "guides",
        name: "guides · two",
        workspace: { id: "ws2", name: "two" },
        workspaces: ["ws2", "ws1"],
      });
      expect(runs[1]).toMatchObject({ status: "failed" });
      expect(runs[1]).not.toHaveProperty("workspaces");
      expect(triggers).toEqual([
        expect.objectContaining({
          description: "monitor in two · a launch of refresh waits",
          id: "watch",
          kind: "monitor",
          name: "watch docs · two",
          status: "watching",
          targetId: "refresh",
          workspace: { id: "ws2", name: "two" },
        }),
      ]);
      const fromTwo = await otherWorkspaces({
        database,
        state,
        workspace: "ws2",
      })(Date.now());
      expect(fromTwo.runs.map((run) => run.id)).toEqual(["rn-own"]);
      expect(fromTwo.triggers).toEqual([]);
    } finally {
      opened.close();
    }
  });

  it("shows a run shared with this workspace however many newer runs its owner has, and caps the others per workspace", async () => {
    const state = await machine();
    await seedRuns(
      state,
      "ws2",
      Array.from({ length: 120 }, (_, index) => ({
        createdAt: 100 + index,
        id: `rn-newer-${String(index)}`,
        owner: null,
        status: "complete" as const,
      }))
    );
    const opened = await initializeDatabase(stateDatabase(state));
    try {
      const { database } = opened;
      await resourceAssociations(database, {
        acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
      }).share({ id: "rn-two", kind: "run", owner: "ws2" }, "ws1");
      const { runs } = await otherWorkspaces({
        database,
        state,
        workspace: "ws1",
      })(Date.now());
      expect(runs.find((run) => run.id === "rn-two")).toMatchObject({
        workspaces: ["ws2", "ws1"],
      });
      expect(runs).toHaveLength(101);
    } finally {
      opened.close();
    }
  });

  it("shows a monitor whose launch waits before any of its runs ended, as a monitor", async () => {
    const state = await machine();
    await seedSchedules(state, "ws2", [{ key: "first", kind: "monitor" }]);
    const opened = await initializeDatabase(stateDatabase(state));
    try {
      const { database } = opened;
      await database.insert(marblesMonitorStates).values({
        key: "first",
        observed: {},
        pending: { input: null, workflow: "refresh" },
        scope: "ws2",
      });
      const { triggers } = await otherWorkspaces({
        database,
        state,
        workspace: "ws1",
      })(Date.now());
      expect(triggers.find((trigger) => trigger.id === "first")).toMatchObject({
        description: "monitor in two · a launch of refresh waits",
        kind: "monitor",
        name: "first · two",
        status: "watching",
        targetId: "refresh",
      });
    } finally {
      opened.close();
    }
  });
});
