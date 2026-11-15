import { spawn } from "node:child_process";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { workspaceStores } from "~/database/stores";
import { marblesContainerOwners } from "~/database/tables";
import { CrashRecovery } from "~/lib/crash-recovery";
import { MemoryRunStore } from "~/lib/run-store";
import { HarnessActivities } from "~/lib/sandbox/activities";
import { startedAt } from "~/process/spawned";
import { testHome } from "./helpers/home";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

/**
 * Each container row is filed with the process that last wrote it, in the
 * row's own commit; a start takes back, with their VMs, the rows whose
 * holder is gone, and leaves those a live process holds. The gone holder
 * here is a process this test started, in its own home, and killed.
 */

const SPEC = { format: "foundry.sandbox.container/1", image: "x" } as const;
const machines: TestMachine[] = [];

afterEach(() => {
  for (const machine of machines.splice(0)) {
    machine.close();
  }
});

/** The identity of a process this test started and has seen exit. */
async function goneProcess(): Promise<{ pid: number; started: string }> {
  const home = testHome({ providers: false });
  const child = spawn("sleep", ["60"], { env: home.env, stdio: "ignore" });
  home.track(child.pid, false);
  const pid = child.pid ?? 0;
  const started = startedAt(pid);
  if (typeof started !== "string") {
    throw new Error("no start time");
  }
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGKILL");
  await exited;
  return { pid, started };
}

it("takes back the container rows a gone process holds, with their VMs, and keeps the rest", async () => {
  const machine = await testMachine();
  machines.push(machine);
  const { database } = machine.database;
  const stores = workspaceStores(database, "ws");
  const runtime = createFakeContainerRuntime();
  const first = createContainers({
    instanceLabel: "marbles-ws",
    runtime,
    store: stores.containers,
  });
  const left = await first.start(SPEC);
  const held = await first.start(SPEC);
  const holders = await database.select().from(marblesContainerOwners);
  expect(holders.map((row) => row.ownerPid)).toEqual([
    process.pid,
    process.pid,
  ]);
  expect(await stores.containerOwners.anyLeft()).toBe(false);

  // As though a process that has since died had written `left` last.
  const gone = await goneProcess();
  await database
    .update(marblesContainerOwners)
    .set({ ownerPid: gone.pid, ownerStarted: gone.started })
    .where(
      and(
        eq(marblesContainerOwners.scope, "ws"),
        eq(marblesContainerOwners.containerId, left.id)
      )
    );
  expect(await stores.containerOwners.anyLeft()).toBe(true);
  expect(await stores.containerOwners.left(left.id)).toBe(true);
  expect(await stores.containerOwners.left(held.id)).toBe(false);

  const next = createContainers({
    instanceLabel: "marbles-ws",
    runtime,
    store: stores.containers,
  });
  const lines: string[] = [];
  const recovery = new CrashRecovery({
    activities: new HarnessActivities(),
    artifacts: { recover: () => Promise.resolve() },
    containerOwners: stores.containerOwners,
    containers: () => Promise.resolve(next),
    executions: () => [],
    print: (line) => lines.push(line),
    runs: new MemoryRunStore(),
  });
  const store = {
    abandonRun: () => Promise.resolve(null),
    listRuns: () => Promise.resolve({ items: [], total: 0 }),
  };
  await recovery.recover(store);

  expect(lines).toEqual([
    "[recovery] containers: done, 1 container(s) removed, 0 VM(s) swept",
  ]);
  expect((await stores.containers.list()).map((row) => row.id)).toEqual([
    held.id,
  ]);
  const removed = new Map(runtime.instances.map((vm) => [vm.id, vm.removed]));
  expect(removed.get(`${left.id}-1`)).toBe(true);
  expect(removed.get(`${held.id}-1`)).toBe(false);
  expect(
    (await database.select().from(marblesContainerOwners)).map(
      (row) => row.containerId
    )
  ).toEqual([held.id]);

  // Again: nothing left, so the runtime is not even asked.
  await recovery.recover(store);
  expect(lines).toHaveLength(1);
  // `first` stands for the process that died: it is never shut down.
  await held.close();
  await next.shutdown();
});
