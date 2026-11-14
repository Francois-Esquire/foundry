import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vitest";
import type { z } from "zod";
import { WorkspaceCatalog } from "../catalog";
import { workspaceEntrySchema, workspaceRegistrationSchema } from "../schema";
import type { WorkspaceStoreWrite } from "../store";
import { SqliteWorkspaceStore } from "../store/sqlite";
import { workspaceEntries, workspaces } from "../store/tables";
import {
  directoryRecord,
  fileRecord,
  hostWorkspace,
  newRoot,
  seed,
} from "../testing/records";
import { describeWorkspaceStore } from "../testing/store";
import type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceFile,
  WorkspaceId,
  WorkspaceRegistration,
} from "../types";
import { directorySystem } from "./helpers/directory-system";
import { libsqlDatabases } from "./helpers/sqlite";
import { makeRoot } from "./helpers/temp-roots";

const memory = libsqlDatabases("memory");
const files = libsqlDatabases("file");

for (const [location, databases] of [
  ["memory", memory],
  ["file", files],
] as const) {
  describeWorkspaceStore(
    `SqliteWorkspaceStore on libSQL (${location})`,
    async () => {
      const database = await databases.open();
      return (scope) => new SqliteWorkspaceStore({ database, scope });
    }
  );
}

/** Text SQLite does not give back intact, each made from a plain string. */
const UNSTORABLE: [string, (plain: string) => string][] = [
  ["U+0000", (plain) => `${plain}\u0000tail`],
  ["a lone high surrogate", (plain) => `${plain}\uD800`],
  ["a lone low surrogate", (plain) => `\uDC00${plain}`],
];

/** A host table, written in the same transaction as a commit. */
const changes = sqliteTable("changes", {
  workspace: text("workspace").notNull(),
});

async function withChanges() {
  const database = await memory.open();
  await database.run(sql`CREATE TABLE "changes" ("workspace" text NOT NULL)`);
  return database;
}

async function storeOnMemory(scope = "s") {
  return new SqliteWorkspaceStore({ database: await memory.open(), scope });
}

/** Every row in both tables, in every scope. */
async function rowCounts(database: Awaited<ReturnType<typeof memory.open>>) {
  const [registrations, entries] = await Promise.all([
    database.select().from(workspaces),
    database.select().from(workspaceEntries),
  ]);
  return { entries: entries.length, registrations: registrations.length };
}

/** `count` files at the root, for a valid tree of that size. */
function rootFiles(workspaceId: WorkspaceId, count: number): WorkspaceFile[] {
  return Array.from({ length: count }, (_, index) =>
    fileRecord(workspaceId, { path: `f${String(index).padStart(5, "0")}.md` })
  );
}

