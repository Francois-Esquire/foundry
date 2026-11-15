import type { ContentId } from "@foundry/artifacts";
import { Turns } from "@foundry/lib/turns";
import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  inArray,
  max,
  sql,
} from "drizzle-orm";
import type {
  BaseSQLiteDatabase,
  SQLiteColumn,
  SQLiteTransaction,
} from "drizzle-orm/sqlite-core";

import type { InstallationId, ModuleId } from "../domain";
import type {
  InstallationListQuery,
  ManifestListQuery,
  Module,
  ModuleListQuery,
  ModuleStore,
  ModuleStorePage,
  ModuleStoreWrite,
  StoredInstallation,
  StoredManifest,
} from "../store";
import { ownedQuery } from "./query";
import { moduleInstallations, moduleManifests, modules } from "./tables";

/**
 * An async Drizzle SQLite database, with or without a relational schema, or a
 * transaction on one. A `drizzle-orm/libsql` database and its transactions
 * both satisfy it, so a host can hand the store either.
 */
export type ModuleDatabase = BaseSQLiteDatabase<
  "async",
  unknown,
  Record<string, unknown>
>;

/** The transaction one `commit` runs in, as `onCommit` receives it. */
export type ModuleTransaction = SQLiteTransaction<
  "async",
  unknown,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export interface SqliteModuleStoreOptions {
  /** Opened, migrated, and owned by the host; the store never closes it. */
  readonly database: ModuleDatabase;
  /**
   * Runs inside the commit's transaction after the store's own statements,
   * so the host can record the change atomically with it. A throw rolls the
   * whole commit back. It receives the store's own copy of the write, taken
   * when `commit` was called: exactly what the store wrote, every record
   * put, whole, in the write's order, and every key a delete named. It does
   * not say which put filed a record and which replaced one, or what a
   * replaced or deleted record held; the store has already written when
   * the hook runs, so that is gone.
   */
  readonly onCommit?: (
    transaction: ModuleTransaction,
    write: ModuleStoreWrite
  ) => Promise<void>;
  /** The partition this store reads and writes; any nonempty string. */
  readonly scope: string;
}

/** Why a call from inside the store's own transaction or hook is refused. */
const REENTRY =
  "SqliteModuleStore was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

/** Every column of a row but `scope` and `position`. */
function recordColumns<T extends Record<string, SQLiteColumn>>(
  columns: T
): Omit<T, "position" | "scope"> {
  const { position: _position, scope: _scope, ...rest } = columns;
  return rest;
}

const moduleColumns = recordColumns(getTableColumns(modules));
const manifestColumns = recordColumns(getTableColumns(moduleManifests));
const installationColumns = recordColumns(getTableColumns(moduleInstallations));

type ModuleRow = typeof modules.$inferInsert;
type ManifestRow = typeof moduleManifests.$inferInsert;
type InstallationRow = typeof moduleInstallations.$inferInsert;
type StoreTable =
  | typeof moduleInstallations
  | typeof moduleManifests
  | typeof modules;

/**
 * A `ModuleStore` over the host's SQLite database, in the tables from
 * `@foundry/modules/store/tables`. It behaves as `MemoryModuleStore` does,
 * within its scope.
 *
 * Its calls take turns, as the memory store's do: a call made while a
 * transaction or commit runs waits for it. That keeps two registries over
 * one store apart in this process, and keeps a `:memory:` database, which
 * has a single connection, from refusing a call while a transaction holds
 * it. Across connections and processes, `transaction` takes the database's
 * write lock (see there).
 */
export class SqliteModuleStore implements ModuleStore {
  readonly #database: ModuleDatabase;
  readonly #scope: string;
  readonly #onCommit: SqliteModuleStoreOptions["onCommit"];
  readonly #turns = new Turns(REENTRY);

  constructor(options: SqliteModuleStoreOptions) {
    if (options.scope.length === 0 || !storable(options.scope)) {
      throw new RangeError(
        "scope must be a nonempty string with no U+0000 and no lone surrogate"
      );
    }
    this.#database = options.database;
    this.#scope = options.scope;
    this.#onCommit = options.onCommit;
  }

