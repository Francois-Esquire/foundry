import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import type { ProcessIdentity } from "@foundry/lib/process-identity";
import { createContainers } from "@foundry/sandbox/container/containers";
import { MemoryContainerStore } from "@foundry/sandbox/store/memory";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { afterEach, expect, it } from "vitest";
import { DatabaseRecoveryLog, readLastRecovery } from "~/database/recoveries";
import { workspaceStores } from "~/database/stores";
import { CrashRecovery } from "~/lib/crash-recovery";
import { MemoryRunStore } from "~/lib/run-store";
import { HarnessActivities } from "~/lib/sandbox/activities";
import { containerHolder, leftBehind } from "~/lib/sandbox/holders";
import { startedAt } from "~/process/spawned";
import { testHome } from "./helpers/home";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

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

  lines.length = 0;
  await recovery(next, lines).recover(RUNS);
  expect(lines).toEqual([]);
  await held.close();
  await mine.shutdown();
  await next.shutdown();
});

it("leaves a VM a live container records though it carries a gone one's id, and names it in the report", async () => {
  const { ours, recovery, runtime, stores, theirs } = await fixture();
  const left = await theirs.start(SPEC);
  const mine = ours();
  const held = await mine.start(SPEC);
  const vm = `${left.id}-1`;
  const heldRow = await stores.containers.get(held.id);
  if (heldRow === undefined) {
    throw new Error("no row");
  }
  await stores.containers.commit({
    putContainers: [{ ...heldRow, nativeId: vm }],
  });

  const { report } = await recovery(ours(), []).recover(RUNS);

  expect(report.steps.find((step) => step.step === "containers")).toEqual({
    detail: `0 container(s) removed, 0 VM(s) swept; 1 container(s) whose VM would not go kept, removing, for the next start to retry; the VM(s) ${vm} bear the id or name of one but are not provably its (another container records them, they carry no label of this store, or their name and label disagree), so they were left alone; one no engine owns is removed by hand with \`msb rm -f <name>\` (msb is node_modules/.bin/msb, in the Foundry install)`,
    outcome: "failed",
    step: "containers",
  });
  expect(runtime.instances.find((i) => i.id === vm)?.removed).toBe(false);
  expect(await stores.containers.get(held.id)).toMatchObject({
    nativeId: vm,
  });
  await held.close().catch(() => undefined);
  await mine.shutdown().catch(() => undefined);
});

it("keeps a row whose holder cannot be read, and names it on every start", async () => {
  const { ours, recovery, runtime, stores, theirs } = await fixture();
  const left = await theirs.start(SPEC);
  const row = await stores.containers.get(left.id);
  if (row === undefined) {
    throw new Error("no row");
  }
  await stores.containers.commit({
    putContainers: [{ ...row, holder: "not a holder" }],
  });
  for (let start = 0; start < 2; start += 1) {
    const lines: string[] = [];
    const { report } = await recovery(ours(), lines).recover(RUNS);
    expect(report.steps.find((step) => step.step === "containers")).toEqual({
      detail: `0 container(s) removed; 1 container(s) whose holder cannot be told gone or running kept: ${left.id}`,
      outcome: "done",
      step: "containers",
    });
    expect(lines).toEqual([
      `[recovery] containers: done, 0 container(s) removed; 1 container(s) whose holder cannot be told gone or running kept: ${left.id}`,
    ]);
  }
  expect(runtime.instances.find((i) => i.id === `${left.id}-1`)?.removed).toBe(
    false
  );
});

