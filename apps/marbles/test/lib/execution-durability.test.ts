/**
 * Nothing about a run is acknowledged before the store holds it: a
 * settlement or a cancellation the store has not taken is never paid to
 * its caller, and what the store refused is never shown as done.
 */

import { expect, it, vi } from "vitest";
import type { ExecutionRun } from "~/lib/execution-record";
import { parseStored } from "~/lib/execution-record";
import type { ExecutionStore, LifecycleChange } from "~/lib/execution-store";
import { MemoryExecutionStore } from "~/lib/execution-store";
import { Executions } from "~/lib/executions";
import { Launcher, RunNotRecordedError } from "~/lib/launcher";
import { seedExecution } from "../helpers/executions";

/** A launcher over `store`, running host tasks only. */
function launcherOver(store: ExecutionStore) {
  const warnings: string[] = [];
  const executions = new Executions({
    store,
    warn: (line) => warnings.push(line),
  });
  const launcher = new Launcher({
    agents: () => ({}) as never,
    executions,
    print: () => undefined,
    recoverQueued: false,
    sandbox: () => ({}) as never,
    workflows: {
      cancel: () => Promise.resolve(),
      dispatch: () => Promise.reject(new Error("no workflows here")),
      has: () => false,
    },
  });
  return { executions, launcher, warnings };
}

async function stored(
  store: ExecutionStore,
  id: string
): Promise<ExecutionRun | undefined> {
  const kept = await store.get(id);
  return kept && parseStored(kept);
}

/**
 * `store.transition`, failing for a lifecycle change `fails` picks while
 * `failing.on`, counting every one it fails.
 */
function failingPuts(
  store: MemoryExecutionStore,
  fails: (id: string, change: LifecycleChange) => boolean
) {
  const failing: { failed: number; on: boolean } = { failed: 0, on: true };
  const transition = store.transition.bind(store);
  store.transition = (id, change) => {
    if (failing.on && fails(id, change)) {
      failing.failed += 1;
      return Promise.reject(new Error("simulated disk failure"));
    }
    return transition(id, change);
  };
  return failing;
}

it("pays a caller whose run's settlement could not be stored its failure, not its value, and stores it on a retry", async () => {
  const store = new MemoryExecutionStore();
  const failing = failingPuts(
    store,
    (_id, change) => change.status === "complete"
  );
  const { executions, launcher } = launcherOver(store);
  launcher.task({ name: "answer", run: () => Promise.resolve(42) });

  const launched = await launcher.launch("answer", null, {});
  const outcome = await launched.result.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );

  expect(outcome).toMatchObject({ error: expect.any(RunNotRecordedError) });
  // Not settled here either, since the store does not say so.
  expect(executions.get(launched.id)?.status).toBe("running");
  expect((await stored(store, launched.id))?.status).toBe("running");

  failing.on = false;
  await executions.retrySettlements();
  expect(executions.get(launched.id)?.status).toBe("complete");
  expect((await stored(store, launched.id))?.status).toBe("complete");
});

it("leaves a settlement that could not be stored to its own retry, which another run's settle does not make, and fails a retry that still cannot store it", async () => {
  const store = new MemoryExecutionStore();
  const firsts = new Set<string>();
  const failing = failingPuts(
    store,
    (id, change) => firsts.has(id) && change.status === "complete"
  );
  const { executions, launcher } = launcherOver(store);
  launcher.task({ name: "first", run: () => Promise.resolve(1) });
  launcher.task({ name: "second", run: () => Promise.resolve(2) });

  const gate = Promise.withResolvers<void>();
  launcher.task({ name: "held", run: () => gate.promise.then(() => 1) });
  const first = await launcher.launch("held", null, {});
  firsts.add(first.id);
  gate.resolve();
  await expect(first.result).rejects.toBeInstanceOf(RunNotRecordedError);
  await expect(executions.retrySettlements()).rejects.toThrow(
    "1 settlement(s) could not be recorded"
  );
  expect((await stored(store, first.id))?.status).toBe("running");

  failing.on = false;
  const second = await launcher.launch("second", null, {});
  await expect(second.result).resolves.toBe(2);
  await executions.flush();
  // Another run's settle tries nothing again: the retry's schedule does.
  expect((await stored(store, first.id))?.status).toBe("running");
  await expect(executions.retrySettlements()).resolves.toBeUndefined();
  expect((await stored(store, first.id))?.status).toBe("complete");
  executions.stopRetrying();
});

