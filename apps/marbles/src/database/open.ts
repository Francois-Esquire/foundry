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

import { serialClient } from "~/database/client";
import { guardedClient } from "~/database/guard";
import {
  MIGRATIONS,
  migrate,
  schemaState,
  shippedMigrations,
} from "~/database/migrate";
import {
  IncompatibleDatabaseError,
  type ShippedMigration,
} from "~/database/migrate-core";
import type { StoreDatabase } from "~/database/types";

export type { StoreDatabase } from "~/database/types";

export interface MarblesDatabase {
  close(): void;
  readonly database: StoreDatabase;
  readonly file: string;
}

export interface OpenDatabaseOptions {
  readonly busyTimeout?: number;
  readonly migrations?: string;
}

export class UnreadableDatabaseError extends Error {
  override readonly name = "UnreadableDatabaseError";
}

const BUSY_TIMEOUT_MS = 5000;
const FOREIGN_KEYS = "PRAGMA foreign_keys = ON";
const READ_ATTEMPTS = 3;

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
  const client = serialClient(connect(), path, busyTimeout, {
    connect,
    settings: ["PRAGMA journal_mode = WAL", FOREIGN_KEYS],
  });
  try {
    const folder = options.migrations ?? MIGRATIONS;
    await migrate(client, drizzle({ client }), path, folder);
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

const OWNER_ONLY = 0o600;

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
  const changed = () => before !== undefined && before !== fingerprint(path);
  let client: Client | undefined;
  let value: T | undefined;
  try {
    client = existing(path, live ? "mode=ro" : "mode=ro&immutable=1", options);
    const database = drizzle({ client });
    value = (await usable(database, path, options))
      ? await work(database)
      : undefined;
  } catch (error) {
    if ((live && !existsSync(`${path}-shm`)) || changed()) {
      return { done: false };
    }
    throw error;
  } finally {
    client?.close();
  }
  return changed() ? { done: false } : { done: true, value };
}

function writer(client: Client, path: string, folder: string): MarblesDatabase {
  const guarded = guardedClient(client, path, shippedMigrations(folder));
  return {
    close: () => guarded.close(),
    database: drizzle({ client: guarded }),
    file: path,
  };
}

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

function sizeOf(path: string): number | undefined {
  return statSync(path, { throwIfNoEntry: false })?.size;
}

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
