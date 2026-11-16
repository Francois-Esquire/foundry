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

export type DatabaseLocation = "file" | "memory";

export interface LibsqlDatabases {
  readonly connect: (
    database: LibSQLDatabase,
    options?: {
      readonly busyTimeout?: number;
      readonly onQuery?: (query: string) => void;
    }
  ) => LibSQLDatabase;
  readonly open: () => Promise<LibSQLDatabase>;
  readonly path: (database: LibSQLDatabase) => string;
  readonly reopen: (database: LibSQLDatabase) => Promise<LibSQLDatabase>;
}

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
      return connect(
        fileOf(database).url,
        options.busyTimeout,
        options.onQuery
      );
    },
    async open() {
      const database = connect(await url());
      await createTables(database, [tasks, taskDependencies]);
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
