/**
 * Every execution store keeps one contract: in memory, one engine's, and
 * in the Marbles database, shared by every engine over it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DatabaseExecutionStore } from "~/database/executions";
import { initializeDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";
import { MemoryExecutionStore } from "~/lib/execution-store";
import { describeExecutionStore } from "./helpers/execution-store";

describeExecutionStore(
  "MemoryExecutionStore",
  () =>
    Promise.resolve({
      close: () => Promise.resolve(),
      store: () => new MemoryExecutionStore(),
    }),
  { shared: false }
);

async function database() {
  const root = mkdtempSync(join(tmpdir(), "marbles-execution-store-"));
  const opened = await initializeDatabase(stateDatabase(root));
  return {
    close() {
      opened.close();
      rmSync(root, { force: true, recursive: true });
      return Promise.resolve();
    },
    opened,
    store: (scope = "ws") =>
      new DatabaseExecutionStore({ database: opened.database, scope }),
  };
}

describeExecutionStore("DatabaseExecutionStore", database, { shared: true });

it("keeps one workspace's runs, observations and gaps apart from another's", async () => {
  const fixture = await database();
  try {
    const mine = fixture.store("ws");
    const theirs = fixture.store("other");
    const run = {
      correlation: {},
      id: "rn-1",
      kind: "task" as const,
      name: "save",
      observations: [],
      owner: { pid: process.pid },
      queue: "q",
      revision: 1,
      sequence: 1,
      status: "queued" as const,
      timestamps: { queuedAt: "t", updatedAt: "t" },
    };
    await mine.put(run);
    await theirs.put({ ...run, revision: 9 });
    await mine.putGap({
      removed: 1,
      scope: "host",
      through: "t",
      updatedAt: "t",
    });
    expect(await mine.put({ ...run, revision: 2 })).toBe(true);
    expect(await theirs.gaps()).toEqual([]);
    await theirs.remove("rn-1");
    expect((await mine.list()).map(({ id }) => id)).toEqual(["rn-1"]);
  } finally {
    await fixture.close();
  }
});
