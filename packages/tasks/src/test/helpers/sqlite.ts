import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { drizzle } from "drizzle-orm/libsql";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { getTableConfig } from "drizzle-orm/sqlite-core";
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
      for (const table of [tasks, taskDependencies]) {
        await database.run(sql.raw(createTable(table)));
      }
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

/**
 * `CREATE TABLE` for a table definition: its columns and primary key. A
 * host's migrations own the real schema; this only stands one up for tests,
 * and refuses a definition it would not reproduce whole.
 */
function createTable(table: SQLiteTable): string {
  const config = getTableConfig(table);
  const unsupported =
    config.indexes.length +
    config.foreignKeys.length +
    config.uniqueConstraints.length +
    config.checks.length;
  if (unsupported > 0) {
    throw new Error(`${config.name}: only columns and a primary key supported`);
  }
  const quote = (name: string) => `"${name}"`;
  const columns = config.columns.map(
    (column) =>
      `${quote(column.name)} ${column.getSQLType()}${column.notNull ? " NOT NULL" : ""}`
  );
  const keys = config.primaryKeys.map(
    (key) =>
      `PRIMARY KEY (${key.columns.map((column) => quote(column.name)).join(", ")})`
  );
  return `CREATE TABLE ${quote(config.name)} (${[...columns, ...keys].join(", ")})`;
}
