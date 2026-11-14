import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTables } from "@foundry/lib/testing/sqlite";
import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, afterEach } from "vitest";

import { sandboxContainers } from "../../store/tables";

/** Where each database lives: in the connection, or in a temp-dir file. */
export type DatabaseLocation = "file" | "memory";

export interface LibsqlDatabases {
  /**
   * Another client on `database`'s file, as a second process would hold.
   * `busyTimeout` is how long its writes wait on a lock; none by default.
   */
  readonly connect: (
    database: LibSQLDatabase,
    options?: { readonly busyTimeout?: number }
  ) => LibSQLDatabase;
  /**
   * A new database holding the sandbox tables. `onQuery` is called with each
   * statement's SQL just before it runs; a throw fails that statement.
   */
  readonly open: (options?: {
    readonly onQuery?: (query: string) => void;
  }) => Promise<LibSQLDatabase>;
  /** The file `database` lives in. */
  readonly path: (database: LibSQLDatabase) => string;
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
    directory ??= mkdtemp(join(tmpdir(), "foundry-sandbox-"));
    // Taken before the await, so databases opened at once get their own.
    count += 1;
    const name = `sandbox-${count}.db`;
    return `file:${join(await directory, name)}`;
  }

  function connect(
    at: string,
    busyTimeout?: number,
    onQuery?: (query: string) => void
  ): LibSQLDatabase {
    const client = createClient({
      url: at,
      ...(busyTimeout === undefined ? {} : { timeout: busyTimeout }),
    });
    clients.push(client);
    const database =
      onQuery === undefined
        ? drizzle(client)
        : drizzle(client, { logger: { logQuery: onQuery } });
    connections.set(database, { client, url: at });
    return database;
  }

  function fileOf(database: LibSQLDatabase) {
    const connection = connections.get(database);
    if (connection === undefined || location === "memory") {
      throw new Error("only a file database opened here has a file");
    }
    return connection;
  }

  return {
    connect(database, options = {}) {
      return connect(fileOf(database).url, options.busyTimeout);
    },
    async open(options = {}) {
      const database = connect(await url(), undefined, options.onQuery);
      await createTables(database, [sandboxContainers]);
      return database;
    },
    path(database) {
      return fileOf(database).url.slice("file:".length);
    },
    reopen(database) {
      const connection = fileOf(database);
      connection.client.close();
      return Promise.resolve(connect(connection.url));
    },
  };
}
