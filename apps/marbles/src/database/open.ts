import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import { _createClient } from "@libsql/client/sqlite3";
import { drizzle } from "drizzle-orm/libsql";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import { serialClient } from "~/database/client";
import { guardedClient } from "~/database/guard";
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

/**
 * A database a reader cannot read without writing to it: one left with a
 * WAL file to recover, or one that kept changing under an immutable read.
 */
export class UnreadableDatabaseError extends Error {
  override readonly name = "UnreadableDatabaseError";
}

const BUSY_TIMEOUT_MS = 5000;
/** Every writer's connection enforces foreign keys. */
const FOREIGN_KEYS = "PRAGMA foreign_keys = ON";
/** How many times a read starts again because the file changed under it. */
const READ_ATTEMPTS = 3;

/*
 * Three ways in, one per role:
 *
 * - `initializeDatabase`, for whoever holds the state root's process lock:
 *   the Marbles process for its lifetime, or another writer of a
 *   workspace's state (a program hosting it itself, a task change with no
 *   process running) while it makes the database current
 *   (`openHostDatabase`). Creates the
 *   file, puts it in WAL mode, and migrates it. Nothing else migrates, so
 *   no two processes migrate at once.
 * - `openDatabase` and `writeDatabase`, for writes by a process without
 *   that lock (a worker hosting a workspace, a detach with no process
 *   running): open only a file that is there, never create or migrate
 *   one, and refuse a schema that is not current. `openDatabase` keeps the
 *   handle open for the caller; `writeDatabase` closes it after one piece
 *   of work.
 * - `readDatabase`, for every reader: a read-only connection that never
 *   creates the file, migrates it, or changes its content.
 */

/**
 * Open the database at `file` holding the state root's process lock:
 * create it and its directory if need be, and migrate it. Several processes may hold it at
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
  ownerOnly(path);
  const connect = () =>
    createClient({
      concurrency: 1,
      timeout: busyTimeout,
      url: pathToFileURL(path).href,
    });
  // Applied before its first operation, and again to any client that
  // replaces it (`serialClient`).
  const client = serialClient(connect(), path, busyTimeout, {
    connect,
    settings: ["PRAGMA journal_mode = WAL", FOREIGN_KEYS],
  });
  try {
    const folder = options.migrations ?? MIGRATIONS;
    await migrate(client, drizzle({ client }), path, folder);
    // Side files an earlier Marbles made as the umask had them.
    for (const side of [`${path}-wal`, `${path}-shm`]) {
      if (existsSync(side)) {
        chmodSync(side, OWNER_ONLY);
      }
    }
    return writer(client, path, folder);
  } catch (error) {
    client.close();
    throw error;
  }
}

/** What the database and its side files allow: their owner reads and writes, no one else. */
const OWNER_ONLY = 0o600;

/**
 * Make sure the database at `path` is its owner's alone before SQLite
 * opens it: provider settings and the identity key are kept there. A new
 * file is made empty with that mode, which SQLite reads as a new
 * database, and an existing one is narrowed to it. SQLite gives the WAL
 * and shared-memory files it makes the database file's mode. This runs
 * before this handle connects, so the descriptor it opens and closes on a
 * new file is to one no connection in this process has open.
 */
function ownerOnly(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    closeSync(openSync(path, "wx", OWNER_ONLY));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  chmodSync(path, OWNER_ONLY);
}

/**
 * Open the database at `file` as a writer, if the Marbles process (or a
 * host under the state root's process lock) has made it: for a process
 * that writes to it for as long as it runs, such as one hosting a
 * workspace. Undefined when there is no file or nothing was ever migrated
 * into it. A schema that is not exactly the one this Marbles ships is
 * refused (`IncompatibleDatabaseError`): only the holder of that lock
 * migrates. The caller closes the handle.
 */
export async function openDatabase(
  file: string,
  options: OpenDatabaseOptions = {}
): Promise<MarblesDatabase | undefined> {
  const path = resolve(file);
  if (!existsSync(path)) {
    return;
  }
  const client = existing(path, "mode=rw", options, [FOREIGN_KEYS]);
  try {
    if (!(await usable(drizzle({ client }), path, options))) {
      client.close();
      return;
    }
    return writer(client, path, options.migrations ?? MIGRATIONS);
  } catch (error) {
    client.close();
    throw error;
  }
}

/**
 * Run `work` on the database at `file` if the Marbles process has made it,
 * and close it after (`openDatabase`). Undefined, and `work` not run, when
 * there is no file or nothing was ever migrated into it.
 */
export async function writeDatabase<T>(
  file: string,
  work: (database: StoreDatabase) => Promise<T>,
  options: OpenDatabaseOptions = {}
): Promise<T | undefined> {
  const opened = await openDatabase(file, options);
  if (opened === undefined) {
    return;
  }
  try {
    return await work(opened.database);
  } finally {
    opened.close();
  }
}

