import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { holdsLock } from "@foundry/lib/node/file-lock";
import { Tasks } from "@foundry/tasks";
import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import { _createClient } from "@libsql/client/sqlite3";
import { desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { DatabaseAutomationStore } from "~/database/automations";
import { asBusy, busyError } from "~/database/busy";
import { ChangeRecorder, counterOf, readObservers } from "~/database/changes";
import { serialClient } from "~/database/client";
import type { GenerationRecord } from "~/database/generations";
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
import { DatabaseProviderStore } from "~/database/providers";
import { ResourceView, type ViewScope } from "~/database/resources";
import { marblesGenerations, marblesRecoveries } from "~/database/tables";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { type ScheduleSnapshot, storedSchedules } from "~/database/triggers";
import type { StoreDatabase } from "~/database/types";
import { WorkspaceRegistry } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import type { AutomationStore } from "~/lib/automation/store";
import type { RecoveryReport } from "~/lib/crash-recovery";
import type { ObserverState } from "~/lib/events/log";
import { causingRun } from "~/lib/events/records";
import { NODE_OWNER_LIVENESS } from "~/lib/node-host-liveness";
import type { OwnerLiveness } from "~/lib/owner-liveness";
import { keptConfigurations, type ProviderStore } from "~/lib/providers/store";
import { recoveryReportSchema } from "~/lib/recovery-report";
import { acquireLock, PROCESS_LOCK } from "~/lib/state/locks";
import { insideState, type WorkspaceRecord } from "~/lib/state/workspace";

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

export function readAutomations(state: string, scope: string): AutomationStore {
  const refused = () =>
    Promise.reject(new Error("the automations are read only here"));
  return {
    close: () => Promise.resolve(),
    edit: refused,
    async list() {
      const read = await asBusy(() =>
        readDatabase(stateDatabase(state), (database) =>
          new DatabaseAutomationStore({ database, scope }).list()
        )
      );
      return read ?? [];
    },
    put: refused,
    remove: refused,
  };
}

export async function readStoredObservers(
  state: string,
  scope: string
): Promise<{
  readonly head: number;
  readonly observers: readonly ObserverState[];
}> {
  const read = await asBusy(() =>
    readDatabase(stateDatabase(state), async (database) => ({
      head: (await counterOf(database, scope)).position,
      observers: await readObservers(database, scope),
    }))
  );
  return read ?? { head: 0, observers: [] };
}

export async function readLiveGenerations(
  state: string
): Promise<readonly GenerationRecord[]> {
  const rows = await asBusy(() =>
    readDatabase(stateDatabase(state), (database) =>
      database
        .select()
        .from(marblesGenerations)
        .where(
          inArray(marblesGenerations.state, ["loading", "current", "retiring"])
        )
        .orderBy(desc(marblesGenerations.number))
    )
  );
  return (rows ?? []).map((row) => ({
    error: row.error,
    fingerprint: row.fingerprint,
    number: row.number,
    pid: row.pid,
    started: row.started,
    state: row.state,
    workspaces: row.workspaces,
  }));
}

export async function readLastRecovery(
  state: string,
  scope: string
): Promise<RecoveryReport | null> {
  const rows = await asBusy(() =>
    readDatabase(stateDatabase(state), (database) =>
      database
        .select()
        .from(marblesRecoveries)
        .where(eq(marblesRecoveries.scope, scope))
    )
  );
  const [row] = rows ?? [];
  if (row === undefined) {
    return null;
  }
  const parsed = recoveryReportSchema.safeParse({
    at: row.at,
    steps: row.steps,
  });
  return parsed.success ? parsed.data : null;
}

export function readResourceView<T>(
  state: string,
  scope: ViewScope,
  work: (view: ResourceView) => Promise<T>
): Promise<T | undefined> {
  return readDatabase(stateDatabase(state), (database) =>
    work(
      new ResourceView({
        acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
        database,
        scope,
      })
    )
  );
}

export async function readTasks<T>(
  state: string,
  scope: string,
  work: (tasks: Tasks) => Promise<T>
): Promise<T> {
  const read = await busyAsMarbles(
    readDatabase(stateDatabase(state), async (database) => ({
      value: await work(tasksOver(database, scope)),
    }))
  );
  return read === undefined ? work(new Tasks()) : read.value;
}

export function changeTasks<T>(
  state: string,
  scope: string,
  work: (tasks: Tasks) => Promise<T>,
  options: HostDatabaseOptions = {}
): Promise<T> {
  return busyAsMarbles(
    writeAsHost(
      state,
      async (database) => {
        const records = new DatabaseWorkspaceRecords({
          changes: new ChangeRecorder(scope, {
            causingRun: () => causingRun() ?? undefined,
          }),
          database,
          liveness: NODE_OWNER_LIVENESS,
          scope,
        });
        try {
          return await work(new Tasks({ store: records.taskStore }));
        } finally {
          await records.close();
        }
      },
      options
    )
  );
}

export async function readStoredSchedules(
  state: string,
  scope: string,
  liveness: OwnerLiveness = NODE_OWNER_LIVENESS
): Promise<readonly ScheduleSnapshot[]> {
  return (
    (await asBusy(() =>
      readDatabase(stateDatabase(state), (database) =>
        storedSchedules(database, scope, liveness)
      )
    )) ?? []
  );
}

export async function recordedWorkspaces(
  state: string
): Promise<readonly WorkspaceRecord[]> {
  const records = await readDatabase(stateDatabase(state), (database) =>
    new WorkspaceRegistry({
      acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
      database,
    }).list()
  );
  return records ?? [];
}

export async function openHostDatabase(
  state: string,
  options: HostDatabaseOptions = {}
): Promise<MarblesDatabase> {
  const root = resolve(state);
  const file = stateDatabase(root);
  const deadline = Date.now() + (options.wait ?? HOST_WAIT_MS);
  for (;;) {
    const claim = acquireLock(root, PROCESS_LOCK);
    if ("release" in claim) {
      try {
        return await initializeDatabase(file, options);
      } finally {
        claim.release();
      }
    }
    if (holdsLock(join(root, "locks", PROCESS_LOCK))) {
      return await initializeDatabase(file, options);
    }
    let opened: MarblesDatabase | undefined;
    try {
      opened = await openDatabase(file, options);
    } catch (error) {
      if (!(error instanceof IncompatibleDatabaseError)) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw error;
      }
    }
    if (opened !== undefined) {
      return opened;
    }
    if (Date.now() >= deadline) {
      throw new IncompatibleDatabaseError(
        `there is no Marbles database at ${file} yet, and ${claim.holder} holds the state root, so this host does not make one; start the Marbles process, or retry once it is up`
      );
    }
    await new Promise((settle) => setTimeout(settle, HOST_RETRY_MS));
  }
}

