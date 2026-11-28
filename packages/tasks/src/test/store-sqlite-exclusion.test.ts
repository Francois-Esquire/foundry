import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  type ChildScript,
  startScript,
} from "@foundry/lib/testing/child-script";
import { execInAnotherProcess } from "@foundry/lib/testing/sqlite-process";
import { describe, expect, test } from "vitest";
import type { Task, TaskId } from "../schema";
import { SqliteTaskStore } from "../store/sqlite";
import { Tasks } from "../tasks";
import { libsqlDatabases } from "./helpers/sqlite";

const LOCKED = /locked|busy/i;
const clock = () => new Date("2026-11-01T00:00:00.000Z");
const memory = libsqlDatabases("memory");
const files = libsqlDatabases("file");

function task(id: string, title = id): Task {
  return {
    createdAt: "2026-11-01T00:00:00.000Z",
    description: null,
    id: id as TaskId,
    metadata: {},
    parentId: null,
    settledAt: null,
    status: "open",
    tags: [],
    title,
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

describe.each([
  ["memory", memory],
  ["file", files],
] as const)(
  "two Tasks over one SqliteTaskStore (%s)",
  (_location, databases) => {
    test("cannot close a cycle between them", async () => {
      const store = new SqliteTaskStore({
        database: await databases.open(),
        scope: "s",
      });
      const first = new Tasks({ clock, store });
      const second = new Tasks({ clock, store });
      const a = await first.create({ title: "A" });
      const b = await first.create({ title: "B" });

      const results = await Promise.allSettled([
        first.change({
          operations: [
            {
              dependsOn: { id: b.id },
              kind: "dependency.add",
              task: { id: a.id },
            },
          ],
        }),
        second.change({
          operations: [
            {
              dependsOn: { id: a.id },
              kind: "dependency.add",
              task: { id: b.id },
            },
          ],
        }),
      ]);

      expect(
        results.map((result) =>
          result.status === "fulfilled"
            ? "fulfilled"
            : (result.reason as { code?: string }).code
        )
      ).toEqual(["fulfilled", "cycle"]);
      expect((await store.snapshot()).dependencies).toHaveLength(1);
    });
  }
);

describe("a snapshot against another connection to its file", () => {
  test("is one state: a commit cannot land between its two reads", async () => {
    const database = await files.open();
    let attempted: string | undefined;
    const reader = files.connect(database, {
      onQuery: (query) => {
        if (
          attempted === undefined &&
          query.includes('from "task_dependencies"')
        ) {
          attempted = execInAnotherProcess(files.path(database), [
            "BEGIN IMMEDIATE",
            `INSERT INTO tasks (created_at, description, id, metadata, parent_id, position, scope, settled_at, status, tags, title, updated_at)
                VALUES ('2026-11-01T00:00:00.000Z', NULL, 'b', '{}', NULL, 2, 's', NULL, 'open', '[]', 'b', '2026-11-01T00:00:00.000Z')`,
            "INSERT INTO task_dependencies (depends_on_id, position, scope, task_id) VALUES ('b', 1, 's', 'a')",
            "COMMIT",
          ]);
        }
      },
    });
    const store = new SqliteTaskStore({ database, scope: "s" });
    await store.commit({ putTasks: [task("a")] });

    const snapshot = await new SqliteTaskStore({
      database: reader,
      scope: "s",
    }).snapshot();

    expect(attempted).toMatch(LOCKED);
    expect(snapshot).toEqual({ dependencies: [], tasks: [task("a")] });
  });
});

describe("a transaction against another connection to its file", () => {
  test("a second client in this process is refused, and lands nothing", async () => {
    const database = await files.open();
    const store = new SqliteTaskStore({ database, scope: "s" });
    const elsewhere = new SqliteTaskStore({
      database: files.connect(database),
      scope: "s",
    });
    const a = task("a");
    await store.commit({ putTasks: [a] });

    const outcome = await store.transaction(async (view) => {
      const refused = await elsewhere
        .commit({ putTasks: [task("a", "outside")] })
        .then(
          () => "landed",
          (error: unknown) => String(error)
        );
      const after = await view.get(a.id);
      await view.commit({ putTasks: [task("a", "inside")] });
      return { after, refused };
    });

    expect(outcome.refused).toContain("SQLITE_BUSY");
    expect(outcome.after).toEqual(a);
    expect(await elsewhere.get(a.id)).toEqual(task("a", "inside"));
  });

  test("another process's write is held off, then lands after it commits", async () => {
    const database = files.connect(await files.open(), { busyTimeout: 5000 });
    const store = new SqliteTaskStore({ database, scope: "s" });
    const a = task("a");
    await store.commit({ putTasks: [a] });
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
        const after = await view.get(a.id);
        await view.commit({ putTasks: [task("a", "inside")] });
        return { after, probe, writer };
      });

      expect(outcome.probe).toMatch(LOCKED);
      expect(outcome.after).toEqual(a);
      expect(await outcome.writer.line()).toBe("written");
      await outcome.writer.exited();
      expect(await store.get(a.id)).toEqual(task("a", "outside"));
    } finally {
      await writer?.stop();
    }
  });
});

const WRITER = `const [client, url, title] = process.argv.slice(2);
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
  sql: "UPDATE tasks SET title = ? WHERE scope = 's' AND id = 'a'",
  args: [title],
});
await transaction.commit();
db.close();
console.log("written");
`;
