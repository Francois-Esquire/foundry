import { join } from "node:path";
import { thisProcess } from "@foundry/lib/process-identity";
import { expect, it } from "vitest";
import { step } from "~/authoring/builder";
import { MemoryExecutionStore } from "~/lib/execution-store";
import { type ExecutionRun, Executions } from "~/lib/executions";
import {
  blockingTask,
  executionFixture,
  exitedPid,
  leftBehind,
  orphan,
  seedExecution,
  storedExecution,
  until,
  withExecutions,
} from "../helpers/executions";

const fixture = executionFixture();
const engineWith = fixture.engine;
const NOT_TAKEN_OVER = /not taken over/;

it("marks what an exited process was running interrupted, and admits its queue again in order", async () => {
  const state = join(fixture.root, "state");
  const dead = exitedPid();
  await leftBehind(state, dead, [
    { id: "rn-program", name: "program", queue: "programs", status: "running" },
    { id: "rn-save-1", input: { n: 1 } },
    { id: "rn-save-2", input: { n: 2 } },
    { id: "rn-save-3", input: { n: 3 } },
  ]);
  await leftBehind(state, process.ppid, [
    { id: "rn-live", input: { n: 9 }, sequence: 1 },
  ]);

  const order: number[] = [];
  const engine = engineWith({ recoverQueued: true, state });
  engine.task<{ n: number }, number>({
    name: "save",
    queue: "system",
    run: ({ n }) => {
      order.push(n);
      return n;
    },
  });
  engine.task({ name: "program", queue: "programs", run: () => undefined });
  await engine.start();
  const later = await engine.launch<number>("save", { n: 4 });
  await later.result;

  expect(order).toEqual([1, 2, 3, 4]);
  expect(engine.executions.get("rn-program")).toMatchObject({
    error: { code: "interrupted" },
    owner: thisProcess(),
    status: "interrupted",
  });
  expect(engine.executions.get("rn-live")).toMatchObject({
    owner: { pid: process.ppid, started: null },
    status: "queued",
  });
  expect(await storedExecution(state, "rn-save-3")).toMatchObject({
    status: "complete",
  });
  expect(await storedExecution(state, "rn-program")).toMatchObject({
    status: "interrupted",
  });
});

it("leaves an exited process's queue queued and visible unless asked to recover it", async () => {
  const state = join(fixture.root, "state");
  await leftBehind(state, exitedPid(), [{ id: "rn-save-1", input: { n: 1 } }]);
  let calls = 0;
  const engine = engineWith({ state });
  engine.task({
    name: "save",
    run: () => {
      calls += 1;
    },
  });
  await engine.start();
  expect(engine.executions.get("rn-save-1")?.status).toBe("queued");
  await engine.cancel("rn-save-1");
  expect(engine.executions.get("rn-save-1")?.status).toBe("cancelled");
  expect(calls).toBe(0);
});

it("keeps queued work across a stop and admits it in the next process's order", async () => {
  const state = join(fixture.root, "state");
  const first = engineWith({ state });
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  blockingTask(first, "save", started, gates, "system");
  await first.start();
  await first.launch("save", { label: "a" });
  const queued = await first.launch("save", { label: "b" });
  const after = await first.launch("save", { label: "c" });
  await until(() => started.length === 1);
  const left: ExecutionRun[] = [];
  for (const id of [queued.id, after.id]) {
    const record = await storedExecution(state, id);
    if (record) {
      left.push(record);
    }
  }
  await first.dispose();
  const dead = exitedPid();
  await withExecutions(state, async (store) => {
    for (const record of left) {
      await seedExecution(store, {
        ...record,
        owner: { pid: dead, started: null },
      });
    }
  });

  const second = engineWith({ recoverQueued: true, state });
  const resumed: string[] = [];
  second.task<{ label: string }, string>({
    name: "save",
    queue: "system",
    run: ({ label }) => {
      resumed.push(label);
      return label;
    },
  });
  await second.start();
  await until(() => second.executions.get(after.id)?.status === "complete");
  expect(resumed).toEqual(["b", "c"]);
  expect(started).toEqual(["a"]);
});

