import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thisProcess } from "@foundry/lib/process-identity";
import { afterEach, beforeEach, expect, it } from "vitest";
import { catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import { testEngine } from "../helpers/engine";
import { exitedPid, leftBehind, storedExecution } from "../helpers/executions";

let root: string;
let state: string;
const engines: Engine[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marbles-queued-orphans-"));
  state = join(root, "state");
});

afterEach(async () => {
  catalog.reset();
  await Promise.allSettled(engines.splice(0).map((engine) => engine.dispose()));
  await rm(root, { force: true, recursive: true });
});

async function engineHere(ran: string[]): Promise<Engine> {
  const engine = testEngine({ print: () => undefined, root, state });
  engines.push(engine);
  engine.task({
    name: "save",
    queue: "system",
    run: () => {
      ran.push("save");
      return 42;
    },
  });
  await engine.start();
  return engine;
}

it("takes a gone process's queued run as it starts, and runs it", async () => {
  const dead = { pid: exitedPid(), started: null };
  await leftBehind(state, dead.pid, [{ id: "rn-orphan", input: {} }]);
  const ran: string[] = [];
  const engine = await engineHere(ran);
  await expect.poll(() => ran).toEqual(["save"]);
  await expect
    .poll(async () => (await storedExecution(state, "rn-orphan"))?.status)
    .toBe("complete");
  expect(await engine.adoptQueued("rn-orphan", dead)).toEqual({
    taken: false,
    why: "it is no longer queued under a process proved gone",
  });
});

it("takes a gone process's queued run it is offered while it runs, and runs it", async () => {
  const dead = { pid: exitedPid(), started: null };
  const ran: string[] = [];
  const engine = await engineHere(ran);
  await leftBehind(state, dead.pid, [{ id: "rn-offered", input: {} }]);
  expect(await engine.adoptQueued("rn-offered", dead)).toEqual({ taken: true });
  await expect.poll(() => ran).toEqual(["save"]);
  await expect
    .poll(async () => (await storedExecution(state, "rn-offered"))?.status)
    .toBe("complete");
});

it("moves nothing when the owner is alive", async () => {
  const alive = { pid: process.ppid, started: null };
  await leftBehind(state, alive.pid, [{ id: "rn-alive", input: {} }]);
  const ran: string[] = [];
  const engine = await engineHere(ran);
  expect(await engine.adoptQueued("rn-alive", alive)).toMatchObject({
    taken: false,
  });
  expect(ran).toEqual([]);
  expect(await storedExecution(state, "rn-alive")).toMatchObject({
    owner: { pid: alive.pid },
    status: "queued",
  });
});

it("moves nothing when the run is no longer the named owner's", async () => {
  const dead = { pid: exitedPid(), started: null };
  const alive = { pid: process.ppid, started: null };
  await leftBehind(state, alive.pid, [{ id: "rn-moved", input: {} }]);
  const engine = await engineHere([]);
  expect(await engine.adoptQueued("rn-moved", dead)).toMatchObject({
    taken: false,
  });
  expect((await storedExecution(state, "rn-moved"))?.owner?.pid).toBe(
    alive.pid
  );
});

it("takes it once when two engines race for it", async () => {
  const dead = { pid: exitedPid(), started: null };
  const ran: string[] = [];
  const first = await engineHere(ran);
  const second = await engineHere(ran);
  await leftBehind(state, dead.pid, [{ id: "rn-raced", input: {} }]);
  await Promise.all([
    first.adoptQueued("rn-raced", dead),
    second.adoptQueued("rn-raced", dead),
  ]);
  await expect.poll(() => ran).toEqual(["save"]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(ran).toEqual(["save"]);
});

it("takes nothing once it has begun to retire", async () => {
  const dead = { pid: exitedPid(), started: null };
  const ran: string[] = [];
  const engine = await engineHere(ran);
  await engine.retire({ pid: thisProcess().pid + 1, started: null });
  await leftBehind(state, dead.pid, [{ id: "rn-late", input: {} }]);
  expect(await engine.adoptQueued("rn-late", dead)).toEqual({
    taken: false,
    why: "this engine is retiring",
  });
  expect((await storedExecution(state, "rn-late"))?.owner?.pid).toBe(dead.pid);
});

it("says why it leaves a gone process's queued run nothing here can run", async () => {
  const dead = { pid: exitedPid(), started: null };
  const engine = await engineHere([]);
  await leftBehind(state, dead.pid, [
    { id: "rn-unknown", input: {}, name: "gone-task" },
  ]);
  expect(await engine.adoptQueued("rn-unknown", dead)).toEqual({
    taken: false,
    why: 'no task named "gone-task" is registered here',
  });
  expect((await storedExecution(state, "rn-unknown"))?.owner?.pid).toBe(
    dead.pid
  );
});
