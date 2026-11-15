/**
 * Every trigger store keeps one contract: in memory, shared by the engines
 * handed it, and in the Marbles database, shared by every engine over it.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { initializeDatabase } from "~/database/open";
import { marblesScheduleTicks } from "~/database/tables";
import { DatabaseTriggerStore } from "~/database/triggers";
import { stateDatabase } from "~/layout";
import { MemoryTriggerStore } from "~/lib/trigger-store";
import { describeTriggerStore } from "./helpers/trigger-store";

describeTriggerStore("MemoryTriggerStore", () => {
  const shared = new MemoryTriggerStore();
  // Every store from one fixture is the same one, as engines share it.
  return Promise.resolve({
    close: () => Promise.resolve(),
    store: () => ({
      claimTick: (key) => shared.claimTick(key),
      close: () => shared.close(),
      finishTick: (key, tick) => shared.finishTick(key, tick),
      lastTick: (key) => shared.lastTick(key),
      monitorState: (key) => shared.monitorState(key),
      saveMonitorState: (key, state) => shared.saveMonitorState(key, state),
    }),
  });
});

async function database() {
  const root = mkdtempSync(join(tmpdir(), "marbles-trigger-store-"));
  const opened = await initializeDatabase(stateDatabase(root));
  return {
    close() {
      opened.close();
      rmSync(root, { force: true, recursive: true });
      return Promise.resolve();
    },
    opened,
    store: () =>
      new DatabaseTriggerStore({ database: opened.database, scope: "ws" }),
  };
}

describeTriggerStore("DatabaseTriggerStore", database);

it("lets a tick an exited process held be claimed, and says which live process holds one", async () => {
  const fixture = await database();
  try {
    const dead = spawnSync("true").pid;
    await fixture.opened.database.insert(marblesScheduleTicks).values([
      { key: "left", ownerId: "gone", ownerPid: dead, scope: "ws" },
      { key: "held", ownerId: "parent", ownerPid: process.ppid, scope: "ws" },
    ]);
    const triggers = fixture.store();
    expect(await triggers.claimTick("left")).toEqual({ claimed: true });
    expect(await triggers.claimTick("held")).toEqual({
      claimed: false,
      holder: `pid ${String(process.ppid)}`,
    });
    // A claim it does not hold is not given up by its finish.
    await triggers.finishTick("held");
    expect(await fixture.store().claimTick("held")).toMatchObject({
      claimed: false,
    });
  } finally {
    await fixture.close();
  }
});
