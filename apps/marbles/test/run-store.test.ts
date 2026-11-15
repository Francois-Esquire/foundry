/**
 * Every run store keeps one contract: in memory, and in the Marbles
 * database, where two engines share a workspace's Runs and claim them.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DatabaseExecutionStore } from "~/database/executions";
import { initializeDatabase } from "~/database/open";
import { DatabaseRunStore } from "~/database/runs";
import { stateDatabase } from "~/layout";
import type { ExecutionRun } from "~/lib/execution-record";
import { parseStored } from "~/lib/execution-record";
import type { RunFollower } from "~/lib/run-store";
import { MemoryRunStore } from "~/lib/run-store";
import { describeRunStore, putRun } from "./helpers/run-store";

describeRunStore(
  "MemoryRunStore",
  () =>
    Promise.resolve({
      close: () => Promise.resolve(),
      store: () => new MemoryRunStore(),
    }),
  { shared: false }
);

describeRunStore(
  "DatabaseRunStore",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "marbles-run-store-"));
    const opened = await initializeDatabase(stateDatabase(root));
    return {
      close() {
        opened.close();
        rmSync(root, { force: true, recursive: true });
        return Promise.resolve();
      },
      store: () =>
        new DatabaseRunStore({ database: opened.database, scope: "ws" }),
    };
  },
  { shared: true }
);

it("writes the Execution Run a Run's commit follows with in that commit's own transaction", async () => {
  const root = mkdtempSync(join(tmpdir(), "marbles-run-follow-"));
  const opened = await initializeDatabase(stateDatabase(root));
  try {
    const { database } = opened;
    const executions = new DatabaseExecutionStore({ database, scope: "ws" });
    const at = "2026-11-01T09:00:00.000Z";
    const running: ExecutionRun = {
      correlation: {},
      id: "rn-1",
      kind: "workflow",
      name: "flow",
      observations: [],
      owner: { pid: process.pid },
      queue: "marbles",
      revision: 2,
      sequence: 1,
      status: "running",
      timestamps: { queuedAt: at, startedAt: at, updatedAt: at },
    };
    await executions.put(running);
    let follows: RunFollower = (runId, status) =>
      runId === "rn-1" && status === "suspended"
        ? { ...running, revision: 3, status: "suspended" }
        : undefined;
    const workflows = await new DatabaseRunStore({
      database,
      scope: "ws",
    }).open(
      () => undefined,
      (runId, status) => follows(runId, status)
    );
    await putRun(workflows, "rn-1", "running");
    await putRun(workflows, "rn-1", "suspended");
    const parked = await executions.get("rn-1");
    expect(parked && parseStored(parked)).toMatchObject({
      revision: 3,
      status: "suspended",
    });

    // A follower that fails takes the Run's commit with it.
    follows = () => {
      throw new Error("no record to follow with");
    };
    await expect(putRun(workflows, "rn-1", "running")).rejects.toThrow(
      "no record to follow with"
    );
    expect((await workflows.getRun("rn-1"))?.status).toBe("suspended");
  } finally {
    opened.close();
    rmSync(root, { force: true, recursive: true });
  }
});
