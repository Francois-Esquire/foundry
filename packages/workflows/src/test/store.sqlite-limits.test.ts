import { eq, getTableColumns, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vitest";
import type { z } from "zod";

import type {
  JobRecord,
  QueueRecord,
  RunFrame,
  RunRecord,
  SuspensionRecord,
} from "../schema";
import {
  JobRecordSchema,
  QueueRecordSchema,
  RunFrameSchema,
  RunRecordShapeSchema,
  SuspensionRecordSchema,
} from "../schema";
import type { WorkflowStoreWrite } from "../store/index";
import { SqliteWorkflowStore } from "../store/sqlite";
import type { RecordKind } from "../store/sqlite-records";
import { FRAME, JOB, QUEUE, RUN, SUSPENSION } from "../store/sqlite-records";
import {
  workflowJobs,
  workflowQueues,
  workflowRunFrames,
  workflowRuns,
  workflowSuspensions,
} from "../store/tables";
import { libsqlDatabases } from "./helpers/sqlite";

const memory = libsqlDatabases("memory");
const files = libsqlDatabases("file");

/** Text SQLite does not give back intact, each made from a plain string. */
const UNSTORABLE: [string, (plain: string) => string][] = [
  ["U+0000", (plain) => `${plain}\u0000tail`],
  ["a lone high surrogate", (plain) => `${plain}\uD800`],
  ["a lone low surrogate", (plain) => `\uDC00${plain}`],
];

const queue: QueueRecord = {
  createdAt: 1,
  extensions: {},
  id: "default",
  lastError: null,
  name: "default",
  status: "active",
};
const job: JobRecord = {
  definition: { name: "workflow.job" },
  id: "jb-a",
  input: null,
  links: {},
  status: "pending",
  timestamps: {
    cancelledAt: null,
    completedAt: null,
    createdAt: 1,
    failedAt: null,
  },
};
const run: RunRecord = {
  error: null,
  extensions: {},
  id: "rn-a",
  input: null,
  metadata: {},
  output: null,
  queueId: "default",
  snapshot: { cursor: null, input: null, name: "", steps: [] },
  status: "queued",
  step: "workflow.step",
  tags: {},
  timestamps: {
    completedAt: null,
    createdAt: 1,
    failedAt: null,
    startedAt: null,
  },
};
const suspension: SuspensionRecord = {
  id: "su-a",
  kind: "approval",
  name: "approve",
  occurrence: 0,
  reason: "needs a person",
  request: null,
  resolution: null,
  revision: 0,
  runId: "rn-a",
  status: "pending",
  stepPath: ["approve"],
  timestamps: { cancelledAt: null, createdAt: 1, resolvedAt: null },
};
const frame: RunFrame = {
  at: 1,
  cursor: 0,
  payload: { kind: "output", value: null },
  runId: "rn-a",
};
const everything: WorkflowStoreWrite = {
  putFrames: [frame],
  putJobs: [job],
  putQueues: [queue],
  putRuns: [run],
  putSuspensions: [suspension],
};

/** A host table, written in the same transaction as a commit. */
const changes = sqliteTable("changes", {
  write: text("write", { mode: "json" }).notNull(),
});

async function withChanges() {
  const database = await memory.open();
  await database.run(sql`CREATE TABLE "changes" ("write" text NOT NULL)`);
  return database;
}

/** Every record in the store, read whole. */
async function contents(store: SqliteWorkflowStore) {
  const limit = 1000;
  return {
    frames: (await store.listFrames({ limit })).items,
    jobs: (await store.listJobs({ limit })).items,
    queues: await store.listQueues(),
    runs: (await store.listRuns({ limit })).items,
    suspensions: (await store.listSuspensions({ limit })).items,
  };
}

describe("SqliteWorkflowStore storage limits", () => {
  test("refuses an empty scope", async () => {
    const database = await memory.open();
    expect(() => new SqliteWorkflowStore({ database, scope: "" })).toThrow(
      RangeError
    );
  });

  test.each(UNSTORABLE)("refuses a scope holding %s", async (_kind, bad) => {
    const database = await memory.open();
    expect(
      () => new SqliteWorkflowStore({ database, scope: bad("scope") })
    ).toThrow(RangeError);
  });

  test.each(UNSTORABLE)(
    "refuses, before writing anything, %s in a text column, naming it",
    async (_kind, bad) => {
      let committed = 0;
      const store = new SqliteWorkflowStore({
        database: await memory.open(),
        onCommit: () => {
          committed += 1;
          return Promise.resolve();
        },
        scope: "s",
      });
      await store.commit(everything);
      const before = await contents(store);
      const refusals: [WorkflowStoreWrite, string][] = [
        [{ putQueues: [{ ...queue, id: bad("q") }] }, "putQueues[0].id"],
        [{ putQueues: [{ ...queue, name: bad("q") }] }, "putQueues[0].name"],
        [{ putJobs: [job, { ...job, id: bad("jb-") }] }, "putJobs[1].id"],
        [{ putRuns: [{ ...run, id: bad("rn-") }] }, "putRuns[0].id"],
        [{ putRuns: [{ ...run, queueId: bad("q") }] }, "putRuns[0].queueId"],
        [{ putRuns: [{ ...run, step: bad("s") }] }, "putRuns[0].step"],
        [
          { putSuspensions: [{ ...suspension, kind: bad("k") }] },
          "putSuspensions[0].kind",
        ],
        [
          { putSuspensions: [{ ...suspension, name: bad("n") }] },
          "putSuspensions[0].name",
        ],
        [
          { putSuspensions: [{ ...suspension, reason: bad("r") }] },
          "putSuspensions[0].reason",
        ],
        [
          { putSuspensions: [{ ...suspension, runId: bad("rn-") }] },
          "putSuspensions[0].runId",
        ],
        [
          {
            deleteRuns: [run.id],
            putFrames: [{ ...frame, runId: bad("rn-") }],
          },
          "putFrames[0].runId",
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

      expect(committed).toBe(1);
      expect(await contents(store)).toStrictEqual(before);
      // JSON columns escape it, so the JSON fields keep it.
      const json: RunRecord = {
        ...run,
        id: "rn-json",
        input: bad("input"),
        metadata: { [bad("key")]: bad("value") },
        tags: { label: bad("tag") },
      };
      await store.commit({ putRuns: [json] });
      expect(await store.getRun(json.id)).toStrictEqual(json);
    }
  );

  test.each(UNSTORABLE)(
    "a read, list or delete by a key holding %s touches no other row",
    async (_kind, bad) => {
      const store = new SqliteWorkflowStore({
        database: await memory.open(),
        scope: "s",
      });
      // What a lone surrogate turns into when bound: U+FFFD on Node, nothing
      // on Bun; and what a NUL cuts text to.
      const lookalikes = ["\uFFFD", "x", "\uFFFDx", "x\uFFFD"].map((tail) => ({
        ...run,
        id: `rn-${tail}`,
        queueId: `q-${tail}`,
      }));
      const lookalikeFrames = lookalikes.map((record) => ({
        ...frame,
        runId: record.id,
      }));
      await store.commit({ putFrames: lookalikeFrames, putRuns: lookalikes });
      const keys = [`rn-${bad("x").slice(0, 2)}`, `rn-${bad("")}`];

      for (const key of keys) {
        expect(await store.getRun(key)).toBeNull();
        expect(
          (await store.listRuns({ limit: 10, queueId: `q-${key.slice(3)}` }))
            .items
        ).toEqual([]);
        expect(
          (await store.listFrames({ limit: 10, runId: key })).items
        ).toEqual([]);
      }
      await store.commit({ deleteRunFrames: keys, deleteRuns: keys });
      expect((await contents(store)).runs).toStrictEqual(lookalikes);
      expect((await contents(store)).frames).toStrictEqual(lookalikeFrames);
    }
  );

  test("refuses, naming the field, values JSON or an integer column would change", async () => {
    const store = new SqliteWorkflowStore({
      database: await memory.open(),
      scope: "s",
    });
    const hole: unknown[] = [];
    hole.length = 1;
    const refusals: [WorkflowStoreWrite, string, string][] = [
      [
        { putRuns: [{ ...run, output: { count: -0 } }] },
        "putRuns[0].output.count",
        "-0 does not read back intact from JSON",
      ],
      [
        { putRuns: [{ ...run, metadata: { list: [1, hole] } }] },
        "putRuns[0].metadata.list[1][0]",
        "a hole in an array",
      ],
      [
        { putRuns: [{ ...run, metadata: { at: new Date(0) } }] },
        "putRuns[0].metadata.at",
        "a Date does not read back intact",
      ],
      [
        { putRuns: [{ ...run, metadata: { gone: undefined } }] },
        "putRuns[0].metadata.gone",
        "a property holding undefined",
      ],
      [
        { putRuns: [{ ...run, definition: undefined }] },
        "putRuns[0].definition",
        "a property holding undefined",
      ],
      [
        {
          putRuns: [{ ...run, links: null } as unknown as RunRecord],
        },
        "putRuns[0].links",
        "null reads back from SQLite as the field left out",
      ],
      [
        {
          putRuns: [
            { ...run, archived: () => undefined } as unknown as RunRecord,
          ],
        },
        "putRuns[0].archived",
        "a function has no JSON form",
      ],
      [
        { putQueues: [{ ...queue, createdAt: -0 }] },
        "putQueues[0].createdAt",
        "-0 does not read back intact from SQLite",
      ],
      [
        { putFrames: [{ ...frame, at: 2 ** 60 }] },
        "putFrames[0].at",
        "within ±Number.MAX_SAFE_INTEGER",
      ],
      [
        {
          putJobs: [{ ...job, archived: true } as unknown as JobRecord],
        },
        "putJobs[0].archived",
        "is no field of a Job, and SQLite has no column for it",
      ],
      [
        { putSuspensions: [{ ...suspension, status: "lost" as "pending" }] },
        "putSuspensions[0].status",
        "is not a Suspension its schema accepts",
      ],
    ];
    for (const [write, field, reason] of refusals) {
      await expect(store.commit(write)).rejects.toThrow(
        `cannot store ${field}: `
      );
      await expect(store.commit(write)).rejects.toThrow(reason);
    }
    expect(await contents(store)).toStrictEqual({
      frames: [],
      jobs: [],
      queues: [],
      runs: [],
      suspensions: [],
    });
  });

  test("refuses to read a row it would not have written, naming it", async () => {
    const database = await memory.open();
    const store = new SqliteWorkflowStore({ database, scope: "s" });
    await store.commit({ putRuns: [run] });
    await database
      .update(workflowRuns)
      .set({ metadata: sql`'{not json'` })
      .where(eq(workflowRuns.id, run.id));

    await expect(store.getRun(run.id)).rejects.toThrow(
      'cannot read Run "rn-a" in scope "s": column metadata holds text that is not JSON'
    );
    await database
      .update(workflowRuns)
      .set({ metadata: sql`'{}'`, status: sql`'lost'` })
      .where(eq(workflowRuns.id, run.id));
    await expect(store.listRuns({ limit: 1 })).rejects.toThrow(
      'cannot read Run "rn-a" in scope "s": field status is not a Run its schema accepts: Invalid option'
    );
  });

  test("onCommit runs inside the commit, after the store's statements, with the store's copy of the write", async () => {
    const database = await withChanges();
    const seen: {
      readonly rows: number;
      readonly write: WorkflowStoreWrite;
    }[] = [];
    const store = new SqliteWorkflowStore({
      database,
      onCommit: async (transaction, received) => {
        const rows = await transaction
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.scope, "host"));
        seen.push({ rows: rows.length, write: received });
        await transaction.insert(changes).values({ write: received });
      },
      scope: "host",
    });
    const write = { ...everything, deleteRuns: ["rn-gone"] };
    await store.commit(write);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.rows).toBe(1);
    expect(seen[0]?.write).toStrictEqual({
      ...everything,
      deleteJobs: [],
      deleteRunFrames: [],
      deleteRuns: ["rn-gone"],
      deleteSuspensions: [],
    });
    expect(seen[0]?.write.putRuns?.[0]).not.toBe(run);
    expect((await database.select().from(changes)).length).toBe(1);
  });

  test.each([
    ["memory", memory],
    ["file", files],
  ] as const)(
    "onCommit receives the write as it stood when commit was called (%s)",
    async (_location, databases) => {
      const received: WorkflowStoreWrite[] = [];
      const store = new SqliteWorkflowStore({
        database: await databases.open(),
        onCommit: (_transaction, write) => {
          received.push(write);
          return Promise.resolve();
        },
        scope: "host",
      });
      const writeOf = (id: string) => ({
        putRuns: [{ ...run, id, metadata: { list: ["x"] } }] as RunRecord[],
      });
      const change = (write: ReturnType<typeof writeOf>) => {
        for (const record of write.putRuns) {
          Object.assign(record, { step: "changed" });
          (record.metadata.list as string[]).push("changed");
        }
        write.putRuns.push({ ...run, id: "rn-late" });
      };

      const held = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const running = store.transaction(async () => {
        entered.resolve();
        await held.promise;
      });
      await entered.promise;
      const queued = writeOf("rn-queued");
      const expected = [structuredClone(queued)];
      const landing = store.commit(queued);
      change(queued);
      held.resolve();
      await Promise.all([running, landing]);
      const viewed = writeOf("rn-viewed");
      expected.push(structuredClone(viewed));
      await store.transaction(async (view) => {
        const committed = view.commit(viewed);
        change(viewed);
        await committed;
      });

      expect(received.map((write) => write.putRuns)).toStrictEqual(
        expected.map((write) => write.putRuns)
      );
      expect((await contents(store)).runs).toStrictEqual(
        received.flatMap((write) => write.putRuns ?? [])
      );
    }
  );

  test("onCommit calling the store it belongs to is refused at once", async () => {
    const outcomes: string[] = [];
    let store: SqliteWorkflowStore | undefined;
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
    store = new SqliteWorkflowStore({
      database: await memory.open(),
      onCommit: async (transaction) => {
        const outer = store as SqliteWorkflowStore;
        await attempt(() => outer.getRun(run.id));
        await attempt(() => outer.listRuns({ limit: 1 }));
        await attempt(() => outer.commit({}));
        await attempt(() => outer.transaction(() => Promise.resolve()));
        // The transaction it is given is the way in.
        await transaction.select().from(workflowRuns);
      },
      scope: "s",
    });

    await store.commit({ putRuns: [run] });

    expect(outcomes).toHaveLength(4);
    for (const outcome of outcomes) {
      expect(outcome).toContain("ReentrantCallError");
      expect(outcome).toContain("the transaction passed to onCommit");
    }
    expect(await store.getRun(run.id)).toStrictEqual(run);
  });

  test("a throwing onCommit rolls back the store's statements and its own", async () => {
    const database = await withChanges();
    const store = new SqliteWorkflowStore({
      database,
      onCommit: async (transaction, write) => {
        await transaction.insert(changes).values({ write });
        throw new Error("host refused");
      },
      scope: "host",
    });

    await expect(store.commit(everything)).rejects.toThrow("host refused");
    expect(await contents(store)).toStrictEqual({
      frames: [],
      jobs: [],
      queues: [],
      runs: [],
      suspensions: [],
    });
    expect(await database.select().from(changes)).toEqual([]);
  });

  test("a host transaction can be the database, so a commit joins it", async () => {
    const database = await memory.open();

    await expect(
      database.transaction(async (transaction) => {
        const joined = new SqliteWorkflowStore({
          database: transaction,
          scope: "s",
        });
        await joined.commit({ putRuns: [run] });
        expect(await joined.getRun(run.id)).toStrictEqual(run);
        throw new Error("host rolled back");
      })
    ).rejects.toThrow("host rolled back");
    expect(
      await new SqliteWorkflowStore({ database, scope: "s" }).getRun(run.id)
    ).toBeNull();
  });

  test("a file database keeps its records for the next connection", async () => {
    const first = await files.open();
    await new SqliteWorkflowStore({ database: first, scope: "s" }).commit(
      everything
    );
    const reopened = await files.reopen(first);
    expect(
      await contents(
        new SqliteWorkflowStore({ database: reopened, scope: "s" })
      )
    ).toStrictEqual({
      frames: [frame],
      jobs: [job],
      queues: [queue],
      runs: [run],
      suspensions: [suspension],
    });
  });
});

