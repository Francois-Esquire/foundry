import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thisProcess } from "@foundry/lib/process-identity";
import { afterEach, beforeEach, expect, it } from "vitest";
import { catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import { testEngine } from "../helpers/engine";
import { exitedPid, leftBehind, storedExecution } from "../helpers/executions";

/**
 * A queued run whose owning process is proved gone is taken by the engine
 * offered it, in the one transaction that checks, inside it, that the run
 * is still queued under exactly that owner: an owner that is alive keeps
 * it, two takers take it once, and a retiring engine takes nothing.
 */

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

/** A started engine over the shared state, with the task `save` that says it ran. */
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

it("takes a queued run whose owner is gone, and runs it", async () => {
  const dead = { pid: exitedPid(), started: null };
  await leftBehind(state, dead.pid, [{ id: "rn-orphan", input: {} }]);
  const ran: string[] = [];
  const engine = await engineHere(ran);
  // Its start leaves it: queued runs of a gone process are not recovered
  // at start in Marbles.
  expect((await storedExecution(state, "rn-orphan"))?.status).toBe("queued");
  expect(await engine.takeQueued("rn-orphan", dead)).toEqual({ taken: true });
  await expect.poll(() => ran).toEqual(["save"]);
  expect(await storedExecution(state, "rn-orphan")).toMatchObject({
    owner: { pid: thisProcess().pid },
    status: "complete",
  });
});

it("moves nothing when the owner is alive", async () => {
  const alive = { pid: process.ppid, started: null };
  await leftBehind(state, alive.pid, [{ id: "rn-alive", input: {} }]);
  const ran: string[] = [];
  const engine = await engineHere(ran);
  expect(await engine.takeQueued("rn-alive", alive)).toMatchObject({
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
  const other = { pid: exitedPid(), started: null };
  await leftBehind(state, other.pid, [{ id: "rn-moved", input: {} }]);
  const ran: string[] = [];
  const engine = await engineHere(ran);
  expect(await engine.takeQueued("rn-moved", dead)).toMatchObject({
    taken: false,
  });
  expect((await storedExecution(state, "rn-moved"))?.owner.pid).toBe(other.pid);
});

it("takes it once when two engines race for it", async () => {
  const dead = { pid: exitedPid(), started: null };
  await leftBehind(state, dead.pid, [{ id: "rn-raced", input: {} }]);
  const ran: string[] = [];
  const first = await engineHere(ran);
  const second = await engineHere(ran);
  const taken = await Promise.all([
    first.takeQueued("rn-raced", dead),
    second.takeQueued("rn-raced", dead),
  ]);
  expect(taken.filter((take) => take.taken)).toHaveLength(1);
  await expect.poll(() => ran).toEqual(["save"]);
  await new Promise((resolve) => setImmediate(resolve));
  expect(ran).toEqual(["save"]);
});

it("takes nothing once it has begun to retire", async () => {
  const dead = { pid: exitedPid(), started: null };
  await leftBehind(state, dead.pid, [{ id: "rn-late", input: {} }]);
  const ran: string[] = [];
  const engine = await engineHere(ran);
  await engine.retire({ pid: thisProcess().pid + 1, started: null });
  expect(await engine.takeQueued("rn-late", dead)).toEqual({
    taken: false,
    why: "this engine is retiring",
  });
  expect((await storedExecution(state, "rn-late"))?.owner.pid).toBe(dead.pid);
});

it("says why it leaves a gone process's queued run nothing here can run", async () => {
  const dead = { pid: exitedPid(), started: null };
  await leftBehind(state, dead.pid, [
    { id: "rn-unknown", input: {}, name: "gone-task" },
  ]);
  const engine = await engineHere([]);
  expect(await engine.takeQueued("rn-unknown", dead)).toEqual({
    taken: false,
    why: 'no task named "gone-task" is registered here',
  });
  expect((await storedExecution(state, "rn-unknown"))?.owner.pid).toBe(
    dead.pid
  );
});