/**
 * Run `work` on a read-only view of the database at `file`, and close it
 * after. Undefined, and `work` not run, when there is no file or nothing
 * was ever migrated into it. A schema behind or ahead of this Marbles is
 * refused (`IncompatibleDatabaseError`).
 *
 * The rule a reader keeps: it never creates the database file, never
 * migrates it, and never changes its content. The connection is read-only
 * (`mode=ro`), so it cannot write.
 *
 * With both side files beside it, the database may be open in another
 * process: the read takes part in SQLite's WAL locking through the
 * shared-memory file already there. It opens that file read-write, as a
 * writer does. SQLite maps one shared-memory file per database once per
 * process, for every connection there, and libSQL closes a connection
 * only once its statements are collected; mapped read-only
 * (`readonly_shm=1`), every writer this process opened afterwards, until
 * then, would be refused (`SQLITE_READONLY`). Without them, or with only an empty WAL file,
 * everything is in the main file and no connection has it open, so it is
 * read as immutable, which takes no lock and makes no side file; a file
 * that changes while it is read that way (a process opened it meanwhile)
 * is read again. A WAL file holding frames but no shared-memory file needs
 * recovering, which only a writer can do.
 *
 * One race is narrowed, not closed. When the last writer closes between
 * this connection opening and its first read, it takes the side files with
 * it. SQLite then makes an empty WAL file and a shared-memory file for the
 * read, which no process holds once it closes. libSQL offers no supported
 * way to stop that short of a VFS of its own. Neither holds anything: the
 * next reader reads past them, and the next writer opens and migrates as
 * usual.
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
    const read = await readOnce(path, work, options);
    if (read.done) {
      return read.value;
    }
  }
  throw new UnreadableDatabaseError(
    `the Marbles database at ${path} kept changing while it was read; try again`
  );
}

type Read<T> =
  | { readonly done: true; readonly value: T | undefined }
  | { readonly done: false };

/** One attempt of `readDatabase`; not done when the file changed under it. */
async function readOnce<T>(
  path: string,
  work: (database: StoreDatabase) => Promise<T>,
  options: OpenDatabaseOptions
): Promise<Read<T>> {
  const wal = sizeOf(`${path}-wal`);
  const live = wal !== undefined && existsSync(`${path}-shm`);
  if (!live && wal !== undefined && wal > 0) {
    throw new UnreadableDatabaseError(
      `the Marbles database at ${path} was not closed cleanly; start the Marbles process to recover it`
    );
  }
  const before = live ? undefined : fingerprint(path);
  const client = existing(
    path,
    live ? "mode=ro" : "mode=ro&immutable=1",
    options
  );
  let value: T | undefined;
  try {
    const database = drizzle({ client });
    value = (await usable(database, path, options))
      ? await work(database)
      : undefined;
  } catch (error) {
    // The last writer closed after this one opened and took the side files
    // along, and none could be made for the read (a directory this process
    // cannot write): read again, now as immutable.
    if (live && !existsSync(`${path}-shm`)) {
      return { done: false };
    }
    throw error;
  } finally {
    client.close();
  }
  return before === undefined || before === fingerprint(path)
    ? { done: true, value }
    : { done: false };
}

/**
 * A writer's handle over `client`, whose schema was just found to be the
 * one the migrations in `folder` make: every transaction on it checks that
 * it still is (`guardedClient`), so a handle kept open for hours never
 * writes to a database a newer Marbles has migrated since.
 */
function writer(client: Client, path: string, folder: string): MarblesDatabase {
  const guarded = guardedClient(client, path, shippedMigrations(folder));
  return {
    close: () => guarded.close(),
    database: drizzle({ client: guarded }),
    file: path,
  };
}

/**
 * A connection to the file at `path`, which must exist, in the SQLite URI
 * `query` mode. The public `createClient` refuses URI parameters, so this
 * builds the local client from the configuration it would expand to.
 */
function existing(
  path: string,
  query: string,
  options: OpenDatabaseOptions,
  settings: readonly string[] = []
): Client {
  const busyTimeout = options.busyTimeout ?? BUSY_TIMEOUT_MS;
  const connect = () =>
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
    });
  return serialClient(connect(), path, busyTimeout, { connect, settings });
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

/** The size of the file at `path`, read without opening it; undefined when there is none. */
function sizeOf(path: string): number | undefined {
  return statSync(path, { throwIfNoEntry: false })?.size;
}

/** What changes when a process writes the file or opens it: its identity, size and time, and its side files. */
function fingerprint(path: string): string | undefined {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat === undefined
    ? undefined
    : [
        stat.ino,
        stat.size,
        stat.mtimeMs,
        sizeOf(`${path}-wal`),
        existsSync(`${path}-shm`),
      ].join(":");
}
