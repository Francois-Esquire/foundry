import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "~/database/open";
import { DatabaseRunStore } from "~/database/runs";
import { stateDatabase } from "~/layout";
import { MemoryRunStore } from "~/lib/run-store";
import { describeRunStore } from "./helpers/run-store";

describeRunStore(
  "MemoryRunStore",
  () =>
    Promise.resolve({
      close: () => Promise.resolve(),
      store: () => new MemoryRunStore(),
    }),
  { shared: false }
);

describeRunStore(
  "DatabaseRunStore",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "marbles-run-store-"));
    const opened = await initializeDatabase(stateDatabase(root));
    return {
      close() {
        opened.close();
        rmSync(root, { force: true, recursive: true });
        return Promise.resolve();
      },
      store: () =>
        new DatabaseRunStore({ database: opened.database, scope: "ws" }),
    };
  },
  { shared: true }
);
