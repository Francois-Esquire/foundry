import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { afterAll, describe, expect, test } from "vitest";
import type { Task, TaskId } from "../schema";
import { SqliteTaskStore } from "../store/sqlite";
import { Tasks } from "../tasks";
import { libsqlDatabases } from "./helpers/sqlite";

const clock = () => new Date("2026-11-01T00:00:00.000Z");
const memory = libsqlDatabases("memory");
const files = libsqlDatabases("file");

const pause = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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

      // The second waits its turn, sees the first's edge, and is refused.
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

  test("another process's write waits on its busy timeout, then lands after", async () => {
    const database = await files.open();
    const store = new SqliteTaskStore({ database, scope: "s" });
    const a = task("a");
    await store.commit({ putTasks: [a] });

    const outcome = await store.transaction(async (view) => {
      const writer = await writeFromAnotherProcess(database, {
        busyTimeout: 10_000,
        title: "outside",
      });
      // Time enough for the other process to have tried its write.
      await pause(300);
      const after = await view.get(a.id);
      await view.commit({ putTasks: [task("a", "inside")] });
      return { after, writer };
    });

    expect(outcome.after).toEqual(a);
    await outcome.writer.done;
    expect(await store.get(a.id)).toEqual(task("a", "outside"));
  });
});

const scripts = mkdtemp(join(tmpdir(), "foundry-tasks-writer-"));
afterAll(async () => {
  await rm(await scripts, { force: true, recursive: true });
});

/**
 * Starts a process that opens a write transaction on `database`'s file, the
 * way a `SqliteTaskStore` there would, and renames task `a`. Resolves once
 * the process is about to begin; `done` settles when it has committed.
 */
async function writeFromAnotherProcess(
  database: LibSQLDatabase,
  options: { readonly busyTimeout: number; readonly title: string }
): Promise<{ readonly done: Promise<void> }> {
  const [main] = await database.all<{ url: string }>(
    "SELECT 'file:' || file AS url FROM pragma_database_list WHERE name = 'main'"
  );
  if (main === undefined) {
    throw new Error("the database has no main file");
  }
  const { url } = main;
  const client = pathToFileURL(
    createRequire(import.meta.url).resolve("@libsql/client")
  ).href;
  const script = join(await scripts, `writer-${Date.now()}.mjs`);
  await writeFile(
    script,
    `const { createClient } = await import(${JSON.stringify(client)});
const db = createClient({ url: ${JSON.stringify(url)}, timeout: ${options.busyTimeout} });
console.log("begin");
const tx = await db.transaction("write");
await tx.execute({ sql: "UPDATE tasks SET title = ? WHERE scope = 's' AND id = 'a'", args: [${JSON.stringify(options.title)}] });
await tx.commit();
db.close();
`
  );
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(child, "exit").then(([code]) => {
    if (code !== 0) {
      throw new Error(`writer exited with ${String(code)}`);
    }
  });
  await once(child.stdout, "data");
  return { done: exited };
}
