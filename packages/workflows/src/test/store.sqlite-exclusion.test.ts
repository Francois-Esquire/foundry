import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

import { ExecutionCoordinator } from "../index";
import type { RunRecord } from "../schema";
import { SqliteWorkflowStore } from "../store/sqlite";
import { type ChildScript, startScript } from "./helpers/child-script";
import { libsqlDatabases } from "./helpers/sqlite";
import { execInAnotherProcess } from "./helpers/sqlite-process";

const LOCKED = /locked|busy/i;
const files = libsqlDatabases("file");

function run(id: string, step = "workflow.step"): RunRecord {
  return {
    error: null,
    extensions: {},
    id,
    input: null,
    metadata: {},
    output: null,
    queueId: "q",
    snapshot: { cursor: null, input: null, name: "", steps: [] },
    status: "queued",
    step,
    tags: {},
    timestamps: {
      completedAt: null,
      createdAt: 1,
      failedAt: null,
      startedAt: null,
    },
  };
}

describe("a coordinator's snapshot against another connection to its file", () => {
  test("is one state: a commit cannot land between its reads", async () => {
    const database = await files.open();
    let attempted: string | undefined;
    const reader = files.connect(database, {
      onQuery: (query) => {
        if (attempted === undefined && query.includes('from "workflow_runs"')) {
          attempted = execInAnotherProcess(files.path(database), [
            "BEGIN IMMEDIATE",
            `INSERT INTO workflow_runs (definition, error, extensions, id, input, links, metadata, output, position, queue_id, scope, snapshot, status, step, tags, timestamps, undeclared)
                VALUES (NULL, NULL, '{}', 'rn-b', NULL, NULL, '{}', NULL, 9, 'q', 's', '{"cursor":null,"input":null,"name":"","steps":[]}', 'queued', 'workflow.step', '{}', '{"completedAt":null,"createdAt":1,"failedAt":null,"startedAt":null}', NULL)`,
            "COMMIT",
          ]);
        }
      },
    });
    const writer = new ExecutionCoordinator({
      store: new SqliteWorkflowStore({ database, scope: "s" }),
    });
    await writer.ensureQueue({ id: "q", name: "q" });
    await writer.createRun({
      id: "rn-a",
      input: null,
      queueId: "q",
      step: "s",
    });

    const snapshot = await new ExecutionCoordinator({
      store: new SqliteWorkflowStore({ database: reader, scope: "s" }),
    }).snapshot();

    expect(attempted).toMatch(LOCKED);
    expect(snapshot.runs.map((record) => record.id)).toEqual(["rn-a"]);
  });
});

describe("a transaction against another connection to its file", () => {
  test("a second client in this process is refused, and lands nothing", async () => {
    const database = await files.open();
    const store = new SqliteWorkflowStore({ database, scope: "s" });
    const elsewhere = new SqliteWorkflowStore({
      database: files.connect(database),
      scope: "s",
    });
    const a = run("rn-a");
    await store.commit({ putRuns: [a] });

    const outcome = await store.transaction(async (view) => {
      const refused = await elsewhere
        .commit({ putRuns: [run("rn-a", "outside")] })
        .then(
          () => "landed",
          (error: unknown) => String(error)
        );
      const after = await view.getRun(a.id);
      await view.commit({ putRuns: [run("rn-a", "inside")] });
      return { after, refused };
    });

    expect(outcome.refused).toContain("SQLITE_BUSY");
    expect(outcome.after).toStrictEqual(a);
    expect(await elsewhere.getRun(a.id)).toStrictEqual(run("rn-a", "inside"));
  });

  test("another process's write is held off, then lands after it commits", async () => {
    const database = files.connect(await files.open(), { busyTimeout: 5000 });
    const store = new SqliteWorkflowStore({ database, scope: "s" });
    const a = run("rn-a");
    await store.commit({ putRuns: [a] });
    let writer: ChildScript | undefined;

    try {
      const outcome = await store.transaction(async (view) => {
        writer = await startScript(WRITER, [
          pathToFileURL(
            createRequire(import.meta.url).resolve("@libsql/client")
          ).href,
          `file:${files.path(database)}`,
          "outside",
        ]);
        const probe = await writer.line();
        const after = await view.getRun(a.id);
        await view.commit({ putRuns: [run("rn-a", "inside")] });
        return { after, probe, writer };
      });

      expect(outcome.probe).toMatch(LOCKED);
      expect(outcome.after).toStrictEqual(a);
      expect(await outcome.writer.line()).toBe("written");
      await outcome.writer.exited();
      expect(await store.getRun(a.id)).toStrictEqual(run("rn-a", "outside"));
    } finally {
      await writer?.stop();
    }
  });
});

const WRITER = `const [client, url, step] = process.argv.slice(2);
const { createClient } = await import(client);
const probe = createClient({ url });
try {
  const attempt = await probe.transaction("write");
  await attempt.rollback();
  console.log("free");
} catch (error) {
  console.log(String(error));
} finally {
  probe.close();
}
const db = createClient({ url, timeout: 10000 });
const transaction = await db.transaction("write");
await transaction.execute({
  sql: "UPDATE workflow_runs SET step = ? WHERE scope = 's' AND id = 'rn-a'",
  args: [step],
});
await transaction.commit();
db.close();
console.log("written");
`;
