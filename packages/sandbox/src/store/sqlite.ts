import { Turns } from "@foundry/lib/turns";
import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import { and, eq, getTableColumns, inArray, max, sql } from "drizzle-orm";
import type {
  BaseSQLiteDatabase,
  SQLiteColumn,
  SQLiteTransaction,
} from "drizzle-orm/sqlite-core";

import type { ContainerRow } from "../schema";
import { ownedWrite } from "./events";
import type { ContainerStore, ContainerStoreWrite } from "./index";
import { sandboxContainers } from "./tables";

export type ContainerDatabase = BaseSQLiteDatabase<
  "async",
  unknown,
  Record<string, unknown>
>;

export type ContainerTransaction = SQLiteTransaction<
  "async",
  unknown,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export interface SqliteContainerStoreOptions {
  readonly database: ContainerDatabase;
  readonly location?: string;
  readonly onCommit?: (
    transaction: ContainerTransaction,
    write: ContainerStoreWrite
  ) => Promise<void>;
  readonly scope: string;
}

const {
  position: _position,
  scope: _scope,
  ...rowColumns
} = getTableColumns(sandboxContainers);

const replaceRow = Object.fromEntries(
  Object.entries(rowColumns).map(([key, column]) => [key, excluded(column)])
);

const REENTRY =
  "The SQLite container store was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

const CANNOT_STORE = "The SQLite container store cannot store";

type StoredRow = typeof sandboxContainers.$inferInsert;

export function createSqliteContainerStore(
  options: SqliteContainerStoreOptions
): ContainerStore {
  const { scope } = options;
  if (scope.length === 0 || !storableText(scope) || scope.includes(UNIT)) {
    throw new RangeError(
      "scope must be a nonempty string with no U+0000, no U+001F and no lone surrogate"
    );
  }
  return storeOver(options);
}

function storeOver(
  options: SqliteContainerStoreOptions,
  fixedIdentity?: string
): ContainerStore {
  const { database, location, onCommit, scope } = options;
  const turns = new Turns(REENTRY);
  const inScope = eq(sandboxContainers.scope, scope);
  const identityRow = and(
    eq(sandboxContainers.scope, identityScope(scope)),
    eq(sandboxContainers.id, IDENTITY_ID)
  );
  let known = fixedIdentity;

  const identityOf = async (): Promise<string> => {
    if (known !== undefined) {
      return known;
    }
    await database
      .insert(sandboxContainers)
      .values({
        createdAt: 0,
        holder: null,
        id: IDENTITY_ID,
        nativeId: globalThis.crypto.randomUUID(),
        position: 0,
        scope: identityScope(scope),
        spec: "{}",
        status: "stopped",
        updatedAt: 0,
      })
      .onConflictDoNothing();
    const [row] = await database
      .select({ nativeId: sandboxContainers.nativeId })
      .from(sandboxContainers)
      .where(identityRow);
    if (typeof row?.nativeId !== "string" || row.nativeId === "") {
      throw new Error("the container store's identity could not be read");
    }
    known =
      location === undefined
        ? row.nativeId
        : await digest(`${row.nativeId}\u0000${location}`);
    return known;
  };

  const put = async (
    transaction: ContainerTransaction,
    rows: readonly ContainerRow[]
  ): Promise<void> => {
    const columns = Object.keys(getTableColumns(sandboxContainers)).length;
    const [last] = await transaction
      .select({ position: max(sandboxContainers.position) })
      .from(sandboxContainers)
      .where(inScope);
    const first = (last?.position ?? 0) + 1;
    const stored = rows.map(
      (row, index): StoredRow => ({
        ...row,
        holder: row.holder ?? null,
        nativeId: row.nativeId ?? null,
        position: first + index,
        scope,
      })
    );
    await inOrder(batches(stored, MAX_PARAMETERS / columns), (batch) =>
      transaction
        .insert(sandboxContainers)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceRow,
          target: [sandboxContainers.scope, sandboxContainers.id],
        })
    );
  };

  const remove = async (
    transaction: ContainerTransaction,
    ids: readonly string[]
  ): Promise<void> => {
    await inOrder(batches(ids, MAX_PARAMETERS - 1), (batch) =>
      transaction
        .delete(sandboxContainers)
        .where(and(inScope, inArray(sandboxContainers.id, batch)))
    );
  };

  return {
    commit: (write) => {
      let owned: ContainerStoreWrite;
      try {
        owned = ownedWrite(write);
      } catch (error: unknown) {
        return Promise.reject(error);
      }
      return turns.run(() => {
        const field = unstorableField(owned);
        if (field !== undefined) {
          return Promise.reject(new RangeError(`${CANNOT_STORE} ${field}`));
        }
        const deletes = (owned.deleteContainers ?? []).filter(storableText);
        const puts = owned.putContainers ?? [];
        return database.transaction(async (transaction) => {
          await remove(transaction, deletes);
          await put(transaction, puts);
          await onCommit?.(transaction, owned);
        });
      });
    },

    get: (id) =>
      turns.run(async () => {
        if (!storableText(id)) {
          return;
        }
        const [row] = await database
          .select(rowColumns)
          .from(sandboxContainers)
          .where(and(inScope, eq(sandboxContainers.id, id)));
        return row === undefined ? undefined : containerRow(row);
      }),

    identity: () => turns.run(identityOf),

    list: () =>
      turns.run(async () => {
        const rows = await database
          .select(rowColumns)
          .from(sandboxContainers)
          .where(inScope)
          .orderBy(sandboxContainers.position);
        return Object.freeze(rows.map(containerRow));
      }),

    transaction: (work) =>
      turns.run(async () => {
        const identity = await identityOf();
        return await database.transaction((transaction) =>
          work(
            storeOver(
              {
                database: transaction,
                scope,
                ...(onCommit === undefined ? {} : { onCommit }),
              },
              identity
            )
          )
        );
      }),
  };
}

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text)
    )
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const UNIT = "\u001f";

