import { join } from "node:path";
import { expect, it } from "vitest";
import { step } from "~/authoring/builder";
import type { ExecutionRun } from "~/lib/executions";
import {
  blockingTask,
  executionFixture,
  exitedPid,
  leftBehind,
  seedExecution,
  storedExecution,
  until,
  withExecutions,
} from "../helpers/executions";

const fixture = executionFixture();
const engineWith = fixture.engine;

it("marks what an exited process was running interrupted, and admits its queue again in order", async () => {
  const state = join(fixture.root, "state");
  const dead = exitedPid();
  await leftBehind(state, dead, [
    { id: "rn-program", name: "program", queue: "programs", status: "running" },
    { id: "rn-save-1", input: { n: 1 } },
    { id: "rn-save-2", input: { n: 2 } },
    { id: "rn-save-3", input: { n: 3 } },
  ]);
  await leftBehind(state, process.ppid, [{ id: "rn-live", input: { n: 9 } }]);

  const order: number[] = [];
  const engine = engineWith({ state });
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

  const second = engineWith({ state });
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

it("re-admits a gone process's queued workflow under its recorded id", async () => {
  const state = join(fixture.root, "state");
  const calls: string[] = [];
  step("flow").do(() => {
    calls.push("flow");
    return "ran";
  });
  await leftBehind(state, exitedPid(), [
    {
      id: "rn-flow-queued",
      input: {},
      kind: "workflow",
      name: "flow",
      queue: "marbles",
    },
  ]);

  const engine = engineWith({ state });
  await engine.start();
  await until(
    () => engine.executions.get("rn-flow-queued")?.status === "complete"
  );
  expect(calls).toEqual(["flow"]);
  expect((await engine.runs()).map((run) => run.id)).toContain(
    "rn-flow-queued"
  );
});

it("lets one of two engines taking over an exited process's queued run run it", async () => {
  const state = join(fixture.root, "state");
  await leftBehind(state, exitedPid(), [{ id: "rn-queued", input: {} }]);
  const ran: string[] = [];
  const engines = [engineWith({ state }), engineWith({ state })];
  for (const engine of engines) {
    engine.task({
      name: "save",
      queue: "system",
      run: () => {
        ran.push("save");
      },
    });
  }
  await Promise.all(engines.map((engine) => engine.start()));
  await until(() => ran.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(ran).toEqual(["save"]);
});
