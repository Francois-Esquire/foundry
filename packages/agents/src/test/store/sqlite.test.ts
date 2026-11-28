import { asc, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import type { SessionChangeEvent } from "../../schema";
import type { SessionStore } from "../../store";
import type { SessionDatabase } from "../../store/sqlite";
import { capturedSessionWrite, SqliteSessionStore } from "../../store/sqlite";
import type { RecordingSessionStorage } from "../../testing/store";
import { describeSessionStore } from "../../testing/store";
import { libsqlDatabases } from "../helpers/sqlite";

function scopedStores(
  database: SessionDatabase
): (scope: string) => SessionStore {
  const scopes = new Map<string, SessionStore>();
  return (scope) => {
    const store =
      scopes.get(scope) ?? new SqliteSessionStore({ database, scope });
    scopes.set(scope, store);
    return store;
  };
}

const recordedEvents = sqliteTable("recorded_events", {
  payload: text("payload", { mode: "json" })
    .$type<SessionChangeEvent>()
    .notNull(),
  seq: integer("seq").primaryKey({ autoIncrement: true }),
});

async function recordingStores(
  database: SessionDatabase
): Promise<RecordingSessionStorage> {
  await database.run(
    sql`CREATE TABLE "recorded_events" ("seq" integer PRIMARY KEY AUTOINCREMENT, "payload" text NOT NULL)`
  );
  let failNext = false;
  const scopes = new Map<string, SessionStore>();
  return {
    failNextCommit: () => {
      failNext = true;
    },
    recorded: async () =>
      (
        await database
          .select()
          .from(recordedEvents)
          .orderBy(asc(recordedEvents.seq))
      ).map((row) => row.payload),
    storage: (scope) => {
      const store =
        scopes.get(scope) ??
        new SqliteSessionStore({
          database,
          onCommit: async (transaction, write) => {
            for (const payload of write.events ?? []) {
              await transaction.insert(recordedEvents).values({ payload });
            }
            if (failNext) {
              failNext = false;
              throw new Error("host refused the commit");
            }
          },
          scope,
        });
      scopes.set(scope, store);
      return store;
    },
  };
}

for (const location of ["memory", "file"] as const) {
  const databases = libsqlDatabases(location);
  describeSessionStore(
    `SqliteSessionStore on libSQL (${location})`,
    async () => scopedStores(await databases.open()),
    {
      hooked: true,
      recording: async () => recordingStores(await databases.open()),
    }
  );
}

describe("capturedSessionWrite", () => {
  class Point {
    readonly x = 1;
  }
  const message = (input: unknown) => ({
    createdAt: 1,
    id: "m",
    parts: [
      { input, name: "tool", toolCallId: "c", type: "tool_call" as const },
    ],
    role: "assistant" as const,
    sessionId: "s",
    status: "complete" as const,
    updatedAt: 1,
  });

  it("refuses what commit refuses, with the same error", async () => {
    const database = await libsqlDatabases("memory").open();
    const write = { putMessages: [message(new Point())] };
    const refused = await new SqliteSessionStore({ database, scope: "s" })
      .commit(write)
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(refused).toBeInstanceOf(RangeError);
    expect(() => capturedSessionWrite(write)).toThrow(
      (refused as Error).message
    );
  });

  it("keeps only the write's own fields, and shares nothing with it", () => {
    const input = { n: 1 };
    const write = { extra: () => undefined, putMessages: [message(input)] };
    const copy = capturedSessionWrite(write);
    input.n = 2;
    write.putMessages.length = 0;
    expect(copy).toEqual({ putMessages: [message({ n: 1 })] });
  });
});