it("returns from cancelling a queued run only once its cancellation is stored", async () => {
  const store = new MemoryExecutionStore();
  const { launcher } = launcherOver(store);
  const gate = Promise.withResolvers<void>();
  launcher.task({ name: "block", run: () => gate.promise });
  const running = await launcher.launch("block", null, {});
  const queued = await launcher.launch("block", null, {});
  queued.result.catch(() => undefined);

  // The cancellation's transaction waits before it reads and writes.
  const transaction = store.transaction.bind(store);
  const written = Promise.withResolvers<void>();
  store.transaction = async (work) => {
    await written.promise;
    return await transaction(work);
  };
  let returned = false;
  let rejected = false;
  queued.result.catch(() => {
    rejected = true;
  });
  const cancelling = launcher.cancel(queued.id).then(() => {
    returned = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Still queued on disk: neither the cancel nor the caller is answered.
  expect((await stored(store, queued.id))?.status).toBe("queued");
  expect({ rejected, returned }).toEqual({ rejected: false, returned: false });

  written.resolve();
  await cancelling;
  expect((await stored(store, queued.id))?.status).toBe("cancelled");
  expect(rejected).toBe(true);
  gate.resolve();
  await running.result;
});

it("leaves a queued run queued, in its place, when its cancellation cannot be stored", async () => {
  const store = new MemoryExecutionStore();
  // Off until the cancellation: every write of the memory store is one.
  const failing: { on: boolean } = { on: false };
  const transaction = store.transaction.bind(store);
  store.transaction = (work) =>
    failing.on
      ? Promise.reject(new Error("simulated disk failure"))
      : transaction(work);
  const { executions, launcher } = launcherOver(store);
  const gate = Promise.withResolvers<void>();
  const ran: string[] = [];
  launcher.task({
    name: "block",
    run: async (input) => {
      const { label } = input as { readonly label: string };
      ran.push(label);
      if (label === "first") {
        await gate.promise;
      }
      return label;
    },
  });
  const first = await launcher.launch("block", { label: "first" }, {});
  const queued = await launcher.launch("block", { label: "second" }, {});

  failing.on = true;
  await expect(launcher.cancel(queued.id)).rejects.toThrow(
    "simulated disk failure"
  );
  expect((await stored(store, queued.id))?.status).toBe("queued");
  expect(executions.waiting()).toEqual([queued.id]);

  failing.on = false;
  gate.resolve();
  await first.result;
  await expect(queued.result).resolves.toBe("second");
  expect(ran).toEqual(["first", "second"]);
});

it("never prunes a run the store holds unsettled, whatever this process last saw of it", async () => {
  const store = new MemoryExecutionStore();
  const at = new Date().toISOString();
  const settled: ExecutionRun = {
    correlation: {},
    id: "rn-1",
    kind: "task",
    name: "save",
    observations: [],
    owner: { pid: process.pid },
    queue: "q",
    revision: 3,
    sequence: 1,
    status: "complete",
    timestamps: { queuedAt: at, settledAt: at, updatedAt: at },
  };
  await store.create(settled);
  const removed: string[] = [];
  const reader = new Executions({
    removed: (run) => {
      removed.push(run.id);
    },
    store,
    warn: () => undefined,
  });
  await reader.load();
  // The store moves on after the reader looked: it is not settled there.
  await seedExecution(store, { ...settled, revision: 4, status: "running" });

  expect(await reader.prune(["rn-1"], () => "host")).toEqual([]);
  expect(removed).toEqual([]);
  expect((await stored(store, "rn-1"))?.status).toBe("running");
  expect(reader.get("rn-1")?.status).toBe("running");
  expect(reader.gaps()).toEqual([]);
});

it("settles a run its owner finished though another engine's progress changed it meanwhile", async () => {
  const store = new MemoryExecutionStore();
  const { executions, launcher } = launcherOver(store);
  const gate = Promise.withResolvers<void>();
  launcher.task({ name: "collide", run: () => gate.promise.then(() => 42) });
  const launched = await launcher.launch("collide", null, {});
  // Another reader of the same store reports progress while it runs.
  const reader = new Executions({ store, warn: () => undefined });
  await reader.load();
  reader.progress(launched.id, { reader: true });
  await reader.flush();
  gate.resolve();

  await expect(launched.result).resolves.toBe(42);
  expect(await stored(store, launched.id)).toMatchObject({
    progress: { reader: true },
    status: "complete",
  });
  expect(executions.get(launched.id)?.status).toBe("complete");
  await expect(executions.retrySettlements()).resolves.toBeUndefined();
});

it("drops progress reported while a settle is being written, and never undoes the settle", async () => {
  const store = new MemoryExecutionStore();
  const { executions, launcher } = launcherOver(store);
  const transition = store.transition.bind(store);
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  store.transition = async (id, change) => {
    if (change.status === "complete") {
      entered.resolve();
      await held.promise;
    }
    return await transition(id, change);
  };
  let report: ((value: never) => void) | undefined;
  launcher.task({
    name: "settle-race",
    run: (_input, context) => {
      report = context.progress as (value: never) => void;
      return Promise.resolve(42);
    },
  });
  const launched = await launcher.launch("settle-race", null, {});
  await entered.promise;
  report?.({ n: 1 } as never);
  report?.({ n: 2 } as never);
  held.resolve();

  await expect(launched.result).resolves.toBe(42);
  await executions.flush();
  expect((await stored(store, launched.id))?.status).toBe("complete");
  expect(executions.get(launched.id)?.status).toBe("complete");
});

it("records a run running once it starts, whatever progress lands while the start is written", async () => {
  const store = new MemoryExecutionStore();
  const { executions, launcher } = launcherOver(store);
  const transition = store.transition.bind(store);
  const entered = Promise.withResolvers<string>();
  const held = Promise.withResolvers<void>();
  store.transition = async (runId, change) => {
    if (change.status === "running") {
      entered.resolve(runId);
      await held.promise;
    }
    return await transition(runId, change);
  };
  const body = Promise.withResolvers<void>();
  let ran = false;
  launcher.task({
    name: "start-race",
    run: () => {
      ran = true;
      return body.promise;
    },
  });
  const launching = launcher.launch("start-race", 123, {});
  const id = await entered.promise;
  executions.progress(id, { n: 1 });
  executions.progress(id, { n: 2 });
  held.resolve();
  const launched = await launching;
  await executions.flush();

  expect(ran).toBe(true);
  expect(await stored(store, id)).toMatchObject({
    progress: { n: 2 },
    status: "running",
  });
  body.resolve();
  await launched.result;
});

it("keeps a queue's order while a cancellation is written, and after it fails", async () => {
  const store = new MemoryExecutionStore();
  const { launcher } = launcherOver(store);
  const gates = [0, 1, 2].map(() => Promise.withResolvers<void>());
  const ran: number[] = [];
  launcher.task({
    name: "fifo",
    run: async (input) => {
      const index = input as number;
      ran.push(index);
      await gates[index]?.promise;
      return index;
    },
  });
  const first = await launcher.launch("fifo", 0, {});
  const second = await launcher.launch("fifo", 1, {});
  const third = await launcher.launch("fifo", 2, {});
  // The cancellation's transaction, and only it, waits and then fails.
  const transaction = store.transaction.bind(store);
  const held = Promise.withResolvers<void>();
  store.transaction = async () => {
    store.transaction = transaction;
    await held.promise;
    throw new Error("simulated disk failure");
  };
  const cancelling = launcher
    .cancel(second.id)
    .catch((error: unknown) => error);
  // The first's work ends while the second's cancellation is written: the
  // third is not let in ahead of the second.
  gates[0]?.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(ran).toEqual([0]);
  held.resolve();
  expect(await cancelling).toBeInstanceOf(Error);
  await first.result;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(ran).toEqual([0, 1]);
  gates[1]?.resolve();
  gates[2]?.resolve();
  await second.result;
  await third.result;
  expect(ran).toEqual([0, 1, 2]);
});

it("retries failed settlements on one schedule, each once a try and waiting longer after each failed try", async () => {
  vi.useFakeTimers();
  try {
    const store = new MemoryExecutionStore();
    const failing = failingPuts(
      store,
      (_id, change) => change.status === "complete"
    );
    const { executions } = launcherOver(store);
    const ids: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const { run } = await executions.enqueue({
        kind: "task",
        name: "work",
        queue: "q",
      });
      ids.push(run.id);
    }
    for (const id of ids) {
      await expect(executions.settle(id, "complete")).rejects.toThrow(
        "simulated disk failure"
      );
    }
    // One attempt each: a settle never retries the others.
    expect(failing.failed).toBe(40);
    await vi.advanceTimersByTimeAsync(100);
    expect(failing.failed).toBe(80);
    // The next try waits twice as long.
    await vi.advanceTimersByTimeAsync(199);
    expect(failing.failed).toBe(80);
    await vi.advanceTimersByTimeAsync(1);
    expect(failing.failed).toBe(120);
    failing.on = false;
    await vi.advanceTimersByTimeAsync(400);
    for (const id of ids) {
      expect((await stored(store, id))?.status).toBe("complete");
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failing.failed).toBe(120);
    executions.stopRetrying();
  } finally {
    vi.useRealTimers();
  }
});