export async function writeAsHost<T>(
  state: string,
  work: (database: StoreDatabase) => Promise<T>,
  options: HostDatabaseOptions = {}
): Promise<T> {
  const opened = await openHostDatabase(state, options);
  try {
    return await work(opened.database);
  } finally {
    opened.close();
  }
}

async function busyAsMarbles<T>(opening: Promise<T>): Promise<T> {
  try {
    return await opening;
  } catch (error) {
    throw busyError(error) ?? error;
  }
}

function tasksOver(database: StoreDatabase, scope: string): Tasks {
  return new Tasks({
    store: new DatabaseWorkspaceRecords({
      changes: new ChangeRecorder(scope, {
        causingRun: () => causingRun() ?? undefined,
      }),
      database,
      liveness: NODE_OWNER_LIVENESS,
      scope,
    }).taskStore,
  });
}

export function providerStoreForState(state: string): ProviderStore {
  const file = stateDatabase(state);
  const reading = async <T>(
    work: (store: DatabaseProviderStore) => Promise<T>,
    none: T
  ): Promise<T> =>
    (await readDatabase(file, (database) =>
      work(new DatabaseProviderStore({ database }))
    )) ?? none;
  const writing = <T>(
    work: (store: DatabaseProviderStore) => Promise<T>
  ): Promise<T> =>
    writeAsHost(state, (database) =>
      work(new DatabaseProviderStore({ database }))
    );
  return {
    identityKey: (make) =>
      make
        ? writing((store) => store.identityKey(true))
        : reading((store) => store.identityKey(false), undefined),
    read: () =>
      reading((store) => store.read(), keptConfigurations(new Map(), 0)),
    revision: () => reading((store) => store.revision(), 0),
    update: (workspace, edit) =>
      writing((store) => store.update(workspace, edit)),
  };
}

export interface HostDatabaseOptions extends OpenDatabaseOptions {
  readonly wait?: number;
}

const HOST_WAIT_MS = 5000;
const HOST_RETRY_MS = 50;
