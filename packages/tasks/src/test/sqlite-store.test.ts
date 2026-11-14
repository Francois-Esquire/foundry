import { eq, getTableColumns, sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, expectTypeOf, test } from "vitest";
import type { z } from "zod";
import type {
  Task,
  TaskDependency,
  TaskEvent,
  TaskId,
  TaskStoreWrite,
} from "../schema";
import { taskDependencySchema, taskSchema } from "../schema";
import { SqliteTaskStore } from "../store/sqlite";
import { taskDependencies, tasks } from "../store/tables";
import { Tasks } from "../tasks";
import { libsqlDatabases } from "./helpers/sqlite";

const clock = () => new Date("2026-11-01T00:00:00.000Z");
const id = (value: string) => value as TaskId;

/** Text SQLite does not give back intact, each made from a plain string. */
const UNSTORABLE: [string, (plain: string) => string][] = [
  ["U+0000", (plain) => `${plain}\u0000tail`],
  ["a lone high surrogate", (plain) => `${plain}\uD800`],
  ["a lone low surrogate", (plain) => `\uDC00${plain}`],
];

function taskRecord(name: string, overrides: Partial<Task> = {}): Task {
  return {
    createdAt: "2026-11-01T00:00:00.000Z",
    description: null,
    id: id(name),
    metadata: {},
    parentId: null,
    settledAt: null,
    status: "open",
    tags: [],
    title: name,
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}
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

  test.each(UNSTORABLE)(
    "refuses, before writing anything, %s in a text field, naming it",
    async (_kind, bad) => {
      let committed = 0;
      const store = new SqliteTaskStore({
        database: await memory.open(),
        onCommit: () => {
          committed += 1;
          return Promise.resolve();
        },
        scope: "s",
      });
      const backlog = new Tasks({ clock, store });
      const kept = await backlog.create({ title: "kept" });
      const before = await store.snapshot();
      const refusals: [TaskStoreWrite, string][] = [
        [{ putTasks: [{ ...kept, title: bad("title") }] }, "putTasks[0].title"],
        [
          { putTasks: [kept, { ...kept, description: bad("d"), id: id("b") }] },
          "putTasks[1].description",
        ],
        [{ putTasks: [{ ...kept, id: id(bad("id")) }] }, "putTasks[0].id"],
        [
          { putTasks: [{ ...kept, parentId: id(bad("parent")) }] },
          "putTasks[0].parentId",
        ],
        [
          { putTasks: [{ ...kept, createdAt: bad("2026") }] },
          "putTasks[0].createdAt",
        ],
        [
          {
            deleteTasks: [kept.id],
            putDependencies: [{ dependsOnId: id(bad("t")), taskId: kept.id }],
          },
          "putDependencies[0].dependsOnId",
        ],
      ];
      for (const [write, field] of refusals) {
        await expect(store.commit(write)).rejects.toThrow(
          `cannot store ${field}: text holding U+0000 or a lone surrogate`
        );
        // A commit through a transaction's view is checked the same way.
        await expect(
          store.transaction((view) => view.commit(write))
        ).rejects.toThrow(`cannot store ${field}`);
      }
      await expect(backlog.create({ title: bad("via Tasks") })).rejects.toThrow(
        RangeError
      );

      expect(committed).toBe(1);
      expect(await store.snapshot()).toEqual(before);
      // JSON columns escape it, so metadata and tags keep it.
      const json = await backlog.create({
        metadata: { note: bad("m") },
        tags: [bad("t")],
        title: "json",
      });
      expect(await store.get(json.id)).toEqual(json);
    }
  );

  test.each(UNSTORABLE)(
    "a read or delete by a key holding %s touches no other row",
    async (_kind, bad) => {
      const store = new SqliteTaskStore({
        database: await memory.open(),
        scope: "s",
      });
      // What a lone surrogate turns into when bound: U+FFFD on Node, nothing
      // on Bun; and what a NUL cuts text to.
      const lookalikes = ["\uFFFD", "", "x"].map((name) =>
        taskRecord(name, { title: `lookalike ${JSON.stringify(name)}` })
      );
      const edges = lookalikes.map((record) => ({
        dependsOnId: record.id,
        taskId: record.id,
      }));
      await store.commit({ putDependencies: edges, putTasks: lookalikes });
      const key = id(bad("x").slice(0, 2));

      expect(await store.get(key)).toBeNull();
      expect(await store.get(id(bad("")))).toBeNull();
      await store.commit({
        deleteDependencies: [{ dependsOnId: key, taskId: key }],
        deleteTasks: [key, id(bad(""))],
      });
      expect(await store.snapshot()).toEqual({
        dependencies: edges,
        tasks: lookalikes,
      });
    }
  );

  test.each(UNSTORABLE)("refuses a scope holding %s", async (_kind, bad) => {
    const database = await memory.open();
    expect(
      () => new SqliteTaskStore({ database, scope: bad("scope") })
    ).toThrow(RangeError);
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

  test.each([
    ["memory", memory],
    ["file", files],
  ] as const)(
    "onCommit receives the write as it stood when commit was called, not the caller's object (%s)",
    async (_location, databases) => {
      const received: TaskStoreWrite[] = [];
      const store = new SqliteTaskStore({
        database: await databases.open(),
        onCommit: (_transaction, write) => {
          received.push(write);
          return Promise.resolve();
        },
        scope: "host",
      });
      const writeOf = (name: string) => {
        const record = taskRecord(name, { metadata: { list: ["x"] } });
        return {
          event: {
            dependencies: { added: [], removed: [] },
            kind: "tasks.changed",
            tasks: [{ after: { ...record }, before: null, id: record.id }],
          } satisfies TaskEvent,
          putTasks: [record],
        };
      };
      const change = (write: ReturnType<typeof writeOf>) => {
        for (const record of write.putTasks) {
          Object.assign(record, { title: "changed" });
          (record.metadata.list as string[]).push("changed");
        }
        for (const delta of write.event.tasks) {
          Object.assign(delta.after, { title: "changed" });
        }
        write.putTasks.push(taskRecord("late"));
      };

      // Queued behind a transaction, then through a transaction's view.
      const held = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const running = store.transaction(async () => {
        entered.resolve();
        await held.promise;
      });
      await entered.promise;
      const queued = writeOf("queued");
      const expected = [structuredClone(queued)];
      const landing = store.commit(queued);
      change(queued);
      held.resolve();
      await Promise.all([running, landing]);
      const viewed = writeOf("viewed");
      expected.push(structuredClone(viewed));
      await store.transaction(async (view) => {
        const committed = view.commit(viewed);
        change(viewed);
        await committed;
      });

      expect(received).toEqual(expected);
      expect(received[0]).not.toBe(queued);
      expect(received[1]).not.toBe(viewed);
      expect((await store.snapshot()).tasks).toEqual(
        received.flatMap((write) => write.putTasks ?? [])
      );
    }
  );

  test("onCommit runs for a write that changed nothing, which has no event", async () => {
    const writes: TaskStoreWrite[] = [];
    const store = new SqliteTaskStore({
      database: await memory.open(),
      onCommit: (_transaction, write) => {
        writes.push(write);
        return Promise.resolve();
      },
      scope: "host",
    });
    const backlog = new Tasks({ clock, store });
    const task = await backlog.create({ title: "a" });
    await backlog.change({
      operations: [
        { kind: "task.set_status", status: "open", task: { id: task.id } },
      ],
    });

    expect(writes).toHaveLength(2);
    expect(writes[1]).not.toHaveProperty("event");
  });

  test("onCommit calling the store it belongs to is refused at once", async () => {
    const outcomes: string[] = [];
    let store: SqliteTaskStore | undefined;
    const attempt = async (call: () => Promise<unknown>) => {
      const result = await Promise.race([
        call().then(
          () => "resolved",
          (error: unknown) => String(error)
        ),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("still pending"), 1000);
        }),
      ]);
      outcomes.push(result);
    };
    store = new SqliteTaskStore({
      database: await memory.open(),
      onCommit: async (transaction) => {
        const outer = store as SqliteTaskStore;
        await attempt(() => outer.get(id("a")));
        await attempt(() => outer.snapshot());
        await attempt(() => outer.commit({}));
        await attempt(() => outer.transaction(() => Promise.resolve()));
        // The transaction it is given is the way in.
        await transaction.select().from(tasks);
      },
      scope: "s",
    });

    const created = await new Tasks({ clock, store }).create({ title: "a" });

    expect(outcomes).toHaveLength(4);
    for (const outcome of outcomes) {
      expect(outcome).toContain("ReentrantCallError");
      expect(outcome).toContain("the transaction passed to onCommit");
    }
    expect(await store.get(created.id)).toEqual(created);
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

  test("one write can carry thousands of tasks and edges", async () => {
    const store = new SqliteTaskStore({
      database: await memory.open(),
      scope: "s",
    });
    const records = Array.from({ length: 4000 }, (_, index) => ({
      createdAt: "2026-11-01T00:00:00.000Z",
      description: null,
      id: `t${index}` as TaskId,
      metadata: {},
      parentId: null,
      settledAt: null,
      status: "open" as const,
      tags: [],
      title: `t${index}`,
      updatedAt: "2026-11-01T00:00:00.000Z",
    }));
    const edges = records.slice(1).map((task) => ({
      dependsOnId: records[0]?.id as TaskId,
      taskId: task.id,
    }));
    await store.commit({ putDependencies: edges, putTasks: records });
    const stored = await store.snapshot();
    expect(stored.tasks.map((task) => task.id)).toEqual(
      records.map((task) => task.id)
    );
    expect(stored.dependencies).toHaveLength(edges.length);
    await store.commit({
      deleteDependencies: edges,
      deleteTasks: records.map((task) => task.id),
    });

    expect(await store.snapshot()).toEqual({ dependencies: [], tasks: [] });
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
  test("hold each record field for field, plus scope and position", () => {
    expect(columnsOf(tasks)).toEqual(fieldsOf(taskSchema.shape));
    expect(columnsOf(taskDependencies)).toEqual(
      fieldsOf(taskDependencySchema.unwrap().shape)
    );
    expectTypeOf<
      Readonly<Omit<typeof tasks.$inferSelect, "position" | "scope">>
    >().toEqualTypeOf<Task>();
    expectTypeOf<
      Readonly<Omit<typeof taskDependencies.$inferSelect, "position" | "scope">>
    >().toEqualTypeOf<TaskDependency>();
  });
});

/** Each record column, by field name, and whether it takes `null`. */
function columnsOf(table: typeof tasks | typeof taskDependencies) {
  const { position, scope, ...columns } = getTableColumns(table);
  expect([position.notNull, scope.notNull]).toEqual([true, true]);
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
