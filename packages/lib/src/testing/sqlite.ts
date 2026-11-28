import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { drizzle } from "drizzle-orm/libsql";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { getTableConfig, SQLiteColumn } from "drizzle-orm/sqlite-core";
import { afterAll, afterEach } from "vitest";
import type { SqliteDatabase } from "../sqlite";

export type TestDatabase = SqliteDatabase;

export type DatabaseLocation = "file" | "memory";

export type OnQuery = (query: string) => void;

export interface ConnectOptions {
  readonly busyTimeout?: number;
  readonly onQuery?: OnQuery;
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

export interface LibsqlDatabasesOptions {
  readonly name: string;
  readonly tables: readonly SQLiteTable[];
}

export function libsqlDatabases(
  location: DatabaseLocation,
  { name, tables }: LibsqlDatabasesOptions
): LibsqlDatabases {
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
    directory ??= mkdtemp(join(tmpdir(), `foundry-${name}-`));
    count += 1;
    const file = `${name}-${count}.db`;
    return `file:${join(await directory, file)}`;
  }

  function connect(at: string, options: ConnectOptions = {}): LibSQLDatabase {
    const { busyTimeout, onQuery } = options;
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

  function connectionOf(database: LibSQLDatabase) {
    const connection = connections.get(database);
    if (connection === undefined) {
      throw new Error("only a database opened here has a client");
    }
    return connection;
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
      return connectionOf(database).client;
    },
    connect(database, options) {
      return connect(fileOf(database).url, options);
    },
    async open(options) {
      const database = connect(await url(), options);
      await createTables(database, tables);
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

export async function createTables(
  database: TestDatabase,
  tables: readonly SQLiteTable[]
): Promise<void> {
  for (const statement of tables.flatMap(tableStatements)) {
    await database.run(statement);
  }
}

export function tableStatements(table: SQLiteTable): SQL[] {
  const config = getTableConfig(table);
  const refused = [
    config.foreignKeys.length > 0 && "foreign keys",
    config.uniqueConstraints.length > 0 && "unique constraints",
    config.checks.length > 0 && "checks",
    ...config.columns.flatMap((column) => [
      column.primary && `a column primary key on ${column.name}`,
      column.hasDefault && `a default on ${column.name}`,
      column.isUnique && `a unique column ${column.name}`,
      column.generated !== undefined && `a generated column ${column.name}`,
    ]),
    ...config.indexes.flatMap(({ config: index }) => [
      index.where !== undefined && `a partial index ${index.name}`,
      !index.columns.every(isColumn) && `an expression index ${index.name}`,
    ]),
  ].filter((reason): reason is string => typeof reason === "string");
  if (refused.length > 0) {
    throw new Error(
      `${config.name}: cannot create ${refused.join(", ")}; only column types, NOT NULL, a primary key, and plain indexes`
    );
  }

  const columns = config.columns.map((column) =>
    [
      quote(column.name),
      column.getSQLType(),
      ...(column.notNull ? ["NOT NULL"] : []),
    ].join(" ")
  );
  const keys = config.primaryKeys.map(
    (key) => `PRIMARY KEY (${names(key.columns)})`
  );
  const indexes = config.indexes.map(
    ({ config: index }) =>
      `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(index.name)} ON ${quote(config.name)} (${names(index.columns.filter(isColumn))})`
  );
  return [
    `CREATE TABLE ${quote(config.name)} (${[...columns, ...keys].join(", ")})`,
    ...indexes,
  ].map((statement) => sql.raw(statement));
}

function isColumn(value: unknown): value is SQLiteColumn {
  return value instanceof SQLiteColumn;
}

function names(columns: readonly SQLiteColumn[]): string {
  return columns.map((column) => quote(column.name)).join(", ");
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
