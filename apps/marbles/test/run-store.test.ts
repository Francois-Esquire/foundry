import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Job, Run } from "@foundry/queue";
import { expect, it } from "vitest";
import { initializeDatabase } from "~/database/open";
import { DatabaseRunStore } from "~/database/runs";
import { stateDatabase } from "~/layout";
import { linksOf } from "~/lib/executions/record";
import { runStoreEffect } from "~/lib/runs/records";
import { MemoryRunStore } from "~/lib/runs/store";
import { testMachine } from "./helpers/records";
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

it("records RUNS facts for a workflow's runs and none for a host task's", async () => {
  const machine = await testMachine();
  try {
    const state = machine.workspace();
    const scope = basename(state);
    const { changes } = machine.records(state);
    const store = await new DatabaseRunStore({
      changes,
      database: machine.database.database,
      scope,
    }).open(() => undefined);
    for (const [id, kind] of [
      ["rn-task", "task"],
      ["rn-flow", "workflow"],
    ] as const) {
      const job: Job = {
        createdAt: 1,
        handler: { name: kind },
        id: `jb-${id}`,
        input: null,
        links: linksOf({ kind }),
        policy: {},
        pool: "marbles",
        state: { kind: "pending" },
      };
      const run: Run = {
        attempt: 1,
        id,
        jobId: job.id,
        pool: "marbles",
        revision: 0,
        state: { availableAt: 1, kind: "queued", queuedAt: 1 },
      };
      await runStoreEffect(
        store.commit({
          events: [
            { at: 1, id: `ev-${id}-job`, job, type: "job.submitted" },
            { at: 1, id: `ev-${id}-run`, run, type: "run.queued" },
          ],
          jobs: [job],
          runs: [run],
        })
      );
    }
    const logged = await machine.changes(state);
    expect(
      logged
        .filter((change) => change.source === "runs")
        .map((change) => (change.payload as { runId?: string }).runId)
    ).toEqual(["rn-flow"]);
  } finally {
    machine.close();
  }
});
