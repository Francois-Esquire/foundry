import { thisProcess } from "@foundry/lib/process-identity";
/**
 * A starting engine decides to adopt a parked Run in the same atomic step
 * as its claim on it: a Run that moved on after the scan that found it,
 * because its owner resumed it and then died, or whose Execution Run
 * settled meanwhile, is not adopted, and nothing runs its body again. The
 * Execution Run is read in the claim's own transaction, so a canceller's
 * settle lands before it or not at all.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ExecutionCoordinator } from "@foundry/workflows";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { DatabaseExecutionStore } from "~/database/executions";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { DatabaseRunStore } from "~/database/runs";
import { marblesWorkflowRuns } from "~/database/tables";
import { stateDatabase } from "~/layout";
import type { ExecutionRun } from "~/lib/execution-record";
import { parseStored } from "~/lib/execution-record";
import { adoptParkedRuns, closeAbandonedRuns } from "~/lib/run-recovery";
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
  // Its Execution Run, parked with it, owned by the process that died.
  const executions = new DatabaseExecutionStore({ database, scope: "ws" });
  const at = new Date().toISOString();
  const execution: ExecutionRun = {
    correlation: {},
    id: "rn-1",
    kind: "workflow",
    name: "flow",
    observations: [],
    owner: { pid: spawnSync("true").pid ?? 0, started: null },
    queue: "marbles",
    revision: 3,
    sequence: 1,
    status: "suspended",
    timestamps: { queuedAt: at, startedAt: at, updatedAt: at },
  };
  await executions.create(execution);
  /** Its Execution Run as the database holds it now. */
  const storedExecution = async () => {
    const stored = await executions.get("rn-1");
    return stored && parseStored(stored);
  };
  const next = new DatabaseRunStore({ database, scope: "ws" });
  const store = new ExecutionCoordinator({
    store: await next.open(() => undefined),
  });
  return {
    execution,
    executions,
    next,
    owner,
    ownerDies,
    root,
    store,
    storedExecution,
  };
}

/** Never asked: the claim reads the Execution Run itself. */
const unasked = (): Promise<boolean> =>
  Promise.reject(new Error("the claim should have read the Execution Run"));

/** `runs`, running `between` after the scan and before each claim. */
function interleaved(runs: RunStore, between: () => Promise<void>): RunStore {
  return {
    claim: async (runId: string, when: ClaimCondition) => {
      await between();
      return await runs.claim(runId, when);
    },
    close: () => runs.close(),
    durable: runs.durable,
    open: (recorded, follows) => runs.open(recorded, follows),
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
    settled: unasked,
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
  const { execution, executions, next, store } = await parkedByAnOwner();
  const lines: string[] = [];
  const adopted = await adoptParkedRuns({
    askable: true,
    print: (line) => lines.push(line),
    registered: () => true,
    runs: interleaved(next, async () => {
      // A canceller settles it between the scan and the claim.
      await executions.transition("rn-1", {
        from: ["suspended"],
        newOwner: thisProcess(),
        owner: execution.owner,
        settledAt: execution.timestamps.updatedAt,
        status: "cancelled",
        updatedAt: execution.timestamps.updatedAt,
      });
    }),
    settled: unasked,
    store,
  });

  expect(adopted.size).toBe(0);
  expect(lines).toEqual([
    "[run] flow rn-1 not adopted: its execution run has settled",
  ]);
});

