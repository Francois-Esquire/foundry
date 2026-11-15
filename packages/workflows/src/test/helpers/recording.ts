import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { RunEvent } from "../../schema";
import { SqliteWorkflowStore } from "../../store/sqlite";
import type { RecordingWorkflowStores } from "../../testing/store";

/** A host's record of events, written on the commit's own transaction. */
const recordedEvents = sqliteTable("recorded_events", {
  event: text("event", { mode: "json" }).notNull(),
});

/**
 * SQLite storage over `database` whose `onCommit` writes each event of a
 * write as a row on the transaction it is handed, as a host's outbox would,
 * one store per scope. `failNextCommit` makes the hook throw once, after it
 * has written its rows.
 */
export async function recordingStores(
  database: LibSQLDatabase
): Promise<RecordingWorkflowStores> {
  await database.run(
    sql`CREATE TABLE IF NOT EXISTS "recorded_events" ("event" text NOT NULL)`
  );
  let failNext = false;
  const scopes = new Map<string, SqliteWorkflowStore>();
  return {
    failNextCommit: () => {
      failNext = true;
    },
    recorded: async () =>
      (await database.select().from(recordedEvents)).map(
        (row) => row.event as RunEvent
      ),
    stores: (scope) => {
      const store =
        scopes.get(scope) ??
        new SqliteWorkflowStore({
          database,
          onCommit: async (transaction, write) => {
            for (const event of write.events ?? []) {
              await transaction.insert(recordedEvents).values({ event });
            }
            if (failNext) {
              failNext = false;
              throw new Error("the host refused the commit");
            }
          },
          scope,
        });
      scopes.set(scope, store);
      return store;
    },
  };
}
