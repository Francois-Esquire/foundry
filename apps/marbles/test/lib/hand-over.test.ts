import { join } from "node:path";
import { thisProcess } from "@foundry/lib/node/process-identity";
import { expect, it, vi } from "vitest";
import type { Engine } from "~/lib/engine";
import {
  executionFixture,
  gate,
  storedExecution,
  until,
} from "../helpers/executions";

const fixture = executionFixture();

function worker(engine: Engine, label: string, ran: string[]) {
  const finish = gate();
  engine.task<{ readonly n: number }, string>({
    name: "work",
    pool: "system",
    run: async ({ n }) => {
      ran.push(`${label}:${String(n)}`);
      if (n === 1) {
        await finish.opened;
      }
      return label;
    },
  });
  return finish;
}

it("hands its queued runs to the next engine, which runs them, while its running run finishes untouched", async () => {
  const state = join(fixture.root, "state");
  const ran: string[] = [];
  const old = fixture.engine({ state });
  const finish = worker(old, "old", ran);
  await old.start();
  const running = await old.launch<string>("work", { n: 1 });
  await until(() => ran.length === 1);
  const queued = await Promise.all(
    [2, 3].map((n) => old.launch<string>("work", { n }))
  );
  const next = fixture.engine({ state });
  worker(next, "next", ran);
  await next.start();

  const handed: string[] = [];
  const { ended } = await old.retire(thisProcess(), {
    onHanded: (runId) => handed.push(runId),
  });
  expect(handed.sort()).toEqual(queued.map((run) => run.id).sort());
  for (const run of queued) {
    await expect(run.result).rejects.toThrow(
      "handed to the next engine generation"
    );
  }
  await vi.waitFor(
    async () => {
      for (const run of queued) {
        expect((await storedExecution(state, run.id))?.status).toBe("complete");
      }
    },
    { timeout: 5000 }
  );
  expect(ran).toEqual(["old:1", "next:2", "next:3"]);
  expect(old.executions.get(running.id)?.status).toBe("running");

  finish.open();
  expect(await running.result).toBe("old");
  await ended;
  expect((await storedExecution(state, running.id))?.status).toBe("complete");
});

it("refuses a top-level launch once it has begun to retire, as moving to the next engine", async () => {
  const engine = fixture.engine();
  engine.task({ name: "work", run: () => "done" });
  await engine.start();
  await engine.retire({ pid: thisProcess().pid + 1, started: null });
  await expect(engine.launch("work", {})).rejects.toMatchObject({
    message:
      "work was not launched: this engine is retiring; launch it on the next engine generation",
    name: "EngineRetiringError",
  });
});

it("settles its callers' results when another engine cancels their runs, running or queued", async () => {
  const state = join(fixture.root, "state");
  const owner = fixture.engine({ state });
  owner.task({
    name: "hold",
    run: async (_input, { signal }) => {
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true })
      );
    },
  });
  await owner.start();
  const other = fixture.engine({ state });
  other.task({ name: "hold", run: () => undefined });
  await other.start();
  const running = await owner.launch("hold", {});
  const queued = await owner.launch("hold", {});

  await other.cancel(queued.id);
  await other.cancel(running.id);

  await expect(running.result).rejects.toThrow();
  await expect(queued.result).rejects.toThrow();
  expect(owner.executions.get(running.id)?.status).toBe("cancelled");
  expect(owner.executions.get(queued.id)?.status).toBe("cancelled");
});

it("launches one run for a key launched twice at once, task or workflow", async () => {
  const engine = fixture.engine();
  const finish = gate();
  engine.task({ name: "keyed-task", run: () => finish.opened });
  engine.define({
    fn: () => finish.opened,
    kind: "step",
    name: "keyed-flow",
  });
  await engine.start();
  const launchTwice = (name: string) =>
    Promise.all(
      [0, 1].map(() => engine.launch(name, {}, { idempotencyKey: name }))
    );
  const tasks = await launchTwice("keyed-task");
  const flows = await launchTwice("keyed-flow");
  finish.open();
  await Promise.all([...tasks, ...flows].map((launched) => launched.result));
  expect(new Set(tasks.map((launched) => launched.id)).size).toBe(1);
  expect(new Set(flows.map((launched) => launched.id)).size).toBe(1);
  expect(engine.executions.list().map((run) => [run.name, run.status])).toEqual(
    [
      ["keyed-task", "complete"],
      ["keyed-flow", "complete"],
    ]
  );
  expect(
    (await engine.runs()).filter((run) => run.id === flows[0]?.id)
  ).toHaveLength(1);
});

it("follows a keyed run another engine launched to its end when launched again with the key", async () => {
  const state = join(fixture.root, "state");
  const finish = gate();
  const ran: string[] = [];
  const owner = fixture.engine({ state });
  owner.task({
    name: "keyed",
    run: async () => {
      ran.push("owner");
      await finish.opened;
    },
  });
  await owner.start();
  const other = fixture.engine({ state });
  other.task({ name: "keyed", run: () => ran.push("other") });
  await other.start();
  const first = await owner.launch("keyed", {}, { idempotencyKey: "keyed" });
  const again = await other.launch("keyed", {}, { idempotencyKey: "keyed" });
  finish.open();
  await first.result;
  await expect(again.result).resolves.toBeNull();
  expect(again.id).toBe(first.id);
  expect(ran).toEqual(["owner"]);
});
