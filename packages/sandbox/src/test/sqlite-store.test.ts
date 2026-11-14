import { eq, getTableColumns, sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { ContainerRow } from "../schema";
import { containerRowSchema } from "../schema";
import type { ContainerStoreWrite } from "../store/index";
import { createSqliteContainerStore } from "../store/sqlite";
import { sandboxContainers } from "../store/tables";
import { libsqlDatabases } from "./helpers/sqlite";

const memory = libsqlDatabases("memory");
const files = libsqlDatabases("file");

/** Text SQLite does not give back intact, each made from a plain string. */
const UNSTORABLE_TEXT: [string, (plain: string) => string][] = [
  ["U+0000", (plain) => `${plain}\u0000tail`],
  ["a lone high surrogate", (plain) => `${plain}\uD800`],
  ["a lone low surrogate", (plain) => `\uDC00${plain}`],
];

/** Numbers the schema accepts that SQLite does not give back intact. */
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

/** A host table, written in the same transaction as a commit. */
const changes = sqliteTable("changes", {
  write: text("write", { mode: "json" }).notNull(),
});

async function withChanges() {
  const database = await memory.open();
  await database.run(sql`CREATE TABLE "changes" ("write" text NOT NULL)`);
  return database;
}

/** A store that counts the commits it lets through. */
async function counted() {
  let committed = 0;
  const store = createSqliteContainerStore({
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
  it("refuses an empty scope", async () => {
    const database = await memory.open();
    expect(() => createSqliteContainerStore({ database, scope: "" })).toThrow(
      RangeError
    );
  });

  it.each(UNSTORABLE_TEXT)("refuses a scope holding %s", async (_kind, bad) => {
    const database = await memory.open();
    expect(() =>
      createSqliteContainerStore({ database, scope: bad("scope") })
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
        // A commit through a transaction's view is checked the same way.
        await expect(
          store.transaction?.((view) => view.commit(write))
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
          store.transaction?.((view) => view.commit(write))
        ).rejects.toThrow(message);
      }

      expect(committed()).toBe(1);
      // No refused row was half-written to break the scope's reads.
      expect(await store.list()).toStrictEqual([kept]);
    }
  );

  it("keeps every timestamp it accepts, whole or fractional, exactly", async () => {
    const store = createSqliteContainerStore({
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
      const store = createSqliteContainerStore({
        database: await memory.open(),
        scope: "s",
      });
      // What a lone surrogate turns into when bound: U+FFFD on Node, nothing
      // on Bun; and what a NUL cuts text to.
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
    const store = createSqliteContainerStore({
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

  it("a throwing onCommit rolls back the store's statements and its own", async () => {
    const database = await withChanges();
    const store = createSqliteContainerStore({
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
      store.transaction?.(async (view) => {
        await view.commit({ putContainers: [row("b")] });
      })
    ).rejects.toThrow("host refused");
    expect(await store.list()).toEqual([]);
    expect(await database.select().from(changes)).toEqual([]);
  });

  it("onCommit calling the store it belongs to is refused at once", async () => {
    const outcomes: string[] = [];
    let store: ReturnType<typeof createSqliteContainerStore> | undefined;
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
    store = createSqliteContainerStore({
      database: await memory.open(),
      onCommit: async (transaction) => {
        const outer = store as ReturnType<typeof createSqliteContainerStore>;
        await attempt(() => outer.get("a"));
        await attempt(() => outer.list());
        await attempt(() => outer.commit({}));
        await attempt(() => outer.transaction?.(() => Promise.resolve()));
        // The transaction it is given is the way in.
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
        const joined = createSqliteContainerStore({
          database: transaction,
          scope: "s",
        });
        await joined.commit({ putContainers: [row("a")] });
        expect(await joined.get("a")).toStrictEqual(row("a"));
        throw new Error("host rolled back");
      })
    ).rejects.toThrow("host rolled back");
    expect(
      await createSqliteContainerStore({ database, scope: "s" }).list()
    ).toEqual([]);
  });

  it("one write can carry thousands of rows", async () => {
    const store = createSqliteContainerStore({
      database: await memory.open(),
      scope: "s",
    });
    // More rows than one statement can bind, for puts and for deletes.
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
    await createSqliteContainerStore({ database: first, scope: "s" }).commit({
      putContainers: rows,
    });
    const reopened = await files.reopen(first);
    expect(
      await createSqliteContainerStore({
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
    // A column takes NULL exactly where the row takes `undefined`; the schema
    // takes `null` nowhere.
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
          "nativeId" | "position" | "scope"
        >
      >
    >().toEqualTypeOf<Omit<ContainerRow, "nativeId">>();
    expectTypeOf<
      (typeof sandboxContainers.$inferSelect)["nativeId"]
    >().toEqualTypeOf<string | null>();
  });
});
