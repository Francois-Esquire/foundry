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

export const ARTIFACT_TABLES = [
  artifacts,
  artifactContents,
  artifactBlobs,
  artifactContentBlobs,
  artifactBlobChunks,
] as const;

export type DatabaseLocation = "file" | "memory";

export interface ConnectOptions {
  readonly busyTimeout?: number;
  readonly onQuery?: (query: string) => void;
}

export interface LibsqlDatabases {
  readonly client: (database: LibSQLDatabase) => Client;
  readonly connect: (
    database: LibSQLDatabase,
    options?: ConnectOptions
  ) => LibSQLDatabase;
  readonly open: (options?: ConnectOptions) => Promise<LibSQLDatabase>;
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
    directory ??= mkdtemp(join(tmpdir(), "foundry-artifacts-"));
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
