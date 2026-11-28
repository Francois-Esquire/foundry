import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DatabaseExecutionStore } from "~/database/executions";
import { initializeDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";
import { MemoryExecutionStore } from "~/lib/executions/store";
import { describeExecutionStore } from "./helpers/execution-store";

describeExecutionStore("MemoryExecutionStore", () =>
  Promise.resolve({
    close: () => Promise.resolve(),
    store: () => new MemoryExecutionStore(),
  })
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
    store: (scope = "ws") =>
      new DatabaseExecutionStore({ database: opened.database, scope }),
  };
}

describeExecutionStore("DatabaseExecutionStore", database);

it("keeps one workspace's observations, progress and gaps apart from another's", async () => {
  const opened = await database();
  try {
    const one = opened.store("one");
    const other = opened.store("other");
    const at = "2026-11-01T09:00:00.000Z";
    await one.progress("rn-a", { step: 1 }, at);
    await one.remove([], [{ scope: "save", through: at }], at);
    expect(await other.get("rn-a")).toBeUndefined();
    expect(await other.list()).toEqual([]);
    expect(await other.gaps()).toEqual([]);
    expect((await one.list()).map((annex) => annex.id)).toEqual(["rn-a"]);
  } finally {
    await opened.close();
  }
});
