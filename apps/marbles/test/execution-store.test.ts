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

it("reads in memory what is kept, not what a transaction under way has written", async () => {
  const executions = new MemoryExecutionStore();
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
  await executions.create(run);
  let resume = (): void => undefined;
  const paused = new Promise<void>((done) => {
    resume = done;
  });
  let written = (): void => undefined;
  const wrote = new Promise<void>((done) => {
    written = done;
  });
  const transaction = executions.transaction(async (view) => {
    await view.advise("rn-1", { progress: { n: 1 }, updatedAt: "t2" });
    await view.create({ ...run, id: "rn-2", sequence: 2 });
    written();
    await paused;
  });
  await wrote;

  expect((await executions.list()).map(({ id }) => id)).toEqual(["rn-1"]);
  expect((await executions.get("rn-1"))?.value).toMatchObject({
    revision: 1,
  });
  resume();
  await transaction;
  expect((await executions.list()).map(({ id }) => id)).toEqual([
    "rn-1",
    "rn-2",
  ]);
  expect((await executions.get("rn-1"))?.value).toMatchObject({
    progress: { n: 1 },
    revision: 2,
  });
});

it("finds, in memory, a run removed and created again in one transaction after every other", async () => {
  const executions = new MemoryExecutionStore();
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
    source: "request-1",
    status: "queued" as const,
    timestamps: { queuedAt: "t", updatedAt: "t" },
  };
  await executions.create(run);
  await executions.create({ ...run, id: "rn-2" });
  await executions.transaction(async (view) => {
    await view.remove("rn-1");
    await view.create({ ...run, revision: 7 });
    expect((await view.withSource("save", "request-1"))?.id).toBe("rn-2");
  });

  expect((await executions.withSource("save", "request-1"))?.id).toBe("rn-2");
  expect((await executions.get("rn-1"))?.value).toMatchObject({
    revision: 7,
  });
});

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
    await mine.create(run);
    await theirs.create({ ...run, revision: 9 });
    await mine.putGap({
      removed: 1,
      scope: "host",
      through: "t",
      updatedAt: "t",
    });
    expect(
      (await mine.advise("rn-1", { progress: { n: 1 }, updatedAt: "t2" }))
        .record
    ).toMatchObject({ progress: { n: 1 }, revision: 2 });
    expect(await theirs.gaps()).toEqual([]);
    await theirs.remove("rn-1");
    expect((await mine.list()).map(({ id }) => id)).toEqual(["rn-1"]);
  } finally {
    await fixture.close();
  }
});
