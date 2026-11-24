import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thisProcess } from "@foundry/lib/process-identity";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import type { WorkspaceRecords } from "~/lib/events/records";
import { MemoryWorkspaceRecords } from "~/lib/events/records";
import { TASKS } from "~/lib/events/source";
import type { Context } from "~/lib/types";
import { testEngine } from "../helpers/engine";
import {
  type SeededRun,
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

function exitedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined) {
    throw new Error("could not spawn");
  }
  return pid;
}

async function leftBehind(run: SeededRun): Promise<void> {
  const at = new Date().toISOString();
  await withExecutions(state, async (seeds) => {
    await seedExecution(seeds, {
      kind: "task",
      name: "save",
      owner: { pid: exitedPid(), started: null },
      queue: "system",
      status: "queued",
      timestamps: { queuedAt: at, updatedAt: at },
      ...run,
    });
  });
}

it.each([
  ["an exited process", undefined],
  ["this process, handed over", thisProcess()],
] as const)(
  "lets a queued run of %s in only once the start has succeeded",
  async (_owner, owner) => {
    await leftBehind({
      id: "rn-queued",
      input: {},
      ...(owner === undefined ? {} : { owner }),
    });
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
    const engine = engineWith({ records: unreadable });
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
  }
);

it("lets a run in again after delivery starts, on an engine that accepts launches", async () => {
  await leftBehind({ id: "rn-queued", input: {} });
  const engine = engineWith();
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

async function suspendedThenOrphaned(): Promise<string> {
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
  await first.dispose();
  catalog.reset();
  return id;
}

it("cancels a suspended run left by an engine that is gone, from an engine that never ran it", async () => {
  const id = await suspendedThenOrphaned();
  const engine = engineWith({ askable: true });
  await engine.start();
  expect(engine.executions.get(id)?.status).toBe("suspended");

  await engine.cancel(id);

  expect(engine.executions.get(id)?.status).toBe("cancelled");
  expect(await storedExecution(state, id)).toMatchObject({
    status: "cancelled",
  });
  expect(await engine.executions.prune([id], () => "scope")).toHaveLength(1);
});

it("never resumes a suspended run that was cancelled after its process exited", async () => {
  const id = await suspendedThenOrphaned();
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
});

it("fails, without running it, a queued run under a name now registered as the other kind", async () => {
  await leftBehind({
    id: "rn-was-task",
    input: {},
    kind: "task",
    name: "flow",
  });
  let ran = false;
  const engine = engineWith();
  engine.define({
    fn: () => {
      ran = true;
      return "ran";
    },
    kind: "step",
    name: "flow",
  });
  await engine.start();

  await vi.waitFor(() =>
    expect(engine.executions.get("rn-was-task")).toMatchObject({
      error: { code: "KindChanged" },
      status: "failed",
    })
  );
  expect(ran).toBe(false);
});