describe("SqliteWorkflowStore writes and positions", () => {
  test("onCommit receives the write its one read of each property gave", async () => {
    let reads = 0;
    let received: WorkflowStoreWrite | undefined;
    const store = new SqliteWorkflowStore({
      database: await memory.open(),
      onCommit: (_transaction, write) => {
        received = write;
        return Promise.resolve();
      },
      scope: "s",
    });
    await store.commit({
      get putRuns() {
        reads += 1;
        return reads === 1 ? [run] : undefined;
      },
    });

    expect(reads).toBe(1);
    expect(received?.putRuns).toStrictEqual([run]);
    expect(await store.getRun(run.id)).toStrictEqual(run);
  });

  test("states durability: commit over a database, host over a transaction it was handed", async () => {
    const database = await memory.open();
    expect(new SqliteWorkflowStore({ database, scope: "s" }).durability).toBe(
      "commit"
    );
    expect(
      new SqliteWorkflowStore({ database, durability: "host", scope: "s" })
        .durability
    ).toBe("host");
    await database.transaction(async (transaction) => {
      expect(
        new SqliteWorkflowStore({ database: transaction, scope: "s" })
          .durability
      ).toBe("host");
      expect(
        () =>
          new SqliteWorkflowStore({
            database: transaction,
            durability: "commit",
            scope: "s",
          })
      ).toThrow('durability cannot be "commit"');
    });
  });

  test.each([
    ["deletes and puts", true],
    ["only deletes", false],
  ] as const)(
    "a scope written before the counter keeps its high-water mark when its first commit %s",
    async (_case, putsToo) => {
      const first = await files.open();
      const named = (id: string) => ({ ...run, id });
      await new SqliteWorkflowStore({ database: first, scope: "s" }).commit({
        putRuns: [named("rn-a"), named("rn-b"), named("rn-x")],
      });
      // A scope whose rows predate `workflow_positions`: no counter row.
      await first.run(sql`DELETE FROM workflow_positions WHERE scope = 's'`);
      const before = new SqliteWorkflowStore({
        database: await files.reopen(first),
        scope: "s",
      });
      const page = await before.listRuns({ limit: 2 });
      await before.commit({
        deleteRuns: ["rn-b", "rn-x"],
        ...(putsToo ? { putRuns: [named("rn-c")] } : {}),
      });

      const after = new SqliteWorkflowStore({
        database: await files.reopen(first),
        scope: "s",
      });
      if (!putsToo) {
        await after.commit({ putRuns: [named("rn-c")] });
      }
      expect(
        (await after.listRuns({ after: page.next, limit: 10 })).items
      ).toStrictEqual([named("rn-c")]);
    }
  );

  test("never hands a position out twice, across deletes and reopening", async () => {
    const first = await files.open();
    const store = new SqliteWorkflowStore({ database: first, scope: "s" });
    const named = (id: string) => ({ ...run, id });
    await store.commit({
      putRuns: [named("rn-a"), named("rn-b"), named("rn-x")],
    });
    const page = await store.listRuns({ limit: 2 });
    // The two highest positions go, so none is left past the cursor.
    await store.commit({ deleteRuns: ["rn-b", "rn-x"] });

    const reopened = new SqliteWorkflowStore({
      database: await files.reopen(first),
      scope: "s",
    });
    await reopened.commit({ putRuns: [named("rn-c")] });

    expect(
      (await reopened.listRuns({ after: page.next, limit: 10 })).items
    ).toStrictEqual([named("rn-c")]);
    // Another scope counts on its own.
    const other = new SqliteWorkflowStore({
      database: await files.reopen(first),
      scope: "t",
    });
    await other.commit({ putRuns: [named("rn-t")] });
    expect((await other.listRuns({ limit: 10 })).items).toStrictEqual([
      named("rn-t"),
    ]);
  });
});

