import { type ChildProcess, spawn } from "node:child_process";
import {
  nodeStartedAt,
  type ProcessIdentity,
  thisProcess,
} from "@foundry/lib/node/process-identity";
import { anotherStart } from "@foundry/lib/testing/process-identity";
import { afterEach, describe, expect, it } from "vitest";
import { marblesDeliveryClaims } from "~/database/tables";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { NODE_OWNER_LIVENESS } from "~/lib/node-host-liveness";
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
  const started = nodeStartedAt(pid);
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
      const records = new DatabaseWorkspaceRecords({
        database: db,
        liveness: NODE_OWNER_LIVENESS,
        scope,
      });
      const holder = await records.claimDelivery();
      expect([name, holder === undefined]).toEqual([name, !held]);
      if (holder === undefined) {
        await records.releaseDelivery();
      }
    }
  });
});
