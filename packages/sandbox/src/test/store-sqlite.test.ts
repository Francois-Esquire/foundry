import { copyFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createContainers } from "../node/containers";
import type { ContainerStoreWrite } from "../store/index";
import type { ContainerRow } from "../store/schema";
import { containerRowSchema } from "../store/schema";
import { SqliteContainerStore } from "../store/sqlite";
import { sandboxContainers } from "../store/tables";
import { createFakeContainerRuntime } from "../testing/index";
import { libsqlDatabases } from "./helpers/sqlite";

const memory = libsqlDatabases("memory");
const files = libsqlDatabases("file");

const UNSTORABLE_TEXT: [string, (plain: string) => string][] = [
  ["U+0000", (plain) => `${plain}\u0000tail`],
  ["a lone high surrogate", (plain) => `${plain}\uD800`],
  ["a lone low surrogate", (plain) => `\uDC00${plain}`],
];

const UNSTORABLE_NUMBERS: [string, number][] = [
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["-0", -0],
  [String(2 ** 53), 2 ** 53],
  [String(-(2 ** 53)), -(2 ** 53)],
  [String(1e20), 1e20],
];

function row(id: string, fields: Partial<ContainerRow> = {}): ContainerRow {
  return {
    createdAt: 1,
    id,
    nativeId: undefined,
    spec: "{}",
    status: "starting",
    updatedAt: 1,
    ...fields,
  };
}

const changes = sqliteTable("changes", {
  write: text("write", { mode: "json" }).notNull(),
});

async function withChanges() {
  const database = await memory.open();
  await database.run(sql`CREATE TABLE "changes" ("write" text NOT NULL)`);
  return database;
}

async function counted() {
  let committed = 0;
  const store = new SqliteContainerStore({
    database: await memory.open(),
    onCommit: () => {
      committed += 1;
      return Promise.resolve();
    },
    scope: "s",
  });
  return { committed: () => committed, store };
}

