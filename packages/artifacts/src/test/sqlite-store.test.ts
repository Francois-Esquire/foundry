import { eq, getTableColumns, sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, expectTypeOf, test } from "vitest";
import type { z } from "zod";

import { ArtifactManager } from "../manager";
import type { ArtifactId, BlobId, ContentId } from "../ref";
import type { Artifact, Blob, Content } from "../schema";
import { artifactSchema, contentSchema } from "../schema";
import type { ArtifactStoreWrite } from "../store";
import { InMemoryArtifactStore } from "../store/memory";
import { SqliteArtifactStore } from "../store/sqlite";
import {
  artifactBlobChunks,
  artifactBlobs,
  artifactContentBlobs,
  artifactContents,
  artifacts,
} from "../store/tables";
import { required } from "./helpers/required";
import { libsqlDatabases } from "./helpers/sqlite";

const AT = new Date("2026-01-01T00:00:00.000Z");
const DIGEST = "a".repeat(64);
const memory = libsqlDatabases("memory");
const files = libsqlDatabases("file");

const artifactId = (value: string) => value as ArtifactId;
const contentId = (value: string) => value as ContentId;
const blobId = (value: string) => value as BlobId;

function artifactRecord(id: string, fields: Partial<Artifact> = {}): Artifact {
  return {
    archivedAt: null,
    contentId: null,
    createdAt: AT,
    id: artifactId(id),
    metadata: {},
    name: id,
    publishedAt: null,
    status: "draft",
    type: "text/plain",
    updatedAt: AT,
    ...fields,
  };
}

function contentRecord(
  id: string,
  owner: string,
  fields: Partial<Content> = {}
): Content {
  return {
    artifactId: artifactId(owner),
    createdAt: AT,
    digest: DIGEST,
    frozenAt: null,
    id: contentId(id),
    metadata: {},
    state: "ready",
    tag: null,
    tree: {},
    updatedAt: AT,
    ...fields,
  };
}

function inlineBlob(id: string, fields: Partial<Blob> = {}): Blob {
  return {
    byteLength: 1,
    bytes: new Uint8Array([1]),
    createdAt: AT,
    digest: DIGEST,
    id: blobId(id),
    ...fields,
  } as Blob;
}

function fileNode(blob: string) {
  return {
    blobId: blobId(blob),
    bytes: 1,
    digest: DIGEST,
    mime: null,
    type: "file",
  } as const;
}

/** Text SQLite does not give back intact, each made from a plain string. */
const UNSTORABLE: [string, (plain: string) => string][] = [
  ["U+0000", (plain) => `${plain}\u0000tail`],
  ["a lone high surrogate", (plain) => `${plain}\uD800`],
  ["a lone low surrogate", (plain) => `\uDC00${plain}`],
];

const TEXT_REFUSAL = "text holding U+0000 or a lone surrogate";

async function storeOn(
  options: { readonly onCommit?: () => Promise<void> } = {}
) {
  return new SqliteArtifactStore({
    database: await memory.open(),
    scope: "s",
    ...options,
  });
}

/** Every record of the store's scope, for comparing before and after. */
async function everything(store: SqliteArtifactStore) {
  return {
    artifacts: (
      await store.listArtifacts({ includeArchived: true, limit: 1e4 })
    ).artifacts,
    blobs: await store.listBlobs(),
    contents: await store.listContents(),
  };
}

