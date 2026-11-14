import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import { _createClient } from "@libsql/client/sqlite3";
import { drizzle } from "drizzle-orm/libsql";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import { canonicalFile, serialClient } from "~/database/client";
import {
  IncompatibleDatabaseError,
  MIGRATIONS,
  migrate,
  type ShippedMigration,
  schemaState,
  shippedMigrations,
} from "~/database/migrate";

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
  /** The migrations this Marbles ships; the committed ones when omitted. */
  readonly migrations?: string;
}

const BUSY_TIMEOUT_MS = 5000;
/** How many times a read starts again because the file changed under it. */
const READ_ATTEMPTS = 3;

/*
 * Three ways in, one per role:
 *
 * - `initializeDatabase`, the Marbles process's: creates the file, puts it
 *   in WAL mode, and migrates it. Nothing else migrates.
 * - `writeDatabase`, for a write outside it (a worker's record, a detach
 *   with no process running): opens only a file that is there, never
 *   creates or migrates one, and refuses a schema that is not current.
 * - `readDatabase`, for every reader: a connection that cannot write or
 *   create, that changes neither the schema nor the journal mode, and that
 *   leaves no file behind that was not there.
 */

/**
 * Open the database at `file` as the Marbles process: create it and its
 * directory if need be, and migrate it. Several processes may hold it at
 * once: it runs in WAL mode, so readers never wait for a writer, and a
 * writer waits up to the busy timeout for another. In this process,
 * everything opened on the file takes turns (`serialClient`). Foreign keys
 * are on.
 */
export async function initializeDatabase(
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
    canonicalFile(path),
    busyTimeout
  );
  try {
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA foreign_keys = ON");
    const database = drizzle({ client });
    await migrate(client, database, path, options.migrations ?? MIGRATIONS);
    return { close: () => client.close(), database, file: path };
  } catch (error) {
    client.close();
    throw error;
  }
}

/**
 * Run `work` on the database at `file` if the Marbles process has made it,
 * and close it after. Undefined, and `work` not run, when there is no file
 * or nothing was ever migrated into it. A schema that is not exactly the
 * one this Marbles ships is refused (`IncompatibleDatabaseError`): only the
 * Marbles process migrates.
 */
export async function writeDatabase<T>(
  file: string,
  work: (database: StoreDatabase) => Promise<T>,
  options: OpenDatabaseOptions = {}
): Promise<T | undefined> {
  const path = resolve(file);
  if (!existsSync(path)) {
    return;
  }
  const client = existing(path, "mode=rw", options);
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    const database = drizzle({ client });
    if (!(await usable(database, path, options))) {
      return;
    }
    return await work(database);
  } finally {
    client.close();
  }
}

/**
 * Run `work` on a read-only view of the database at `file`, and close it
 * after. Undefined, and `work` not run, when there is no file or nothing
 * was ever migrated into it. The connection cannot write or create, and a
 * schema behind or ahead of this Marbles is refused
 * (`IncompatibleDatabaseError`) without touching the file.
 *
 * With a WAL file beside it, the database may be open in another process:
 * the read takes part in SQLite's WAL locking through the shared-memory
 * file already there. Without one, everything is in the main file and no
 * connection has it open, so it is read as immutable, which takes no lock
 * and writes no side file; a file that changes while it is read that way
 * (a process opened it meanwhile) is read again. A WAL file without its
 * shared-memory file needs recovering, which only a writer can do.
 */
export async function readDatabase<T>(
  file: string,
  work: (database: StoreDatabase) => Promise<T>,
  options: OpenDatabaseOptions = {}
): Promise<T | undefined> {
  const path = resolve(file);
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    if (!existsSync(path)) {
      return;
    }
    const wal = existsSync(`${path}-wal`);
    if (wal && !existsSync(`${path}-shm`)) {
      throw new Error(
        `the Marbles database at ${path} was not closed cleanly; start the Marbles process to recover it`
      );
    }
    const before = wal ? undefined : fingerprint(path);
    const client = existing(
      path,
      wal ? "mode=ro" : "mode=ro&immutable=1",
      options
    );
    let value: T | undefined;
    try {
      const database = drizzle({ client });
      value = (await usable(database, path, options))
        ? await work(database)
        : undefined;
    } finally {
      client.close();
    }
    if (before === undefined || before === fingerprint(path)) {
      return value;
    }
  }
  throw new Error(
    `the Marbles database at ${path} kept changing while it was read; try again`
  );
}

/**
 * A connection to the file at `path`, which must exist, in the SQLite URI
 * `query` mode. The public `createClient` refuses URI parameters, so this
 * builds the local client from the configuration it would expand to.
 */
function existing(
  path: string,
  query: string,
  options: OpenDatabaseOptions
): Client {
  const busyTimeout = options.busyTimeout ?? BUSY_TIMEOUT_MS;
  return serialClient(
    _createClient({
      authority: undefined,
      authToken: undefined,
      concurrency: 1,
      encryptionKey: undefined,
      fetch: undefined,
      intMode: "number",
      offline: undefined,
      path: `${pathToFileURL(path).href}?${query}`,
      readYourWrites: undefined,
      remoteEncryptionKey: undefined,
      scheme: "file",
      syncInterval: undefined,
      syncUrl: undefined,
      timeout: busyTimeout,
      tls: false,
    }),
    canonicalFile(path),
    busyTimeout
  );
}

/**
 * Whether a caller that does not migrate can use the database: false when
 * nothing was ever migrated into it, and a refusal when it is behind or
 * ahead of this Marbles.
 */
async function usable(
  database: StoreDatabase,
  path: string,
  options: OpenDatabaseOptions
): Promise<boolean> {
  const state = await schemaState(
    database,
    shippedMigrations(options.migrations ?? MIGRATIONS),
    path
  );
  if (state.kind === "behind") {
    throw new IncompatibleDatabaseError(
      `the Marbles database at ${path} is older than this Marbles: it lacks ${describe(state.missing)}; the Marbles process brings it up to date when it starts`
    );
  }
  return state.kind === "current";
}

function describe(missing: readonly ShippedMigration[]): string {
  const [first] = missing;
  const more = missing.length - 1;
  return `${first?.tag ?? "a migration"}${more > 0 ? ` and ${String(more)} more` : ""}`;
}

/** What changes when a process writes the file: its identity, size and time. */
function fingerprint(path: string): string | undefined {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat === undefined
    ? undefined
    : `${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeMs)}:${String(existsSync(`${path}-wal`))}`;
}
