import type { ContentId } from "@foundry/artifacts";
import type { Page } from "@foundry/core/pagination";
import { pageFromRows } from "@foundry/lib/pagination";
import {
  assertScope,
  batches,
  describeNumber,
  replacing,
  SQLITE_MAX_PARAMETERS,
  type SqliteDatabase,
  type SqliteTransaction,
  storableNumber,
  storableText,
  UNSTORABLE_TEXT,
} from "@foundry/lib/sqlite";
import { Turns } from "@foundry/lib/turns";
import type { SQL } from "drizzle-orm";
import {
  and,
  asc,
  count,
  eq,
  getTableColumns,
  gt,
  inArray,
  is,
  max,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { SQLiteTransaction } from "drizzle-orm/sqlite-core";

import type { InstallationId, ModuleId } from "../domain";
import {
  capturedQuery,
  capturedWrite,
  ownedIdPageQuery,
  ownedQuery,
} from "./captured";
import type {
  InstallationIdPageQuery,
  InstallationListQuery,
  ManifestListQuery,
  Module,
  ModuleIdPageQuery,
  ModuleListQuery,
  ModuleStore,
  ModuleStoreDurability,
  ModuleStorePage,
  ModuleStoreWrite,
  StoredInstallation,
  StoredManifest,
} from "./index";
import {
  moduleInstallations,
  moduleManifests,
  modulePositions,
  modules,
} from "./tables";

export type ModuleDatabase = SqliteDatabase;

export type ModuleTransaction = SqliteTransaction;

export interface SqliteModuleStoreOptions {
  readonly database: ModuleDatabase;
  readonly durability?: ModuleStoreDurability;
  readonly onCommit?: (
    transaction: ModuleTransaction,
    write: ModuleStoreWrite
  ) => Promise<void>;
  readonly scope: string;
}

const REENTRY =
  "SqliteModuleStore was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

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

export class SqliteModuleStore implements ModuleStore {
  readonly durability: ModuleStoreDurability;
  readonly #database: ModuleDatabase;
  readonly #scope: string;
  readonly #onCommit: SqliteModuleStoreOptions["onCommit"];
  readonly #turns = new Turns(REENTRY);

  constructor(options: SqliteModuleStoreOptions) {
    assertScope(options.scope);
    const joined = is(options.database, SQLiteTransaction);
    if (joined && options.durability === "commit") {
      throw new RangeError(
        'database is a transaction the host owns, which it may roll back: a commit is durable only when the host\'s is, so durability cannot be "commit"'
      );
    }
    this.durability = joined ? "host" : (options.durability ?? "commit");
    this.#database = options.database;
    this.#scope = options.scope;
    this.#onCommit = options.onCommit;
  }

  commit(write: ModuleStoreWrite): Promise<void> {
    let owned: ModuleStoreWrite;
    let rows: Rows;
    try {
      owned = structuredClone(capturedWrite(write));
      rows = rowsOf(owned);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(() =>
      this.#database.transaction(async (transaction) => {
        const positions = await this.#positions(transaction, owned);
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
        await this.#put(
          transaction,
          modules,
          [modules.id],
          rows.modules,
          positions
        );
        await this.#put(
          transaction,
          moduleManifests,
          [moduleManifests.contentId],
          rows.manifests,
          positions
        );
        await this.#put(
          transaction,
          moduleInstallations,
          [moduleInstallations.id],
          rows.installations,
          positions
        );
        await this.#savePositions(transaction, positions);
        await this.#onCommit?.(transaction, owned);
      })
    );
  }

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

  getModule(id: ModuleId): Promise<Module | null> {
    return this.#turns.run(async () => {
      if (!storableText(id)) {
        return null;
      }
      const [row] = await this.#database
        .select(moduleColumns)
        .from(modules)
        .where(and(eq(modules.scope, this.#scope), eq(modules.id, id)));
      return row ?? null;
    });
  }

  getManifest(contentId: ContentId): Promise<StoredManifest | null> {
    return this.#turns.run(async () => {
      if (!storableText(contentId)) {
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

  getInstallation(id: InstallationId): Promise<StoredInstallation | null> {
    return this.#turns.run(async () => {
      if (!storableText(id)) {
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
      if (owned.artifactId !== undefined && !storableText(owned.artifactId)) {
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

  listModulesPage(
    query: ModuleIdPageQuery = {}
  ): Promise<Page<Module, string>> {
    let owned: ModuleIdPageQuery & { readonly limit: number };
    try {
      owned = ownedIdPageQuery(capturedQuery(query));
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(() => {
      if (owned.artifactId !== undefined && !storableText(owned.artifactId)) {
        if (owned.cursor !== undefined) {
          return Promise.reject(new RangeError("Page cursor is invalid"));
        }
        return Promise.resolve({ items: [], total: 0 });
      }
      if (owned.cursor !== undefined && !storableText(owned.cursor)) {
        return Promise.reject(new RangeError("Page cursor is invalid"));
      }
      const filter = and(
        eq(modules.scope, this.#scope),
        owned.artifactId === undefined
          ? undefined
          : eq(modules.artifactId, owned.artifactId)
      );
      return this.#database.transaction(async (transaction) => {
        if (owned.cursor !== undefined) {
          const [anchor] = await transaction
            .select({ id: modules.id })
            .from(modules)
            .where(and(filter, eq(modules.id, owned.cursor as ModuleId)))
            .limit(1);
          if (anchor === undefined) {
            throw new RangeError("Page cursor is invalid");
          }
        }
        const [counted] = await transaction
          .select({ total: count() })
          .from(modules)
          .where(filter);
        const rows = await transaction
          .select(moduleColumns)
          .from(modules)
          .where(
            and(
              filter,
              owned.cursor === undefined
                ? undefined
                : gt(modules.id, owned.cursor as ModuleId)
            )
          )
          .orderBy(asc(modules.id))
          .limit(owned.limit + 1);
        return pageFromRows(
          rows,
          owned.limit,
          counted?.total ?? 0,
          (row) => row.id
        );
      });
    });
  }

  listInstallations(
    query: InstallationListQuery
  ): Promise<ModuleStorePage<StoredInstallation>> {
    return this.#page(query, (owned) => {
      if (owned.moduleId !== undefined && !storableText(owned.moduleId)) {
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

  listInstallationsPage(
    query: InstallationIdPageQuery = {}
  ): Promise<Page<StoredInstallation, string>> {
    let owned: InstallationIdPageQuery & { readonly limit: number };
    try {
      owned = ownedIdPageQuery(capturedQuery(query));
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(() => {
      if (owned.moduleId !== undefined && !storableText(owned.moduleId)) {
        if (owned.cursor !== undefined) {
          return Promise.reject(new RangeError("Page cursor is invalid"));
        }
        return Promise.resolve({ items: [], total: 0 });
      }
      if (owned.cursor !== undefined && !storableText(owned.cursor)) {
        return Promise.reject(new RangeError("Page cursor is invalid"));
      }
      const filter = and(
        eq(moduleInstallations.scope, this.#scope),
        owned.moduleId === undefined
          ? undefined
          : eq(moduleInstallations.moduleId, owned.moduleId)
      );
      return this.#database.transaction(async (transaction) => {
        if (owned.cursor !== undefined) {
          const [anchor] = await transaction
            .select({ id: moduleInstallations.id })
            .from(moduleInstallations)
            .where(
              and(
                filter,
                eq(moduleInstallations.id, owned.cursor as InstallationId)
              )
            )
            .limit(1);
          if (anchor === undefined) {
            throw new RangeError("Page cursor is invalid");
          }
        }
        const [counted] = await transaction
          .select({ total: count() })
          .from(moduleInstallations)
          .where(filter);
        const rows = await transaction
          .select(installationColumns)
          .from(moduleInstallations)
          .where(
            and(
              filter,
              owned.cursor === undefined
                ? undefined
                : gt(moduleInstallations.id, owned.cursor as InstallationId)
            )
          )
          .orderBy(asc(moduleInstallations.id))
          .limit(owned.limit + 1);
        return pageFromRows(
          rows.map(installationOf),
          owned.limit,
          counted?.total ?? 0,
          (stored) => stored.installation.id
        );
      });
    });
  }

  listManifests(
    query: ManifestListQuery = {}
  ): Promise<readonly StoredManifest[]> {
    let owned: ManifestListQuery;
    try {
      owned = capturedQuery(query);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(async () => {
      if (owned.moduleId !== undefined && !storableText(owned.moduleId)) {
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
      owned = ownedQuery(capturedQuery(query));
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
    for (const batch of batches(
      keys.filter(storableText),
      SQLITE_MAX_PARAMETERS - 1
    )) {
      await transaction
        .delete(table)
        .where(and(eq(table.scope, this.#scope), inArray(key, batch)));
    }
  }

  async #put(
    transaction: ModuleTransaction,
    table: StoreTable,
    keys: readonly SQLiteColumn[],
    records: readonly object[],
    positions: Positions
  ): Promise<void> {
    const columns: Record<string, SQLiteColumn> = getTableColumns(table);
    const rows = records.map((record) => {
      const position = positions.next;
      positions.next += 1;
      return { ...record, position, scope: this.#scope };
    });
    const replace = replacing(recordColumns(columns));
    for (const batch of batches(
      rows,
      SQLITE_MAX_PARAMETERS / Object.keys(columns).length
    )) {
      await transaction
        .insert(table)
        .values(batch as never[])
        .onConflictDoUpdate({
          set: replace,
          target: [table.scope, ...keys],
        });
    }
  }

  async #positions(
    transaction: ModuleTransaction,
    write: ModuleStoreWrite
  ): Promise<Positions> {
    const changes =
      (write.deleteInstallations?.length ?? 0) +
      (write.deleteManifests?.length ?? 0) +
      (write.deleteModules?.length ?? 0) +
      (write.putInstallations?.length ?? 0) +
      (write.putManifests?.length ?? 0) +
      (write.putModules?.length ?? 0);
    if (changes === 0) {
      return { next: 0, start: 0 };
    }
    const [counter] = await transaction
      .select({ next: modulePositions.next })
      .from(modulePositions)
      .where(eq(modulePositions.scope, this.#scope));
    if (counter !== undefined) {
      return { next: counter.next, start: counter.next };
    }
    let highest = 0;
    for (const table of [modules, moduleManifests, moduleInstallations]) {
      const [last] = await transaction
        .select({ position: max(table.position) })
        .from(table)
        .where(eq(table.scope, this.#scope));
      highest = Math.max(highest, Number(last?.position ?? 0));
    }
    return { next: highest + 1, start: Number.NaN };
  }

  async #savePositions(
    transaction: ModuleTransaction,
    positions: Positions
  ): Promise<void> {
    if (positions.next === positions.start) {
      return;
    }
    await transaction
      .insert(modulePositions)
      .values({ next: positions.next, scope: this.#scope })
      .onConflictDoUpdate({
        set: { next: positions.next },
        target: [modulePositions.scope],
      });
  }
}

interface Positions {
  next: number;
  readonly start: number;
}

interface Rows {
  readonly installations: readonly Omit<
    InstallationRow,
    "position" | "scope"
  >[];
  readonly manifests: readonly Omit<ManifestRow, "position" | "scope">[];
  readonly modules: readonly Omit<ModuleRow, "position" | "scope">[];
}

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

function text<T extends string>(value: T, field: string): T {
  if (typeof value !== "string") {
    throw unstorable(field, `${describe(value)} is not text`);
  }
  if (!storableText(value)) {
    throw unstorable(field, UNSTORABLE_TEXT);
  }
  return value;
}

function jsonText(value: string, field: string): string {
  if (typeof value !== "string") {
    throw unstorable(field, `${describe(value)} is not text`);
  }
  return value;
}

function instant(value: Date, field: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw unstorable(field, `${describe(value)} is not a valid Date`);
  }
  return value.toISOString();
}

function integer(value: number, field: string): number {
  if (typeof value !== "number" || !storableNumber(value)) {
    throw unstorable(
      field,
      `${describe(value)} does not read back intact from SQLite; it must be a number within ±Number.MAX_SAFE_INTEGER, and not -0`
    );
  }
  return value;
}

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

function json<T>(value: T, field: string): T {
  checkJson(value, field, new Set());
  return value;
}

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
    return describeNumber(value);
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
