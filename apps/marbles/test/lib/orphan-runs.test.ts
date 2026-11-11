/**
 * What an exited process leaves behind: queued runs are let in again only
 * by a start that succeeds, and a parked workflow nothing here can adopt can
 * still be cancelled, but never one a live process or an adopter owns.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import { TASKS } from "~/lib/events/source";
import type { ExecutionRun } from "~/lib/executions";
import { JsonStateStore } from "~/lib/state/store";
import type { Context } from "~/lib/types";
import { testEngine } from "../helpers/engine";

let root: string;
let state: string;
const engines: Engine[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marbles-orphans-"));
  state = join(root, "state");
});

afterEach(async () => {
  catalog.reset();
  await Promise.allSettled(engines.splice(0).map((engine) => engine.dispose()));
  await rm(root, { force: true, recursive: true });
});

function engineWith(options: Parameters<typeof testEngine>[0] = {}): Engine {
  const engine = testEngine({ root, state, ...options });
  engines.push(engine);
  return engine;
}

/** A pid that has certainly exited. */
function exitedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined) {
    throw new Error("could not spawn");
  }
  return pid;
}

/** A run record as a crashed process would have left it. */
function leftBehind(run: Partial<ExecutionRun> & { id: string }): void {
  const at = new Date().toISOString();
  new JsonStateStore(state).write("executions", run.id, {
    correlation: {},
    kind: "task",
    name: "save",
    observations: [],
    owner: { pid: exitedPid() },
    queue: "system",
    revision: 1,
    sequence: 1,
    status: "queued",
    timestamps: { queuedAt: at, updatedAt: at },
    ...run,
  });
}

it("lets an exited process's queued run in again only once the start has succeeded", async () => {
  leftBehind({ id: "rn-queued", input: {} });
  // Delivery cannot read its tasks, so the start fails after the run store loaded.
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "tasks.json"), "{not json");
  const dead = new JsonStateStore(state).read("executions", "rn-queued") as
    | ExecutionRun
    | undefined;
  let started = 0;
  const engine = engineWith({ recoverQueued: true });
  engine.task({
    name: "save",
    queue: "system",
    run: async (_input, { signal }) => {
      started += 1;
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true })
      );
    },
  });
  engine.observe(TASKS, () => undefined);

  await expect(engine.start()).rejects.toThrow();
  await engine.dispose();

  expect(started).toBe(0);
  // Still queued under the exited process, for a start that can run it.
  expect(new JsonStateStore(state).read("executions", "rn-queued")).toEqual(
    dead
  );
});

it("lets a run in again after delivery starts, on an engine that accepts launches", async () => {
  leftBehind({ id: "rn-queued", input: {} });
  const engine = engineWith({ recoverQueued: true });
  const launched: string[] = [];
  engine.task({
    name: "save",
    queue: "system",
    // A recovered body runs at once, and may launch more work.
    run: async () => {
      launched.push((await engine.launch("note", {})).id);
    },
  });
  engine.task({ name: "note", run: () => undefined });
  await engine.start();
  await vi.waitFor(() =>
    expect(engine.executions.get("rn-queued")?.status).toBe("complete")
  );
  expect(launched).toHaveLength(1);
});

/** A run parked on a question, then left as if its process had exited. */
async function parkedThenOrphaned(): Promise<string> {
  const definition = {
    fn: ({ ask }: Context) => ask.question({ title: "continue?" }),
    kind: "step" as const,
    name: "probe",
  };
  const first = engineWith({ askable: true });
  first.define(definition);
  await first.start();
  const { id } = await first.launch("probe", {});
  await vi.waitFor(() =>
    expect(first.executions.get(id)?.status).toBe("suspended")
  );
  // With a state dir a stop keeps the parked run for a later process.
  await first.stop({ cancel: true });
  await first.dispose();
  catalog.reset();

  const dead = exitedPid();
  const store = new JsonStateStore(state);
  const record = store.read("executions", id) as ExecutionRun;
  store.write("executions", id, { ...record, owner: { pid: dead } });
  const path = join(state, "runs", `${id}.json`);
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(path, JSON.stringify({ ...file, pid: dead }));
  return id;
}

it("cancels a parked run whose process exited when nothing here can adopt it", async () => {
  const id = await parkedThenOrphaned();
  // Nothing here runs `probe`, so nothing adopts it.
  const engine = engineWith({ askable: true });
  await engine.start();
  expect(engine.executions.get(id)?.status).toBe("suspended");

  await engine.cancel(id);

  expect(engine.executions.get(id)).toMatchObject({
    owner: { pid: process.pid },
    status: "cancelled",
  });
  expect(new JsonStateStore(state).read("executions", id)).toMatchObject({
    status: "cancelled",
  });
  // The run-file lock is given back, so a later start can still read it.
  expect("release" in engine.store.lock(`run-${id}`)).toBe(true);
  expect(engine.executions.prune([id], () => "scope")).toHaveLength(1);
});

