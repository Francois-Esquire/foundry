import { join } from "node:path";
import { expect, it } from "vitest";
import { step } from "~/authoring/builder";
import { type ExecutionRun, Executions } from "~/lib/executions";
import type { StateStore } from "~/lib/state/store";
import { InMemoryStateStore, JsonStateStore } from "~/lib/state/store";
import {
  blockingTask,
  executionFixture,
  exitedPid,
  leftBehind,
  orphan,
  until,
} from "../helpers/executions";

const fixture = executionFixture();
const engineWith = fixture.engine;
const NOT_TAKEN_OVER = /not taken over/;

it("marks what an exited process was running interrupted, and admits its queue again in order", async () => {
  const state = join(fixture.root, "state");
  const dead = exitedPid();
  leftBehind(state, dead, [
    { id: "rn-program", name: "program", queue: "programs", status: "running" },
    { id: "rn-save-1", input: { n: 1 } },
    { id: "rn-save-2", input: { n: 2 } },
    { id: "rn-save-3", input: { n: 3 } },
  ]);
  // A live process's work is its own.
  leftBehind(state, process.ppid, [
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
  // A run launched after start waits behind what was recovered.
  const later = await engine.launch<number>("save", { n: 4 });
  await later.result;

  expect(order).toEqual([1, 2, 3, 4]);
  expect(engine.executions.get("rn-program")).toMatchObject({
    error: { code: "interrupted" },
    owner: { pid: process.pid },
    status: "interrupted",
  });
  expect(engine.executions.get("rn-live")).toMatchObject({
    owner: { pid: process.ppid },
    status: "queued",
  });
  const store = new JsonStateStore(state);
  expect(store.read("executions", "rn-save-3")).toMatchObject({
    status: "complete",
  });
  expect(store.read("executions", "rn-program")).toMatchObject({
    status: "interrupted",
  });
});

it("leaves an exited process's queue queued and visible unless asked to recover it", async () => {
  const state = join(fixture.root, "state");
  leftBehind(state, exitedPid(), [{ id: "rn-save-1", input: { n: 1 } }]);
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
  // As a crash would leave them: the queued records on disk, owned by a dead pid.
  const store = new JsonStateStore(state);
  const left = [queued.id, after.id].map(
    (id) => store.read("executions", id) as ExecutionRun
  );
  await first.dispose();
  const dead = exitedPid();
  for (const record of left) {
    store.write("executions", record.id, { ...record, owner: { pid: dead } });
  }

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
  // As a crash between the run file and its record would leave them.
  const dead = exitedPid();
  const store = new JsonStateStore(state);
  const record = store.read("executions", finished.id) as ExecutionRun;
  store.write("executions", finished.id, {
    ...record,
    owner: { pid: dead },
    status: "running",
  });
  leftBehind(state, dead, [
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
  "reconciles an exited process's %s workflow record with a %s run file",
  (status, file, expected) => {
    const store = new InMemoryStateStore();
    orphan(store, { id: "rn-left", status });
    const executions = new Executions({ store, warn: () => undefined });
    executions.load();

    executions.recover({
      adopted: new Set(),
      fileStatus: () => file,
      readmit: () => false,
    });

    expect(executions.get("rn-left")?.status).toBe(expected);
    expect(
      (store.read("executions", "rn-left") as ExecutionRun | undefined)?.status
    ).toBe(expected);
  }
);

it("readmits a queued run only once its new owner is on disk", () => {
  const backing = new InMemoryStateStore();
  orphan(backing, {
    id: "rn-queued",
    input: {},
    kind: "task",
    status: "queued",
  });
  const left = backing.read("executions", "rn-queued");
  const disk: { full: boolean } = { full: false };
  const store: StateStore = {
    append: (...args) => backing.append(...args),
    list: (collection) => backing.list(collection),
    lock: (name) => backing.lock(name),
    log: (...args) => backing.log(...args),
    read: (collection, key) => backing.read(collection, key),
    remove: (collection, key) => backing.remove(collection, key),
    revision: (collection) => backing.revision(collection),
    write: (collection, key, value) => {
      if (disk.full) {
        throw new Error("disk full");
      }
      backing.write(collection, key, value);
    },
  };
  const warnings: string[] = [];
  const executions = new Executions({
    store,
    warn: (line) => warnings.push(line),
  });
  executions.load();
  disk.full = true;

  const readmitted = executions.recover({
    adopted: new Set(),
    readmit: () => true,
  });

  expect(readmitted).toEqual([]);
  expect(backing.read("executions", "rn-queued")).toEqual(left);
  expect(executions.get("rn-queued")?.owner.pid).not.toBe(process.pid);
  expect(warnings.join("\n")).toMatch(NOT_TAKEN_OVER);
});
