import { asc, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ContainerStore } from "../store/index";
import { MemoryContainerStore } from "../store/memory";
import type { SandboxEvent } from "../store/schema";
import type { ContainerDatabase } from "../store/sqlite";
import { SqliteContainerStore } from "../store/sqlite";
import type { RecordingContainerStores } from "../testing/store";
import { describeContainerStore } from "../testing/store";
import { libsqlDatabases } from "./helpers/sqlite";

describeContainerStore(
  "memory",
  () => {
    const stores = new Map<string, ContainerStore>();
    return (scope) => {
      const store = stores.get(scope) ?? new MemoryContainerStore();
      stores.set(scope, store);
      return store;
    };
  },
  { hooked: false }
);

const recordedEvents = sqliteTable("recorded_events", {
  payload: text("payload", { mode: "json" }).$type<SandboxEvent>().notNull(),
  seq: integer("seq").primaryKey({ autoIncrement: true }),
});

async function recordingStores(
  database: ContainerDatabase
): Promise<RecordingContainerStores> {
  await database.run(
    sql`CREATE TABLE "recorded_events" ("seq" integer PRIMARY KEY AUTOINCREMENT, "payload" text NOT NULL)`
  );
  let failNext = false;
  const stores = new Map<string, ContainerStore>();
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
    stores: (scope) => {
      const store =
        stores.get(scope) ??
        new SqliteContainerStore({
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
      stores.set(scope, store);
      return store;
    },
  };
}

for (const location of ["memory", "file"] as const) {
  const databases = libsqlDatabases(location);
  describeContainerStore(
    `SQLite on libSQL (${location})`,
    async () => {
      const database = await databases.open();
      return (scope) => new SqliteContainerStore({ database, scope });
    },
    {
      hooked: true,
      recording: async () => recordingStores(await databases.open()),
    }
  );
}