describe("SqliteWorkspaceStore", () => {
  test("refuses an empty scope", async () => {
    const database = await memory.open();
    expect(() => new SqliteWorkspaceStore({ database, scope: "" })).toThrow(
      RangeError
    );
  });

  test.each(UNSTORABLE)("refuses a scope holding %s", async (_kind, bad) => {
    const database = await memory.open();
    expect(
      () => new SqliteWorkspaceStore({ database, scope: bad("scope") })
    ).toThrow(RangeError);
  });

  test.each(UNSTORABLE)(
    "refuses, before writing anything, %s in a text field, naming it",
    async (_kind, bad) => {
      let committed = 0;
      const store = new SqliteWorkspaceStore({
        database: await memory.open(),
        onCommit: () => {
          committed += 1;
          return Promise.resolve();
        },
        scope: "s",
      });
      const workspace = hostWorkspace({
        path: newRoot("kept"),
        sourceId: "source",
      });
      const file = fileRecord(workspace.id, { path: "a.md" });
      const link: WorkspaceEntry = {
        ...directoryRecord(workspace.id, "link"),
        target: "a.md",
        type: "symlink",
      };
      await seed(store, workspace, [file, link]);
      const before = {
        entries: await store.listEntries(workspace.id),
        list: await store.listWorkspaces(),
      };
      const { source } = workspace;
      const refusals: [WorkspaceStoreWrite, string][] = [
        [
          { workspace: { ...workspace, id: bad("w") as WorkspaceId } },
          "workspace.id",
        ],
        [{ workspace: { ...workspace, name: bad("name") } }, "workspace.name"],
        [
          {
            workspace: { ...workspace, source: { ...source, kind: bad("k") } },
          },
          "workspace.source.kind",
        ],
        [
          {
            workspace: { ...workspace, source: { ...source, path: bad("/p") } },
          },
          "workspace.source.path",
        ],
        [
          {
            workspace: {
              ...workspace,
              source: { ...source, sourceId: bad("id") },
            },
          },
          "workspace.source.sourceId",
        ],
        ...(
          [
            "id",
            "workspaceId",
            "name",
            "path",
            "type",
            "digest",
            "extension",
            "kind",
            "mime",
          ] as const
        ).map((field): [WorkspaceStoreWrite, string] => [
          {
            deleteEntries: [file.id],
            putEntries: [file, { ...file, [field]: bad(field) }],
            workspace,
          },
          `putEntries[1].${field}`,
        ]),
        [
          {
            putEntries: [{ ...link, target: bad("t") } as WorkspaceEntry],
            workspace,
          },
          "putEntries[0].target",
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
      // So is a catalog's write, which is how Workspaces reach the store.
      const catalog = new WorkspaceCatalog(store, () => undefined);
      await expect(
        catalog.create({
          entries: [],
          workspace: hostWorkspace({ name: bad("via catalog"), path: "/c" }),
        })
      ).rejects.toThrow(RangeError);

      expect(committed).toBe(1);
      expect(await store.listWorkspaces()).toEqual(before.list);
      expect(await store.listEntries(workspace.id)).toEqual(before.entries);
    }
  );

  test("refuses a value the schema accepts and an integer column cannot keep", async () => {
    const store = await storeOnMemory();
    const workspace = hostWorkspace({ path: newRoot("numbers") });
    const negativeZero = fileRecord(workspace.id, { bytes: -0, path: "z" });
    // The schema accepts -0, and toEqual tells it from the 0 SQLite returns.
    expect(workspaceEntrySchema.safeParse(negativeZero).success).toBe(true);

    await expect(
      store.commit({ putEntries: [negativeZero], workspace })
    ).rejects.toThrow(
      "SqliteWorkspaceStore cannot store putEntries[0].bytes: SQLite keeps"
    );
    await expect(
      store.commit({
        putEntries: [fileRecord(workspace.id, { bytes: 0.5, path: "half" })],
        workspace,
      })
    ).rejects.toThrow("cannot store putEntries[0].bytes");
    expect(await store.getWorkspace(workspace.id)).toBeNull();
  });

  test("refuses an invalid Date, naming the field", async () => {
    const store = await storeOnMemory();
    const workspace = hostWorkspace({ path: newRoot("times") });
    const invalid = new Date(Number.NaN);

    await expect(
      store.commit({ workspace: { ...workspace, lastReconciledAt: invalid } })
    ).rejects.toThrow(
      "cannot store workspace.lastReconciledAt: a time that is not a valid Date"
    );
    await expect(
      store.commit({
        putEntries: [
          fileRecord(workspace.id, { path: "a", updatedAt: invalid }),
        ],
        workspace,
      })
    ).rejects.toThrow("cannot store putEntries[0].updatedAt");
    expect(await store.getWorkspace(workspace.id)).toBeNull();
  });

  test.each(UNSTORABLE)(
    "a read or delete by a key holding %s touches no other row",
    async (_kind, bad) => {
      const store = await storeOnMemory();
      // What a lone surrogate turns into when bound: U+FFFD on Node, nothing
      // on Bun; and what a NUL cuts text to.
      const lookalikes = ["�", "", "x"].map((key) =>
        hostWorkspace({
          id: key as WorkspaceId,
          path: key,
          sourceId: key,
        })
      );
      const entries = lookalikes.map((workspace) =>
        fileRecord(workspace.id, {
          id: workspace.id as string as WorkspaceEntryId,
          path: "a.md",
        })
      );
      for (const [index, workspace] of lookalikes.entries()) {
        await seed(store, workspace, [entries[index] as WorkspaceFile]);
      }
      const before = await store.listWorkspaces();
      const keys = [bad("x").slice(0, 2), bad("")];

      for (const key of keys) {
        const id = key as WorkspaceId;
        const entryId = key as WorkspaceEntryId;
        expect(await store.getWorkspace(id)).toBeNull();
        expect(await store.findWorkspaceByPath(key)).toBeNull();
        expect(await store.findWorkspaceBySourceId(key)).toBeNull();
        expect(await store.listEntries(id)).toEqual([]);
        expect(await store.getEntry(id, entryId)).toBeNull();
        expect(await store.getEntry("x" as WorkspaceId, entryId)).toBeNull();
        await store.commit({ removeWorkspace: id });
        await store.commit({
          deleteEntries: [entryId],
          workspace: lookalikes[2] as WorkspaceRegistration,
        });
      }
      expect(await store.listWorkspaces()).toEqual(before);
      for (const [index, workspace] of lookalikes.entries()) {
        expect(await store.listEntries(workspace.id)).toEqual([entries[index]]);
      }
    }
  );

  test("onCommit runs inside the commit, after the store's statements, with the whole write", async () => {
    const database = await withChanges();
    const seen: {
      readonly rows: number;
      readonly write: WorkspaceStoreWrite;
    }[] = [];
    const store = new SqliteWorkspaceStore({
      database,
      onCommit: async (transaction, write) => {
        const rows = await transaction
          .select()
          .from(workspaceEntries)
          .where(eq(workspaceEntries.scope, "host"));
        seen.push({ rows: rows.length, write });
        await transaction
          .insert(changes)
          .values({ workspace: write.workspace?.id ?? "removal" });
      },
      scope: "host",
    });
    const workspace = hostWorkspace({ path: newRoot("hooked") });
    const entries = rootFiles(workspace.id, 2);
    await seed(store, workspace, entries);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.rows).toBe(2);
    expect(seen[0]?.write).toEqual({ putEntries: entries, workspace });
    expect(await database.select().from(changes)).toEqual([
      { workspace: workspace.id },
    ]);
  });

  test("onCommit calling the store it belongs to is refused at once", async () => {
    const outcomes: string[] = [];
    let store: SqliteWorkspaceStore | undefined;
    const workspace = hostWorkspace({ path: newRoot("reentrant") });
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
    store = new SqliteWorkspaceStore({
      database: await memory.open(),
      onCommit: async (transaction) => {
        const outer = store as SqliteWorkspaceStore;
        await attempt(() => outer.getWorkspace(workspace.id));
        await attempt(() => outer.listWorkspaces());
        await attempt(() => outer.listEntries(workspace.id));
        await attempt(() => outer.commit({ workspace }));
        await attempt(() => outer.transaction(() => Promise.resolve()));
        // The transaction it is given is the way in.
        await transaction.select().from(workspaces);
      },
      scope: "s",
    });

    await seed(store, workspace);

    expect(outcomes).toHaveLength(5);
    for (const outcome of outcomes) {
      expect(outcome).toContain("ReentrantCallError");
      expect(outcome).toContain("the transaction passed to onCommit");
    }
    expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
  });

  test("a throwing onCommit rolls back a save larger than one batch, and its own statements", async () => {
    const database = await withChanges();
    const store = new SqliteWorkspaceStore({
      database,
      onCommit: async (transaction, write) => {
        await transaction
          .insert(changes)
          .values({ workspace: write.workspace?.id ?? "" });
        throw new Error("host refused");
      },
      scope: "host",
    });
    const workspace = hostWorkspace({ path: newRoot("refused") });

    // More rows than one insert statement can bind.
    await expect(
      seed(store, workspace, rootFiles(workspace.id, 5000))
    ).rejects.toThrow("host refused");
    expect(await rowCounts(database)).toEqual({ entries: 0, registrations: 0 });
    expect(await database.select().from(changes)).toEqual([]);
  });

  test("a host transaction can be the database, so a commit joins it", async () => {
    const database = await memory.open();
    const workspace = hostWorkspace({ path: newRoot("joined") });

    await expect(
      database.transaction(async (transaction) => {
        const joined = new SqliteWorkspaceStore({
          database: transaction,
          scope: "s",
        });
        await seed(joined, workspace);
        expect(await joined.getWorkspace(workspace.id)).toEqual(workspace);
        expect((await joined.listWorkspaces()).total).toBe(1);
        throw new Error("host rolled back");
      })
    ).rejects.toThrow("host rolled back");
    expect(await rowCounts(database)).toEqual({ entries: 0, registrations: 0 });
  });

  test("a file database keeps its records for the next connection", async () => {
    const first = await files.open();
    const workspace = hostWorkspace({ path: newRoot("kept") });
    const entries = rootFiles(workspace.id, 3);
    await seed(
      new SqliteWorkspaceStore({ database: first, scope: "s" }),
      workspace,
      entries
    );

    const reopened = new SqliteWorkspaceStore({
      database: await files.reopen(first),
      scope: "s",
    });
    expect(await reopened.getWorkspace(workspace.id)).toEqual(workspace);
    expect(await reopened.listEntries(workspace.id)).toEqual(entries);
  });
});

describe("WorkspaceCatalog over SqliteWorkspaceStore", () => {
  test("removing a Workspace removes every row it has in one commit", async () => {
    const database = await memory.open();
    let failNext = true;
    const removals: WorkspaceStoreWrite[] = [];
    const store = new SqliteWorkspaceStore({
      database,
      onCommit: (_transaction, write) => {
        if (write.removeWorkspace !== undefined) {
          removals.push(write);
        }
        if (write.removeWorkspace !== undefined && failNext) {
          failNext = false;
          return Promise.reject(new Error("host refused"));
        }
        return Promise.resolve();
      },
      scope: "s",
    });
    const catalog = new WorkspaceCatalog(store, () => undefined);
    const workspace = hostWorkspace({ path: newRoot("large") });
    const kept = hostWorkspace({ path: newRoot("kept") });
    // More entries than one statement could name by id.
    const entries = rootFiles(workspace.id, 33_000);
    expect(await catalog.create({ entries, workspace })).toEqual({
      kind: "committed",
    });
    await catalog.create({ entries: rootFiles(kept.id, 1), workspace: kept });
    const before = await rowCounts(database);
    expect(before).toEqual({ entries: 33_001, registrations: 2 });

    // A failing removal leaves every row.
    await expect(catalog.remove(workspace.id)).rejects.toThrow("host refused");
    expect(await rowCounts(database)).toEqual(before);

    expect(await catalog.remove(workspace.id)).toEqual({ kind: "removed" });
    expect(await rowCounts(database)).toEqual({ entries: 1, registrations: 1 });
    expect(await catalog.getWorkspace(kept.id)).toEqual(kept);
    // The hook sees the removal as written: the Workspace, and no entry ids.
    expect(removals).toEqual([
      { removeWorkspace: workspace.id },
      { removeWorkspace: workspace.id },
    ]);
  }, 60_000);

  test("a WorkspaceSystem loads a real directory into SQLite and reads it back", async () => {
    const root = await makeRoot({
      "docs/guide.md": "# Guide",
      "README.md": "hello",
    });
    await symlink("README.md", join(root, "readme-link"));
    const store = await storeOnMemory();
    const workspace = await directorySystem({ store }).load({ path: root });
    const registration = await workspace.registration();
    const entries = await workspace.entries();

    expect(entries.map((entry) => [entry.path, entry.type])).toEqual([
      ["README.md", "file"],
      ["docs", "directory"],
      ["docs/guide.md", "file"],
      ["readme-link", "symlink"],
    ]);
    for (const entry of entries) {
      expect(workspaceEntrySchema.safeParse(entry).success).toBe(true);
    }
    expect(workspaceRegistrationSchema.safeParse(registration).success).toBe(
      true
    );
  });
});

describe("SqliteWorkspaceStore query plans", () => {
  /** What SQLite plans for one read, step by step, and the index it names. */
  async function plansOf(
    read: (store: SqliteWorkspaceStore) => Promise<unknown>
  ) {
    const database = await files.open();
    const queries: string[] = [];
    const store = new SqliteWorkspaceStore({
      database: files.connect(database, {
        onQuery: (query) => queries.push(query),
      }),
      scope: "s",
    });
    await read(store);
    const reads = queries.filter((query) => query.startsWith("select"));
    return Promise.all(
      reads.map(async (query) => {
        const steps = await database.all<{ detail: string }>(
          sql.raw(`EXPLAIN QUERY PLAN ${query}`)
        );
        return steps.map((step) => step.detail).join("; ");
      })
    );
  }

  const workspaceId = "w" as WorkspaceId;
  const entryId = "e" as WorkspaceEntryId;
  /** `null` stands for any index led by `scope`, as a count may use. */
  test.each([
    [
      "getWorkspace",
      (store: SqliteWorkspaceStore) => store.getWorkspace(workspaceId),
      ["sqlite_autoindex_workspaces_1"],
    ],
    [
      "findWorkspaceByPath",
      (store: SqliteWorkspaceStore) => store.findWorkspaceByPath("/p"),
      ["workspaces_scope_source_path"],
    ],
    [
      "findWorkspaceBySourceId",
      (store: SqliteWorkspaceStore) => store.findWorkspaceBySourceId("id"),
      ["workspaces_scope_source_id"],
    ],
    [
      "listWorkspaces",
      (store: SqliteWorkspaceStore) => store.listWorkspaces(),
      [null, "workspaces_scope_created"],
    ],
    [
      "getEntry",
      (store: SqliteWorkspaceStore) => store.getEntry(workspaceId, entryId),
      ["sqlite_autoindex_workspace_entries_1"],
    ],
    [
      "listEntries",
      (store: SqliteWorkspaceStore) => store.listEntries(workspaceId),
      ["sqlite_autoindex_workspace_entries_1"],
    ],
  ] as const)(
    "%s searches its index, with no scan and no sort",
    async (_read, read, indexes) => {
      const plans = await plansOf(read);

      expect(plans).toHaveLength(indexes.length);
      for (const [step, plan] of plans.entries()) {
        const index = indexes[step] ?? String.raw`\S+`;
        expect(plan).toMatch(
          new RegExp(
            String.raw`^SEARCH \S+ USING (COVERING )?INDEX ${index} \(scope=\?`
          )
        );
        expect(plan).not.toContain("SCAN");
        expect(plan).not.toContain("TEMP B-TREE");
      }
    }
  );
});

/** The plans a removal's two deletes must have: each searches a primary key. */
const DELETES_ENTRIES_BY_KEY =
  /^SEARCH workspace_entries USING (COVERING )?INDEX sqlite_autoindex_workspace_entries_1 \(scope=\? AND workspace_id=\?\)$/;
const DELETES_REGISTRATION_BY_KEY =
  /^SEARCH workspaces USING (COVERING )?INDEX sqlite_autoindex_workspaces_1 \(scope=\? AND id=\?\)$/;

describe("SqliteWorkspaceStore removal plans", () => {
  test("a removal deletes entries and the registration through the primary keys", async () => {
    const database = await files.open();
    const queries: string[] = [];
    const store = new SqliteWorkspaceStore({
      database: files.connect(database, {
        onQuery: (query) => queries.push(query),
      }),
      scope: "s",
    });
    await store.commit({ removeWorkspace: "w" as WorkspaceId });
    const deletes = queries.filter((query) => query.startsWith("delete"));

    const plans = await Promise.all(
      deletes.map(async (query) => {
        const steps = await database.all<{ detail: string }>(
          sql.raw(`EXPLAIN QUERY PLAN ${query}`)
        );
        return steps.map((step) => step.detail).join("; ");
      })
    );
    expect(plans).toEqual([
      expect.stringMatching(DELETES_ENTRIES_BY_KEY),
      expect.stringMatching(DELETES_REGISTRATION_BY_KEY),
    ]);
  });
});

describe("SqliteWorkspaceStore reading a row it did not write", () => {
  const workspaceId = "w" as WorkspaceId;
  const base = {
    bytes: null,
    createdAt: new Date(1),
    digest: null,
    extension: null,
    id: "e" as WorkspaceEntryId,
    kind: null,
    mime: null,
    name: "e",
    path: "e",
    scope: "s",
    target: null,
    updatedAt: new Date(1),
    workspaceId,
  } satisfies Partial<typeof workspaceEntries.$inferInsert>;
  const file = {
    ...base,
    bytes: 4,
    digest: "d",
    extension: "md",
    kind: "document",
    mime: "text/markdown",
    type: "file",
  } as const;

  test.each([
    [
      "a file row missing a file column",
      { ...file, digest: null },
      "column digest is null on a file row",
    ],
    [
      "a file row of an unknown kind",
      { ...file, kind: "spreadsheet" },
      'column kind holds "spreadsheet", which is no file kind',
    ],
    [
      "a symlink row missing its target",
      { ...base, type: "symlink" },
      "column target is null on a symlink row",
    ],
    [
      "a directory row holding a file column",
      { ...base, bytes: 4, type: "directory" },
      "column bytes holds a value on a directory row, which has none",
    ],
    [
      "a row of an unknown type",
      { ...base, type: "fifo" },
      'column type holds "fifo", which is no entry type',
    ],
  ] as const)(
    "refuses %s, naming the scope, the Workspace, the entry, and the column",
    async (_case, row, fault) => {
      const database = await memory.open();
      await database
        .insert(workspaceEntries)
        .values(row as typeof workspaceEntries.$inferInsert);
      const store = new SqliteWorkspaceStore({ database, scope: "s" });
      const message = `SqliteWorkspaceStore cannot read entry "e" of Workspace "w" in scope "s": ${fault}`;

      await expect(store.getEntry(workspaceId, base.id)).rejects.toThrow(
        message
      );
      await expect(store.listEntries(workspaceId)).rejects.toThrow(message);
    }
  );

  test("reads a well-formed row it did not write", async () => {
    const database = await memory.open();
    await database.insert(workspaceEntries).values(file);
    const store = new SqliteWorkspaceStore({ database, scope: "s" });

    const { scope: _scope, target: _target, ...entry } = file;
    expect(await store.getEntry(workspaceId, base.id)).toEqual(entry);
  });
});

describe("Workspace tables", () => {
  test("hold each record field for field, plus scope", () => {
    const { source, ...registration } =
      workspaceRegistrationSchema.unwrap().shape;
    expect(columnsOf(workspaces)).toEqual({
      ...fieldsOf(registration),
      ...Object.fromEntries(
        Object.entries(fieldsOf(source.unwrap().shape)).map(
          ([key, nullable]) => [
            key === "sourceId"
              ? key
              : `source${key[0]?.toUpperCase()}${key.slice(1)}`,
            nullable,
          ]
        )
      ),
    });

    // Each entry field of any type; nullable where a type lacks it.
    const variants = workspaceEntrySchema
      .unwrap()
      .options.map((option) => fieldsOf(option.shape));
    const every = new Set(variants.flatMap((fields) => Object.keys(fields)));
    expect(columnsOf(workspaceEntries)).toEqual(
      Object.fromEntries(
        [...every].map((key) => [
          key,
          variants.some((fields) => fields[key] !== false),
        ])
      )
    );
  });
});

/** Each record column, by field name, and whether it takes `null`. */
function columnsOf(table: typeof workspaces | typeof workspaceEntries) {
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
