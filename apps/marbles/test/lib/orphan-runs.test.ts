import { thisProcess } from "@foundry/lib/process-identity";
/** Recovery must leave runs owned by a live process or adopter alone. */

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { catalog } from "~/authoring/catalog";
import { defaultWorkspaceRuns } from "~/database/managed";
import type { Engine } from "~/lib/engine";
import type { WorkspaceRecords } from "~/lib/events/records";
import { MemoryWorkspaceRecords } from "~/lib/events/records";
import { TASKS } from "~/lib/events/source";
import { MemoryExecutionStore } from "~/lib/execution-store";
import type { ExecutionRun } from "~/lib/executions";
import { Executions } from "~/lib/executions";
import { ANY_STORED_RUN } from "~/lib/run-store";
import type { Context } from "~/lib/types";
import { testEngine } from "../helpers/engine";
import {
  seedExecution,
  storedExecution,
  withExecutions,
} from "../helpers/executions";

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

async function claimedElsewhere(runId: string): Promise<boolean> {
  const probe = defaultWorkspaceRuns(state, root, "test");
  try {
    const claimed = await probe.claim(runId, ANY_STORED_RUN);
    await probe.release(runId);
    return !claimed;
  } finally {
    await probe.close();
  }
}

function exitedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined) {
    throw new Error("could not spawn");
  }
  return pid;
}

async function leftBehind(
  run: Partial<ExecutionRun> & { id: string }
): Promise<void> {
  const at = new Date().toISOString();
  await withExecutions(state, async (store) => {
    await seedExecution(store, {
      correlation: {},
      kind: "task",
      name: "save",
      observations: [],
      owner: { pid: exitedPid(), started: null },
      queue: "system",
      revision: 1,
      sequence: 1,
      status: "queued",
      timestamps: { queuedAt: at, updatedAt: at },
      ...run,
    });
  });
}

it("lets an exited process's queued run in again only once the start has succeeded", async () => {
  await leftBehind({ id: "rn-queued", input: {} });
  const memory = new MemoryWorkspaceRecords();
  const unreadable: WorkspaceRecords = {
    claimDelivery: () => memory.claimDelivery(),
    close: () => memory.close(),
    log: {
      ...memory.log,
      declare: () => Promise.reject(new Error("the records cannot be read")),
      head: () => Promise.reject(new Error("the records cannot be read")),
    },
    releaseDelivery: () => memory.releaseDelivery(),
    taskStore: memory.taskStore,
    watch: (listener) => memory.watch(listener),
  };
  const dead = await storedExecution(state, "rn-queued");
  let started = 0;
  const engine = engineWith({ records: unreadable, recoverQueued: true });
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
  engine.observe(TASKS, () => undefined, { name: "idle" });

  await expect(engine.start()).rejects.toThrow();
  await engine.dispose();

  expect(started).toBe(0);
  expect(await storedExecution(state, "rn-queued")).toEqual(dead);
});