describe("the SQLite container store", () => {
  it("binds its identity to where it lives: a byte copy of its database, or the database moved, gets another", async () => {
    const original = await files.open();
    const at = files.path(original);
    const first = await new SqliteContainerStore({
      database: original,
      location: at,
      scope: "w",
    }).identity();
    expect(
      await new SqliteContainerStore({
        database: files.connect(original),
        location: at,
        scope: "w",
      }).identity()
    ).toBe(first);
    const copy = `${at}.copy.db`;
    copyFileSync(at, copy);
    const client = createClient({ url: `file:${copy}` });
    try {
      expect(
        await new SqliteContainerStore({
          database: drizzle(client),
          location: copy,
          scope: "w",
        }).identity()
      ).not.toBe(first);
    } finally {
      client.close();
    }
    expect(
      await new SqliteContainerStore({
        database: files.connect(original),
        location: `${at}.moved`,
        scope: "w",
      }).identity()
    ).not.toBe(first);
  });

  it("never has a copy's or a moved home's sweep remove the original's live VM: it is passed over, and named", async () => {
    const original = await files.open();
    const at = files.path(original);
    const a = new SqliteContainerStore({
      database: original,
      location: at,
      scope: "w",
    });
    await a.identity();
    const copy = `${at}.copy.db`;
    copyFileSync(at, copy);
    const client = createClient({ url: `file:${copy}` });
    try {
      const runtime = createFakeContainerRuntime();
      const engineA = createContainers({
        instanceLabel: "marbles-w",
        report: () => undefined,
        runtime,
        store: a,
      });
      const held = await engineA.start({
        format: "foundry.sandbox.container/1",
        image: "docker.io/oven/bun:1",
      });
      const name = held.row.nativeId ?? "";
      for (const store of [
        new SqliteContainerStore({
          database: drizzle(client),
          location: copy,
          scope: "w",
        }),
        new SqliteContainerStore({
          database: files.connect(original),
          location: `${at}.moved`,
          scope: "w",
        }),
      ]) {
        const other = createContainers({
          instanceLabel: "marbles-w",
          report: () => undefined,
          runtime,
          store,
        });
        const swept = await other.sweep();
        expect([...swept]).toEqual([]);
        expect(swept.passedOver).toEqual([name]);
        expect(runtime.instances.find((i) => i.id === name)?.removed).toBe(
          false
        );
      }
      await held.close();
      await engineA.shutdown();
    } finally {
      client.close();
    }
  });

  it("refuses a scope holding U+001F, which its identity's own scope uses", async () => {
    const database = await memory.open();
    expect(
      () => new SqliteContainerStore({ database, scope: "w\u001fstore" })
    ).toThrow(RangeError);
  });

  it("keeps the identity it gave inside a transaction that rolled back", async () => {
    const store = new SqliteContainerStore({
      database: await files.open(),
      scope: "w",
    });
    let inside = "";
    await store
      .transaction(async (view) => {
        inside = await view.identity();
        throw new Error("rolled back");
      })
      .catch(() => undefined);
    expect(inside).not.toBe("");
    expect(await store.identity()).toBe(inside);
  });

  it("keeps its identity in its database: every store over that database and scope gives the same, another database another", async () => {
    const database = await files.open();
    const first = await new SqliteContainerStore({
      database,
      scope: "s",
    }).identity();
    expect(
      await new SqliteContainerStore({ database, scope: "s" }).identity()
    ).toBe(first);
    expect(
      await new SqliteContainerStore({
        database: await files.open(),
        scope: "s",
      }).identity()
    ).not.toBe(first);
    expect(
      await new SqliteContainerStore({ database, scope: "s" }).list()
    ).toEqual([]);
  });

  it("refuses an empty scope", async () => {
    const database = await memory.open();
    expect(() => new SqliteContainerStore({ database, scope: "" })).toThrow(
      RangeError
    );
  });

  it.each(UNSTORABLE_TEXT)("refuses a scope holding %s", async (_kind, bad) => {
    const database = await memory.open();
    expect(
      () => new SqliteContainerStore({ database, scope: bad("scope") })
    ).toThrow(RangeError);
  });

  it.each(UNSTORABLE_TEXT)(
    "refuses, before writing anything, %s in a text field, naming it",
    async (_kind, bad) => {
      const { committed, store } = await counted();
      const kept = row("kept", { nativeId: "kept-1" });
      await store.commit({ putContainers: [kept] });
      const refusals: [ContainerStoreWrite, string][] = [
        [
          { putContainers: [{ ...kept, id: bad("id") }] },
          "putContainers[0].id",
        ],
        [
          { putContainers: [kept, { ...row("b"), nativeId: bad("b-1") }] },
          "putContainers[1].nativeId",
        ],
        [
          {
            deleteContainers: [kept.id],
            putContainers: [{ ...kept, spec: bad("{}") }],
          },
          "putContainers[0].spec",
        ],
        [
          {
            putContainers: [
              { ...kept, status: bad("running") as ContainerRow["status"] },
            ],
          },
          "putContainers[0].status",
        ],
      ];
      for (const [write, field] of refusals) {
        await expect(store.commit(write)).rejects.toThrow(
          `cannot store ${field}: text holding U+0000 or a lone surrogate`
        );
        await expect(
          store.transaction((view) => view.commit(write))
        ).rejects.toThrow(`cannot store ${field}`);
      }

      expect(committed()).toBe(1);
      expect(await store.list()).toStrictEqual([kept]);
    }
  );

  it.each(UNSTORABLE_NUMBERS)(
    "refuses, before writing anything, a timestamp of %s, naming it",
    async (kind, value) => {
      const { committed, store } = await counted();
      const kept = row("kept");
      await store.commit({ putContainers: [kept] });
      for (const field of ["createdAt", "updatedAt"] as const) {
        const write = {
          deleteContainers: [kept.id],
          putContainers: [row("a"), row("b", { [field]: value })],
        };
        const message = `cannot store putContainers[1].${field}: ${kind} does not read back intact`;
        await expect(store.commit(write)).rejects.toThrow(message);
        await expect(
          store.transaction((view) => view.commit(write))
        ).rejects.toThrow(message);
      }

      expect(committed()).toBe(1);
      expect(await store.list()).toStrictEqual([kept]);
    }
  );

  it("keeps every timestamp it accepts, whole or fractional, exactly", async () => {
    const store = new SqliteContainerStore({
      database: await memory.open(),
      scope: "s",
    });
    const timestamps = [
      0,
      1,
      -1,
      0.5,
      -0.25,
      1_700_000_000_000,
      1_700_000_000_000.25,
      Number.MAX_SAFE_INTEGER,
      -Number.MAX_SAFE_INTEGER,
      Number.MIN_VALUE,
      2 ** 52 + 0.5,
    ];
    const rows = timestamps.map((value, index) =>
      row(`t${index}`, { createdAt: value, updatedAt: 0 - value })
    );
    await store.commit({ putContainers: rows });
    const read = await store.list();
    expect(read).toStrictEqual(rows);
    for (const [index, kept] of read.entries()) {
      expect(Object.is(kept.createdAt, timestamps[index])).toBe(true);
    }
  });

  it.each(UNSTORABLE_TEXT)(
    "a read or delete by an id holding %s touches no other row",
    async (_kind, bad) => {
      const store = new SqliteContainerStore({
        database: await memory.open(),
        scope: "s",
      });
      const lookalikes = ["�", "", "x"].map((id) => row(id));
      await store.commit({ putContainers: lookalikes });
      const key = bad("x").slice(0, 2);

      expect(await store.get(key)).toBeUndefined();
      expect(await store.get(bad(""))).toBeUndefined();
      await store.commit({ deleteContainers: [key, bad("")] });
      expect(await store.list()).toStrictEqual(lookalikes);
    }
  );

  it("onCommit runs inside the commit, after the store's statements, with the whole write", async () => {
    const database = await withChanges();
    const seen: {
      readonly rows: number;
      readonly write: ContainerStoreWrite;
    }[] = [];
    const store = new SqliteContainerStore({
      database,
      onCommit: async (transaction, write) => {
        const rows = await transaction
          .select()
          .from(sandboxContainers)
          .where(eq(sandboxContainers.scope, "host"));
        seen.push({ rows: rows.length, write });
        await transaction.insert(changes).values({ write });
      },
      scope: "host",
    });
    const committed = { putContainers: [row("a")] };
    await store.commit(committed);

    expect(seen).toEqual([{ rows: 1, write: committed }]);
    const [recorded] = await database.select().from(changes);
    expect(recorded?.write).toEqual({ putContainers: [row("a")] });
  });

  it.each([
    ["memory", memory],
    ["file", files],
  ] as const)(
    "onCommit receives the write as it stood when commit was called, not the caller's object (%s)",
    async (_location, databases) => {
      const received: ContainerStoreWrite[] = [];
      const store = new SqliteContainerStore({
        database: await databases.open(),
        onCommit: (_transaction, write) => {
          received.push(write);
          return Promise.resolve();
        },
        scope: "host",
      });
      const writeOf = (id: string) => ({ putContainers: [row(id)] });
      const change = (write: ReturnType<typeof writeOf>) => {
        for (const put of write.putContainers) {
          Object.assign(put, { nativeId: "changed", status: "failed" });
        }
        write.putContainers.push(row("late"));
      };

      const transaction = store.transaction.bind(store);
      if (transaction === undefined) {
        throw new Error("the SQLite store has a transaction");
      }
      const held = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const running = transaction(async () => {
        entered.resolve();
        await held.promise;
      });
      await entered.promise;
      const queued = writeOf("queued");
      const expected: ContainerStoreWrite[] = [structuredClone(queued)];
      const landing = store.commit(queued);
      change(queued);
      held.resolve();
      await Promise.all([running, landing]);
      const viewed = writeOf("viewed");
      expected.push(structuredClone(viewed));
      await transaction(async (view) => {
        const committed = view.commit(viewed);
        change(viewed);
        await committed;
      });

      expect(received).toStrictEqual(expected);
      expect(received[0]).not.toBe(queued);
      expect(received[1]).not.toBe(viewed);
      expect(await store.list()).toStrictEqual(
        received.flatMap((write) => write.putContainers ?? [])
      );
    }
  );

  it("a throwing onCommit rolls back the store's statements and its own", async () => {
    const database = await withChanges();
    const store = new SqliteContainerStore({
      database,
      onCommit: async (transaction, write) => {
        await transaction.insert(changes).values({ write });
        throw new Error("host refused");
      },
      scope: "host",
    });

    await expect(store.commit({ putContainers: [row("a")] })).rejects.toThrow(
      "host refused"
    );
    await expect(
      store.transaction(async (view) => {
        await view.commit({ putContainers: [row("b")] });
      })
    ).rejects.toThrow("host refused");
    expect(await store.list()).toEqual([]);
    expect(await database.select().from(changes)).toEqual([]);
  });

  it("onCommit calling the store it belongs to is refused at once", async () => {
    const outcomes: string[] = [];
    let store: SqliteContainerStore | undefined;
    const attempt = async (call: () => Promise<unknown> | undefined) => {
      const result = await Promise.race([
        Promise.resolve(call()).then(
          () => "resolved",
          (error: unknown) => String(error)
        ),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("still pending"), 1000);
        }),
      ]);
      outcomes.push(result);
    };
    store = new SqliteContainerStore({
      database: await memory.open(),
      onCommit: async (transaction) => {
        const outer = store as SqliteContainerStore;
        await attempt(() => outer.get("a"));
        await attempt(() => outer.list());
        await attempt(() => outer.commit({}));
        await attempt(() => outer.transaction(() => Promise.resolve()));
        await transaction.select().from(sandboxContainers);
      },
      scope: "s",
    });

    await store.commit({ putContainers: [row("a")] });

    expect(outcomes).toHaveLength(4);
    for (const outcome of outcomes) {
      expect(outcome).toContain("ReentrantCallError");
      expect(outcome).toContain("the transaction passed to onCommit");
    }
    expect(await store.get("a")).toStrictEqual(row("a"));
  });

  it("a host transaction can be the database, so a commit joins it", async () => {
    const database = await memory.open();

    await expect(
      database.transaction(async (transaction) => {
        const joined = new SqliteContainerStore({
          database: transaction,
          scope: "s",
        });
        await joined.commit({ putContainers: [row("a")] });
        expect(await joined.get("a")).toStrictEqual(row("a"));
        throw new Error("host rolled back");
      })
    ).rejects.toThrow("host rolled back");
    expect(
      await new SqliteContainerStore({ database, scope: "s" }).list()
    ).toEqual([]);
  });

  it("one write can carry thousands of rows", async () => {
    const store = new SqliteContainerStore({
      database: await memory.open(),
      scope: "s",
    });
    const rows = Array.from({ length: 40_000 }, (_, index) =>
      row(`c${index}`, { nativeId: `c${index}-1` })
    );
    await store.commit({ putContainers: rows });
    expect((await store.list()).map((kept) => kept.id)).toEqual(
      rows.map((kept) => kept.id)
    );

    await store.commit({ deleteContainers: rows.map((kept) => kept.id) });
    expect(await store.list()).toEqual([]);
  });

  it("a file database keeps its rows for the next connection", async () => {
    const first = await files.open();
    const rows = [row("b", { nativeId: "b-1" }), row("a")];
    await new SqliteContainerStore({ database: first, scope: "s" }).commit({
      putContainers: rows,
    });
    const reopened = await files.reopen(first);
    expect(
      await new SqliteContainerStore({
        database: reopened,
        scope: "s",
      }).list()
    ).toStrictEqual(rows);
  });
});

