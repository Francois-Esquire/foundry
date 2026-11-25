import { createTables } from "@foundry/lib/testing/sqlite";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Effect } from "effect";
import { afterEach } from "vitest";
import { makeMemoryScheduleStore } from "../store/memory";
import { makeSqliteScheduleStore } from "../store/sqlite";
import { schedulingTables } from "../store/tables";
import { describeScheduleStore } from "../testing/store";

const clients: ReturnType<typeof createClient>[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close();
  }
});

describeScheduleStore("MemoryScheduleStore", () =>
  Effect.runPromise(makeMemoryScheduleStore)
);

describeScheduleStore("SqliteScheduleStore on libSQL", async () => {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  const database = drizzle(client);
  await createTables(database, schedulingTables);
  return makeSqliteScheduleStore({ database, scope: "conformance" });
});