  /**
   * Takes the write as it stands when `commit` is called: one
   * `structuredClone` of the whole write, as the memory store takes it,
   * made before the commit waits its turn. That copy alone is checked, made
   * into every row, and handed to `onCommit`, so a caller changing its
   * write later changes nothing. A write the clone refuses rejects with the
   * clone's error, as in the memory store.
   *
   * Rejects, before writing anything, a write that puts a value SQLite
   * would not give back as it was (see {@link unstorable}), naming the
   * field. A delete of a key no row can hold does nothing.
   */
  commit(write: ModuleStoreWrite): Promise<void> {
    let owned: ModuleStoreWrite;
    let rows: Rows;
    try {
      owned = structuredClone(write);
      rows = rowsOf(owned);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(() =>
      this.#database.transaction(async (transaction) => {
        await this.#delete(
          transaction,
          moduleInstallations,
          moduleInstallations.id,
          owned.deleteInstallations ?? []
        );
        await this.#delete(
          transaction,
          moduleManifests,
          moduleManifests.contentId,
          owned.deleteManifests ?? []
        );
        await this.#delete(
          transaction,
          modules,
          modules.id,
          owned.deleteModules ?? []
        );
        await this.#put(transaction, modules, [modules.id], rows.modules);
        await this.#put(
          transaction,
          moduleManifests,
          [moduleManifests.contentId],
          rows.manifests
        );
        await this.#put(
          transaction,
          moduleInstallations,
          [moduleInstallations.id],
          rows.installations
        );
        await this.#onCommit?.(transaction, owned);
      })
    );
  }

  /**
   * Runs `work` inside one database transaction, over a view whose reads
   * and commits use it; a throw from `work` rolls everything back. In this
   * process, the store's other calls wait for it. Across connections, the
   * transaction holds SQLite's write lock from its first statement: Drizzle's
   * libSQL driver opens every transaction with libSQL's default mode,
   * `BEGIN IMMEDIATE`. Another connection's write then waits for it, for as
   * long as that connection's busy timeout allows, or fails with
   * `SQLITE_BUSY`; it never lands between `work`'s reads and its commit.
   */
  transaction<T>(work: (view: ModuleStore) => Promise<T>): Promise<T> {
    return this.#turns.run(() =>
      this.#database.transaction((transaction) =>
        work(
          new SqliteModuleStore({
            database: transaction,
            scope: this.#scope,
            ...(this.#onCommit === undefined
              ? {}
              : { onCommit: this.#onCommit }),
          })
        )
      )
    );
  }

  /** `null` for an id no row can hold (see {@link storable}). */
  getModule(id: ModuleId): Promise<Module | null> {
    return this.#turns.run(async () => {
      if (!storable(id)) {
        return null;
      }
      const [row] = await this.#database
        .select(moduleColumns)
        .from(modules)
        .where(and(eq(modules.scope, this.#scope), eq(modules.id, id)));
      return row ?? null;
    });
  }

  /** `null` for a Content id no row can hold. */
  getManifest(contentId: ContentId): Promise<StoredManifest | null> {
    return this.#turns.run(async () => {
      if (!storable(contentId)) {
        return null;
      }
      const [row] = await this.#database
        .select(manifestColumns)
        .from(moduleManifests)
        .where(
          and(
            eq(moduleManifests.scope, this.#scope),
            eq(moduleManifests.contentId, contentId)
          )
        );
      return row ?? null;
    });
  }

  /** `null` for an id no row can hold. */
  getInstallation(id: InstallationId): Promise<StoredInstallation | null> {
    return this.#turns.run(async () => {
      if (!storable(id)) {
        return null;
      }
      const [row] = await this.#database
        .select(installationColumns)
        .from(moduleInstallations)
        .where(
          and(
            eq(moduleInstallations.scope, this.#scope),
            eq(moduleInstallations.id, id)
          )
        );
      return row === undefined ? null : installationOf(row);
    });
  }

  listModules(query: ModuleListQuery): Promise<ModuleStorePage<Module>> {
    return this.#page(query, (owned) => {
      if (owned.artifactId !== undefined && !storable(owned.artifactId)) {
        return null;
      }
      return {
        filter:
          owned.artifactId === undefined
            ? undefined
            : eq(modules.artifactId, owned.artifactId),
        read: (where, limit) =>
          this.#database
            .select({ ...moduleColumns, position: modules.position })
            .from(modules)
            .where(where)
            .orderBy(asc(modules.position))
            .limit(limit),
        table: modules,
      };
    });
  }

  listInstallations(
    query: InstallationListQuery
  ): Promise<ModuleStorePage<StoredInstallation>> {
    return this.#page(query, (owned) => {
      if (owned.moduleId !== undefined && !storable(owned.moduleId)) {
        return null;
      }
      return {
        filter:
          owned.moduleId === undefined
            ? undefined
            : eq(moduleInstallations.moduleId, owned.moduleId),
        read: async (where, limit) =>
          (
            await this.#database
              .select({
                ...installationColumns,
                position: moduleInstallations.position,
              })
              .from(moduleInstallations)
              .where(where)
              .orderBy(asc(moduleInstallations.position))
              .limit(limit)
          ).map((row) => ({ ...installationOf(row), position: row.position })),
        table: moduleInstallations,
      };
    });
  }

  listManifests(
    query: ManifestListQuery = {}
  ): Promise<readonly StoredManifest[]> {
    let owned: ManifestListQuery;
    try {
      owned = structuredClone(query);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(async () => {
      if (owned.moduleId !== undefined && !storable(owned.moduleId)) {
        return [];
      }
      return await this.#database
        .select(manifestColumns)
        .from(moduleManifests)
        .where(
          and(
            eq(moduleManifests.scope, this.#scope),
            owned.moduleId === undefined
              ? undefined
              : eq(moduleManifests.moduleId, owned.moduleId)
          )
        )
        .orderBy(asc(moduleManifests.position));
    });
  }

  /**
   * One page of a list read: the rows in this scope that `plan`'s filter
   * matches, after the cursor, in position order. `plan` returns `null`
   * for a filter no row can match.
   */
  #page<Q extends ModuleListQuery | InstallationListQuery, T>(
    query: Q,
    plan: (owned: Q) => {
      readonly filter: SQL | undefined;
      readonly read: (
        where: SQL | undefined,
        limit: number
      ) => PromiseLike<readonly (T & { readonly position: number })[]>;
      readonly table: StoreTable;
    } | null
  ): Promise<ModuleStorePage<T>> {
    let owned: Q;
    try {
      owned = ownedQuery(query);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(async () => {
      const planned = plan(owned);
      if (planned === null) {
        return { items: [] };
      }
      const { table } = planned;
      const rows = await planned.read(
        and(
          eq(table.scope, this.#scope),
          owned.after === undefined
            ? undefined
            : gt(table.position, owned.after),
          planned.filter
        ),
        owned.limit + 1
      );
      const items = rows.slice(0, owned.limit);
      const last = items.at(-1);
      return {
        items: items.map(({ position: _position, ...record }) => record as T),
        ...(rows.length > owned.limit && last !== undefined
          ? { next: last.position }
          : {}),
      };
    });
  }

  async #delete(
    transaction: ModuleTransaction,
    table: StoreTable,
    key: SQLiteColumn,
    keys: readonly string[]
  ): Promise<void> {
    await inOrder(batches(keys.filter(storable), MAX_PARAMETERS - 1), (batch) =>
      transaction
        .delete(table)
        .where(and(eq(table.scope, this.#scope), inArray(key, batch)))
    );
  }

  /** A new row takes the next position; one put again keeps its own. */
  async #put(
    transaction: ModuleTransaction,
    table: StoreTable,
    keys: readonly SQLiteColumn[],
    records: readonly object[]
  ): Promise<void> {
    const columns: Record<string, SQLiteColumn> = getTableColumns(table);
    const first = await this.#nextPosition(transaction, table);
    const rows = records.map((record, index) => ({
      ...record,
      position: first + index,
      scope: this.#scope,
    }));
    const replace = Object.fromEntries(
      Object.entries(recordColumns(columns)).map(([field, column]) => [
        field,
        excluded(column),
      ])
    );
    await inOrder(
      batches(rows, MAX_PARAMETERS / Object.keys(columns).length),
      (batch) =>
        transaction
          .insert(table)
          // Each row is the table's own: `rowsOf` made it field by field.
          .values(batch as never[])
          .onConflictDoUpdate({
            set: replace,
            target: [table.scope, ...keys],
          })
    );
  }

  /**
   * One past the last position in this scope. A row that turns out to exist
   * keeps its own and leaves a gap; only the order of positions matters.
   */
  async #nextPosition(
    transaction: ModuleTransaction,
    table: StoreTable
  ): Promise<number> {
    const [last] = await transaction
      .select({ position: max(table.position) })
      .from(table)
      .where(eq(table.scope, this.#scope));
    return (last?.position ?? 0) + 1;
  }
}

/** A write's rows, without `scope` and `position`. */
interface Rows {
  readonly installations: readonly Omit<
    InstallationRow,
    "position" | "scope"
  >[];
  readonly manifests: readonly Omit<ManifestRow, "position" | "scope">[];
  readonly modules: readonly Omit<ModuleRow, "position" | "scope">[];
}

/**
 * The rows a write puts, made from the store's own copy, field by field.
 * Throws a `RangeError` naming the first field SQLite would not give back
 * as it was, before anything is written.
 */
function rowsOf(write: ModuleStoreWrite): Rows {
  return {
    installations: (write.putInstallations ?? []).map((stored, index) =>
      installationRow(stored, `putInstallations[${index}]`)
    ),
    manifests: (write.putManifests ?? []).map((stored, index) => {
      const at = `putManifests[${index}]`;
      return {
        contentId: text(stored.contentId, `${at}.contentId`),
        manifest: json(stored.manifest, `${at}.manifest`),
        moduleId: text(stored.moduleId, `${at}.moduleId`),
      };
    }),
    modules: (write.putModules ?? []).map((module, index) => {
      const at = `putModules[${index}]`;
      return {
        artifactId: text(module.artifactId, `${at}.artifactId`),
        id: text(module.id, `${at}.id`),
      };
    }),
  };
}

function installationRow(
  stored: StoredInstallation,
  at: string
): Omit<InstallationRow, "position" | "scope"> {
  const { installation } = stored;
  const field = (name: string) => `${at}.installation.${name}`;
  if (!Array.isArray(stored.grants)) {
    throw unstorable(`${at}.grants`, "holds no array of Grants");
  }
  return {
    containerId:
      installation.containerId === null
        ? null
        : text(installation.containerId, field("containerId")),
    contentId: text(installation.contentId, field("contentId")),
    createdAt: instant(installation.createdAt, field("createdAt")),
    generation: integer(installation.generation, field("generation")),
    grants: stored.grants.map((grant, index) => {
      const grantAt = `${at}.grants[${index}]`;
      return {
        capability: jsonText(grant.capability, `${grantAt}.capability`),
        constraintsDigest: jsonText(
          grant.constraintsDigest,
          `${grantAt}.constraintsDigest`
        ),
        createdAt: instant(grant.createdAt, `${grantAt}.createdAt`),
        version: jsonNumber(grant.version, `${grantAt}.version`),
      };
    }),
    id: text(installation.id, field("id")),
    moduleId: text(installation.moduleId, field("moduleId")),
    startAttempts: integer(installation.startAttempts, field("startAttempts")),
    status: text(installation.status, field("status")),
    updatedAt: instant(installation.updatedAt, field("updatedAt")),
  };
}

/** A row read back as the record it holds. */
function installationOf(
  row: Omit<typeof moduleInstallations.$inferSelect, "position" | "scope">
): StoredInstallation {
  return {
    grants: row.grants.map((grant) => ({
      capability: grant.capability,
      constraintsDigest: grant.constraintsDigest,
      createdAt: new Date(grant.createdAt),
      version: grant.version,
    })),
    installation: {
      containerId: row.containerId,
      contentId: row.contentId,
      createdAt: new Date(row.createdAt),
      generation: row.generation,
      id: row.id,
      moduleId: row.moduleId,
      startAttempts: row.startAttempts,
      status: row.status,
      updatedAt: new Date(row.updatedAt),
    },
  };
}

function unstorable(field: string, reason: string): RangeError {
  return new RangeError(`SqliteModuleStore cannot store ${field}: ${reason}`);
}

/**
 * Whether SQLite gives `text` back as it was bound. It does not when the text
 * holds U+0000 (libSQL reads it back cut at the NUL) or is not well-formed
 * UTF-16: a lone surrogate is bound as U+FFFD on Node and as nothing on Bun,
 * so it reads back changed, and a key holding one would match another key's
 * row. JSON columns are exempt: JSON escapes both.
 */
function storable(value: string): boolean {
  return value.isWellFormed() && !value.includes("\u0000");
}

/** A plain-text column value; see {@link storable}. */
function text<T extends string>(value: T, field: string): T {
  if (typeof value !== "string") {
    throw unstorable(field, `${describe(value)} is not text`);
  }
  if (!storable(value)) {
    throw unstorable(
      field,
      "text holding U+0000 or a lone surrogate (not well-formed UTF-16) does not read back intact from SQLite"
    );
  }
  return value;
}

/** Text inside a JSON column: JSON escapes every code unit, so any string. */
function jsonText(value: string, field: string): string {
  if (typeof value !== "string") {
    throw unstorable(field, `${describe(value)} is not text`);
  }
  return value;
}

/**
 * A `Date` as ISO 8601 text, which `new Date` reads back to the same
 * millisecond across the whole range a `Date` holds, extended years
 * included. An invalid `Date` has no such text.
 */
function instant(value: Date, field: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw unstorable(field, `${describe(value)} is not a valid Date`);
  }
  return value.toISOString();
}

/**
 * An integer column. SQLite does not give back NaN or an infinity (libSQL
 * refuses to bind them), `-0` (it reads back as `0`), or an integer beyond
 * `Number.MAX_SAFE_INTEGER` either way. Every other number, whole or
 * fractional, reads back exactly.
 */
function integer(value: number, field: string): number {
  if (
    typeof value !== "number" ||
    Object.is(value, -0) ||
    !(Math.abs(value) <= Number.MAX_SAFE_INTEGER)
  ) {
    throw unstorable(
      field,
      `${describe(value)} does not read back intact from SQLite; it must be a number within ±Number.MAX_SAFE_INTEGER, and not -0`
    );
  }
  return value;
}

/** A number inside a JSON column: JSON writes NaN and infinities as `null`, `-0` as `0`. */
function jsonNumber(value: number, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Object.is(value, -0)
  ) {
    throw unstorable(
      field,
      `${describe(value)} does not read back intact from JSON`
    );
  }
  return value;
}

/**
 * `value` itself, once it is known to be JSON that reads back as it is, or
 * a refusal naming the first part that would not: NaN, an infinity or
 * `-0`, `undefined`, a hole in an array, a `bigint` or a function, a value
 * that contains itself, anything but a plain object or an array (a `Date`
 * becomes a string), and a property holding `undefined` (JSON leaves it
 * out). Strings need no check: JSON escapes U+0000 and lone surrogates.
 */
function json<T>(value: T, field: string): T {
  checkJson(value, field, new Set());
  return value;
}

/** A plain key reads after a dot in a path; any other is bracketed. */
const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/;

function checkJson(value: unknown, at: string, ancestors: Set<object>): void {
  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      jsonNumber(value, at);
      return;
    case "object":
      if (value === null) {
        return;
      }
      checkComposite(value, at, ancestors);
      return;
    default:
      throw unstorable(at, `${describe(value)} has no JSON form`);
  }
}

function checkComposite(value: object, at: string, ancestors: Set<object>) {
  if (ancestors.has(value)) {
    throw unstorable(at, "a value that contains itself has no JSON form");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw unstorable(
            `${at}[${index}]`,
            "a hole in an array reads back from JSON as null"
          );
        }
        checkJson(value[index], `${at}[${index}]`, ancestors);
      }
      return;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw unstorable(
        at,
        `${describe(value)} is not a plain object and does not read back intact from JSON`
      );
    }
    for (const [key, item] of Object.entries(value)) {
      const path = PLAIN_KEY.test(key)
        ? `${at}.${key}`
        : `${at}[${JSON.stringify(key)}]`;
      if (item === undefined) {
        throw unstorable(
          path,
          "a property holding undefined is left out by JSON"
        );
      }
      checkJson(item, path, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function describe(value: unknown): string {
  if (typeof value === "number") {
    return Object.is(value, -0) ? "-0" : String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "an invalid Date" : "a Date";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  if (typeof value === "object" && value !== null) {
    return `a ${value.constructor?.name ?? "object"}`;
  }
  return value === undefined ? "undefined" : `a ${typeof value}`;
}

/** SQLite's default limit on the parameters one statement binds. */
const MAX_PARAMETERS = 32_766;

/** `items` in order, at most `size` at a time; none when `items` is empty. */
function batches<T>(items: readonly T[], size: number): T[][] {
  const length = Math.max(1, Math.floor(size));
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += length) {
    result.push(items.slice(start, start + length));
  }
  return result;
}

/** Runs one statement per batch, each after the one before. */
async function inOrder<T>(
  items: readonly T[],
  run: (item: T) => PromiseLike<unknown>
): Promise<void> {
  for (const item of items) {
    // In sequence: deletes precede puts, and later batches follow earlier ones.
    await run(item);
  }
}

/** The value an `INSERT` proposed for `column`, inside its `ON CONFLICT`. */
function excluded(column: SQLiteColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}