describe("the sandbox_containers table", () => {
  it("holds each row field for field, plus scope and position", () => {
    const { position, scope, ...columns } = getTableColumns(sandboxContainers);
    expect([position.notNull, scope.notNull]).toEqual([true, true]);
    const { shape } = containerRowSchema.unwrap();
    expect(
      Object.fromEntries(
        Object.entries(columns).map(([key, column]) => [key, !column.notNull])
      )
    ).toEqual(
      Object.fromEntries(
        Object.entries(shape).map(([key, field]) => [
          key,
          field.safeParse(undefined).success,
        ])
      )
    );
    for (const field of Object.values(shape)) {
      expect(field.safeParse(null).success).toBe(false);
    }
    expectTypeOf<
      Readonly<
        Omit<
          typeof sandboxContainers.$inferSelect,
          "holder" | "nativeId" | "position" | "scope"
        >
      >
    >().toEqualTypeOf<Omit<ContainerRow, "holder" | "nativeId">>();
    expectTypeOf<
      (typeof sandboxContainers.$inferSelect)["nativeId"]
    >().toEqualTypeOf<string | null>();
    expectTypeOf<
      (typeof sandboxContainers.$inferSelect)["holder"]
    >().toEqualTypeOf<string | null>();
  });
});

const DELETE = 'delete from "sandbox_containers"';
const INSERT = 'insert into "sandbox_containers"';

