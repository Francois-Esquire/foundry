import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thisProcess } from "@foundry/lib/process-identity";
import { Tasks } from "@foundry/tasks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { catalog } from "~/authoring/catalog";
import { openWorkspaceRecords } from "~/database/managed";
import type { Engine } from "~/lib/engine";
import type { Handler } from "~/lib/events/source";
import { TASKS } from "~/lib/events/source";
import { testEngine } from "../helpers/engine";

/**
 * An engine that has begun to retire does not stand in the way of its
 * successor's delivery: it gives the delivery claim up at once, not when
 * a handler still running returns, and writes nothing about that handler
 * afterwards, so the successor's record of what it delivered wins. A
 * handler that never returns holds nothing: the retired engine ends once
 * its runs have.
 */

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

/** An engine over the shared database, its tasks kept there too. */
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

/** The titles a change's payload carries. */
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
  old.observe(TASKS, async () => {
    entered.resolve();
    await release.promise;
  });
  await old.start();
  await new Tasks({ store: old.taskStore }).create({ title: "first" });
  await entered.promise;
  const retired = await old.retire(successor());

  const next = engineHere();
  const seen: string[] = [];
  next.observe(TASKS, (payload) => {
    seen.push(...titles(payload));
  });
  await next.start();
  await new Tasks({ store: next.taskStore }).create({ title: "second" });
  // The next engine takes the claim on its tick and delivers, the old
  // handler still running.
  await vi.waitFor(() => expect(seen).toContain("second"), {
    interval: 50,
    timeout: 10_000,
  });
  // The retired engine has no runs: it has ended, its handler or not.
  await retired.ended;
  release.resolve();
}, 30_000);

it("writes nothing about a handler that returns after the next engine delivered", async () => {
  // One observer, the same handler in both engines: its calls say which.
  const calls: string[] = [];
  const oldCall = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let failFirstOnce = true;
  const handler: Handler<unknown> = async (payload) => {
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
  old.observe(TASKS, handler);
  await old.start();
  await new Tasks({ store: old.taskStore }).create({ title: "first" });
  await entered.promise;
  await old.retire(successor());

  const next = engineHere();
  next.observe(TASKS, handler);
  await next.start();
  // The next engine is handed "first" and fails it: not completed there.
  await vi.waitFor(() => expect(calls).toEqual(["first", "first"]), {
    interval: 50,
    timeout: 10_000,
  });
  // The old call returns now, late; once the old engine is gone, all it
  // did is done.
  oldCall.resolve();
  await old.dispose();
  // The next change makes the next engine look again: "first" is still
  // its to complete, the late return having recorded nothing.
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
  old.observe(TASKS, async () => {
    entered.resolve();
    await new Promise(() => undefined);
  });
  old.task({ name: "work", run: () => 1 });
  await old.start();
  await new Tasks({ store: old.taskStore }).create({ title: "stuck" });
  await entered.promise;
  const running = await old.launch("work", {});
  const retired = await old.retire(successor());
  await running.result;
  await retired.ended;
  // Its stop waits for nothing the handler holds.
  await old.dispose();
  engines.splice(engines.indexOf(old), 1);
}, 30_000);
