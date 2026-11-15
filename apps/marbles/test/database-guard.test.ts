import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tasks } from "@foundry/tasks";
import { tasks as taskRows } from "@foundry/tasks/store/tables";
import { afterEach, describe, expect, it } from "vitest";
import { IncompatibleDatabaseError, MIGRATIONS } from "~/database/migrate";
import { initializeDatabase, readDatabase } from "~/database/open";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { openHostDatabase, WorkspaceRegistry } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import { workspaceState } from "~/lib/state/workspace";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

/** The shipped migrations and one more, as a newer Marbles ships them. */
function newerMigrations(dir: string): string {
  const folder = join(dir, "migrations-next");
  cpSync(MIGRATIONS, folder, { recursive: true });
  const path = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  const last = journal.entries.at(-1);
  if (last === undefined) {
    throw new Error("no migrations are committed");
  }
  journal.entries.push({ ...last, tag: "9999_probe", when: last.when + 1 });
  writeFileSync(path, JSON.stringify(journal));
  writeFileSync(
    join(folder, "9999_probe.sql"),
    "CREATE TABLE `probe` (`id` text PRIMARY KEY NOT NULL);\n"
  );
  return folder;
}

/** Whether `error`, or anything in its causes, is an `IncompatibleDatabaseError`. */
function incompatible(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof IncompatibleDatabaseError) {
      return true;
    }
  }
  return false;
}

describe("a writer's handle kept open while a newer Marbles migrates", () => {
  it("refuses every write and transaction through it, before it changes anything", async () => {
    const root = mkdtempSync(join(tmpdir(), "marbles-guard-"));
    roots.push(root);
    const state = join(root, "state");
    const workspace = workspaceState(state, root);
    const host = await openHostDatabase(state);
    try {
      const records = new DatabaseWorkspaceRecords({
        database: host.database,
        scope: workspace.id,
      });
      const tasks = new Tasks({ store: records.taskStore });
      const before = await tasks.create({ title: "Before" });
      const observer = { name: "h", source: "tasks" };
      const { position } = await records.log.declare(observer, Date.now());

      // Another Marbles, one migration ahead, migrates the file meanwhile.
      const newer = newerMigrations(root);
      (
        await initializeDatabase(stateDatabase(state), { migrations: newer })
      ).close();

      for (const attempt of [
        () => tasks.create({ title: "After" }),
        () => tasks.update(before.id, { title: "Renamed" }),
        () => tasks.list(),
        () =>
          records.log.move(observer, {
            from: position,
            now: Date.now(),
            to: position + 1,
          }),
        () =>
          new WorkspaceRegistry({ database: host.database, state }).touch(
            workspace,
            null
          ),
      ]) {
        await expect(attempt()).rejects.toSatisfy(incompatible);
      }

      const stored = await readDatabase(
        stateDatabase(state),
        (database) => database.select({ title: taskRows.title }).from(taskRows),
        { migrations: newer }
      );
      expect(stored).toEqual([{ title: "Before" }]);
      await records.close();
    } finally {
      host.close();
    }
  });
});