describe.each([
  ["memory", memory],
  ["file", files],
] as const)("a commit that fails as it runs (%s)", (_location, databases) => {
  async function failingInsert() {
    let armed = false;
    const ran: string[] = [];
    const database = await databases.open({
      onQuery: (query) => {
        if (!armed) {
          return;
        }
        if (query.startsWith(INSERT)) {
          armed = false;
          throw new Error("insert failed");
        }
        ran.push(query);
      },
    });
    return {
      arm() {
        armed = true;
      },
      ran,
      store: new SqliteContainerStore({ database, scope: "s" }),
    };
  }

  it("rolls back the statements before the one that failed", async () => {
    const { arm, ran, store } = await failingInsert();
    await store.commit({ putContainers: [row("a"), row("b")] });
    arm();

    await expect(
      store.commit({ deleteContainers: ["a"], putContainers: [row("c")] })
    ).rejects.toThrow("insert failed");

    expect(ran.some((query) => query.startsWith(DELETE))).toBe(true);
    expect(await store.list()).toStrictEqual([row("a"), row("b")]);
  });

  it("rolls back only a view commit that work catches, keeping the transaction's others", async () => {
    const { arm, ran, store } = await failingInsert();
    await store.commit({ putContainers: [row("a"), row("b")] });

    await store.transaction(async (view) => {
      await view.commit({ putContainers: [row("c1")] });
      arm();
      await expect(
        view.commit({ deleteContainers: ["a"], putContainers: [row("c2")] })
      ).rejects.toThrow("insert failed");
      expect(ran.some((query) => query.startsWith(DELETE))).toBe(true);
      expect((await view.list()).map((kept) => kept.id)).toEqual([
        "a",
        "b",
        "c1",
      ]);
      await view.commit({ putContainers: [row("c4")] });
    });

    expect((await store.list()).map((kept) => kept.id)).toEqual([
      "a",
      "b",
      "c1",
      "c4",
    ]);
  });
});