describe("SqliteArtifactStore", () => {
  test("refuses an empty scope", async () => {
    const database = await memory.open();
    expect(() => new SqliteArtifactStore({ database, scope: "" })).toThrow(
      RangeError
    );
  });

  test.each(UNSTORABLE)("refuses a scope holding %s", async (_kind, bad) => {
    const database = await memory.open();
    expect(
      () => new SqliteArtifactStore({ database, scope: bad("scope") })
    ).toThrow(RangeError);
  });

  test.each(UNSTORABLE)(
    "refuses, before writing anything, %s in a text field, naming it",
    async (_kind, bad) => {
      let committed = 0;
      const store = await storeOn({
        onCommit: () => {
          committed += 1;
          return Promise.resolve();
        },
      });
      const kept = artifactRecord("kept");
      await store.commit({ putArtifacts: [kept] });
      const before = await everything(store);
      const version = contentRecord("c", "kept");
      const refusals: [ArtifactStoreWrite, string][] = [
        [
          { putArtifacts: [{ ...kept, name: bad("n") }] },
          "putArtifacts[0].name",
        ],
        [
          { putArtifacts: [kept, { ...kept, id: artifactId(bad("id")) }] },
          "putArtifacts[1].id",
        ],
        [
          { putArtifacts: [{ ...kept, type: bad("t") }] },
          "putArtifacts[0].type",
        ],
        [
          { putArtifacts: [{ ...kept, contentId: contentId(bad("c")) }] },
          "putArtifacts[0].contentId",
        ],
        [
          { putContents: [{ ...version, tag: bad("v") }] },
          "putContents[0].tag",
        ],
        [
          { putContents: [{ ...version, artifactId: artifactId(bad("a")) }] },
          "putContents[0].artifactId",
        ],
        [
          { putContents: [{ ...version, digest: bad(DIGEST) }] },
          "putContents[0].digest",
        ],
        [
          {
            putContents: [
              { ...version, tree: { "a.txt": fileNode(bad("b")) } },
            ],
          },
          'putContents[0].tree["a.txt"].blobId',
        ],
        [
          { putBlobs: [{ ...inlineBlob("b"), id: blobId(bad("b")) }] },
          "putBlobs[0].id",
        ],
        [
          {
            putBlobs: [
              {
                byteLength: 1,
                createdAt: AT,
                digest: DIGEST,
                id: blobId("p"),
                path: bad("p"),
              },
            ],
          },
          "putBlobs[0].path",
        ],
        [
          {
            putBlobs: [
              {
                byteLength: 1,
                chunks: [blobId("x"), blobId(bad("y"))],
                createdAt: AT,
                digest: DIGEST,
                id: blobId("m"),
              },
            ],
          },
          "putBlobs[0].chunks[1]",
        ],
      ];
      for (const [write, field] of refusals) {
        await expect(store.commit(write)).rejects.toThrow(
          `cannot store ${field}: ${TEXT_REFUSAL}`
        );
        // A commit through a transaction's view is checked the same way.
        await expect(
          store.transaction((view) => view.commit(write))
        ).rejects.toThrow(`cannot store ${field}: ${TEXT_REFUSAL}`);
      }
      expect(committed).toBe(1);
      expect(await everything(store)).toEqual(before);

      // JSON columns escape it, so metadata, tree paths and targets keep it.
      const json = contentRecord("json", "kept", {
        metadata: { note: bad("m") },
        tree: {
          [bad("path")]: { target: bad("target"), type: "symlink" },
        },
      });
      await store.commit({
        putArtifacts: [{ ...kept, metadata: { note: bad("a") } }],
        putContents: [json],
      });
      expect(await store.getContent(json.id)).toEqual(json);
      expect((await store.getArtifact(kept.id))?.metadata).toEqual({
        note: bad("a"),
      });
    }
  );

  test.each([
    ["-0", -0],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["undefined", undefined],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
  ])(
    "refuses, before writing anything, %s inside a JSON column, naming its path",
    async (_kind, value) => {
      const store = await storeOn();
      const kept = artifactRecord("kept");
      await store.commit({ putArtifacts: [kept] });
      const before = await everything(store);
      const metadata = { list: [1, { deep: value }] } as Artifact["metadata"];
      const refusals: [ArtifactStoreWrite, string][] = [
        [
          { putArtifacts: [{ ...kept, metadata }] },
          "putArtifacts[0].metadata.list[1].deep",
        ],
        [
          { putContents: [contentRecord("c", "kept", { metadata })] },
          "putContents[0].metadata.list[1].deep",
        ],
      ];
      for (const [write, field] of refusals) {
        await expect(store.commit(write)).rejects.toThrow(
          `cannot store ${field}: `
        );
      }
      expect(await everything(store)).toEqual(before);
    }
  );

  test.each([
    ["a function", () => undefined],
    ["a symbol", Symbol("s")],
  ])(
    "rejects, as the memory store does, a write holding %s, which structuredClone refuses",
    async (_kind, value) => {
      const store = await storeOn();
      const metadata = { deep: value } as Artifact["metadata"];
      const write = { putArtifacts: [artifactRecord("a", { metadata })] };
      const memoryRefusal = await new InMemoryArtifactStore()
        .commit(write)
        .catch((error: unknown) => (error as Error).name);
      await expect(store.commit(write)).rejects.toMatchObject({
        name: memoryRefusal,
      });
      expect(await everything(store)).toEqual({
        artifacts: [],
        blobs: [],
        contents: [],
      });
    }
  );

  test("refuses an array hole or a cycle in JSON, and a -0 file size in a tree", async () => {
    const store = await storeOn();
    const kept = artifactRecord("kept");
    // biome-ignore lint/suspicious/noSparseArray: The hole is what this refuses.
    const holes = { list: [1, , 3] } as unknown as Artifact["metadata"];
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const refusals: [ArtifactStoreWrite, string][] = [
      [
        { putArtifacts: [{ ...kept, metadata: holes }] },
        "putArtifacts[0].metadata.list: an array with holes",
      ],
      [
        {
          putArtifacts: [{ ...kept, metadata: cycle as Artifact["metadata"] }],
        },
        "putArtifacts[0].metadata.self: a circular reference",
      ],
      [
        {
          putContents: [
            contentRecord("c", "kept", {
              tree: { "a.txt": { ...fileNode("b"), bytes: -0 } },
            }),
          ],
        },
        'putContents[0].tree["a.txt"].bytes: -0',
      ],
    ];
    for (const [write, message] of refusals) {
      await expect(store.commit(write)).rejects.toThrow(message);
    }
    expect(await everything(store)).toEqual({
      artifacts: [],
      blobs: [],
      contents: [],
    });
  });

  test.each([
    ["-0", { byteLength: -0 }, "putBlobs[0].byteLength: SQLite keeps"],
    [
      "an unsafe integer",
      { byteLength: 2 ** 53 },
      "putBlobs[0].byteLength: SQLite keeps",
    ],
    [
      "an invalid time",
      { createdAt: new Date(Number.NaN) },
      "putBlobs[0].createdAt: a time that is not a valid Date",
    ],
    [
      "two sources",
      { path: "objects/x" },
      "putBlobs[0]: a blob row holds exactly one of bytes, path and chunks",
    ],
    [
      "a source key holding undefined",
      { path: undefined },
      "putBlobs[0]: its path key holds undefined",
    ],
  ])("refuses a blob with %s, naming it", async (_kind, fields, message) => {
    const store = await storeOn();
    await expect(
      store.commit({ putBlobs: [inlineBlob("b", fields as Partial<Blob>)] })
    ).rejects.toThrow(message);
    expect(await store.listBlobs()).toEqual([]);
  });

  test("refuses an invalid time on an Artifact or a Content, naming it", async () => {
    const store = await storeOn();
    const invalid = new Date(Number.NaN);
    await expect(
      store.commit({
        putArtifacts: [artifactRecord("a", { publishedAt: invalid })],
      })
    ).rejects.toThrow("cannot store putArtifacts[0].publishedAt: a time");
    await expect(
      store.commit({
        putContents: [contentRecord("c", "a", { frozenAt: invalid })],
      })
    ).rejects.toThrow("cannot store putContents[0].frozenAt: a time");
  });

  test("refuses a write whose fields throw when read, before writing", async () => {
    const store = await storeOn();
    const kept = artifactRecord("kept");
    await store.commit({ putArtifacts: [kept] });
    const throwing = Object.defineProperty({ ...kept }, "name", {
      enumerable: true,
      get() {
        throw new Error("unreadable name");
      },
    });
    await expect(
      store.commit({ deleteArtifacts: [kept.id], putArtifacts: [throwing] })
    ).rejects.toThrow("unreadable name");
    expect(await store.getArtifact(kept.id)).toEqual(kept);
  });

  test.each(UNSTORABLE)(
    "a read or delete by a key holding %s touches no other row",
    async (_kind, bad) => {
      const store = await storeOn();
      // What a lone surrogate turns into when bound: U+FFFD on Node, nothing
      // on Bun; and what a NUL cuts text to.
      const names = ["�", "", "x"];
      const lookalikes = {
        artifacts: names.map((name) =>
          artifactRecord(name === "" ? "empty" : name, {
            id: artifactId(name),
            type: name,
          })
        ),
        blobs: names.map((name) => inlineBlob(name, { digest: name })),
        contents: names.map((name) => ({
          ...contentRecord(name, name),
          tree: { "a.txt": fileNode(name) },
        })),
      };
      await store.commit({
        putArtifacts: lookalikes.artifacts,
        putBlobs: lookalikes.blobs,
        putContents: lookalikes.contents,
      });
      const before = await everything(store);
      for (const key of [bad("x").slice(0, 2), bad("")]) {
        expect(await store.getArtifact(artifactId(key))).toBeNull();
        expect(await store.getContent(contentId(key))).toBeNull();
        expect(await store.getBlob(blobId(key))).toBeNull();
        expect(await store.findBlobs(key)).toEqual([]);
        expect(await store.findReferences(blobId(key))).toEqual({
          blobIds: [],
          contentIds: [],
        });
        expect(await store.listContents(artifactId(key))).toEqual([]);
        expect(
          await store.listArtifacts({
            includeArchived: true,
            limit: 10,
            type: key,
          })
        ).toEqual({ artifacts: [], total: 0 });
        await store.commit({
          deleteArtifacts: [artifactId(key)],
          deleteBlobs: [blobId(key)],
          deleteContents: [contentId(key)],
        });
      }
      expect(await everything(store)).toEqual(before);
    }
  );

  test("onCommit runs inside the commit, after the store's statements, with the whole write", async () => {
    const database = await withChanges();
    const seen: {
      readonly rows: number;
      readonly write: ArtifactStoreWrite;
    }[] = [];
    const store = new SqliteArtifactStore({
      database,
      onCommit: async (transaction, write) => {
        const rows = await transaction
          .select()
          .from(artifacts)
          .where(eq(artifacts.scope, "host"));
        seen.push({ rows: rows.length, write });
        await transaction
          .insert(changes)
          .values({ ids: (write.putArtifacts ?? []).map((row) => row.id) });
      },
      scope: "host",
    });
    const created = await new ArtifactManager({ store }).create({
      name: "A",
      type: "text/plain",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.rows).toBe(1);
    expect(seen[0]?.write.putArtifacts).toEqual([
      expect.objectContaining({ id: created.id }),
    ]);
    expect(await database.select().from(changes)).toEqual([
      { ids: [created.id] },
    ]);
  });

  test("onCommit calling the store it belongs to is refused at once", async () => {
    const outcomes: string[] = [];
    let store: SqliteArtifactStore | undefined;
    const attempt = async (call: () => Promise<unknown>) => {
      outcomes.push(
        await Promise.race([
          call().then(
            () => "resolved",
            (error: unknown) => String(error)
          ),
          new Promise<string>((resolve) => {
            setTimeout(() => resolve("still pending"), 1000);
          }),
        ])
      );
    };
    store = new SqliteArtifactStore({
      database: await memory.open(),
      onCommit: async (transaction) => {
        const outer = store as SqliteArtifactStore;
        await attempt(() => outer.getArtifact(artifactId("a")));
        await attempt(() => outer.listArtifacts({ limit: 1 }));
        await attempt(() => outer.listBlobs());
        await attempt(() => outer.commit({}));
        await attempt(() => outer.transaction(() => Promise.resolve()));
        // The transaction it is given is the way in.
        await transaction.select().from(artifacts);
      },
      scope: "s",
    });
    const created = await new ArtifactManager({ store }).create({
      name: "A",
      type: "text/plain",
    });

    expect(outcomes).toHaveLength(5);
    for (const outcome of outcomes) {
      expect(outcome).toContain("ReentrantCallError");
      expect(outcome).toContain("the transaction passed to onCommit");
    }
    expect((await store.getArtifact(created.id))?.name).toBe("A");
  });

  test("a throwing onCommit rolls back the store's statements and its own", async () => {
    const database = await withChanges();
    const store = new SqliteArtifactStore({
      database,
      onCommit: async (transaction) => {
        await transaction.insert(changes).values({ ids: [] });
        throw new Error("host refused");
      },
      scope: "host",
    });

    await expect(
      new ArtifactManager({ store }).create({ name: "A", type: "text/plain" })
    ).rejects.toThrow("host refused");
    expect(await everything(store)).toEqual({
      artifacts: [],
      blobs: [],
      contents: [],
    });
    expect(await database.select().from(changes)).toEqual([]);
  });

  test("a host transaction can be the database, so a commit joins it", async () => {
    const database = await memory.open();
    const record = artifactRecord("a");

    await expect(
      database.transaction(async (transaction) => {
        const joined = new SqliteArtifactStore({
          database: transaction,
          scope: "s",
        });
        await joined.commit({ putArtifacts: [record] });
        expect(await joined.getArtifact(record.id)).toEqual(record);
        throw new Error("host rolled back");
      })
    ).rejects.toThrow("host rolled back");
    expect(
      await new SqliteArtifactStore({ database, scope: "s" }).getArtifact(
        record.id
      )
    ).toBeNull();
  });

  test("a file database keeps its records for the next connection", async () => {
    const first = await files.open();
    const manager = new ArtifactManager({
      store: new SqliteArtifactStore({ database: first, scope: "s" }),
    });
    const created = await manager.create({
      entries: { "a.txt": { bytes: "hello" } },
      name: "A",
      type: "text/plain",
    });
    const reopened = new ArtifactManager({
      store: new SqliteArtifactStore({
        database: await files.reopen(first),
        scope: "s",
      }),
    });
    expect(await reopened.get(created.id)).toEqual(created);
    const root = await reopened.readRoot(
      created.content?.id ?? contentId("missing")
    );
    expect(new TextDecoder().decode(root?.blob)).toBe("hello");
  });
});

/** A host table, written in the same transaction as a commit. */
const changes = sqliteTable("changes", {
  ids: text("ids", { mode: "json" }).$type<readonly string[]>().notNull(),
});

async function withChanges() {
  const database = await memory.open();
  await database.run(sql`CREATE TABLE "changes" ("ids" text NOT NULL)`);
  return database;
}

describe("SqliteArtifactStore reading a blob row it did not write", () => {
  const base = {
    byteLength: 1,
    bytes: null,
    chunks: null,
    createdAt: AT,
    digest: DIGEST,
    id: blobId("b"),
    path: null,
    scope: "s",
  } satisfies typeof artifactBlobs.$inferInsert;

  test.each([
    ["no source", base, "none of bytes, path and chunks holds a value"],
    [
      "two sources",
      { ...base, chunks: [blobId("x")], path: "objects/x" },
      "path and chunks each hold a value",
    ],
    [
      "chunks that are no list",
      { ...base, chunks: "x" as unknown as readonly BlobId[] },
      "chunks holds no list",
    ],
  ])(
    "refuses a row with %s, naming the blob and scope",
    async (_kind, row, fault) => {
      const database = await memory.open();
      await database.insert(artifactBlobs).values(row);
      const store = new SqliteArtifactStore({ database, scope: "s" });
      await expect(store.getBlob(blobId("b"))).rejects.toThrow(
        `SqliteArtifactStore cannot read blob "b" in scope "s": ${fault}`
      );
    }
  );
});

describe("Artifact tables", () => {
  test("hold each record field for field, plus scope and the store's own columns", () => {
    expect(
      columnsOf(artifacts, [
        "idLower",
        "idOrder",
        "nameLower",
        "textUnits",
        "typeLower",
      ])
    ).toEqual(fieldsOf(artifactSchema.unwrap().shape));
    expect(columnsOf(artifactContents)).toEqual(
      fieldsOf(contentSchema.unwrap().shape)
    );
    // A blob row holds one of three sources; each is null on the others.
    expect(columnsOf(artifactBlobs)).toEqual({
      byteLength: false,
      bytes: true,
      chunks: true,
      createdAt: false,
      digest: false,
      id: false,
      path: true,
    });
    expect(columnsOf(artifactContentBlobs)).toEqual({
      blobId: false,
      contentId: false,
    });
    expect(columnsOf(artifactBlobChunks)).toEqual({
      blobId: false,
      chunkId: false,
    });
    expectTypeOf<
      Readonly<
        Omit<
          typeof artifacts.$inferSelect,
          | "idLower"
          | "idOrder"
          | "nameLower"
          | "scope"
          | "textUnits"
          | "typeLower"
        >
      >
    >().toEqualTypeOf<Artifact>();
    expectTypeOf<
      Readonly<Omit<typeof artifactContents.$inferSelect, "scope">>
    >().toEqualTypeOf<Content>();
  });
});

/** Each record column, by field name, and whether it takes `null`. */
function columnsOf(
  table: Parameters<typeof getTableColumns>[0],
  extra: readonly string[] = []
) {
  const columns = getTableColumns(table) as Record<
    string,
    { readonly notNull: boolean }
  >;
  for (const name of ["scope", ...extra]) {
    expect(columns[name]?.notNull).toBe(true);
  }
  return Object.fromEntries(
    Object.entries(columns)
      .filter(([key]) => key !== "scope" && !extra.includes(key))
      .map(([key, column]) => [key, !column.notNull])
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

describe("SqliteArtifactStore query plans", () => {
  /** What SQLite plans for each statement `run` makes, step by step. */
  async function plansOf(
    run: (store: SqliteArtifactStore) => Promise<unknown>,
    kind: "delete" | "select"
  ) {
    const database = await files.open();
    const queries: string[] = [];
    const store = new SqliteArtifactStore({
      database: files.connect(database, {
        onQuery: (query) => queries.push(query),
      }),
      scope: "s",
    });
    await run(store);
    return Promise.all(
      queries
        .filter((query) => query.startsWith(kind))
        .map(async (query) => {
          const steps = await database.all<{ detail: string }>(
            sql.raw(`EXPLAIN QUERY PLAN ${query}`)
          );
          return steps.map((step) => step.detail).join("; ");
        })
    );
  }

  const after = { createdAt: AT, id: artifactId("a") };
  /**
   * Each read, the index each of its statements must search, and what it
   * must search it by. `null` stands for any index led by `scope`, as a
   * count or a listing of the whole scope may use.
   */
  test.each([
    [
      "getArtifact",
      (store: SqliteArtifactStore) => store.getArtifact(artifactId("a")),
      [["sqlite_autoindex_artifacts_1", "scope=? AND id=?"]],
    ],
    [
      "getContent",
      (store: SqliteArtifactStore) => store.getContent(contentId("c")),
      [["sqlite_autoindex_artifact_contents_1", "scope=? AND id=?"]],
    ],
    [
      "getBlob",
      (store: SqliteArtifactStore) => store.getBlob(blobId("b")),
      [["sqlite_autoindex_artifact_blobs_1", "scope=? AND id=?"]],
    ],
    [
      "findBlobs",
      (store: SqliteArtifactStore) => store.findBlobs(DIGEST),
      [["artifact_blobs_scope_digest", "scope=? AND digest=?"]],
    ],
    [
      "findReferences",
      (store: SqliteArtifactStore) => store.findReferences(blobId("b")),
      [
        ["sqlite_autoindex_artifact_content_blobs_1", "scope=? AND blob_id=?"],
        ["sqlite_autoindex_artifact_blob_chunks_1", "scope=? AND chunk_id=?"],
      ],
    ],
    [
      "listArtifacts",
      (store: SqliteArtifactStore) => store.listArtifacts({ limit: 5 }),
      [
        [null, "scope=?"],
        ["artifacts_scope_created", "scope=?"],
      ],
    ],
    [
      "listArtifacts after a cursor",
      (store: SqliteArtifactStore) =>
        store.listArtifacts({ after, includeArchived: true, limit: 5 }),
      [
        [null, "scope=?"],
        ["artifacts_scope_created", "scope=? AND (created_at,id_order)>(?,?)"],
      ],
    ],
    [
      "listArtifacts by type after a cursor",
      (store: SqliteArtifactStore) =>
        store.listArtifacts({ after, limit: 5, type: "text/plain" }),
      [
        ["artifacts_scope_type_created", "scope=? AND type=?"],
        [
          "artifacts_scope_type_created",
          "scope=? AND type=? AND (created_at,id_order)>(?,?)",
        ],
      ],
    ],
    [
      "listArtifacts by text",
      (store: SqliteArtifactStore) =>
        store.listArtifacts({ limit: 5, text: "notes" }),
      [
        [null, "scope=?"],
        ["artifacts_scope_created", "scope=?"],
      ],
    ],
    [
      "listArtifacts by text holding a lone surrogate",
      (store: SqliteArtifactStore) =>
        store.listArtifacts({ limit: 5, text: "\uD83D" }),
      [
        [null, "scope=?"],
        ["artifacts_scope_created", "scope=?"],
      ],
    ],
    [
      "listArtifacts after a cursor whose time is no valid Date",
      (store: SqliteArtifactStore) =>
        store.listArtifacts({
          after: { createdAt: new Date(Number.NaN), id: artifactId("a") },
          limit: 5,
        }),
      [
        [null, "scope=?"],
        ["artifacts_scope_created", "scope=?"],
      ],
    ],
    [
      "listArtifacts by text holding NUL, which reads nothing",
      (store: SqliteArtifactStore) =>
        store.listArtifacts({ limit: 5, text: "a\u0000" }),
      [],
    ],
    [
      "listBlobs",
      (store: SqliteArtifactStore) => store.listBlobs(),
      [[null, "scope=?"]],
    ],
    [
      "listContents",
      (store: SqliteArtifactStore) => store.listContents(),
      [[null, "scope=?"]],
    ],
    [
      "listContents of one Artifact",
      (store: SqliteArtifactStore) => store.listContents(artifactId("a")),
      [["artifact_contents_scope_artifact", "scope=? AND artifact_id=?"]],
    ],
  ] as const)(
    "%s searches its index, with no scan and no sort",
    async (_read, read, expected) => {
      const plans = await plansOf(read, "select");
      expect(plans).toHaveLength(expected.length);
      for (const [step, plan] of plans.entries()) {
        const [index, by] = expected[step] ?? [];
        expect(plan).toMatch(
          new RegExp(
            String.raw`^SEARCH \S+ USING (COVERING )?INDEX ${index ?? String.raw`\S+`} \(${escapeRegExp(by ?? "")}\)$`
          )
        );
      }
    }
  );

  test("a write's deletes each search a key, the lookup rows included", async () => {
    const plans = await plansOf(
      (store) =>
        store.commit({
          deleteArtifacts: [artifactId("a")],
          deleteBlobs: [blobId("b")],
          deleteContents: [contentId("c")],
        }),
      "delete"
    );
    expect(plans).toEqual([
      "SEARCH artifacts USING INDEX sqlite_autoindex_artifacts_1 (scope=? AND id=?)",
      "SEARCH artifact_content_blobs USING INDEX artifact_content_blobs_scope_content (scope=? AND content_id=?)",
      "SEARCH artifact_contents USING INDEX sqlite_autoindex_artifact_contents_1 (scope=? AND id=?)",
      "SEARCH artifact_blob_chunks USING INDEX artifact_blob_chunks_scope_blob (scope=? AND blob_id=?)",
      "SEARCH artifact_blobs USING INDEX sqlite_autoindex_artifact_blobs_1 (scope=? AND id=?)",
    ]);
  });
});

/** `literal` with every regular-expression character escaped. */
function escapeRegExp(literal: string): string {
  return literal.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** What a commit's put into the Artifact table begins with. */
const PUT_ARTIFACTS = 'insert into "artifacts"';
const DELETE = "delete from";

describe.each([
  ["memory", memory],
  ["file", files],
] as const)("a commit that fails as it runs (%s)", (_location, databases) => {
  /**
   * A store whose next put into the Artifact table, once armed, fails as it
   * runs, after the statements before it in the same commit have run. `ran`
   * lists the statements that ran while it was armed.
   */
  async function failingPut() {
    let armed = false;
    const ran: string[] = [];
    const database = await databases.open({
      onQuery: (query) => {
        if (!armed) {
          return;
        }
        if (query.startsWith(PUT_ARTIFACTS)) {
          armed = false;
          throw new Error("put failed");
        }
        ran.push(query);
      },
    });
    return {
      arm() {
        armed = true;
      },
      ran,
      store: new SqliteArtifactStore({ database, scope: "s" }),
    };
  }

  const owner = artifactRecord("owner");
  const version = {
    ...contentRecord("c", "owner"),
    tree: { "a.txt": fileNode("b") },
  };
  const seeded = {
    putArtifacts: [owner],
    putBlobs: [inlineBlob("b")],
    putContents: [version],
  };

  test("rolls back the statements before the one that failed", async () => {
    const { arm, ran, store } = await failingPut();
    await store.commit(seeded);
    const before = await everything(store);
    arm();

    await expect(
      store.commit({
        deleteBlobs: [blobId("b")],
        deleteContents: [version.id],
        putArtifacts: [artifactRecord("new")],
      })
    ).rejects.toThrow("put failed");

    expect(
      ran.filter((query) => query.startsWith(DELETE)).length
    ).toBeGreaterThan(2);
    expect(await everything(store)).toEqual(before);
    expect((await store.findReferences(blobId("b"))).contentIds).toEqual([
      version.id,
    ]);
  });

  test("rolls back only a view commit that work catches, keeping the transaction's others", async () => {
    const { arm, ran, store } = await failingPut();
    await store.commit(seeded);

    await store.transaction(async (view) => {
      await view.commit({ putArtifacts: [artifactRecord("first")] });
      arm();
      await expect(
        view.commit({
          deleteContents: [version.id],
          putArtifacts: [artifactRecord("lost")],
        })
      ).rejects.toThrow("put failed");
      expect(ran.some((query) => query.startsWith(DELETE))).toBe(true);
      expect(await view.getContent(version.id)).toEqual(version);
      await view.commit({ putArtifacts: [artifactRecord("last")] });
    });

    expect(
      (await store.listArtifacts({ limit: 10 })).artifacts.map((row) => row.id)
    ).toEqual(["first", "last", "owner"]);
    expect(await store.getContent(version.id)).toEqual(version);
  });
});

describe("what onCommit learns of a change", () => {
  async function recorded() {
    const writes: ArtifactStoreWrite[] = [];
    const store = new SqliteArtifactStore({
      database: await memory.open(),
      onCommit: (_transaction, write) => {
        writes.push(structuredClone(write));
        return Promise.resolve();
      },
      scope: "s",
    });
    /** Which lists the writes `run` committed fill, and how full. */
    const shapes = async (run: () => Promise<unknown>) => {
      const before = writes.length;
      await run();
      return writes.slice(before).map((write) =>
        Object.fromEntries(
          Object.entries(write)
            .map(([list, rows]) => [list, (rows as unknown[]).length])
            .filter(([, rows]) => rows !== 0)
        )
      );
    };
    return { manager: new ArtifactManager({ store }), shapes, store, writes };
  }

  test("each operation is one write of whole records put and ids deleted", async () => {
    const { manager, shapes } = await recorded();
    let created = await manager.create({ name: "A", type: "text/plain" });
    expect(
      await shapes(async () => {
        created = await manager.create({
          entries: { "a.txt": { bytes: "a" } },
          name: "B",
          type: "text/plain",
        });
      })
    ).toEqual([{ events: 2, putArtifacts: 1, putBlobs: 1, putContents: 1 }]);
    const { id } = created;
    // A blob only this file names is rewritten in place: the same id, put again.
    expect(
      await shapes(() =>
        manager.write({
          artifactId: id,
          changes: { put: { "a.txt": { bytes: "b" } } },
        })
      )
    ).toEqual([{ events: 1, putArtifacts: 1, putBlobs: 1, putContents: 1 }]);
    expect(await shapes(() => manager.rename(id, "C"))).toEqual([
      { events: 1, putArtifacts: 1 },
    ]);
    const first = required(created.contentId);
    expect(await shapes(() => manager.setMetadata(first, { n: 1 }))).toEqual([
      { events: 1, putContents: 1 },
    ]);
    expect(await shapes(() => manager.freeze(first))).toEqual([
      { events: 1, putArtifacts: 1, putContents: 1 },
    ]);
    expect(await shapes(() => manager.tag(first, "v1"))).toEqual([
      { events: 1, putContents: 1 },
    ]);
    expect(await shapes(() => manager.fork({ contentId: first }))).toEqual([
      { events: 1, putArtifacts: 1, putContents: 1 },
    ]);
    // Deleting an Artifact names its Contents; the shared blob stays.
    expect(await shapes(() => manager.delete(id))).toEqual([
      { deleteArtifacts: 1, deleteContents: 1, events: 1 },
    ]);
  });

  test("a transaction of several operations arrives as one net write", async () => {
    const { manager, shapes, writes } = await recorded();
    expect(
      await shapes(() =>
        manager.transaction(async (transaction) => {
          const made = await transaction.create({
            name: "T",
            type: "text/plain",
          });
          await transaction.rename(made.id, "Renamed");
        })
      )
    ).toEqual([{ events: 2, putArtifacts: 1 }]);
    expect(writes.at(-1)?.putArtifacts?.[0]?.name).toBe("Renamed");
    expect(writes.at(-1)?.events?.map((event) => event.type)).toEqual([
      "artifact.created",
      "artifact.renamed",
    ]);
  });

  test("a record put and deleted in one change arrives as a delete of an id the store never held", async () => {
    const { manager, shapes, store } = await recorded();
    expect(
      await shapes(() =>
        manager.transaction(async (transaction) => {
          const made = await transaction.create({
            entries: { "z.txt": { bytes: "z" } },
            name: "Gone",
            type: "text/plain",
          });
          await transaction.delete(made.id);
        })
      )
    ).toEqual([
      { deleteArtifacts: 1, deleteBlobs: 1, deleteContents: 1, events: 3 },
    ]);
    expect(await everything(store)).toEqual({
      artifacts: [],
      blobs: [],
      contents: [],
    });
  });
});

describe("SqliteArtifactStore's own copy of a write", () => {
  test("is what every row comes from, though the caller changes the write while it runs", async () => {
    let change: () => void = () => undefined;
    const database = await memory.open({
      onQuery: (query) => {
        // After the rows are made, before the lookup rows are written.
        if (query.startsWith('delete from "artifact_content_blobs"')) {
          change();
        }
      },
    });
    const store = new SqliteArtifactStore({ database, scope: "s" });
    const version = contentRecord("c", "a", {
      tree: { f: fileNode("old") },
    });
    const write = { putContents: [version] };
    change = () => {
      Object.assign(version.tree.f ?? {}, { blobId: blobId("new") });
    };

    await store.commit(write);

    expect((await store.getContent(version.id))?.tree).toEqual({
      f: fileNode("old"),
    });
    expect(await store.findReferences(blobId("old"))).toEqual({
      blobIds: [],
      contentIds: [version.id],
    });
    expect(await store.findReferences(blobId("new"))).toEqual({
      blobIds: [],
      contentIds: [],
    });
  });

  test("is what onCommit receives, not the caller's object", async () => {
    const received: ArtifactStoreWrite[] = [];
    const store = new SqliteArtifactStore({
      database: await memory.open(),
      onCommit: (_transaction, committed) => {
        received.push(committed);
        return Promise.resolve();
      },
      scope: "s",
    });
    const record = artifactRecord("a");
    const write = { putArtifacts: [record] };
    const landing = store.commit(write);
    Object.assign(record, { name: "changed" });
    await landing;

    expect(received).toHaveLength(1);
    expect(received[0]).not.toBe(write);
    expect(received[0]?.putArtifacts).toEqual([artifactRecord("a")]);
  });
});
