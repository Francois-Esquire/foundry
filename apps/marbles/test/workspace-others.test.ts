import { describe, expect, it } from "vitest";
import { initializeDatabase } from "~/database/open";
import { resourceAssociations } from "~/database/resources";
import { marblesMonitorStates } from "~/database/tables";
import { stateDatabase } from "~/layout";
import { otherWorkspaces } from "~/workspace/others";
import { seedWorkspace } from "./helpers/registry";
import { seedRuns, seedTicks } from "./helpers/stored-runs";
import { temporaryDirectory } from "./helpers/temporary";

/**
 * A hosted workspace's dashboard lists the other workspaces' runs and
 * triggers from the Marbles database, each owned elsewhere and qualified
 * by its owner, a shared run naming this workspace too.
 */

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
  await seedTicks(state, "ws2", [
    {
      key: "watch",
      last: {
        kind: "monitor",
        label: "watch docs",
        lastFinish: SEEN,
        lastStart: SEEN,
        lastStatus: "complete",
        nextDue: "2026-11-01T01:00:00.000Z",
      },
      owner: null,
    },
  ]);
  return state;
}

describe("other workspaces on the dashboard", () => {
  it("lists another workspace's runs and triggers, qualified by their owner, a shared run naming this workspace", async () => {
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
      await resourceAssociations(database, state).share(
        { id: "rn-shared", kind: "run", owner: "ws2" },
        "ws1"
      );
      const read = otherWorkspaces({ database, state, workspace: "ws1" });
      const { runs, triggers } = await read(Date.now());
      expect(runs.map((run) => run.id)).toEqual(["rn-shared", "rn-two"]);
      expect(runs[0]).toMatchObject({
        definitionId: "ws2:guides",
        name: "guides · two",
        workspace: { id: "ws2", name: "two" },
        workspaces: ["ws2", "ws1"],
      });
      expect(runs[1]).toMatchObject({ status: "failed" });
      expect(runs[1]).not.toHaveProperty("workspaces");
      expect(triggers).toEqual([
        expect.objectContaining({
          description: "monitor in two · a launch of refresh waits",
          id: "ws2:watch",
          kind: "monitor",
          name: "watch docs · two",
          status: "watching",
          workspace: { id: "ws2", name: "two" },
        }),
      ]);
      // The workspace's own lists come from its engine, not from here.
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
});