it("never resumes a parked run that was cancelled after its process exited", async () => {
  const id = await parkedThenOrphaned();
  const cancelling = engineWith({ askable: true });
  await cancelling.start();
  await cancelling.cancel(id);
  await cancelling.dispose();

  // A process that can run it finds its run file still parked on disk.
  const next = engineWith({ askable: true });
  next.define({
    fn: ({ ask }: Context) => ask.question({ title: "continue?" }),
    kind: "step",
    name: "probe",
  });
  await next.start();

  expect(next.scopes.has(id)).toBe(false);
  expect(next.executions.get(id)?.status).toBe("cancelled");
  // It holds no claim on the run either.
  const lock = next.store.lock(`run-${id}`);
  expect("release" in lock).toBe(true);
  if ("release" in lock) {
    lock.release();
  }
});

it("leaves a parked run alone while a live process owns it", async () => {
  leftBehind({
    id: "rn-remote",
    kind: "workflow",
    name: "gone",
    owner: { pid: process.ppid },
    queue: "marbles",
    status: "suspended",
  });
  const engine = engineWith();
  await engine.start();

  await expect(engine.cancel("rn-remote")).rejects.toThrow();

  expect(engine.executions.get("rn-remote")).toMatchObject({
    owner: { pid: process.ppid },
    status: "suspended",
  });
});

it("leaves a parked run alone while another process is adopting it", async () => {
  leftBehind({
    id: "rn-adopting",
    kind: "workflow",
    name: "gone",
    queue: "marbles",
    status: "suspended",
  });
  const engine = engineWith();
  await engine.start();
  // An adopter holds the run's lock from reading its file until it owns it.
  const adopter = new JsonStateStore(state).lock("run-rn-adopting");
  expect("release" in adopter).toBe(true);
  try {
    await expect(engine.cancel("rn-adopting")).rejects.toThrow();
    expect(engine.executions.get("rn-adopting")?.status).toBe("suspended");
  } finally {
    if ("release" in adopter) {
      adopter.release();
    }
  }
  await engine.cancel("rn-adopting");
  expect(engine.executions.get("rn-adopting")?.status).toBe("cancelled");
});

/** `probe`, the definition `parkedThenOrphaned` parks. */
function defineProbe(engine: Engine): void {
  engine.define({
    fn: ({ ask }: Context) => ask.question({ title: "continue?" }),
    kind: "step",
    name: "probe",
  });
}

/** Change what the exited process left on its record. */
function rewriteRecord(id: string, patch: Partial<ExecutionRun>): void {
  const store = new JsonStateStore(state);
  const record = store.read("executions", id) as ExecutionRun;
  store.write("executions", id, { ...record, ...patch });
}

it("records suspended a run it adopts whose process exited before its record saw the park", async () => {
  const id = await parkedThenOrphaned();
  rewriteRecord(id, { status: "running" });
  const engine = engineWith({ askable: true });
  defineProbe(engine);
  await engine.start();

  expect(engine.scopes.has(id)).toBe(true);
  expect(engine.executions.get(id)).toMatchObject({
    owner: { pid: process.pid },
    status: "suspended",
  });
});

it("leaves a parked run it cannot adopt suspended for a process that can, even when its record said running", async () => {
  const id = await parkedThenOrphaned();
  rewriteRecord(id, { status: "running" });
  const dead = (
    new JsonStateStore(state).read("executions", id) as ExecutionRun
  ).owner.pid;
  // Nothing here runs `probe`.
  const engine = engineWith({ askable: true });
  await engine.start();

  expect(engine.executions.get(id)).toMatchObject({
    owner: { pid: dead },
    status: "suspended",
  });
  await engine.dispose();

  // A later process that can answer it still adopts it.
  const next = engineWith({ askable: true });
  defineProbe(next);
  await next.start();
  expect(next.scopes.has(id)).toBe(true);
  expect(next.executions.get(id)?.status).toBe("suspended");
});

it("gives a parked run saved before Execution Runs existed a record when it is adopted", async () => {
  const id = await parkedThenOrphaned();
  new JsonStateStore(state).remove("executions", id);
  const engine = engineWith({ askable: true });
  defineProbe(engine);
  await engine.start();

  expect(engine.executions.list().map((run) => run.id)).toContain(id);
  expect(engine.executions.get(id)).toMatchObject({
    kind: "workflow",
    name: "probe",
    owner: { pid: process.pid },
    status: "suspended",
  });
  await engine.cancel(id);
  await vi.waitFor(() =>
    expect(engine.executions.get(id)?.status).toBe("cancelled")
  );
  expect(engine.executions.prune([id], () => "scope")).toHaveLength(1);
  expect((await engine.runs()).map((run) => run.id)).not.toContain(id);
});

it("never readmits a queued run under a name now registered as the other kind", async () => {
  leftBehind({ id: "rn-was-task", input: {}, kind: "task", name: "flow" });
  let ran = false;
  const engine = engineWith({ recoverQueued: true });
  engine.define({
    fn: () => {
      ran = true;
      return "ran";
    },
    kind: "step",
    name: "flow",
  });
  await engine.start();

  expect(engine.executions.get("rn-was-task")?.status).toBe("queued");
  expect(engine.executions.queues().every((queue) => queue.waiting === 0)).toBe(
    true
  );
  expect(ran).toBe(false);
});