const IDENTITY_ID = "identity";

function identityScope(scope: string): string {
  return `${scope}${UNIT}store`;
}

function containerRow(
  row: Omit<typeof sandboxContainers.$inferSelect, "position" | "scope">
): ContainerRow {
  const { holder, ...rest } = row;
  return Object.freeze({
    ...rest,
    ...(holder === null ? {} : { holder }),
    nativeId: row.nativeId ?? undefined,
  });
}

const TEXT_FIELDS = ["holder", "id", "nativeId", "spec", "status"] as const;

const NUMBER_FIELDS = ["createdAt", "updatedAt"] as const;

function storableText(text: string): boolean {
  return text.isWellFormed() && !text.includes("\u0000");
}

function storableNumber(value: number): boolean {
  return !Object.is(value, -0) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function unstorableField(write: ContainerStoreWrite): string | undefined {
  for (const [index, row] of (write.putContainers ?? []).entries()) {
    const path = `putContainers[${index}]`;
    const text = TEXT_FIELDS.find((name) => {
      const value = row[name];
      return typeof value === "string" && !storableText(value);
    });
    if (text !== undefined) {
      return `${path}.${text}: text holding U+0000 or a lone surrogate (not well-formed UTF-16) does not read back intact from SQLite`;
    }
    const number = NUMBER_FIELDS.find((name) => !storableNumber(row[name]));
    if (number !== undefined) {
      return `${path}.${number}: ${describeNumber(row[number])} does not read back intact from SQLite; a timestamp must be a number within ±Number.MAX_SAFE_INTEGER, and not -0`;
    }
  }
}

function describeNumber(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

const MAX_PARAMETERS = 32_766;

function batches<T>(items: readonly T[], size: number): T[][] {
  const length = Math.max(1, Math.floor(size));
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += length) {
    result.push(items.slice(start, start + length));
  }
  return result;
}

async function inOrder<T>(
  items: readonly T[],
  run: (item: T) => PromiseLike<unknown>
): Promise<void> {
  for (const item of items) {
    await run(item);
  }
}

function excluded(column: SQLiteColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}
