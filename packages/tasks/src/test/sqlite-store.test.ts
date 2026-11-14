import { eq, getTableColumns, sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, expectTypeOf, test } from "vitest";
import type { z } from "zod";
import type { Task, TaskDependency, TaskStoreWrite } from "../schema";
import { taskDependencySchema, taskSchema } from "../schema";
import { SqliteTaskStore } from "../store/sqlite";
import { taskDependencies, tasks } from "../store/tables";
import { Tasks } from "../tasks";
import { libsqlDatabases } from "./helpers/sqlite";

const clock = () => new Date("2026-11-01T00:00:00.000Z");
const memory = libsqlDatabases("memory");
const files = libsqlDatabases("file");

/** A host table, written in the same transaction as a commit. */
const changes = sqliteTable("changes", {
  event: text("event", { mode: "json" }).notNull(),
});

async function withChanges() {
  const database = await memory.open();
  await database.run(sql`CREATE TABLE "changes" ("event" text NOT NULL)`);
  return database;
}

describe("SqliteTaskStore", () => {
  test("refuses an empty scope", async () => {
    const database = await memory.open();
    expect(() => new SqliteTaskStore({ database, scope: "" })).toThrow(
      RangeError
    );
  });

  test("onCommit runs inside the commit, after the store's statements, with the whole write", async () => {
    const database = await withChanges();
    const seen: { readonly rows: number; readonly write: TaskStoreWrite }[] =
      [];
    const store = new SqliteTaskStore({
      database,
      onCommit: async (transaction, write) => {
        const rows = await transaction
          .select()
          .from(tasks)
          .where(eq(tasks.scope, "host"));
        seen.push({ rows: rows.length, write });
        await transaction.insert(changes).values({ event: write.event });
      },
      scope: "host",
    });
    const created = await new Tasks({ clock, store }).create({ title: "a" });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.rows).toBe(1);
    expect(seen[0]?.write.putTasks).toEqual([created]);
    const [recorded] = await database.select().from(changes);
    expect(recorded?.event).toEqual({
      dependencies: { added: [], removed: [] },
      kind: "tasks.changed",
      tasks: [{ after: created, before: null, id: created.id }],
    });
  });

  test("a throwing onCommit rolls back the store's statements and its own", async () => {
    const database = await withChanges();
    const store = new SqliteTaskStore({
      database,
      onCommit: async (transaction, write) => {
        await transaction.insert(changes).values({ event: write.event });
        throw new Error("host refused");
      },
      scope: "host",
    });

    await expect(
      new Tasks({ clock, store }).create({ title: "a" })
    ).rejects.toThrow("host refused");
    expect(await store.snapshot()).toEqual({ dependencies: [], tasks: [] });
    expect(await database.select().from(changes)).toEqual([]);
  });

  test("a host transaction can be the database, so a commit joins it", async () => {
    const database = await memory.open();
    const task = await new Tasks({ clock }).create({ title: "a" });

    await expect(
      database.transaction(async (transaction) => {
        const joined = new SqliteTaskStore({
          database: transaction,
          scope: "s",
        });
        await joined.commit({ putTasks: [task] });
        expect(await joined.get(task.id)).toEqual(task);
        throw new Error("host rolled back");
      })
    ).rejects.toThrow("host rolled back");
    expect(
      await new SqliteTaskStore({ database, scope: "s" }).snapshot()
    ).toEqual({ dependencies: [], tasks: [] });
  });

  test("a file database keeps its records for the next connection", async () => {
    const first = await files.open();
    const tasksOnFile = new Tasks({
      clock,
      store: new SqliteTaskStore({ database: first, scope: "s" }),
    });
    const a = await tasksOnFile.create({ title: "a" });
    const b = await tasksOnFile.create(
      { title: "b" },
      { dependsOn: [{ id: a.id }] }
    );
    const reopened = await files.reopen(first);
    expect(
      await new SqliteTaskStore({ database: reopened, scope: "s" }).snapshot()
    ).toEqual({
      dependencies: [{ dependsOnId: a.id, taskId: b.id }],
      tasks: [a, b],
    });
  });
});

describe("task tables", () => {
  test("hold each record field for field, plus scope", () => {
    expect(columnsOf(tasks)).toEqual(fieldsOf(taskSchema.shape));
    expect(columnsOf(taskDependencies)).toEqual(
      fieldsOf(taskDependencySchema.unwrap().shape)
    );
    expectTypeOf<
      Readonly<Omit<typeof tasks.$inferSelect, "scope">>
    >().toEqualTypeOf<Task>();
    expectTypeOf<
      Readonly<Omit<typeof taskDependencies.$inferSelect, "scope">>
    >().toEqualTypeOf<TaskDependency>();
  });
});

/** Each column but `scope`, by field name, and whether it takes `null`. */
function columnsOf(table: typeof tasks | typeof taskDependencies) {
  const { scope, ...columns } = getTableColumns(table);
  expect(scope.notNull).toBe(true);
  return Object.fromEntries(
    Object.entries(columns).map(([key, column]) => [key, !column.notNull])
  );
}

/** Each schema field and whether it accepts `null`. */
function fieldsOf(shape: Readonly<Record<string, z.ZodType>>) {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      field.safeParse(null).success,
    ])
  );
}
