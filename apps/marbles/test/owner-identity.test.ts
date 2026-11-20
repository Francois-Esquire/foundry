import { type ChildProcess, spawn } from "node:child_process";
import {
  type ProcessIdentity,
  startedAt,
  thisProcess,
} from "@foundry/lib/process-identity";
import { anotherStart } from "@foundry/lib/testing/process-identity";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseRunStore } from "~/database/runs";
import {
  marblesDeliveryClaims,
  marblesScheduleTicks,
  marblesWorkflowRuns,
} from "~/database/tables";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { DatabaseTriggerStore } from "~/database/triggers";
import { ANY_STORED_RUN } from "~/lib/run-store";
import { testHome } from "./helpers/home";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

const LONG_AGO = anotherStart();
const machines: TestMachine[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGKILL");
    await exited;
  }
  for (const machine of machines.splice(0)) {
    machine.close();
  }
});

function liveProcess(): ProcessIdentity {
  const home = testHome({ providers: false });
  const child = spawn("sleep", ["60"], { env: home.env, stdio: "ignore" });
  home.track(child.pid, false);
  children.push(child);
  const pid = child.pid ?? 0;
  const started = startedAt(pid);
  if (typeof started !== "string") {
    throw new Error("no start time for the sleep");
  }
  return { pid, started };
}

async function database() {
  const machine = await testMachine();
  machines.push(machine);
  return machine.database.database;
}

function holders(): readonly [string, ProcessIdentity, boolean][] {
  const live = liveProcess();
  const self = thisProcess();
  return [
    ["a live process", live, true],
    [
      "a live pid that started at another time",
      { ...live, started: LONG_AGO },
      false,
    ],
    [
      "this process's pid, from before it started",
      { ...self, started: LONG_AGO },
      false,
    ],
  ];
}

describe("a claim recorded by another engine", () => {
  it("on a Run is held only while its holder, by pid and start time, is there", async () => {
    const db = await database();
    for (const [name, owner, held] of holders()) {
      const runId = `rn-${name.replaceAll(" ", "-")}`;
      await db.insert(marblesWorkflowRuns).values({
        ledger: {},
        literals: {},
        ownerId: "another-engine",
        ownerPid: owner.pid,
        ownerStarted: owner.started,
        runId,
        scope: "ws",
      });
      const store = new DatabaseRunStore({ database: db, scope: "ws" });
      expect([name, await store.claim(runId, ANY_STORED_RUN)]).toEqual([
        name,
        !held,
      ]);
      await store.close();
    }
  });

  it("on a tick is held only while its holder is there", async () => {
    const db = await database();
    for (const [name, owner, held] of holders()) {
      const key = `schedule:${name}`;
      await db.insert(marblesScheduleTicks).values({
        key,
        ownerId: "another-engine",
        ownerPid: owner.pid,
        ownerStarted: owner.started,
        scope: "ws",
      });
      const store = new DatabaseTriggerStore({ database: db, scope: "ws" });
      expect([name, (await store.claimTick(key)).claimed]).toEqual([
        name,
        !held,
      ]);
      await store.close();
    }
  });

  it("on delivering a workspace's task changes is held only while its holder is there", async () => {
    const db = await database();
    for (const [name, owner, held] of holders()) {
      const scope = `ws-${name.replaceAll(" ", "-")}`;
      await db.insert(marblesDeliveryClaims).values({
        ownerId: "another-engine",
        ownerPid: owner.pid,
        ownerStarted: owner.started,
        scope,
      });
      const records = new DatabaseWorkspaceRecords({ database: db, scope });
      const holder = await records.claimDelivery();
      expect([name, holder === undefined]).toEqual([name, !held]);
      if (holder === undefined) {
        await records.releaseDelivery();
      }
    }
  });
});
