import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thisProcess } from "@foundry/lib/process-identity";
import { Tasks } from "@foundry/tasks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { catalog } from "~/authoring/catalog";
import { openWorkspaceRecords } from "~/database/managed";
import type { Engine } from "~/lib/engine";
import { MemoryWorkspaceRecords } from "~/lib/events/records";
import type { Fact, Handler } from "~/lib/events/source";
import { TASKS } from "~/lib/events/source";
import { testEngine } from "../helpers/engine";

let root: string;
let state: string;
const engines: Engine[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marbles-delivery-retire-"));
  state = join(root, "state");
});

afterEach(async () => {
  catalog.reset();
  await Promise.allSettled(engines.splice(0).map((engine) => engine.dispose()));
  await rm(root, { force: true, recursive: true });
});

function engineHere(): Engine {
  const engine = testEngine({
    print: () => undefined,
    records: openWorkspaceRecords({ state, workspaceId: "test" }),
    root,
    state,
  });
  engines.push(engine);
  return engine;
}

const successor = () => ({
  pid: thisProcess().pid,
  started: thisProcess().started,
});

function titles(payload: unknown): string[] {
  const { tasks } = payload as {
    readonly tasks: readonly { readonly after?: { readonly title?: string } }[];
  };
  return tasks.map((change) => change.after?.title ?? "-");
}

it("lets the next engine deliver while the retired engine's observer is still handling a change", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const old = engineHere();
  old.observe(
    TASKS,
    async () => {
      entered.resolve();
      await release.promise;
    },
    { name: "watcher" }
  );
  await old.start();
  await new Tasks({ store: old.taskStore }).create({ title: "first" });
  await entered.promise;
  const retired = await old.retire(successor());

  const next = engineHere();
  const seen: string[] = [];
  next.observe(
    TASKS,
    (payload) => {
      seen.push(...titles(payload));
    },
    { name: "watcher" }
  );
  await next.start();
  await new Tasks({ store: next.taskStore }).create({ title: "second" });
  await vi.waitFor(() => expect(seen).toContain("second"), {
    interval: 50,
    timeout: 10_000,
  });
  await retired.ended;
  release.resolve();
}, 30_000);

it("writes nothing about a handler that returns after the next engine delivered", async () => {
  const calls: string[] = [];
  const oldCall = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let failFirstOnce = true;
  const handler: Handler<Fact> = async (payload) => {
    const what = titles(payload).join(",");
    calls.push(what);
    if (calls.length === 1) {
      entered.resolve();
      await oldCall.promise;
      return;
    }
    if (what === "first" && failFirstOnce) {
      failFirstOnce = false;
      throw new Error("the next engine's first try fails");
    }
  };
  const old = engineHere();
  old.observe(TASKS, handler, { name: "watcher" });
  await old.start();
  await new Tasks({ store: old.taskStore }).create({ title: "first" });
  await entered.promise;
  await old.retire(successor());

  const next = engineHere();
  next.observe(TASKS, handler, { name: "watcher" });
  await next.start();
  await vi.waitFor(() => expect(calls).toEqual(["first", "first"]), {
    interval: 50,
    timeout: 10_000,
  });
  oldCall.resolve();
  await old.dispose();
  await new Tasks({ store: next.taskStore }).create({ title: "second" });
  await vi.waitFor(() => expect(calls).toContain("second"), {
    interval: 50,
    timeout: 10_000,
  });
  expect(calls.filter((call) => call === "first")).toHaveLength(3);
}, 30_000);

it("ends a retired engine whose handler never returns once its runs have, and stops it", async () => {
  const entered = Promise.withResolvers<void>();
  const old = engineHere();
  old.observe(
    TASKS,
    async () => {
      entered.resolve();
      await new Promise(() => undefined);
    },
    { name: "watcher" }
  );
  old.task({ name: "work", run: () => 1 });
  await old.start();
  await new Tasks({ store: old.taskStore }).create({ title: "stuck" });
  await entered.promise;
  const running = await old.launch("work", {});
  const retired = await old.retire(successor());
  await running.result;
  await retired.ended;
  await old.dispose();
  engines.splice(engines.indexOf(old), 1);
}, 30_000);

it("hands its queued runs over though giving up the delivery claim fails", async () => {
  class FailingRelease extends MemoryWorkspaceRecords {
    override releaseDelivery(): Promise<void> {
      return Promise.reject(new Error("the claim could not be given up"));
    }
  }
  const lines: string[] = [];
  const old = testEngine({
    print: (line) => lines.push(line),
    records: new FailingRelease(),
    root,
  });
  engines.push(old);
  old.observe(TASKS, () => undefined, { name: "watcher" });
  const finish = Promise.withResolvers<void>();
  old.task({ name: "active", run: () => finish.promise });
  old.task({ name: "queued", run: () => undefined });
  await old.start();
  const active = await old.launch("active", {});
  const queued = await old.launch("queued", {});
  queued.result.catch(() => undefined);
  const next = { pid: thisProcess().pid + 1, started: null };
  await old.retire(next);
  expect(old.executions.get(queued.id)?.owner).toMatchObject({
    pid: next.pid,
  });
  expect(
    lines.some((line) => line.includes("the claim could not be given up"))
  ).toBe(true);
  finish.resolve();
  await active.result;
}, 30_000);
