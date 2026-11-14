import { getTableColumns, sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import type { SessionMessage, SessionRecord } from "../../schema";
import { sessionMessageSchema, sessionRecordSchema } from "../../schema";
import { Sessions } from "../../session/sessions";
import type { SessionStoreWrite } from "../../store";
import type { SessionDatabase } from "../../store/sqlite";
import { SqliteSessionStore } from "../../store/sqlite";
import { agentMessages, agentSessions } from "../../store/tables";
import type { OnQuery } from "../helpers/sqlite";
import { libsqlDatabases } from "../helpers/sqlite";

const memory = libsqlDatabases("memory");
const files = libsqlDatabases("file");

/** Text SQLite does not give back intact, each made from a plain string. */
const UNSTORABLE: [string, (plain: string) => string][] = [
  ["U+0000", (plain) => `${plain}\u0000tail`],
  ["a lone high surrogate", (plain) => `${plain}\uD800`],
  ["a lone low surrogate", (plain) => `\uDC00${plain}`],
];

function session(
  id: string,
  fields: Partial<SessionRecord> = {}
): SessionRecord {
  return {
    createdAt: 1,
    id,
    parentMessageId: null,
    parentSessionId: null,
    status: "active",
    title: null,
    updatedAt: 1,
    ...fields,
  };
}

function message(
  id: string,
  sessionId: string,
  fields: Partial<SessionMessage> = {}
): SessionMessage {
  return {
    createdAt: 1,
    id,
    parts: [{ text: id, type: "text" }],
    role: "user",
    sessionId,
    status: "complete",
    updatedAt: 1,
    ...fields,
  };
}

async function storeOn(
  options: {
    readonly onCommit?: ConstructorParameters<
      typeof SqliteSessionStore
    >[0]["onCommit"];
    readonly onQuery?: OnQuery;
  } = {}
) {
  const database = await memory.open(
    options.onQuery === undefined ? {} : { onQuery: options.onQuery }
  );
  return {
    database,
    store: new SqliteSessionStore({
      database,
      scope: "s",
      ...(options.onCommit === undefined ? {} : { onCommit: options.onCommit }),
    }),
  };
}

/** Every row of both tables, as stored, scope and position included. */
async function rowsIn(database: SessionDatabase) {
  return {
    messages: await database.select().from(agentMessages),
    sessions: await database.select().from(agentSessions),
  };
}

describe("SqliteSessionStore scope", () => {
  it("refuses an empty scope", async () => {
    const database = await memory.open();
    expect(() => new SqliteSessionStore({ database, scope: "" })).toThrow(
      RangeError
    );
  });

  it.each(UNSTORABLE)("refuses a scope holding %s", async (_kind, bad) => {
    const database = await memory.open();
    expect(
      () => new SqliteSessionStore({ database, scope: bad("scope") })
    ).toThrow(RangeError);
  });
});

describe("SqliteSessionStore text refusals", () => {
  it.each(UNSTORABLE)(
    "refuses, before writing anything, %s in a plain-text field, naming it",
    async (_kind, bad) => {
      let committed = 0;
      const { database, store } = await storeOn({
        onCommit: () => {
          committed += 1;
          return Promise.resolve();
        },
      });
      const sessions = new Sessions({ store });
      await sessions.createSession({ id: "kept" });
      const before = await rowsIn(database);
      const kept = session("kept");
      const refusals: [SessionStoreWrite, string][] = [
        [{ putSessions: [session(bad("id"))] }, "putSessions[0].id"],
        [
          { putSessions: [kept, session("t", { title: bad("title") })] },
          "putSessions[1].title",
        ],
        [
          { putSessions: [session("p", { parentSessionId: bad("p") })] },
          "putSessions[0].parentSessionId",
        ],
        [
          { putSessions: [session("p", { parentMessageId: bad("m") })] },
          "putSessions[0].parentMessageId",
        ],
        [
          {
            putSessions: [
              session("p", {
                status: bad("active") as SessionRecord["status"],
              }),
            ],
          },
          "putSessions[0].status",
        ],
        [
          { putMessages: [message(bad("m"), "kept")], putSessions: [kept] },
          "putMessages[0].id",
        ],
        [
          { putMessages: [message("m", "kept"), message("n", bad("kept"))] },
          "putMessages[1].sessionId",
        ],
        [
          {
            putMessages: [
              message("m", "kept", {
                role: bad("user") as SessionMessage["role"],
              }),
            ],
          },
          "putMessages[0].role",
        ],
        [
          {
            putMessages: [
              message("m", "kept", {
                status: bad("complete") as SessionMessage["status"],
              }),
            ],
          },
          "putMessages[0].status",
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
      await expect(
        sessions.createSession({ title: bad("via Sessions") })
      ).rejects.toThrow(RangeError);

      expect(committed).toBe(1);
      expect(await rowsIn(database)).toEqual(before);
    }
  );

  it.each(UNSTORABLE)(
    "keeps %s in JSON, in values and in keys alike",
    async (_kind, bad) => {
      const { store } = await storeOn();
      const stored = message("m", "s", {
        metadata: {
          output: { [bad("key")]: [bad("item")] },
          providerOptions: { [bad("p")]: { [bad("k")]: bad("v") } },
        },
        parts: [
          { text: bad("text"), type: "text" },
          { output: bad("out"), toolCallId: "c", type: "tool_result" },
        ],
      });
      await store.commit({
        putMessages: [stored],
        putSessions: [session("s")],
      });

      await expect(store.getMessage("m")).resolves.toStrictEqual(stored);
      await expect(store.listMessages("s")).resolves.toStrictEqual([stored]);
    }
  );

  it.each(UNSTORABLE)(
    "a read by a key holding %s touches no other row",
    async (_kind, bad) => {
      const { store } = await storeOn();
      // What a lone surrogate turns into when bound: U+FFFD on Node, nothing
      // on Bun; and what a NUL cuts text to.
      const lookalikes = ["�", "", "x"];
      await store.commit({
        putMessages: lookalikes.map((id) => message(id, id)),
        putSessions: lookalikes.map((id) => session(id)),
      });
      for (const key of [bad("x").slice(0, 2), bad("")]) {
        await expect(store.getSession(key)).resolves.toBeNull();
        await expect(store.getMessage(key)).resolves.toBeNull();
        await expect(store.listMessages(key)).resolves.toEqual([]);
      }
    }
  );
});

describe("SqliteSessionStore number refusals", () => {
  const NUMBERS: [string, number][] = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["-0", -0],
    [String(2 ** 53), 2 ** 53],
    [String(-(2 ** 53)), -(2 ** 53)],
  ];

  it.each(NUMBERS)(
    "refuses %s in an integer field, naming it",
    async (shown, value) => {
      const { database, store } = await storeOn();
      const refusals: [SessionStoreWrite, string][] = [
        [
          { putSessions: [session("a", { createdAt: value })] },
          "putSessions[0].createdAt",
        ],
        [
          { putSessions: [session("a", { updatedAt: value })] },
          "putSessions[0].updatedAt",
        ],
        [
          { putSessions: [session("a", { recursionDepth: value })] },
          "putSessions[0].recursionDepth",
        ],
        [
          { putMessages: [message("m", "a", { createdAt: value })] },
          "putMessages[0].createdAt",
        ],
        [
          { putMessages: [message("m", "a", { updatedAt: value })] },
          "putMessages[0].updatedAt",
        ],
      ];
      for (const [write, field] of refusals) {
        await expect(store.commit(write)).rejects.toThrow(
          `cannot store ${field}: ${shown} does not read back intact from SQLite`
        );
      }
      expect(await rowsIn(database)).toEqual({ messages: [], sessions: [] });
    }
  );

  it("keeps every other number, the largest safe integers and fractions too", async () => {
    const { store } = await storeOn();
    const stored = session("a", {
      createdAt: Number.MAX_SAFE_INTEGER,
      recursionDepth: 0.5,
      updatedAt: -Number.MAX_SAFE_INTEGER,
    });
    const filed = message("m", "a", { createdAt: 0, updatedAt: 1.25 });
    await store.commit({ putMessages: [filed], putSessions: [stored] });

    await expect(store.getSession("a")).resolves.toStrictEqual(stored);
    await expect(store.getMessage("m")).resolves.toStrictEqual(filed);
  });
});

describe("SqliteSessionStore JSON refusals", () => {
  class Point {
    readonly x = 1;
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const REFUSED: [string, unknown, string, string][] = [
    ["NaN", Number.NaN, "", "NaN does not read back intact from JSON"],
    [
      "Infinity",
      Number.POSITIVE_INFINITY,
      "",
      "Infinity does not read back intact from JSON",
    ],
    ["-0", -0, "", "-0 does not read back intact from JSON"],
    [
      "undefined in an array",
      [1, undefined],
      "[1]",
      "undefined in an array reads back from JSON as null",
    ],
    [
      "a hole in an array",
      // biome-ignore lint/suspicious/noSparseArray: the hole is the case.
      [1, , 3],
      "[1]",
      "a hole in an array reads back from JSON as null",
    ],
    ["a Date", new Date(0), "", "a Date does not read back intact from JSON"],
    ["a Map", new Map(), "", "a Map does not read back intact from JSON"],
    ["a class instance", new Point(), "", "a Point does not read back"],
    ["a bigint", 1n, "", "a bigint has no JSON form"],
    ["a function", () => 1, "", "a function has no JSON form"],
    ["a symbol", Symbol("s"), "", "a symbol has no JSON form"],
    [
      "a value that contains itself",
      cyclic,
      ".self",
      "a value that contains itself has no JSON form",
    ],
    [
      "a nested NaN under an odd key",
      { list: [{ "odd key": Number.NaN }] },
      '.list[0]["odd key"]',
      "NaN does not read back",
    ],
  ];

  it.each(REFUSED)(
    "refuses %s in parts or metadata, naming where",
    async (_kind, value, below, reason) => {
      const { database, store } = await storeOn();
      const refusals: [SessionStoreWrite, string][] = [
        [
          {
            putMessages: [
              message("m", "a", {
                parts: [
                  { text: "t", type: "text" },
                  {
                    input: value,
                    name: "n",
                    toolCallId: "c",
                    type: "tool_call",
                  },
                ],
              }),
            ],
          },
          `putMessages[0].parts[1].input${below}`,
        ],
        [
          {
            putMessages: [
              message("ok", "a"),
              message("m", "a", { metadata: { output: value } }),
            ],
          },
          `putMessages[1].metadata.output${below}`,
        ],
      ];
      for (const [write, field] of refusals) {
        await expect(store.commit(write)).rejects.toThrow(
          `SqliteSessionStore cannot store ${field}: ${reason}`
        );
      }
      expect(await rowsIn(database)).toEqual({ messages: [], sessions: [] });
    }
  );

  it("refuses a property holding undefined, at the top and inside JSON, naming it", async () => {
    const { database, store } = await storeOn();
    const refusals: [SessionStoreWrite, string][] = [
      [
        { putMessages: [message("m", "a", { summarized: undefined })] },
        "putMessages[0].summarized",
      ],
      [
        { putMessages: [message("m", "a", { metadata: undefined })] },
        "putMessages[0].metadata",
      ],
      [
        { putSessions: [session("a", { recursionDepth: undefined })] },
        "putSessions[0].recursionDepth",
      ],
      [
        { putSessions: [session("a", { parentSessionId: undefined })] },
        "putSessions[0].parentSessionId",
      ],
      [
        {
          putMessages: [
            message("m", "a", {
              parts: [
                {
                  isError: undefined,
                  output: 1,
                  toolCallId: "c",
                  type: "tool_result",
                },
              ],
            }),
          ],
        },
        "putMessages[0].parts[0].isError",
      ],
      [
        {
          putMessages: [
            message("m", "a", {
              metadata: { model: { id: "x", provider: undefined } },
            }),
          ],
        },
        "putMessages[0].metadata.model.provider",
      ],
    ];
    for (const [write, field] of refusals) {
      await expect(store.commit(write)).rejects.toThrow(
        `SqliteSessionStore cannot store ${field}: a property holding undefined does not read back from SQLite; leave the field out`
      );
    }
    expect(await rowsIn(database)).toEqual({ messages: [], sessions: [] });
  });

  it.each([
    [
      "a part that is not an object",
      { parts: [null] },
      "putMessages[0].parts[0]: holds null, not a part",
    ],
    [
      "a part of no known type",
      { parts: [{ text: "t", type: "note" }] },
      'putMessages[0].parts[0].type: holds "note", which is no part type',
    ],
    [
      "a part without a field its type requires",
      { parts: [{ type: "text" }] },
      "putMessages[0].parts[0].text: is missing",
    ],
    [
      "metadata whose usage is not an object",
      { metadata: { usage: false } },
      "putMessages[0].metadata.usage: holds false, not an object",
    ],
  ])(
    "refuses %s, which would not read back as a message",
    async (_kind, fields, why) => {
      const { database, store } = await storeOn();
      await expect(
        store.commit({
          putMessages: [
            message("m", "a", fields as unknown as Partial<SessionMessage>),
          ],
        })
      ).rejects.toThrow(`SqliteSessionStore cannot store ${why}`);
      expect(await rowsIn(database)).toEqual({ messages: [], sessions: [] });
    }
  );

  it("refuses a parent link left out, which one column cannot tell from null", async () => {
    const { database, store } = await storeOn();
    const { parentSessionId: _session, ...noParentSession } = session("a");
    const { parentMessageId: _message, ...noParentMessage } = session("a");
    for (const [record, field] of [
      [noParentSession, "parentSessionId"],
      [noParentMessage, "parentMessageId"],
    ] as const) {
      await expect(store.commit({ putSessions: [record] })).rejects.toThrow(
        `cannot store putSessions[0].${field}: a field left out reads back from SQLite as null`
      );
    }
    expect(await rowsIn(database)).toEqual({ messages: [], sessions: [] });
  });
});

describe("SqliteSessionStore reading a row it did not write", () => {
  /** A good message row, as SQL values by column, and what to change in it. */
  async function corruptMessage(corrupted: Record<string, unknown>) {
    const { database, store } = await storeOn();
    const row: Record<string, unknown> = {
      created_at: 1,
      id: "m",
      metadata: null,
      parts: "[]",
      position: 1,
      role: "user",
      scope: "s",
      session_id: "a",
      status: "complete",
      summarized: null,
      updated_at: 1,
      ...corrupted,
    };
    await insertRaw(database, "agent_messages", row);
    return { database, store };
  }

  async function insertRaw(
    database: SessionDatabase,
    table: string,
    row: Record<string, unknown>
  ) {
    const columns = Object.keys(row);
    await database.run(
      sql.join(
        [
          sql.raw(
            `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (`
          ),
          sql.join(
            columns.map((column) => sql`${row[column]}`),
            sql.raw(", ")
          ),
          sql.raw(")"),
        ],
        sql.raw("")
      )
    );
  }

  const MESSAGE = 'message "m" of session "a" in scope "s"';

  it.each([
    [
      "parts [null]",
      { parts: "[null]" },
      "field parts[0] holds null, not a part",
    ],
    [
      "parts holding no array",
      { parts: '{"not":"a list"}' },
      "field parts holds an object, not an array",
    ],
    [
      "a part of no known type",
      { parts: '[{"type":"note"}]' },
      'field parts[0].type holds "note", which is no part type',
    ],
    [
      "a part missing a field its type requires",
      { parts: '[{"type":"tool_call","toolCallId":"c"}]' },
      "field parts[0].name is missing",
    ],
    [
      "a nested field of the wrong type",
      {
        parts:
          '[{"type":"harness_tool","event":{"agentId":"a","harness":"h","inputSummary":"i","outcome":"ran","sessionId":"a","toolCallId":"c","toolName":7}}]',
      },
      "field parts[0].event.toolName holds 7, not a string",
    ],
    [
      'metadata {"usage":false}',
      { metadata: '{"usage":false}' },
      "field metadata.usage holds false, not an object",
    ],
    [
      "metadata holding an array",
      { metadata: "[1]" },
      "field metadata holds an array, not an object",
    ],
    [
      "metadata usage missing a count",
      { metadata: '{"usage":{"inputTokens":1,"outputTokens":1}}' },
      "field metadata.usage.totalTokens is missing",
    ],
    [
      "summarized 7",
      { summarized: 7 },
      "column summarized holds 7, not 0, 1 or NULL",
    ],
    [
      "parts that are not JSON",
      { parts: "[{" },
      "column parts holds text that is not JSON",
    ],
    [
      "metadata that is not JSON",
      { metadata: "{usage" },
      "column metadata holds text that is not JSON",
    ],
    [
      "an unknown role",
      { role: "robot" },
      'column role holds "robot", which is no role',
    ],
    [
      "an unknown status",
      { status: "done" },
      'column status holds "done", which is no message status',
    ],
    [
      "a timestamp that is text",
      { created_at: "yesterday" },
      'column created_at holds "yesterday", not a number',
    ],
  ])(
    "refuses a message row holding %s, naming the row and the field",
    async (_kind, corrupted, fault) => {
      const { store } = await corruptMessage(corrupted);
      const named = `SqliteSessionStore cannot read ${MESSAGE}: ${fault}`;

      await expect(store.getMessage("m")).rejects.toThrow(named);
      await expect(store.listMessages("a")).rejects.toThrow(named);
    }
  );

  it("reads summarized 0 and 1 back as false and true", async () => {
    const { database, store } = await corruptMessage({ summarized: 0 });
    await insertRaw(database, "agent_messages", {
      created_at: 1,
      id: "n",
      metadata: null,
      parts: "[]",
      position: 2,
      role: "user",
      scope: "s",
      session_id: "a",
      status: "complete",
      summarized: 1,
      updated_at: 1,
    });

    const listed = await store.listMessages("a");
    expect(listed.map((m) => m.summarized)).toEqual([false, true]);
  });

  it("rejects a session's whole list for one bad row", async () => {
    const { database, store } = await storeOn();
    await store.commit({
      putMessages: [message("good-1", "a"), message("good-2", "a")],
      putSessions: [session("a")],
    });
    await insertRaw(database, "agent_messages", {
      created_at: 1,
      id: "bad",
      metadata: null,
      parts: "[null]",
      position: 99,
      role: "user",
      scope: "s",
      session_id: "a",
      status: "complete",
      summarized: null,
      updated_at: 1,
    });

    await expect(store.listMessages("a")).rejects.toThrow(
      'cannot read message "bad" of session "a" in scope "s"'
    );
    await expect(store.getMessage("good-1")).resolves.toStrictEqual(
      message("good-1", "a")
    );
  });

  it.each([
    [
      "an unknown status",
      { status: "paused" },
      'column status holds "paused", which is no session status',
    ],
    [
      "a recursion depth that is text",
      { recursion_depth: "deep" },
      'column recursion_depth holds "deep", not a number or NULL',
    ],
    [
      "a timestamp that is text",
      { updated_at: "later" },
      'column updated_at holds "later", not a number',
    ],
  ])("refuses a session row holding %s", async (_kind, corrupted, fault) => {
    const { database, store } = await storeOn();
    await insertRaw(database, "agent_sessions", {
      created_at: 1,
      id: "a",
      parent_message_id: null,
      parent_session_id: null,
      recursion_depth: null,
      scope: "s",
      status: "active",
      title: null,
      updated_at: 1,
      ...corrupted,
    });

    await expect(store.getSession("a")).rejects.toThrow(
      `SqliteSessionStore cannot read session "a" in scope "s": ${fault}`
    );
  });
});

/** A host table, written in the same transaction as a commit. */
const changes = sqliteTable("changes", {
  ids: text("ids", { mode: "json" }).notNull(),
});

async function withChanges() {
  const database = await memory.open();
  await database.run(sql`CREATE TABLE "changes" ("ids" text NOT NULL)`);
  return database;
}

describe("SqliteSessionStore onCommit", () => {
  it("runs inside the commit, after the store's statements, with the whole write", async () => {
    const database = await withChanges();
    const seen: { readonly rows: number; readonly write: SessionStoreWrite }[] =
      [];
    const store = new SqliteSessionStore({
      database,
      onCommit: async (transaction, write) => {
        const rows = await transaction.select().from(agentMessages);
        seen.push({ rows: rows.length, write });
        await transaction
          .insert(changes)
          .values({ ids: (write.putMessages ?? []).map((m) => m.id) });
      },
      scope: "host",
    });
    const sessions = new Sessions({ store });
    const created = await sessions.createSession({ id: "a" });
    const appended = await sessions.appendMessage({
      parts: [{ text: "hi", type: "text" }],
      role: "user",
      sessionId: "a",
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.write).toEqual({ putSessions: [created] });
    expect(seen[1]?.rows).toBe(1);
    expect(seen[1]?.write.putMessages).toEqual([appended]);
    expect(await database.select().from(changes)).toEqual([
      { ids: [] },
      { ids: [appended.id] },
    ]);
  });

  it("calling the store it belongs to is refused at once", async () => {
    const outcomes: string[] = [];
    let store: SqliteSessionStore | undefined;
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
    store = new SqliteSessionStore({
      database: await memory.open(),
      onCommit: async (transaction) => {
        const outer = store as SqliteSessionStore;
        await attempt(() => outer.getSession("a"));
        await attempt(() => outer.getMessage("m"));
        await attempt(() => outer.listMessages("a"));
        await attempt(() => outer.commit({}));
        await attempt(() => outer.transaction(() => Promise.resolve()));
        // The transaction it is given is the way in.
        await transaction.select().from(agentSessions);
      },
      scope: "s",
    });

    await store.commit({ putSessions: [session("a")] });

    expect(outcomes).toHaveLength(5);
    for (const outcome of outcomes) {
      expect(outcome).toContain("ReentrantCallError");
      expect(outcome).toContain("the transaction passed to onCommit");
    }
    await expect(store.getSession("a")).resolves.toStrictEqual(session("a"));
  });

  it("a throw rolls back the store's statements and the hook's own", async () => {
    const database = await withChanges();
    const store = new SqliteSessionStore({
      database,
      onCommit: async (transaction) => {
        await transaction.insert(changes).values({ ids: ["x"] });
        throw new Error("host refused");
      },
      scope: "host",
    });

    await expect(
      store.commit({
        putMessages: [message("m", "a")],
        putSessions: [session("a")],
      })
    ).rejects.toThrow("host refused");
    expect(await rowsIn(database)).toEqual({ messages: [], sessions: [] });
    expect(await database.select().from(changes)).toEqual([]);
  });

  it("a host transaction can be the database, so a commit joins it", async () => {
    const database = await memory.open();

    await expect(
      database.transaction(async (transaction) => {
        const joined = new SqliteSessionStore({
          database: transaction,
          scope: "s",
        });
        await joined.commit({ putSessions: [session("a")] });
        await expect(joined.getSession("a")).resolves.toStrictEqual(
          session("a")
        );
        throw new Error("host rolled back");
      })
    ).rejects.toThrow("host rolled back");
    expect(await rowsIn(database)).toEqual({ messages: [], sessions: [] });
  });
});

/** How a commit asks for the last entry of a session's run. */
const LAST_OF_RUN = /order by "agent_messages"\."position" desc limit \?$/;

/** What a commit's insert into the messages table begins with. */
const MESSAGE_INSERT = 'insert into "agent_messages"';
const SESSION_INSERT = 'insert into "agent_sessions"';

describe.each([
  ["memory", memory],
  ["file", files],
] as const)("a commit that fails as it runs (%s)", (_location, databases) => {
  /**
   * A store whose next insert into the messages table, once armed, fails as
   * it runs, after the statements before it in the same commit have run.
   * `ran` lists the statements that ran while it was armed.
   */
  async function failingInsert() {
    let armed = false;
    const ran: string[] = [];
    const database = await databases.open({
      onQuery: (query) => {
        if (!armed) {
          return;
        }
        if (query.startsWith(MESSAGE_INSERT)) {
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
      store: new SqliteSessionStore({ database, scope: "s" }),
    };
  }

  it("rolls back the statements before the one that failed", async () => {
    const { arm, ran, store } = await failingInsert();
    await store.commit({
      putMessages: [message("a1", "a"), message("b1", "b")],
      putSessions: [session("a"), session("b")],
    });
    arm();

    await expect(
      store.commit({
        putMessages: [message("a1", "b"), message("a2", "a")],
        putSessions: [session("a", { title: "changed" })],
      })
    ).rejects.toThrow("insert failed");

    expect(ran.some((query) => query.startsWith(SESSION_INSERT))).toBe(true);
    await expect(store.getSession("a")).resolves.toStrictEqual(session("a"));
    await expect(store.listMessages("a")).resolves.toStrictEqual([
      message("a1", "a"),
    ]);
    await expect(store.listMessages("b")).resolves.toStrictEqual([
      message("b1", "b"),
    ]);
  });

  it("rolls back only a view commit that work catches, keeping the transaction's others", async () => {
    const { arm, ran, store } = await failingInsert();
    await store.commit({ putSessions: [session("a")] });

    await store.transaction(async (view) => {
      await view.commit({ putMessages: [message("m1", "a")] });
      arm();
      await expect(
        view.commit({
          putMessages: [message("m2", "a")],
          putSessions: [session("a", { title: "lost" })],
        })
      ).rejects.toThrow("insert failed");
      expect(ran.some((query) => query.startsWith(SESSION_INSERT))).toBe(true);
      await expect(view.getSession("a")).resolves.toStrictEqual(session("a"));
      await view.commit({ putMessages: [message("m3", "a")] });
    });

    expect((await store.listMessages("a")).map((m) => m.id)).toEqual([
      "m1",
      "m3",
    ]);
    await expect(store.getSession("a")).resolves.toStrictEqual(session("a"));
  });
});

describe("SqliteSessionStore large writes", () => {
  it("one commit carries more rows than any one statement takes, moves and re-puts among them", async () => {
    const queries: string[] = [];
    const { store } = await storeOn({
      onQuery: (query) => queries.push(query),
    });
    await store.commit({
      putMessages: [message("old-1", "x"), message("old-2", "x")],
      putSessions: [session("x")],
    });
    queries.length = 0;
    // More ids than one lookup binds, more messages and sessions than one
    // insert takes.
    const count = 33_000;
    const sessionIds = Array.from({ length: 4000 }, (_, index) => `s${index}`);
    const messages = Array.from({ length: count }, (_, index) =>
      message(`m${index}`, sessionIds[index % 2] ?? "s0", { createdAt: index })
    );
    const moved = message("old-1", "s0", { status: "error" });
    const again = message("m5", "s1", { status: "streaming" });
    await store.commit({
      putMessages: [...messages, moved, again],
      putSessions: sessionIds.map((id) => session(id)),
    });

    const lookups = queries.filter((query) =>
      query.startsWith('select "id", "position", "session_id"')
    );
    const inserts = (table: string) =>
      queries.filter((query) => query.startsWith(`insert into "${table}"`));
    expect(lookups).toHaveLength(2);
    expect(inserts("agent_messages").length).toBeGreaterThan(1);
    expect(inserts("agent_sessions").length).toBeGreaterThan(1);
    const even = messages.filter((_, index) => index % 2 === 0);
    const odd = messages.filter((_, index) => index % 2 === 1);
    await expect(store.listMessages("s0")).resolves.toStrictEqual([
      ...even,
      moved,
    ]);
    await expect(store.listMessages("s1")).resolves.toStrictEqual(
      odd.map((m) => (m.id === again.id ? again : m))
    );
    await expect(store.listMessages("x")).resolves.toStrictEqual([
      message("old-2", "x"),
    ]);
    await expect(store.getSession("s3999")).resolves.toStrictEqual(
      session("s3999")
    );
    // Tens of thousands of rows, each checked and decoded: seconds alone,
    // more beside the rest of the suite.
  }, 30_000);

  it("keeps a message of tens of megabytes whole", async () => {
    const { store } = await storeOn();
    // 32 MiB of text, and a part list of thousands of parts.
    const big = message("big", "a", {
      parts: [
        { text: "x".repeat(32 * 1024 * 1024), type: "text" },
        ...Array.from({ length: 5000 }, (_, index) => ({
          output: { index, text: "y".repeat(100) },
          toolCallId: `c${index}`,
          type: "tool_result" as const,
        })),
      ],
    });
    await store.commit({ putMessages: [big], putSessions: [session("a")] });

    await expect(store.getMessage("big")).resolves.toStrictEqual(big);
  });
});

describe("SqliteSessionStore query plans", () => {
  /** What SQLite plans for each statement whose SQL `pick` keeps. */
  async function plansOf(
    act: (store: SqliteSessionStore) => Promise<unknown>,
    pick: (query: string) => boolean = (query) => query.startsWith("select")
  ) {
    const database = await files.open();
    const queries: string[] = [];
    const store = new SqliteSessionStore({
      database: files.connect(database, {
        onQuery: (query) => queries.push(query),
      }),
      scope: "s",
    });
    await act(store);
    return Promise.all(
      queries.filter(pick).map(async (query) => {
        const steps = await database.all<{ detail: string }>(
          sql.raw(`EXPLAIN QUERY PLAN ${query}`)
        );
        return steps.map((step) => step.detail).join("; ");
      })
    );
  }

  const SESSION_KEY = String.raw`SEARCH agent_sessions USING INDEX sqlite_autoindex_agent_sessions_1 \(scope=\? AND id=\?\)`;
  const MESSAGE_KEY = String.raw`SEARCH agent_messages USING INDEX sqlite_autoindex_agent_messages_1 \(scope=\? AND id=\?\)`;
  const SESSION_RUN = String.raw`SEARCH agent_messages USING (COVERING )?INDEX agent_messages_scope_session_position \(scope=\? AND session_id=\?\)`;

  it.each([
    [
      "getSession",
      (store: SqliteSessionStore) => store.getSession("a"),
      [SESSION_KEY],
    ],
    [
      "getMessage",
      (store: SqliteSessionStore) => store.getMessage("m"),
      [MESSAGE_KEY],
    ],
    [
      "listMessages",
      (store: SqliteSessionStore) => store.listMessages("a"),
      [SESSION_RUN],
    ],
    [
      // Where each message put is filed now, then the next position in each
      // session it is new to: the last entry of that session's run.
      "commit",
      (store: SqliteSessionStore) =>
        store.commit({ putMessages: [message("m", "a"), message("n", "b")] }),
      [MESSAGE_KEY, SESSION_RUN, SESSION_RUN],
    ],
  ] as const)(
    "%s searches its index, with no scan and no sort",
    async (_read, act, expected) => {
      const plans = await plansOf(act);

      expect(plans).toEqual(
        expected.map((plan) => expect.stringMatching(new RegExp(`^${plan}$`)))
      );
    }
  );

  it("a commit's next position reads one entry: the last of its session's run", async () => {
    const queries: string[] = [];
    await plansOf(
      (store) => store.commit({ putMessages: [message("m", "a")] }),
      (query) => {
        queries.push(query);
        return false;
      }
    );

    expect(queries).toContainEqual(expect.stringMatching(LAST_OF_RUN));
  });
});

describe("SqliteSessionStore on a file", () => {
  it("keeps its records for the next connection", async () => {
    const first = await files.open();
    const sessions = new Sessions({
      store: new SqliteSessionStore({ database: first, scope: "s" }),
    });
    const created = await sessions.createSession({ id: "a", title: "t" });
    const appended = await sessions.appendMessage({
      parts: [{ text: "hi", type: "text" }],
      role: "user",
      sessionId: "a",
    });
    const reopened = new SqliteSessionStore({
      database: await files.reopen(first),
      scope: "s",
    });

    await expect(reopened.getSession("a")).resolves.toStrictEqual({
      ...created,
      updatedAt: appended.createdAt,
    });
    await expect(reopened.listMessages("a")).resolves.toStrictEqual([appended]);
  });
});

describe("session tables", () => {
  it("hold each record field for field, plus scope, and position for messages", () => {
    expect([
      agentSessions.scope.notNull,
      agentMessages.scope.notNull,
      agentMessages.position.notNull,
    ]).toEqual([true, true, true]);
    expect(columnsOf(agentSessions)).toEqual(
      fieldsOf(sessionRecordSchema.shape)
    );
    expect(columnsOf(agentMessages)).toEqual(
      fieldsOf(sessionMessageSchema.shape)
    );
    expectTypeOf<
      Omit<typeof agentSessions.$inferSelect, "scope">
    >().toEqualTypeOf<{
      [K in keyof SessionRecord]-?:
        | Exclude<SessionRecord[K], undefined>
        | (undefined extends SessionRecord[K] ? null : never);
    }>();
    expectTypeOf<
      Omit<typeof agentMessages.$inferSelect, "position" | "scope">
    >().toEqualTypeOf<{
      [K in keyof SessionMessage]-?:
        | Exclude<SessionMessage[K], undefined>
        | (undefined extends SessionMessage[K] ? null : never);
    }>();
  });
});

/** Each record column, by field name, and whether it takes NULL. */
function columnsOf(table: typeof agentSessions | typeof agentMessages) {
  const columns: Record<string, { readonly notNull: boolean }> = {
    ...getTableColumns(table),
  };
  const { position: _position, scope: _scope, ...fields } = columns;
  return Object.fromEntries(
    Object.entries(fields).map(([key, column]) => [key, !column.notNull])
  );
}

/** Each schema field and whether it may be absent or `null`. */
function fieldsOf(shape: Readonly<Record<string, z.ZodType>>) {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      field.safeParse(null).success || field.safeParse(undefined).success,
    ])
  );
}