describe("workflow tables", () => {
  test.each([
    ["workflow_queues", workflowQueues, QUEUE, QueueRecordSchema.shape],
    ["workflow_jobs", workflowJobs, JOB, JobRecordSchema.shape],
    ["workflow_runs", workflowRuns, RUN, RunRecordShapeSchema.shape],
    [
      "workflow_suspensions",
      workflowSuspensions,
      SUSPENSION,
      SuspensionRecordSchema.shape,
    ],
    ["workflow_run_frames", workflowRunFrames, FRAME, RunFrameSchema.shape],
  ] as const)(
    "%s holds each record field for field, plus scope and position",
    (_name, table, kind, shape) => {
      const { position, scope, undeclared, ...columns } = getTableColumns(
        table as SQLiteTable
      ) as ReturnType<typeof getTableColumns<SQLiteTable>>;
      expect([position?.notNull, scope?.notNull]).toEqual([true, true]);
      expect(undeclared === undefined).toBe(
        !(kind as RecordKind<unknown>).undeclared
      );
      const fields = shape as Readonly<Record<string, z.ZodType>>;
      expect(Object.keys(columns).sort()).toEqual(Object.keys(fields).sort());
      expect(Object.keys((kind as RecordKind<unknown>).fields).sort()).toEqual(
        Object.keys(fields).sort()
      );
      for (const [field, column] of Object.entries(columns)) {
        const schema = fields[field] as z.ZodType;
        const fieldKind = (kind as RecordKind<unknown>).fields[field];
        // A nullable column is a field that takes `null` or may be left out.
        expect([field, !column.notNull]).toEqual([
          field,
          schema.safeParse(null).success || fieldKind === "optional",
        ]);
        expect([field, column.columnType]).toEqual([
          field,
          {
            integer: "SQLiteInteger",
            json: "SQLiteTextJson",
            optional: "SQLiteTextJson",
            text: "SQLiteText",
          }[fieldKind ?? "text"],
        ]);
      }
    }
  );
});
