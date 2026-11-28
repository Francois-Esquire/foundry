import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "~/database/open";
import { DatabaseTriggerStore } from "~/database/triggers";
import { stateDatabase } from "~/layout";
import { MemoryTriggerStore } from "~/lib/schedule/store";
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
    store: () =>
      new DatabaseTriggerStore({ database: opened.database, scope: "ws" }),
  };
}

describeTriggerStore("DatabaseTriggerStore", database, { shared: true });