it("re-admits a queued workflow under its recorded id, and trusts a settled run file over a running record", async () => {
  const state = join(fixture.root, "state");
  const calls: string[] = [];
  step("flow").do(() => {
    calls.push("flow");
    return "ran";
  });
  const first = engineWith({ state });
  await first.start();
  const finished = await first.launch<string>("flow", {});
  await finished.result;
  await first.dispose();
  const dead = exitedPid();
  const record = await storedExecution(state, finished.id);
  if (!record) {
    throw new Error("the run was not stored");
  }
  await withExecutions(state, async (store) => {
    await seedExecution(store, {
      ...record,
      owner: { pid: dead, started: null },
      status: "running",
    });
  });
  await leftBehind(state, dead, [
    {
      id: "rn-flow-queued",
      input: {},
      kind: "workflow",
      name: "flow",
      queue: "marbles",
    },
  ]);

  const second = engineWith({ recoverQueued: true, state });
  await second.start();
  await until(
    () => second.executions.get("rn-flow-queued")?.status === "complete"
  );
  expect(second.executions.get(finished.id)?.status).toBe("complete");
  expect(calls).toEqual(["flow", "flow"]);
  expect((await second.runs()).map((run) => run.id)).toContain(
    "rn-flow-queued"
  );
});

it.each([
  ["suspended", "cancelled", "cancelled"],
  ["suspended", "complete", "complete"],
  ["suspended", "running", "interrupted"],
  ["suspended", "suspended", "suspended"],
  ["suspended", undefined, "suspended"],
  ["running", "failed", "failed"],
  ["running", "suspended", "suspended"],
  ["running", "running", "interrupted"],
  ["running", undefined, "interrupted"],
] as const)(
  "reconciles an exited process's %s workflow record with a %s Run",
  async (status, file, expected) => {
    const store = new MemoryExecutionStore();
    await orphan(store, { id: "rn-left", status });
    const executions = new Executions({ store, warn: () => undefined });
    await executions.load();

    await executions.recover({
      adopted: new Set(),
      fileStatus: () => file,
      readmit: () => false,
    });

    expect(executions.get("rn-left")?.status).toBe(expected);
    expect(
      ((await store.get("rn-left"))?.value as ExecutionRun | undefined)?.status
    ).toBe(expected);
  }
);

it("readmits a queued run only once its new owner is on disk", async () => {
  const store = new MemoryExecutionStore();
  await orphan(store, {
    id: "rn-queued",
    input: {},
    kind: "task",
    status: "queued",
  });
  const left = await store.get("rn-queued");
  const warnings: string[] = [];
  const executions = new Executions({
    store,
    warn: (line) => warnings.push(line),
  });
  await executions.load();
  store.transaction = () => Promise.reject(new Error("disk full"));

  const readmitted = await executions.recover({
    adopted: new Set(),
    readmit: () => true,
  });

  expect(readmitted).toEqual([]);
  expect(await store.get("rn-queued")).toEqual(left);
  expect(executions.get("rn-queued")?.owner.pid).not.toBe(process.pid);
  expect(warnings.join("\n")).toMatch(NOT_TAKEN_OVER);
});

it("lets one of two engines taking over an exited process's queued run admit it", async () => {
  const store = new MemoryExecutionStore();
  await orphan(store, {
    id: "rn-queued",
    input: {},
    kind: "task",
    status: "queued",
  });
  const engines = [0, 1].map(
    () => new Executions({ store, warn: () => undefined })
  );
  for (const executions of engines) {
    await executions.load();
  }
  const readmitted = await Promise.all(
    engines.map((executions) =>
      executions.recover({ adopted: new Set(), readmit: () => true })
    )
  );
  expect(readmitted.flat().map((run) => run.id)).toEqual(["rn-queued"]);
});
