import { createTables } from "@foundry/lib/testing/sqlite";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { QueueDatabase } from "../../store/sqlite";
import { queueTables } from "../../store/tables";

const clients: ReturnType<typeof createClient>[] = [];

export const openDatabase = async (): Promise<QueueDatabase> => {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  const database = drizzle(client);
  await createTables(database, queueTables);
  return database;
};

export const closeDatabases = (): void => {
  for (const client of clients.splice(0)) {
    client.close();
  }
};
