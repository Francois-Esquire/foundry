import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thisProcess } from "@foundry/lib/process-identity";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { catalog } from "~/authoring/catalog";
import { openWorkspaceRecords } from "~/database/managed";
import type { Engine } from "~/lib/engine";
import { testEngine } from "../helpers/engine";
import { storedExecution } from "../helpers/executions";

let root: string;
let state: string;
const engines: Engine[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marbles-recovery-handover-"));
  state = join(root, "state");
});

afterEach(async () => {
  catalog.reset();
  await Promise.allSettled(engines.splice(0).map((engine) => engine.dispose()));
  await rm(root, { force: true, recursive: true });
});

function engineHere(): Engine {
  const engine = testEngine({
    askable: true,
    print: () => undefined,
    records: openWorkspaceRecords({ state, workspaceId: "test" }),
    root,
    state,
  });
  engines.push(engine);
  return engine;
}

it("leaves a retiring engine's active task and workflow to it when the next engine starts and recovers", async () => {
  const taskGate = Promise.withResolvers<void>();
  const stepGate = Promise.withResolvers<void>();
  const stepEntered = Promise.withResolvers<void>();
  const old = engineHere();
  old.task({
    name: "long",
    queue: "tasks",
    run: async () => {
      await taskGate.promise;
      return "task done";
    },
  });
  old.define({
    fn: async () => {
      stepEntered.resolve();
      await stepGate.promise;
      return "step done";
    },
    kind: "step",
    name: "flow",
  });
  await old.start();
  const task = await old.launch<string>("long", {});
  const flow = await old.launch<string>("flow", {});
  await stepEntered.promise;
  const { ended } = await old.retire({
    pid: thisProcess().pid + 1,
    started: null,
  });

  const next = engineHere();
  next.task({ name: "long", queue: "tasks", run: () => "elsewhere" });
  next.define({ fn: () => "elsewhere", kind: "step", name: "flow" });
  await next.start();
  expect((await storedExecution(state, task.id))?.status).toBe("running");
  expect((await storedExecution(state, flow.id))?.status).toBe("running");

  taskGate.resolve();
  stepGate.resolve();
  expect(await task.result).toBe("task done");
  expect(await flow.result).toBe("step done");
  await ended;
  expect((await storedExecution(state, task.id))?.status).toBe("complete");
  expect((await storedExecution(state, flow.id))?.status).toBe("complete");
});

it("leaves a parked run a retiring engine let go to be taken up, never closed out, when the next engine starts", async () => {
  const entered = Promise.withResolvers<void>();
  const old = engineHere();
  old.define({
    fn: async ({ signal }: { readonly signal: AbortSignal }) => {
      entered.resolve();
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      return "first";
    },
    kind: "step",
    name: "parked",
  });
  await old.start();
  const parked = await old.launch("parked", {});
  parked.result.catch(() => undefined);
  await entered.promise;
  expect(old.pause(parked.id, "parked", "hold")).toBe(true);
  await vi.waitFor(() =>
    expect(old.executions.get(parked.id)?.status).toBe("suspended")
  );
  await old.retire({ pid: thisProcess().pid + 1, started: null });

  const next = engineHere();
  next.define({ fn: () => "resumed", kind: "step", name: "parked" });
  await next.start();
  const stored = await storedExecution(state, parked.id);
  expect(stored?.status).toBe("suspended");
  await next.resume(parked.id, "parked");
  await vi.waitFor(async () =>
    expect((await storedExecution(state, parked.id))?.status).toBe("complete")
  );
});
