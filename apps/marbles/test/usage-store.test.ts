import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { initializeDatabase } from "~/database/open";
import { marblesUsageFacts } from "~/database/tables";
import { DatabaseUsageStore } from "~/database/usage";
import { stateDatabase } from "~/layout";
import { UsageLedger } from "~/lib/usage";
import { MemoryUsageStore } from "~/lib/usage-store";
import { describeUsageStore, directFact, runFact } from "./helpers/usage-store";

describeUsageStore(
  "MemoryUsageStore",
  () =>
    Promise.resolve({
      close: () => Promise.resolve(),
      store: () => new MemoryUsageStore(),
    }),
  { shared: false }
);

async function database() {
  const root = mkdtempSync(join(tmpdir(), "marbles-usage-store-"));
  const opened = await initializeDatabase(stateDatabase(root));
  return {
    close() {
      opened.close();
      rmSync(root, { force: true, recursive: true });
      return Promise.resolve();
    },
    opened,
    store: () =>
      new DatabaseUsageStore({ database: opened.database, scope: "ws" }),
  };
}

describeUsageStore("DatabaseUsageStore", database, { shared: true });

it("counts a stored fact that is not one where its row is filed, and keeps another workspace's apart", async () => {
  const fixture = await database();
  try {
    await fixture.opened.database.insert(marblesUsageFacts).values([
      {
        fact: { version: 9 },
        revision: 1,
        runId: "rn-1",
        scope: "ws",
        turnId: "x",
      },
      { fact: "garbage", revision: 2, runId: null, scope: "ws", turnId: "y" },
    ]);
    await new DatabaseUsageStore({
      database: fixture.opened.database,
      scope: "other",
    }).save(runFact("z", "rn-2"));
    const ledger = new UsageLedger(fixture.store());
    await ledger.record(directFact("good"));
    const records = await ledger.read();
    expect(records.facts.map((fact) => fact.turnId)).toEqual(["good"]);
    expect(records.unreadable).toBe(2);
    expect(records.unreadableAt).toEqual({
      direct: 1,
      runs: new Map([["rn-1", 1]]),
      unowned: 0,
    });
  } finally {
    await fixture.close();
  }
});

it("rereads facts another engine saved, and holds its read while nothing changed", async () => {
  const fixture = await database();
  try {
    const reader = new UsageLedger(fixture.store());
    const writer = new UsageLedger(fixture.store());
    const empty = await reader.read();
    expect(await reader.read()).toBe(empty);
    await writer.record(directFact("a"));
    expect((await reader.read()).facts.map((fact) => fact.turnId)).toEqual([
      "a",
    ]);
  } finally {
    await fixture.close();
  }
});

it("keeps a turn's saved fact when a lost marker for it is recorded later", async () => {
  const ledger = new UsageLedger(new MemoryUsageStore());
  await ledger.record(directFact("a"));
  expect(
    await ledger.record(directFact("a", { lost: "price lookup failed" }))
  ).toEqual({ saved: "fact" });
  expect((await ledger.read()).facts).toEqual([directFact("a")]);
});
