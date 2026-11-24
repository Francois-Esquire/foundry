import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thisProcess } from "@foundry/lib/process-identity";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { DatabaseRunStore } from "~/database/runs";
import { marblesWorkflowRuns } from "~/database/tables";
import { stateDatabase } from "~/layout";
import type { ExecutionRun } from "~/lib/execution-record";
import { closeAbandonedRuns } from "~/lib/run-recovery";
import { ANY_STORED_RUN } from "~/lib/run-store";
import { WorkflowQueue } from "~/lib/workflow-queue";
import { readRun } from "~/lib/workflow-runs";
import { putRun } from "../helpers/queue-runs";

const roots: string[] = [];
const handles: MarblesDatabase[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

it("closes out a Run a gone process left running whose settled Execution Run the host keeps in another store", async () => {
  const root = mkdtempSync(join(tmpdir(), "marbles-recovery-abandoned-"));
  roots.push(root);
  const opened = await initializeDatabase(stateDatabase(root));
  handles.push(opened);
  const { database } = opened;
  const owner = await new DatabaseRunStore({ database, scope: "ws" }).open(
    () => undefined
  );
  await putRun(owner, "rn-1", "running");
  await database
    .update(marblesWorkflowRuns)
    .set({ ownerPid: spawnSync("true").pid })
    .where(
      and(
        eq(marblesWorkflowRuns.scope, "ws"),
        eq(marblesWorkflowRuns.runId, "rn-1")
      )
    );
  const at = new Date().toISOString();
  const settled: ExecutionRun = {
    correlation: {},
    id: "rn-1",
    kind: "workflow",
    name: "flow",
    observations: [],
    owner: { pid: spawnSync("true").pid ?? 0, started: null },
    queue: "marbles",
    revision: 4,
    sequence: 1,
    status: "failed",
    timestamps: { queuedAt: at, startedAt: at, updatedAt: at },
  };
  const next = new DatabaseRunStore({ database, scope: "ws" });
  const store = await next.open(() => undefined);
  const lines: string[] = [];

  const queue = new WorkflowQueue(store);
  const closed = await closeAbandonedRuns({
    execution: (runId) => (runId === settled.id ? settled : undefined),
    print: (line) => lines.push(line),
    queue,
    runs: next,
    store,
  });
  await queue.stop();

  expect(closed).toEqual(["rn-1"]);
  expect((await readRun(store, "rn-1"))?.status).toBe("failed");
  expect(lines).toEqual([
    "[run] flow rn-1 closed out: its process exited while it was running",
  ]);
  expect(
    await new DatabaseRunStore({ database, scope: "ws" }).claim(
      "rn-1",
      ANY_STORED_RUN
    )
  ).toBe(true);
});

it("leaves a Run this engine runs, whose Execution Run it holds open elsewhere, and its claim on it", async () => {
  const root = mkdtempSync(join(tmpdir(), "marbles-recovery-open-"));
  roots.push(root);
  const opened = await initializeDatabase(stateDatabase(root));
  handles.push(opened);
  const { database } = opened;
  const next = new DatabaseRunStore({ database, scope: "ws" });
  const store = await next.open(() => undefined);
  await putRun(store, "rn-2", "running");
  const at = new Date().toISOString();
  const open: ExecutionRun = {
    correlation: {},
    id: "rn-2",
    kind: "workflow",
    name: "flow",
    observations: [],
    owner: thisProcess(),
    queue: "marbles",
    revision: 2,
    sequence: 1,
    status: "running",
    timestamps: { queuedAt: at, startedAt: at, updatedAt: at },
  };

  expect(
    await closeAbandonedRuns({
      execution: (runId) => (runId === open.id ? open : undefined),
      print: () => undefined,
      queue: { abandonRun: () => Promise.reject(new Error("never asked")) },
      runs: next,
      store,
    })
  ).toEqual([]);
  expect((await readRun(store, "rn-2"))?.status).toBe("running");
  expect(
    await new DatabaseRunStore({ database, scope: "ws" }).claim(
      "rn-2",
      ANY_STORED_RUN
    )
  ).toBe(false);
});
