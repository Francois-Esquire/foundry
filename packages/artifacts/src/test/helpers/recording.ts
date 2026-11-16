import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { ArtifactEvent } from "../../schema";
import { SqliteArtifactStore } from "../../store/sqlite";
import type { RecordingArtifactStores } from "../../testing/store";

const recordedEvents = sqliteTable("recorded_events", {
  event: text("event", { mode: "json" }).notNull(),
});

export async function recordingStores(
  database: LibSQLDatabase
): Promise<RecordingArtifactStores> {
  await database.run(
    sql`CREATE TABLE IF NOT EXISTS "recorded_events" ("event" text NOT NULL)`
  );
  let failNext = false;
  const scopes = new Map<string, SqliteArtifactStore>();
  return {
    failNextCommit: () => {
      failNext = true;
    },
    recorded: async () =>
      (await database.select().from(recordedEvents)).map(
        (row) => row.event as ArtifactEvent
      ),
    stores: (scope) => {
      const store =
        scopes.get(scope) ??
        new SqliteArtifactStore({
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
