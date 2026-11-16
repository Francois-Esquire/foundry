/**
 * Every trigger store keeps one contract: in memory, shared by the engines
 * handed it, and in the Marbles database, shared by every engine over it.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { initializeDatabase } from "~/database/open";
import { marblesMonitorStates, marblesScheduleTicks } from "~/database/tables";
import { DatabaseTriggerStore } from "~/database/triggers";
import { stateDatabase } from "~/layout";
import type { MonitorState } from "~/lib/trigger-store";
import { MemoryTriggerStore } from "~/lib/trigger-store";
import { describeTriggerStore } from "./helpers/trigger-store";

describeTriggerStore(
  "MemoryTriggerStore",
  () =>
    Promise.resolve({
      close: () => Promise.resolve(),
      store: () => new MemoryTriggerStore(),
    }),
  { shared: false }
);

async function database() {
  const root = mkdtempSync(join(tmpdir(), "marbles-trigger-store-"));
  const opened = await initializeDatabase(stateDatabase(root));
  return {
    close() {
      opened.close();
      rmSync(root, { force: true, recursive: true });
      return Promise.resolve();
    },
    async leftover(key: string, state: MonitorState) {
      await opened.database
        .insert(marblesMonitorStates)
        .values({
          key,
          observed: state.observed,
          pending: state.pending ?? null,
          scope: "ws",
        })
        .onConflictDoUpdate({
          set: { observed: state.observed, pending: state.pending ?? null },
          target: [marblesMonitorStates.scope, marblesMonitorStates.key],
        });
    },
    opened,
    store: () =>
      new DatabaseTriggerStore({ database: opened.database, scope: "ws" }),
  };
}

describeTriggerStore("DatabaseTriggerStore", database, { shared: true });

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

it("returns what it kept when a monitor's save lands between its look and its drop", async () => {
  const root = mkdtempSync(join(tmpdir(), "marbles-trigger-store-"));
  const opened = await initializeDatabase(stateDatabase(root));
  const real = opened.database;
  let between: (() => Promise<void>) | undefined;
  const hooked = new Proxy(real, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === "transaction" && typeof value === "function") {
        return async (...args: unknown[]) => {
          const land = between;
          between = undefined;
          await land?.();
          return Reflect.apply(value, target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const triggers = new DatabaseTriggerStore({ database: hooked, scope: "ws" });
  try {
    const time = "2026-11-01T00:00:00.000Z";
    await triggers.claimTick("k");
    await triggers.finishTick("k", {
      kind: "schedule",
      lastFinish: time,
      lastStart: time,
      lastStatus: "complete",
      nextDue: time,
    });
    const left: MonitorState = {
      observed: { files: {} },
      pending: { input: null, workflow: "ship" },
    };
    await real.insert(marblesMonitorStates).values({
      key: "k",
      observed: left.observed,
      pending: left.pending ?? null,
      scope: "ws",
    });
    // A monitor keeps its state there after the look, before the drop.
    between = async () => {
      await real
        .update(marblesScheduleTicks)
        .set({ kind: "monitor" })
        .where(eq(marblesScheduleTicks.key, "k"));
    };
    expect(await triggers.monitorState("k")).toEqual(left);
  } finally {
    await triggers.close();
    opened.close();
    rmSync(root, { force: true, recursive: true });
  }
});