it("lets a run in again after delivery starts, on an engine that accepts launches", async () => {
  await leftBehind({ id: "rn-queued", input: {} });
  const engine = engineWith({ recoverQueued: true });
  const launched: string[] = [];
  engine.task({
    name: "save",
    queue: "system",
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
  await first.stop({ cancel: true });
  await first.dispose();
  catalog.reset();

  await rewriteRecord(id, { owner: { pid: exitedPid(), started: null } });
  return id;
}

it("cancels a parked run whose process exited when nothing here can adopt it", async () => {
  const id = await parkedThenOrphaned();
  const engine = engineWith({ askable: true });
  await engine.start();
  expect(engine.executions.get(id)?.status).toBe("suspended");

  await engine.cancel(id);

  expect(engine.executions.get(id)).toMatchObject({
    owner: thisProcess(),
    status: "cancelled",
  });
  expect(await storedExecution(state, id)).toMatchObject({
    status: "cancelled",
  });
  expect(await claimedElsewhere(id)).toBe(false);
  expect(await engine.executions.prune([id], () => "scope")).toHaveLength(1);
});

it("never resumes a parked run that was cancelled after its process exited", async () => {
  const id = await parkedThenOrphaned();
  const cancelling = engineWith({ askable: true });
  await cancelling.start();
  await cancelling.cancel(id);
  await cancelling.dispose();

  const next = engineWith({ askable: true });
  next.define({
    fn: ({ ask }: Context) => ask.question({ title: "continue?" }),
    kind: "step",
    name: "probe",
  });
  await next.start();

  expect(next.scopes.has(id)).toBe(false);
  expect(next.executions.get(id)?.status).toBe("cancelled");
  expect(await claimedElsewhere(id)).toBe(false);
});

it("leaves a parked run alone while a live process owns it", async () => {
  await leftBehind({
    id: "rn-remote",
    kind: "workflow",
    name: "gone",
    owner: { pid: process.ppid, started: null },
    queue: "marbles",
    status: "suspended",
  });
  const engine = engineWith();
  await engine.start();

  await expect(engine.cancel("rn-remote")).rejects.toThrow();

  expect(engine.executions.get("rn-remote")).toMatchObject({
    owner: { pid: process.ppid, started: null },
    status: "suspended",
  });
});

it("leaves a parked run alone while another process is adopting it", async () => {
  await leftBehind({
    id: "rn-adopting",
    kind: "workflow",
    name: "gone",
    queue: "marbles",
    status: "suspended",
  });
  const engine = engineWith();
  await engine.start();
  const adopter = defaultWorkspaceRuns(state, root, "test");
  try {
    expect(await adopter.claim("rn-adopting", ANY_STORED_RUN)).toBe(true);
    await expect(engine.cancel("rn-adopting")).rejects.toThrow();
    expect(engine.executions.get("rn-adopting")?.status).toBe("suspended");
    await adopter.release();
  } finally {
    await adopter.close();
  }
  await engine.cancel("rn-adopting");
  expect(engine.executions.get("rn-adopting")?.status).toBe("cancelled");
});

function defineProbe(engine: Engine): void {
  engine.define({
    fn: ({ ask }: Context) => ask.question({ title: "continue?" }),
    kind: "step",
    name: "probe",
  });
}

async function rewriteRecord(
  id: string,
  patch: Partial<ExecutionRun>
): Promise<void> {
  const record = await storedExecution(state, id);
  if (!record) {
    throw new Error(`${id} is not stored`);
  }
  await withExecutions(state, async (store) => {
    await seedExecution(store, {
      ...record,
      ...patch,
      revision: record.revision + 1,
    });
  });
}

it("records suspended a run it adopts whose process exited before its record saw the park", async () => {
  const id = await parkedThenOrphaned();
  await rewriteRecord(id, { status: "running" });
  const engine = engineWith({ askable: true });
  defineProbe(engine);
  await engine.start();

  expect(engine.scopes.has(id)).toBe(true);
  expect(engine.executions.get(id)).toMatchObject({
    owner: thisProcess(),
    status: "suspended",
  });
});

it("leaves a parked run it cannot adopt suspended for a process that can, even when its record said running", async () => {
  const id = await parkedThenOrphaned();
  await rewriteRecord(id, { status: "running" });
  const dead = (await storedExecution(state, id))?.owner.pid;
  const engine = engineWith({ askable: true });
  await engine.start();

  expect(engine.executions.get(id)).toMatchObject({
    owner: { pid: dead, started: null },
    status: "suspended",
  });
  await engine.dispose();

  const next = engineWith({ askable: true });
  defineProbe(next);
  await next.start();
  expect(next.scopes.has(id)).toBe(true);
  expect(next.executions.get(id)?.status).toBe("suspended");
});

it("gives a parked run saved before Execution Runs existed a record when it is adopted", async () => {
  const id = await parkedThenOrphaned();
  await withExecutions(state, (store) => store.remove(id));
  const engine = engineWith({ askable: true });
  defineProbe(engine);
  await engine.start();

  expect(engine.executions.list().map((run) => run.id)).toContain(id);
  expect(engine.executions.get(id)).toMatchObject({
    kind: "workflow",
    name: "probe",
    owner: thisProcess(),
    status: "suspended",
  });
  await engine.cancel(id);
  await vi.waitFor(() =>
    expect(engine.executions.get(id)?.status).toBe("cancelled")
  );
  expect(await engine.executions.prune([id], () => "scope")).toHaveLength(1);
  expect((await engine.runs()).map((run) => run.id)).not.toContain(id);
});

it("never readmits a queued run under a name now registered as the other kind", async () => {
  await leftBehind({
    id: "rn-was-task",
    input: {},
    kind: "task",
    name: "flow",
  });
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

it("reads an orphan's record again once its Run is claimed, and leaves one an adopter took meanwhile", async () => {
  const store = new MemoryExecutionStore();
  const at = new Date().toISOString();
  const left: ExecutionRun = {
    correlation: {},
    id: "rn-late",
    kind: "workflow",
    name: "gone",
    observations: [],
    owner: { pid: exitedPid(), started: null },
    queue: "marbles",
    revision: 1,
    sequence: 1,
    status: "suspended",
    timestamps: { queuedAt: at, updatedAt: at },
  };
  await store.create(left);
  const adopted = {
    ...left,
    owner: { pid: process.ppid, started: null },
    revision: 2,
  };
  const executions = new Executions({
    runs: {
      claim: async () => {
        await seedExecution(store, adopted);
        return true;
      },
      release: () => Promise.resolve(),
    },
    store,
    warn: () => undefined,
  });
  await executions.load();

  expect(await executions.cancelOrphan("rn-late")).toBe(false);
  expect((await store.get("rn-late"))?.value).toEqual(
    (({ observations: _observations, ...record }) => record)(adopted)
  );
});
