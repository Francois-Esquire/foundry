import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTables } from "@foundry/lib/testing/sqlite";
import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, afterEach } from "vitest";

import {
  artifactBlobChunks,
  artifactBlobs,
  artifactContentBlobs,
  artifactContents,
  artifacts,
} from "../../store/tables";

/** Every table the SQLite store reads and writes. */
export const ARTIFACT_TABLES = [
  artifacts,
  artifactContents,
  artifactBlobs,
  artifactContentBlobs,
  artifactBlobChunks,
] as const;

/** Where each database lives: in the connection, or in a temp-dir file. */
export type DatabaseLocation = "file" | "memory";

export interface ConnectOptions {
  /** How long the client's writes wait on a lock; none by default. */
  readonly busyTimeout?: number;
  /** Called with each statement's SQL just before it runs; a throw fails it. */
  readonly onQuery?: (query: string) => void;
}

export interface LibsqlDatabases {
  /** The libSQL client under `database`, for a transaction of its own mode. */
  readonly client: (database: LibSQLDatabase) => Client;
  /** Another client on `database`'s file, as a second process would hold. */
  readonly connect: (
    database: LibSQLDatabase,
    options?: ConnectOptions
  ) => LibSQLDatabase;
  /** A new database holding the Artifact tables. */
  readonly open: (options?: ConnectOptions) => Promise<LibSQLDatabase>;
  /** The file `database` lives in. */
  readonly path: (database: LibSQLDatabase) => string;
  /** Closes `database`'s connection and connects to the same database again. */
  readonly reopen: (database: LibSQLDatabase) => Promise<LibSQLDatabase>;
}

/**
 * libSQL databases for one test file, each closed after the test that opened
 * it. File databases share one temporary directory, removed after the file's
 * tests. Call it at the top of a test file, where Vitest hooks register.
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
    directory ??= mkdtemp(join(tmpdir(), "foundry-artifacts-"));
    // Taken before the await, so databases opened at once get their own.
    count += 1;
    const name = `artifacts-${count}.db`;
    return `file:${join(await directory, name)}`;
  }

  function connect(at: string, options: ConnectOptions = {}): LibSQLDatabase {
    const client = createClient({
      url: at,
      ...(options.busyTimeout === undefined
        ? {}
        : { timeout: options.busyTimeout }),
    });
    clients.push(client);
    const { onQuery } = options;
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
    client(database) {
      const connection = connections.get(database);
      if (connection === undefined) {
        throw new Error("only a database opened here has a client");
      }
      return connection.client;
    },
    connect(database, options = {}) {
      return connect(fileOf(database).url, options);
    },
    async open(options = {}) {
      const database = connect(await url(), options);
      await createTables(database, ARTIFACT_TABLES);
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
