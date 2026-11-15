/**
 * Nothing about a run is acknowledged before the store holds it: a
 * settlement or a cancellation the store has not taken is never paid to
 * its caller, and what the store refused is never shown as done.
 */

import { expect, it } from "vitest";
import type { ExecutionRun } from "~/lib/execution-record";
import { parseStored } from "~/lib/execution-record";
import type { ExecutionStore } from "~/lib/execution-store";
import { MemoryExecutionStore } from "~/lib/execution-store";
import { Executions } from "~/lib/executions";
import { Launcher, RunNotRecordedError } from "~/lib/launcher";

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

/** `store.put`, failing for a record `fails` picks while `failing.on`. */
function failingPuts(
  store: MemoryExecutionStore,
  fails: (run: ExecutionRun) => boolean
) {
  const failing: { on: boolean } = { on: true };
  const put = store.put.bind(store);
  store.put = (run) =>
    failing.on && fails(run)
      ? Promise.reject(new Error("simulated disk failure"))
      : put(run);
  return failing;
}

it("pays a caller whose run's settlement could not be stored its failure, not its value, and stores it on a retry", async () => {
  const store = new MemoryExecutionStore();
  const failing = failingPuts(store, (run) => run.status === "complete");
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

it("tries a settlement that could not be stored again at the next settle, and fails a retry that still cannot store it", async () => {
  const store = new MemoryExecutionStore();
  const failing = failingPuts(
    store,
    (run) => run.name === "first" && run.status === "complete"
  );
  const { executions, launcher } = launcherOver(store);
  launcher.task({ name: "first", run: () => Promise.resolve(1) });
  launcher.task({ name: "second", run: () => Promise.resolve(2) });

  const first = await launcher.launch("first", null, {});
  await expect(first.result).rejects.toBeInstanceOf(RunNotRecordedError);
  await expect(executions.retrySettlements()).rejects.toThrow(
    "1 settlement(s) could not be recorded"
  );
  expect((await stored(store, first.id))?.status).toBe("running");

  failing.on = false;
  const second = await launcher.launch("second", null, {});
  await expect(second.result).resolves.toBe(2);
  await executions.flush();
  expect((await stored(store, first.id))?.status).toBe("complete");
  await expect(executions.retrySettlements()).resolves.toBeUndefined();
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
  await store.put(settled);
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
  await store.put({ ...settled, revision: 4, status: "running" });

  expect(await reader.prune(["rn-1"], () => "host")).toEqual([]);
  expect(removed).toEqual([]);
  expect((await stored(store, "rn-1"))?.status).toBe("running");
  expect(reader.get("rn-1")?.status).toBe("running");
  expect(reader.gaps()).toEqual([]);
});

it("holds what the store holds when it refuses a write as stale, never what it wrote", async () => {
  const store = new MemoryExecutionStore();
  const { executions, warnings } = launcherOver(store);
  const { run } = await executions.enqueue({
    kind: "task",
    name: "save",
    queue: "q",
  });
  // Another write takes the next revision of it first.
  await store.put({ ...run, progress: { elsewhere: true }, revision: 2 });
  executions.progress(run.id, { here: true });
  await executions.flush();

  expect(executions.get(run.id)).toMatchObject({
    progress: { elsewhere: true },
    revision: 2,
  });
  expect(warnings.join("\n")).toContain("changed by another write");
});