it("reads a settled Execution Run once the claim is held, from a run store that keeps none beside its Runs", async () => {
  const { next, store } = await parkedByAnOwner();
  const blind: RunStore = {
    ...interleaved(next, () => Promise.resolve()),
    // As a store that keeps no Execution Runs hands the condition none.
    claim: (runId, when) => next.claim(runId, (stored) => when(stored)),
  };
  let reads = 0;
  const lines: string[] = [];
  const adopted = await adoptParkedRuns({
    askable: true,
    print: (line) => lines.push(line),
    registered: () => true,
    runs: blind,
    settled: () => {
      reads += 1;
      return Promise.resolve(true);
    },
    store,
  });

  expect(adopted.size).toBe(0);
  expect(reads).toBe(1);
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

const SOURCE = resolve(import.meta.dirname, "../../src");

/**
 * A canceller in a process of its own: it claims the Run, waits for
 * `<root>/settle`, cancels the orphan's Execution Run, and dies holding
 * its claim, writing `<root>/released` as it goes.
 */
function canceller(root: string) {
  const script = `
    const { existsSync, writeFileSync } = await import("node:fs");
    const { openDatabase } = await import(${JSON.stringify(join(SOURCE, "database/open.ts"))});
    const { DatabaseRunStore } = await import(${JSON.stringify(join(SOURCE, "database/runs.ts"))});
    const { DatabaseExecutionStore } = await import(${JSON.stringify(join(SOURCE, "database/executions.ts"))});
    const { ExecutionRecords } = await import(${JSON.stringify(join(SOURCE, "lib/execution-records.ts"))});
    const root = ${JSON.stringify(root)};
    const opened = await openDatabase(${JSON.stringify(stateDatabase(root))});
    const runs = new DatabaseRunStore({ database: opened.database, scope: "ws" });
    const records = new ExecutionRecords({
      runs: {
        claim: async (id, when) => {
          const claimed = await runs.claim(id, when);
          writeFileSync(root + "/claimed", String(claimed));
          while (!existsSync(root + "/settle")) await Bun.sleep(2);
          return claimed;
        },
        release: async () => {
          writeFileSync(root + "/released", "");
          process.kill(process.pid, "SIGKILL");
        },
      },
      store: new DatabaseExecutionStore({ database: opened.database, scope: "ws" }),
      warn: (line) => console.error(line),
    });
    await records.load();
    await records.cancelOrphan("rn-1");
  `;
  const child = spawn("bun", ["-e", script], {
    cwd: resolve(import.meta.dirname, "../.."),
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = new Promise<void>((done) => child.on("exit", () => done()));
  return { exited };
}

/** Resolves once `path` exists, polling briefly. */
async function appears(path: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`${path} never appeared`);
    }
    await new Promise((wake) => setTimeout(wake, 5));
  }
}

it("does not adopt a Run whose Execution Run a canceller settled before dying with its claim", {
  timeout: 30_000,
}, async () => {
  const { next, root, store, storedExecution } = await parkedByAnOwner();
  const { exited } = canceller(root);
  await appears(join(root, "claimed"));
  writeFileSync(join(root, "settle"), "");
  await exited;
  expect(await storedExecution()).toMatchObject({ status: "cancelled" });

  const lines: string[] = [];
  const adopted = await adoptParkedRuns({
    askable: true,
    print: (line) => lines.push(line),
    registered: () => true,
    runs: next,
    settled: unasked,
    store,
  });
  expect(adopted.size).toBe(0);
  expect(lines).toEqual([
    "[run] flow rn-1 not adopted: its execution run has settled",
  ]);
});

it("lands no canceller's settle while this engine decides its claim", {
  timeout: 30_000,
}, async () => {
  const { next, root, store, storedExecution } = await parkedByAnOwner();
  const { exited } = canceller(root);
  await appears(join(root, "claimed"));
  const released = join(root, "released");
  const deciding: RunStore = {
    ...interleaved(next, () => Promise.resolve()),
    claim: (runId, when) =>
      next.claim(runId, (stored, execution) => {
        // Inside the claim's transaction: the canceller settles now, and
        // dies once it has tried, while this claim is still undecided.
        writeFileSync(join(root, "settle"), "");
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(released)) {
          Atomics.wait(wait, 0, 0, 10);
        }
        return when(stored, execution);
      }),
  };
  const adopted = await adoptParkedRuns({
    askable: true,
    print: () => undefined,
    registered: () => true,
    runs: deciding,
    settled: unasked,
    store,
  });
  await exited;
  // Its settle waited for this transaction, and gave up: the record is open.
  expect(await storedExecution()).toMatchObject({ status: "suspended" });
  expect(adopted.size).toBeLessThanOrEqual(1);
});

it("adopts a Run still parked when it is claimed", async () => {
  const { next, store } = await parkedByAnOwner();
  const adopted = await adoptParkedRuns({
    askable: true,
    print: () => undefined,
    registered: () => true,
    runs: next,
    settled: unasked,
    store,
  });
  expect([...adopted.keys()]).toEqual(["rn-1"]);
});

it("closes out a Run a gone process left running whose settled Execution Run the host keeps in another store", async () => {
  const root = mkdtempSync(join(tmpdir(), "marbles-recovery-abandoned-"));
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
  // Its process exits mid-run: what it owned, it owns no longer.
  await database
    .update(marblesWorkflowRuns)
    .set({ ownerPid: spawnSync("true").pid })
    .where(
      and(
        eq(marblesWorkflowRuns.scope, "ws"),
        eq(marblesWorkflowRuns.runId, "rn-1")
      )
    );
  // The host keeps Execution Runs elsewhere: this database holds none, and
  // the launcher has settled the Run's there.
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
  const store = new ExecutionCoordinator({
    store: await next.open(() => undefined),
  });
  const lines: string[] = [];

  const closed = await closeAbandonedRuns({
    execution: (runId) => (runId === settled.id ? settled : undefined),
    print: (line) => lines.push(line),
    runs: next,
    store,
  });

  expect(closed).toEqual(["rn-1"]);
  expect((await store.getRun("rn-1"))?.status).toBe("failed");
  expect(lines).toEqual([
    "[run] flow rn-1 closed out: its process exited while it was running",
  ]);
  // The claim it held to close it out is given back.
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
  const store = new ExecutionCoordinator({
    store: await next.open(() => undefined),
  });
  const queue = await store.ensureQueue({ id: "qu-1", name: "marbles" });
  // This engine's own Run, live: readmitted before recovery runs.
  await store.createRun({
    id: "rn-2",
    input: null,
    queueId: queue.id,
    step: "flow",
  });
  await store.updateRun("rn-2", { status: "running" });
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
      runs: next,
      store,
    })
  ).toEqual([]);
  expect((await store.getRun("rn-2"))?.status).toBe("running");
  // Still this engine's: no other may claim it.
  expect(
    await new DatabaseRunStore({ database, scope: "ws" }).claim(
      "rn-2",
      ANY_STORED_RUN
    )
  ).toBe(false);
});
