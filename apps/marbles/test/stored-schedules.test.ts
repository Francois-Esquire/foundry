import { spawnSync } from "node:child_process";
import { occurrenceId } from "@foundry/scheduling";
import { makeSqliteScheduleStore } from "@foundry/scheduling/store/sqlite";
import { describe, expect, it } from "vitest";
import { initializeDatabase, readStoredSchedules } from "~/database/open";
import { marblesMonitorStates } from "~/database/tables";
import { stateDatabase } from "~/layout";
import { runStoreEffect } from "~/lib/workflow-runs";
import { readStatus } from "~/process/status";
import { otherWorkspaces } from "~/workspace/others";
import { seedWorkspace } from "./helpers/registry";
import { seedSchedules } from "./helpers/stored-runs";
import { temporaryDirectory } from "./helpers/temporary";

const SEEN = "2026-11-01T00:00:00.000Z";
const LATER = Date.parse(SEEN) + 1000;

interface Row {
  readonly kind: "monitor" | "schedule";
  readonly pending: boolean;
  readonly running: boolean;
}

const ROWS: readonly Row[] = (["schedule", "monitor"] as const).flatMap(
  (kind) =>
    [false, true].flatMap((pending) =>
      [false, true].map((running) => ({ kind, pending, running }))
    )
);

const keyOf = ({ kind, pending, running }: Row) =>
  `${kind}-${pending ? "pending" : "none"}-${running ? "live" : "dead"}`;

async function machine(): Promise<string> {
  const state = temporaryDirectory("marbles-stored-schedules-");
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
  await seedSchedules(
    state,
    "ws2",
    ROWS.map((row) => ({
      key: keyOf(row),
      kind: row.kind,
      last: { outcome: "complete", settledAt: SEEN },
      nextDue: "2026-11-01T01:00:00.000Z",
      owner: row.running ? process.pid : null,
    }))
  );
  const opened = await initializeDatabase(stateDatabase(state));
  try {
    for (const row of ROWS.filter(({ pending }) => pending)) {
      await opened.database.insert(marblesMonitorStates).values({
        key: keyOf(row),
        observed: {},
        pending: { input: null, workflow: "refresh" },
        scope: "ws2",
      });
    }
  } finally {
    opened.close();
  }
  return state;
}

describe("a stored schedule", () => {
  it.each(ROWS)(
    "of kind $kind, pending $pending, running $running: shown as its kind",
    async (row) => {
      const state = await machine();
      const key = keyOf(row);
      const status = (await readStatus(state)).workspaces
        .find(({ id }) => id === "ws2")
        ?.schedules.find((schedule) => schedule.key === key);
      const opened = await initializeDatabase(stateDatabase(state));
      let shown:
        | Awaited<
            ReturnType<ReturnType<typeof otherWorkspaces>>
          >["triggers"][number]
        | undefined;
      try {
        const { triggers } = await otherWorkspaces({
          database: opened.database,
          state,
          workspace: "ws1",
        })(Date.now());
        shown = triggers.find(({ id }) => id === key);
      } finally {
        opened.close();
      }
      const waits = row.pending && row.kind === "monitor";
      expect(status?.kind).toBe(row.kind === "monitor" ? "monitor" : null);
      expect(status?.running).toBe(row.running ? process.pid : null);
      expect(shown?.kind).toBe(row.kind);
      expect(shown?.targetId).toBe(waits ? "refresh" : key);
      expect(shown?.description).toBe(
        `${row.kind} in two${waits ? " · a launch of refresh waits" : ""}`
      );
    }
  );

  it("reads a dispatched run's own end when no scheduler recorded it, and a refused launch as failed", async () => {
    const state = await machine();
    const opened = await initializeDatabase(stateDatabase(state));
    try {
      const store = makeSqliteScheduleStore({
        database: opened.database,
        scope: "ws2",
      });
      await runStoreEffect(
        store.commit({
          occurrences: [
            {
              id: occurrenceId("schedule-none-dead", LATER),
              scheduledFor: LATER,
              scheduleId: "schedule-none-dead",
              state: {
                dispatchedAt: LATER,
                jobId: "rn-gone",
                kind: "dispatched",
              },
            },
            {
              id: occurrenceId("monitor-none-dead", LATER),
              scheduledFor: LATER,
              scheduleId: "monitor-none-dead",
              state: {
                dispatchedAt: LATER,
                jobId: `refused-${String(LATER)}-monitor-none-dead`,
                kind: "dispatched",
              },
            },
          ],
        })
      );
    } finally {
      opened.close();
    }
    const stored = new Map(
      (await readStoredSchedules(state, "ws2")).map((each) => [each.key, each])
    );
    expect(stored.get("schedule-none-dead")).toMatchObject({
      lastStatus: "cancelled",
      running: null,
    });
    expect(stored.get("monitor-none-dead")).toMatchObject({
      lastSettledAt: new Date(LATER).toISOString(),
      lastStatus: "failed",
      running: null,
    });
  });

  it("is not running when the process that claimed its occurrence is gone", async () => {
    const state = await machine();
    await seedSchedules(state, "ws2", [
      { key: "stale", owner: spawnSync("true").pid },
    ]);
    const stored = await readStoredSchedules(state, "ws2");
    expect(stored.find(({ key }) => key === "stale")?.running).toBeNull();
  });
});
