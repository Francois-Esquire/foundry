import { describe, expect, it } from "vitest";
import { initializeDatabase } from "~/database/open";
import { marblesMonitorStates } from "~/database/tables";
import { stateDatabase } from "~/layout";
import type { ScheduleHistory } from "~/lib/trigger-store";
import { readStatus } from "~/status/model";
import { otherWorkspaces } from "~/workspace/others";
import { seedWorkspace } from "./helpers/registry";
import { seedTicks } from "./helpers/stored-runs";
import { temporaryDirectory } from "./helpers/temporary";

/**
 * Every reader of stored ticks shows a trigger's kind by one rule: history
 * that names a kind decides it, and a launch a monitor left decides only
 * when no history names one. A launch left under a key whose history says
 * schedule is no launch of that trigger's, and is not shown as one.
 */

const SEEN = "2026-11-01T00:00:00.000Z";

const HISTORY: Omit<ScheduleHistory, "kind"> = {
  label: undefined,
  lastFinish: SEEN,
  lastStart: SEEN,
  lastStatus: "complete",
  nextDue: "2026-11-01T01:00:00.000Z",
};

type History = "absent" | "untyped" | "schedule" | "monitor";

interface Row {
  readonly history: History;
  /** What the dashboard and `status` show, or `undefined` when the trigger is not listed. */
  readonly kind: "monitor" | "schedule" | undefined;
  readonly pending: boolean;
  readonly running: boolean;
  /** Whether the launch shows as waiting. */
  readonly waits: boolean;
}

function expected(history: History, pending: boolean, running: boolean): Row {
  const named =
    history === "schedule" || history === "monitor" ? history : undefined;
  const kind = named ?? (pending ? "monitor" : "schedule");
  const listed = history !== "absent" || pending || running;
  return {
    history,
    kind: listed ? kind : undefined,
    pending,
    running,
    waits: listed && pending && kind === "monitor",
  };
}

const ROWS: readonly Row[] = (
  ["absent", "untyped", "schedule", "monitor"] as const
).flatMap((history) =>
  [false, true].flatMap((pending) =>
    [false, true].map((running) => expected(history, pending, running))
  )
);

const keyOf = ({ history, pending, running }: Row) =>
  `${history}-${pending ? "pending" : "none"}-${running ? "live" : "dead"}`;

async function machine(): Promise<string> {
  const state = temporaryDirectory("marbles-stored-ticks-");
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
  await seedTicks(
    state,
    "ws2",
    ROWS.map((row) => ({
      key: keyOf(row),
      ...(row.history === "absent"
        ? {}
        : {
            last: {
              ...HISTORY,
              ...(row.history === "untyped" ? {} : { kind: row.history }),
            },
          }),
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

describe("a stored trigger's kind", () => {
  it.each(ROWS)(
    "history $history, pending $pending, running $running: shown as $kind",
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
      if (row.kind === undefined) {
        expect(status).toBeUndefined();
        expect(shown).toBeUndefined();
        return;
      }
      expect(status?.kind).toBe(row.kind === "monitor" ? "monitor" : null);
      expect(status?.running).toBe(row.running ? process.pid : null);
      expect(shown?.kind).toBe(row.kind);
      expect(shown?.targetId).toBe(row.waits ? "refresh" : key);
      expect(shown?.description).toBe(
        `${row.kind} in two${row.waits ? " · a launch of refresh waits" : ""}`
      );
    }
  );
});
