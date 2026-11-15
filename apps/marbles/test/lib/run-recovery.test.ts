/**
 * A starting engine decides to adopt a parked Run in the same atomic step
 * as its claim on it: a Run that moved on after the scan that found it,
 * because its owner resumed it and then died, or whose Execution Run
 * settled meanwhile, is not adopted, and nothing runs its body again.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionCoordinator } from "@foundry/workflows";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { DatabaseRunStore } from "~/database/runs";
import { marblesWorkflowRuns } from "~/database/tables";
import { stateDatabase } from "~/layout";
import { adoptParkedRuns } from "~/lib/run-recovery";
import type { ClaimCondition, RunStore } from "~/lib/run-store";
import { ANY_STORED_RUN } from "~/lib/run-store";

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

/** A Run parked by an owner engine, in a database another engine starts over. */
async function parkedByAnOwner() {
  const root = mkdtempSync(join(tmpdir(), "marbles-recovery-race-"));
  roots.push(root);
  const opened = await initializeDatabase(stateDatabase(root));
  handles.push(opened);
  const { database } = opened;
  const owner = new ExecutionCoordinator({
    store: await new DatabaseRunStore({ database, scope: "ws" }).open(
      () => undefined
    ),
  });
  const queue = await owner.ensureQueue({ id: "qu-1", name: "marbles" });
  await owner.createRun({
    id: "rn-1",
    input: null,
    queueId: queue.id,
    step: "flow",
  });
  await owner.updateRun("rn-1", { status: "running" });
  await owner.updateRun("rn-1", { status: "suspended" });
  /** The owner's process exits: what it owned, it owns no longer. */
  const ownerDies = async () => {
    await database
      .update(marblesWorkflowRuns)
      .set({ ownerPid: spawnSync("true").pid })
      .where(
        and(
          eq(marblesWorkflowRuns.scope, "ws"),
          eq(marblesWorkflowRuns.runId, "rn-1")
        )
      );
  };
  await ownerDies();
  const next = new DatabaseRunStore({ database, scope: "ws" });
  const store = new ExecutionCoordinator({
    store: await next.open(() => undefined),
  });
  return { next, owner, ownerDies, store };
}

/** `runs`, running `between` after the scan and before each claim. */
function interleaved(runs: RunStore, between: () => Promise<void>): RunStore {
  return {
    claim: async (runId: string, when: ClaimCondition) => {
      await between();
      return await runs.claim(runId, when);
    },
    close: () => runs.close(),
    durable: runs.durable,
    open: (recorded) => runs.open(recorded),
    recorded: (runId) => runs.recorded(runId),
    release: (runId) => runs.release(runId),
    remove: (runId) => runs.remove(runId),
  };
}

it("does not adopt a parked Run its owner resumed, and died running, after the scan", async () => {
  const { next, owner, ownerDies, store } = await parkedByAnOwner();
  const lines: string[] = [];
  const adopted = await adoptParkedRuns({
    askable: true,
    print: (line) => lines.push(line),
    registered: () => true,
    runs: interleaved(next, async () => {
      // The owner, alive again for a moment, resumes the Run and dies.
      await owner.updateRun("rn-1", { status: "running" });
      await ownerDies();
    }),
    settled: () => false,
    store,
  });

  expect(adopted.size).toBe(0);
  expect(lines).toEqual([
    "[run] flow rn-1 not adopted: it is running now, not parked",
  ]);
  // Nothing was claimed either: the Run is left as it stood.
  expect(
    await next.claim("rn-1", (stored) => stored?.status === "running")
  ).toBe(true);
});

it("does not adopt a parked Run whose Execution Run settled after the scan", async () => {
  const { next, store } = await parkedByAnOwner();
  let settled = false;
  const lines: string[] = [];
  const adopted = await adoptParkedRuns({
    askable: true,
    print: (line) => lines.push(line),
    registered: () => true,
    runs: interleaved(next, () => {
      settled = true;
      return Promise.resolve();
    }),
    settled: () => settled,
    store,
  });

  expect(adopted.size).toBe(0);
  expect(lines).toEqual([
    "[run] flow rn-1 not adopted: its execution run has settled",
  ]);
});

it("does not adopt a Run whose Execution Run a dying canceller settled while this engine claimed it", async () => {
  const { next, store } = await parkedByAnOwner();
  // Open as the claim's own step reads it; settled by the time it is won.
  let reads = 0;
  const lines: string[] = [];
  const adopted = await adoptParkedRuns({
    askable: true,
    print: (line) => lines.push(line),
    registered: () => true,
    runs: next,
    settled: () => {
      reads += 1;
      return reads > 1;
    },
    store,
  });

  expect(adopted.size).toBe(0);
  expect(reads).toBe(2);
  expect(lines).toEqual([
    "[run] flow rn-1 not adopted: its execution run has settled",
  ]);
  // The claim it won is given back.
  const other = new DatabaseRunStore({
    database: handles[0]?.database as MarblesDatabase["database"],
    scope: "ws",
  });
  expect(await other.claim("rn-1", ANY_STORED_RUN)).toBe(true);
});

it("adopts a Run still parked when it is claimed", async () => {
  const { next, store } = await parkedByAnOwner();
  const adopted = await adoptParkedRuns({
    askable: true,
    print: () => undefined,
    registered: () => true,
    runs: next,
    settled: () => false,
    store,
  });
  expect([...adopted.keys()]).toEqual(["rn-1"]);
});
