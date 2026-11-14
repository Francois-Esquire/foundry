import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTables } from "@foundry/lib/testing/sqlite";
import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, afterEach } from "vitest";
import { taskDependencies, tasks } from "../../store/tables";

/** Where each database lives: in the connection, or in a temp-dir file. */
export type DatabaseLocation = "file" | "memory";

export interface LibsqlDatabases {
  /** A new database holding the tasks tables. */
  readonly open: () => Promise<LibSQLDatabase>;
  /** Closes `database`'s connection and connects to the same database again. */
  readonly reopen: (database: LibSQLDatabase) => Promise<LibSQLDatabase>;
}

/**
 * libSQL databases for one test file, each closed after the test that opened
 * it. File databases share one temporary directory, removed after the file's
 * tests.
 */
export function libsqlDatabases(location: DatabaseLocation): LibsqlDatabases {
  const clients: Client[] = [];
  const connections = new WeakMap<
    LibSQLDatabase,
    { readonly client: Client; readonly url: string }
  >();
  let directory: Promise<string> | undefined;
  let count = 0;

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close();
    }
  });
  afterAll(async () => {
    if (directory !== undefined) {
      await rm(await directory, { force: true, recursive: true });
    }
  });

  async function url(): Promise<string> {
    if (location === "memory") {
      return ":memory:";
    }
    directory ??= mkdtemp(join(tmpdir(), "foundry-tasks-"));
    count += 1;
    return `file:${join(await directory, `tasks-${count}.db`)}`;
  }

  function connect(at: string): LibSQLDatabase {
    const client = createClient({ url: at });
    clients.push(client);
    const database = drizzle(client);
    connections.set(database, { client, url: at });
    return database;
  }

  return {
    async open() {
      const database = connect(await url());
      await createTables(database, [tasks, taskDependencies]);
      return database;
    },
    reopen(database) {
      const connection = connections.get(database);
      if (connection === undefined || location === "memory") {
        throw new Error("only a file database opened here can be reopened");
      }
      connection.client.close();
      return Promise.resolve(connect(connection.url));
    },
  };
}
