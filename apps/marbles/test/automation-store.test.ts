import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  DatabaseAutomationStore,
  readAutomations,
} from "~/database/automations";
import { initializeDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";
import { MemoryAutomationStore } from "~/lib/automation/store";
import {
  automation,
  describeAutomationStore,
} from "./helpers/automation-store";

describeAutomationStore(
  "MemoryAutomationStore",
  () =>
    Promise.resolve({
      close: () => Promise.resolve(),
      store: () => new MemoryAutomationStore(),
    }),
  { shared: false }
);

async function database() {
  const root = mkdtempSync(join(tmpdir(), "marbles-automation-store-"));
  const opened = await initializeDatabase(stateDatabase(root));
  return {
    close() {
      opened.close();
      rmSync(root, { force: true, recursive: true });
      return Promise.resolve();
    },
    opened,
    root,
    store: () =>
      new DatabaseAutomationStore({ database: opened.database, scope: "ws" }),
  };
}

describeAutomationStore("DatabaseAutomationStore", database, { shared: true });

it("reads a workspace's automations read only, and refuses every change", async () => {
  const fixture = await database();
  try {
    await fixture.store().put(automation("a"));
    await new DatabaseAutomationStore({
      database: fixture.opened.database,
      scope: "other",
    }).put(automation("b"));
    const read = readAutomations(fixture.root, "ws");
    expect(await read.list()).toEqual([{ id: "a", value: automation("a") }]);
    await expect(read.put(automation("c"))).rejects.toThrow("read only");
    await expect(read.remove("a")).rejects.toThrow("read only");
    expect(
      await readAutomations(join(fixture.root, "none"), "ws").list()
    ).toEqual([]);
  } finally {
    await fixture.close();
  }
});
