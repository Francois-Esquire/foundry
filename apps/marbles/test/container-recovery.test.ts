import { spawn } from "node:child_process";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { afterEach, expect, it } from "vitest";
import { workspaceStores } from "~/database/stores";
import { CrashRecovery } from "~/lib/crash-recovery";
import { MemoryRunStore } from "~/lib/run-store";
import { HarnessActivities } from "~/lib/sandbox/activities";
import { containerHolder, leftBehind } from "~/lib/sandbox/holders";
import { startedAt } from "~/process/spawned";
import { testHome } from "./helpers/home";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

/**
 * Each container row names its holder, the registry that last claimed
 * it, by its process's identity; a start takes back, with their VMs, the
 * rows whose holder is gone, keeps those a live process holds, and keeps
 * a row whose VM would not go, saying so, for the next start. The gone
 * holder is a process this test started, in its own home, and killed.
 */

const SPEC = { format: "foundry.sandbox.container/1", image: "x" } as const;
const machines: TestMachine[] = [];
const RUNS = {
  abandonRun: () => Promise.resolve(null),
  listRuns: () => Promise.resolve({ items: [], total: 0 }),
};

afterEach(() => {
  for (const machine of machines.splice(0)) {
    machine.close();
  }
});

/** The identity of a process this test started and has seen exit. */
async function goneProcess(): Promise<ProcessIdentity> {
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

async function fixture() {
  const machine = await testMachine();
  machines.push(machine);
  const stores = workspaceStores(machine.database.database, "ws");
  const runtime = createFakeContainerRuntime();
  const gone = await goneProcess();
  // A registry of the process that died; it is never shut down.
  const theirs = createContainers({
    holder: JSON.stringify({ ...gone, registry: "gone" }),
    instanceLabel: "marbles-ws",
    runtime,
    store: stores.containers,
  });
  const ours = () =>
    createContainers({
      holder: containerHolder(),
      instanceLabel: "marbles-ws",
      runtime,
      store: stores.containers,
    });
  const recovery = (registry: ReturnType<typeof ours>, lines: string[]) =>
    new CrashRecovery({
      activities: new HarnessActivities(),
      artifacts: { recover: () => Promise.resolve() },
      containerRows: stores.containers,
      containers: () => Promise.resolve(registry),
      executions: () => [],
      print: (line) => lines.push(line),
      runs: new MemoryRunStore(),
    });
  return { ours, recovery, runtime, stores, theirs };
}

it("takes back the rows a gone process held, with their VMs, and keeps those a live one holds", async () => {
  const { ours, recovery, runtime, stores, theirs } = await fixture();
  const left = await theirs.start(SPEC);
  const mine = ours();
  const held = await mine.start(SPEC);
  expect(leftBehind((await stores.containers.get(left.id)) as never)).toBe(
    true
  );
  expect(leftBehind((await stores.containers.get(held.id)) as never)).toBe(
    false
  );

  const next = ours();
  const lines: string[] = [];
  const { report } = await recovery(next, lines).recover(RUNS);

  expect(lines).toEqual([
    "[recovery] containers: done, 1 container(s) removed, 0 VM(s) swept",
  ]);
  expect(report.steps.find((step) => step.step === "containers")?.outcome).toBe(
    "done"
  );
  expect((await stores.containers.list()).map((row) => row.id)).toEqual([
    held.id,
  ]);
  const removed = new Map(runtime.instances.map((vm) => [vm.id, vm.removed]));
  expect(removed.get(`${left.id}-1`)).toBe(true);
  expect(removed.get(`${held.id}-1`)).toBe(false);

  // Again: nothing left, so the runtime is not even asked.
  lines.length = 0;
  await recovery(next, lines).recover(RUNS);
  expect(lines).toEqual([]);
  await held.close();
  await mine.shutdown();
  await next.shutdown();
});

it("reports a row whose VM would not go as failed, keeps it, and the next start removes it", async () => {
  const { ours, recovery, runtime, stores, theirs } = await fixture();
  const left = await theirs.start(SPEC);
  const stop = runtime.stopResource.bind(runtime);
  const runtimeDown: { now: boolean } = { now: true };
  runtime.stopResource = async (name) => {
    if (runtimeDown.now) {
      throw new Error("runtime offline");
    }
    await stop(name);
  };

  const first = ours();
  const { report } = await recovery(first, []).recover(RUNS);
  expect(report.steps.find((step) => step.step === "containers")).toEqual({
    detail:
      "0 container(s) removed, 0 VM(s) swept; 1 container(s) whose VM would not go kept, removing, for the next start to retry",
    outcome: "failed",
    step: "containers",
  });
  expect(await stores.containers.get(left.id)).toMatchObject({
    status: "removing",
  });

  runtimeDown.now = false;
  // A later start: the first registry's holder is this process, so it
  // stands for one that has died since with a holder of its own.
  const later = createContainers({
    holder: JSON.stringify({ pid: 1, registry: "later", started: null }),
    instanceLabel: "marbles-ws",
    runtime,
    store: stores.containers,
  });
  const lines: string[] = [];
  await recovery(later, lines).recover(RUNS);
  expect(lines).toEqual([]);
  // Held by this live process now, so a later start leaves it: shown so.
  expect(await stores.containers.get(left.id)).toMatchObject({
    status: "removing",
  });
  // Once its holder is gone, the next start finishes it.
  await stores.containers.commit({
    putContainers: [
      {
        ...((await stores.containers.get(left.id)) as NonNullable<
          Awaited<ReturnType<typeof stores.containers.get>>
        >),
        holder: JSON.stringify({ ...(await goneProcess()), registry: "x" }),
      },
    ],
  });
  await recovery(later, lines).recover(RUNS);
  expect(lines).toEqual([
    "[recovery] containers: done, 1 container(s) removed, 0 VM(s) swept",
  ]);
  expect(await stores.containers.list()).toEqual([]);
  expect(runtime.instances[0]?.removed).toBe(true);
  await first.shutdown();
  await later.shutdown();
});
