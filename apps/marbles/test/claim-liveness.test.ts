import { spawn } from "node:child_process";
import { type ProcessIdentity, startedAt } from "@foundry/lib/process-identity";
import { anotherStart } from "@foundry/lib/testing/process-identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoreDatabase } from "~/database/open";
import { DatabaseRunStore } from "~/database/runs";
import {
  marblesDeliveryClaims,
  marblesScheduleTicks,
  marblesWorkflowRuns,
} from "~/database/tables";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { DatabaseTriggerStore } from "~/database/triggers";
import type { ExecutionStore } from "~/lib/execution-store";
import { MemoryExecutionStore } from "~/lib/execution-store";
import { Executions } from "~/lib/executions";
import { ANY_STORED_RUN } from "~/lib/run-store";
import { orphan } from "./helpers/executions";
import { testHome } from "./helpers/home";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

/**
 * A claim asks whether its row's owner is gone before it opens its write
 * transaction, never while it holds it, and in the transaction only
 * checks that the owner is still the one it judged: one that changed in
 * between is judged again. Every `isGone` call records whether a
 * transaction of the claim's database was open then.
 */

const watch = vi.hoisted(() => ({ asked: [] as boolean[], open: false }));

vi.mock("@foundry/lib/process-identity", async (actual) => {
  const real = await actual<typeof import("@foundry/lib/process-identity")>();
  return {
    ...real,
    isGone: (owner: ProcessIdentity) => {
      watch.asked.push(watch.open);
      return real.isGone(owner);
    },
  };
});

const machines: TestMachine[] = [];
const live: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  watch.asked.length = 0;
  for (const machine of machines.splice(0)) {
    machine.close();
  }
});

/**
 * The machine's database, with every transaction marked open while it
 * runs; `before` runs at the start of the next one only, as another
 * engine's write would land just before it.
 */
async function watched() {
  const machine = await testMachine();
  machines.push(machine);
  const raw = machine.database.database;
  const next: { before?: () => Promise<void> } = {};
  const database = new Proxy(raw, {
    get(target, name) {
      if (name === "transaction") {
        return async (
          work: (transaction: unknown) => Promise<unknown>,
          ...rest: unknown[]
        ) => {
          const { before } = next;
          next.before = undefined;
          await before?.();
          return await (
            target.transaction as (...args: unknown[]) => Promise<unknown>
          )(
            async (transaction: unknown) => {
              watch.open = true;
              try {
                return await work(transaction);
              } finally {
                watch.open = false;
              }
            },
            ...rest
          );
        };
      }
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as StoreDatabase;
  return { database, next, raw };
}

/** A live process of this test's: its identity. */
function liveProcess(): ProcessIdentity {
  const home = testHome({ providers: false });
  const child = spawn("sleep", ["60"], { env: home.env, stdio: "ignore" });
  home.track(child.pid, false);
  live.push(child);
  const pid = child.pid ?? 0;
  return { pid, started: startedAt(pid) ?? null };
}

afterEach(async () => {
  for (const child of live.splice(0)) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGKILL");
    await exited;
  }
});

const gone = (): ProcessIdentity => ({
  pid: process.pid,
  started: anotherStart(),
});

describe("a claim on a row another engine left", () => {
  it("on a Run judges its owner before its transaction, and judges again an owner that changed in between", async () => {
    const { database, next, raw } = await watched();
    const left = gone();
    await raw.insert(marblesWorkflowRuns).values({
      ledger: {},
      literals: {},
      ownerId: "gone-engine",
      ownerPid: left.pid,
      ownerStarted: left.started,
      runId: "rn-1",
      scope: "ws",
    });
    const store = new DatabaseRunStore({ database, scope: "ws" });
    // Just before its transaction, a live engine takes the Run.
    const taker = liveProcess();
    next.before = async () => {
      await raw.update(marblesWorkflowRuns).set({
        ownerId: "live-engine",
        ownerPid: taker.pid,
        ownerStarted: taker.started,
      });
    };
    expect(await store.claim("rn-1", ANY_STORED_RUN)).toBe(false);
    expect(watch.asked.length).toBeGreaterThan(1);
    expect(watch.asked.every((open) => !open)).toBe(true);
    await store.close();

    // Left again by a gone engine: taken, with no one asked under the lock.
    await raw.update(marblesWorkflowRuns).set({
      ownerId: "gone-engine",
      ownerPid: left.pid,
      ownerStarted: left.started,
    });
    watch.asked.length = 0;
    const again = new DatabaseRunStore({ database, scope: "ws" });
    expect(await again.claim("rn-1", ANY_STORED_RUN)).toBe(true);
    expect(watch.asked).toEqual([false]);
    await again.close();
  });

  it("on a tick judges its owner before its transaction", async () => {
    const { database, raw } = await watched();
    const left = gone();
    await raw.insert(marblesScheduleTicks).values({
      key: "schedule:a",
      ownerId: "gone-engine",
      ownerPid: left.pid,
      ownerStarted: left.started,
      scope: "ws",
    });
    const store = new DatabaseTriggerStore({ database, scope: "ws" });
    expect((await store.claimTick("schedule:a")).claimed).toBe(true);
    expect(watch.asked).toEqual([false]);
    // Now this process holds it: refused, still judged outside.
    watch.asked.length = 0;
    const other = new DatabaseTriggerStore({ database, scope: "ws" });
    expect(await other.claimTick("schedule:a")).toEqual({
      claimed: false,
      holder: "this process",
    });
    expect(watch.asked).toEqual([false]);
    await store.close();
    await other.close();
  });

  it("on delivering task changes judges its owner before its transaction", async () => {
    const { database, raw } = await watched();
    const left = gone();
    await raw.insert(marblesDeliveryClaims).values({
      ownerId: "gone-engine",
      ownerPid: left.pid,
      ownerStarted: left.started,
      scope: "ws",
    });
    const records = new DatabaseWorkspaceRecords({ database, scope: "ws" });
    expect(await records.claimDelivery()).toBeUndefined();
    expect(watch.asked).toEqual([false]);
    await records.releaseDelivery();
  });
});

/** A memory execution store whose transactions are marked open while they run. */
function watchedExecutions(): ExecutionStore {
  const store = new MemoryExecutionStore();
  return new Proxy(store, {
    get(target, name) {
      if (name === "transaction") {
        return (work: Parameters<ExecutionStore["transaction"]>[0]) =>
          target.transaction(async (view) => {
            watch.open = true;
            try {
              return await work(view);
            } finally {
              watch.open = false;
            }
          });
      }
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("taking over an Execution Run another process left", () => {
  it("judges its owner before the transaction that settles it, whether recovered, cancelled or withdrawn", async () => {
    const store = watchedExecutions();
    await orphan(store, { id: "rn-running", owner: gone(), status: "running" });
    await orphan(store, {
      id: "rn-parked",
      owner: gone(),
      status: "suspended",
    });
    await orphan(store, { id: "rn-queued", owner: gone(), status: "queued" });
    const executions = new Executions({ store, warn: () => undefined });
    await executions.load();
    watch.asked.length = 0;

    await executions.recover({
      adopted: new Set(),
      fileStatus: () => undefined,
      readmit: () => false,
    });
    expect(executions.get("rn-running")?.status).toBe("interrupted");
    expect(await executions.cancelOrphan("rn-parked")).toBe(true);
    expect(await executions.withdraw("rn-queued")).toBe(true);
    expect(executions.get("rn-queued")?.status).toBe("cancelled");
    expect(watch.asked.length).toBeGreaterThan(0);
    expect(watch.asked.every((open) => !open)).toBe(true);
  });
});