it("names, in its report, the VMs its sweep passed over as not provably this engine's", async () => {
  const { ours, recovery, runtime, theirs } = await fixture();
  await theirs.start(SPEC);
  const other = createContainers({
    instanceLabel: "marbles-ws",
    runtime,
    store: new MemoryContainerStore(),
  });
  const held = await other.start(SPEC);
  const { report } = await recovery(ours(), []).recover(RUNS);
  expect(
    report.steps.find((step) => step.step === "containers")?.detail
  ).toContain(
    `1 VM(s) passed over, not provably this engine's: ${held.row.nativeId}`
  );
  expect(
    runtime.instances.find((i) => i.id === held.row.nativeId)?.removed
  ).toBe(false);
  await held.close();
  await other.shutdown();
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
  const later = createContainers({
    holder: JSON.stringify({ pid: 1, registry: "later", started: null }),
    instanceLabel: "marbles-ws",
    runtime,
    store: stores.containers,
  });
  const lines: string[] = [];
  await recovery(later, lines).recover(RUNS);
  expect(lines).toEqual([]);
  expect(await stores.containers.get(left.id)).toMatchObject({
    status: "removing",
  });
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

it("takes back only its own workspace's rows and VMs, beside another workspace in the same process", async () => {
  const machine = await testMachine();
  machines.push(machine);
  const runtime = createFakeContainerRuntime();
  const registry = (scope: string, holder: string) =>
    createContainers({
      holder,
      instanceLabel: `marbles-${scope}`,
      runtime,
      store: workspaceStores(machine.database.database, scope).containers,
    });
  const gone = await goneProcess();
  const alphaLive = registry("alpha", containerHolder());
  const alphaHeld = await alphaLive.start(SPEC);
  const alphaLeft = await registry(
    "alpha",
    JSON.stringify({ ...gone, registry: "gone" })
  ).start(SPEC);
  const betaLeft = await registry(
    "beta",
    JSON.stringify({ ...gone, registry: "gone" })
  ).start(SPEC);

  const beta = workspaceStores(machine.database.database, "beta");
  const betaNext = registry("beta", containerHolder());
  const lines: string[] = [];
  await new CrashRecovery({
    activities: new HarnessActivities(),
    artifacts: { recover: () => Promise.resolve() },
    containerRows: beta.containers,
    containers: () => Promise.resolve(betaNext),
    executions: () => [],
    print: (line) => lines.push(line),
    runs: new MemoryRunStore(),
  }).recover(RUNS);

  expect(lines).toEqual([
    "[recovery] containers: done, 1 container(s) removed, 0 VM(s) swept",
  ]);
  const removed = new Map(runtime.instances.map((vm) => [vm.id, vm.removed]));
  expect(removed.get(`${betaLeft.id}-1`)).toBe(true);
  expect(removed.get(`${alphaHeld.id}-1`)).toBe(false);
  expect(removed.get(`${alphaLeft.id}-1`)).toBe(false);
  const alpha = workspaceStores(machine.database.database, "alpha");
  expect((await alpha.containers.list()).map((row) => row.id).sort()).toEqual(
    [alphaHeld.id, alphaLeft.id].sort()
  );
  expect(await beta.containers.list()).toEqual([]);
  await alphaHeld.close();
  await alphaLive.shutdown();
  await betaNext.shutdown();
});

it("keeps the names of passed-over VMs in the report as the database keeps it and marbles status reads it", async () => {
  const { ours, runtime, stores, theirs } = await fixture();
  await theirs.start(SPEC);
  const other = createContainers({
    instanceLabel: "marbles-ws",
    runtime,
    store: new MemoryContainerStore(),
  });
  const held = await other.start(SPEC);
  const machine = machines.at(-1);
  if (machine === undefined) {
    throw new Error("no machine");
  }
  const log = new DatabaseRecoveryLog({
    database: machine.database.database,
    scope: "ws",
  });
  const recovered = new CrashRecovery({
    activities: new HarnessActivities(),
    artifacts: { recover: () => Promise.resolve() },
    containerRows: stores.containers,
    containers: () => Promise.resolve(ours()),
    executions: () => [],
    print: () => undefined,
    runs: new MemoryRunStore(),
  });
  const { report } = await recovered.recover(RUNS);
  await log.record(report);
  const read = await readLastRecovery(machine.root, "ws");
  expect(
    read?.steps.find((step) => step.step === "containers")?.detail
  ).toContain(`not provably this engine's: ${held.row.nativeId}`);
  await held.close();
  await other.shutdown();
});

it("binds a workspace's container store identity to its database file: a copy of the file has another", async () => {
  const machine = await testMachine();
  machines.push(machine);
  const at = realpathSync(machine.database.file);
  const original = await workspaceStores(machine.database.database, "ws", {
    location: at,
  }).containers.identity();
  expect(
    await workspaceStores(machine.database.database, "ws", {
      location: at,
    }).containers.identity()
  ).toBe(original);
  expect(
    await workspaceStores(machine.database.database, "ws", {
      location: `${at}.copy`,
    }).containers.identity()
  ).not.toBe(original);
});
