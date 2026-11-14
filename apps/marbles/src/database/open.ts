import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import { serialClient } from "~/database/client";
import { MIGRATIONS, migrate } from "~/database/migrate";

/**
 * What a store is handed: the database, or one of its transactions
 * (`transaction` in `~/database/transaction`). It is the type a domain
 * package's SQLite store declares, which names no driver: libSQL's run
 * result is `unknown` here, so a package never imports `@libsql/client`.
 */
export type StoreDatabase = BaseSQLiteDatabase<"async", unknown>;

/** One open handle on the Marbles database. Open one per process and pass it down. */
export interface MarblesDatabase {
  close(): void;
  readonly database: StoreDatabase;
  readonly file: string;
}

export interface OpenDatabaseOptions {
  /** How long to wait for another process's write lock; 5 s when omitted. */
  readonly busyTimeout?: number;
  /** The migrations to apply; the ones this Marbles ships when omitted. */
  readonly migrations?: string;
}

const BUSY_TIMEOUT_MS = 5000;

/**
 * Open the database at `file`, creating it and its directory if need be,
 * and migrate it. Several processes may hold it at once: it runs in WAL
 * mode, so readers never wait for a writer, and a writer waits up to the
 * busy timeout for another. In this process, everything opened on `file`
 * takes turns (`serialClient`). Foreign keys are on.
 */
export async function openDatabase(
  file: string,
  options: OpenDatabaseOptions = {}
): Promise<MarblesDatabase> {
  const path = resolve(file);
  const busyTimeout = options.busyTimeout ?? BUSY_TIMEOUT_MS;
  mkdirSync(dirname(path), { recursive: true });
  const client = serialClient(
    createClient({
      concurrency: 1,
      timeout: busyTimeout,
      url: pathToFileURL(path).href,
    }),
    path,
    busyTimeout
  );
  try {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA foreign_keys = ON");
    const database = drizzle({ client });
    await migrate(client, database, options.migrations ?? MIGRATIONS);
    return { close: () => client.close(), database, file: path };
  } catch (error) {
    client.close();
    throw error;
  }
}

/**
 * The database at `file` if one is there, for a reader that must leave a
 * machine without one as it found it. Undefined when there is none.
 */
export function openExistingDatabase(
  file: string,
  options?: OpenDatabaseOptions
): Promise<MarblesDatabase | undefined> {
  return existsSync(file)
    ? openDatabase(file, options)
    : Promise.resolve(undefined);
}

/** Open the database at `file` for `work` alone, and close it after. */
export async function withDatabase<T>(
  file: string,
  work: (database: StoreDatabase) => Promise<T>
): Promise<T> {
  const opened = await openDatabase(file);
  try {
    return await work(opened.database);
  } finally {
    opened.close();
  }
}
