import { Turns } from "@foundry/lib/turns";
import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import { and, eq, getTableColumns, inArray, max, sql } from "drizzle-orm";
import type {
  BaseSQLiteDatabase,
  SQLiteColumn,
  SQLiteTransaction,
} from "drizzle-orm/sqlite-core";

import type { ContainerRow } from "../schema";
import type { ContainerStore, ContainerStoreWrite } from "./index";
import { sandboxContainers } from "./tables";

/**
 * An async Drizzle SQLite database, with or without a relational schema, or a
 * transaction on one. A `drizzle-orm/libsql` database and its transactions
 * both satisfy it, so a host can hand the store either.
 */
export type ContainerDatabase = BaseSQLiteDatabase<
  "async",
  unknown,
  Record<string, unknown>
>;

/** The transaction one `commit` runs in, as `onCommit` receives it. */
export type ContainerTransaction = SQLiteTransaction<
  "async",
  unknown,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export interface SqliteContainerStoreOptions {
  /** Opened, migrated, and owned by the host; the store never closes it. */
  readonly database: ContainerDatabase;
  /**
   * Runs inside the commit's transaction after the store's own statements,
   * so the host can record the change atomically with it. A throw rolls the
   * whole commit back. It receives the store's own copy of the write, the
   * one its rows were made from, not the caller's object.
   */
  readonly onCommit?: (
    transaction: ContainerTransaction,
    write: ContainerStoreWrite
  ) => Promise<void>;
  /** The partition this store reads and writes; any nonempty string. */
  readonly scope: string;
}

/** Every column of a container row but `scope` and `position`. */
const {
  position: _position,
  scope: _scope,
  ...rowColumns
} = getTableColumns(sandboxContainers);

/**
 * On a conflicting put, every row column takes the incoming value except
 * `position`, so a row put again keeps its place.
 */
const replaceRow = Object.fromEntries(
  Object.entries(rowColumns).map(([key, column]) => [key, excluded(column)])
);

/** Why a call from inside the store's own transaction or hook is refused. */
const REENTRY =
  "The SQLite container store was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

/** What every refusal to store a field begins with. */
const CANNOT_STORE = "The SQLite container store cannot store";

type StoredRow = typeof sandboxContainers.$inferInsert;

/**
 * A `ContainerStore` over the host's SQLite database, in the table from
 * `@foundry/sandbox/store/tables`. It behaves as the memory store does,
 * within its scope: reads hand out frozen copies and list rows in the order
 * first put.
 *
 * Its calls take turns, as the memory store's do: a call made while a
 * transaction or commit runs waits for it, and one made from inside them is
 * refused. That keeps two registries over one store apart in this process,
 * and keeps a `:memory:` database, which has a single connection, from
 * refusing a call while a transaction holds it. Across connections and
 * processes, `transaction` takes the database's write lock (see there).
 *
 * A storage limit, not a rule of the package: it refuses, before writing
 * anything and naming the field, a write whose rows SQLite would not give
 * back intact; see {@link unstorableField}.
 */
export function createSqliteContainerStore(
  options: SqliteContainerStoreOptions
): ContainerStore {
  const { database, onCommit, scope } = options;
  if (scope.length === 0 || !storableText(scope)) {
    throw new RangeError(
      "scope must be a nonempty string with no U+0000 and no lone surrogate"
    );
  }
  const turns = new Turns(REENTRY);
  const inScope = eq(sandboxContainers.scope, scope);

  /** A new row takes the next position; one put again keeps its own. */
  const put = async (
    transaction: ContainerTransaction,
    rows: readonly ContainerRow[]
  ): Promise<void> => {
    const columns = Object.keys(getTableColumns(sandboxContainers)).length;
    const [last] = await transaction
      .select({ position: max(sandboxContainers.position) })
      .from(sandboxContainers)
      .where(inScope);
    // A row that turns out to exist keeps its own position and leaves a gap;
    // only the order of positions matters.
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
    /**
     * Takes the write as it stands when `commit` is called: one
     * `structuredClone` of the whole write, as the memory store takes it,
     * made before the commit waits its turn. That copy alone is checked,
     * made into every row, and handed to `onCommit`, so a caller changing
     * its write later changes nothing. A write the clone refuses rejects
     * with the clone's error, as in the memory store. A delete of an id no
     * row can hold does nothing.
     */
    commit: (write) => {
      let owned: ContainerStoreWrite;
      try {
        owned = structuredClone(write);
      } catch (error: unknown) {
        return Promise.reject(error);
      }
      return turns.run(() => {
        // The copy is checked whole before any statement, so a write that
        // cannot be stored is refused whole.
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

    /** `undefined` for an id no row can hold. */
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

    /** One query, so one state; no transaction needed. */
    list: () =>
      turns.run(async () => {
        const rows = await database
          .select(rowColumns)
          .from(sandboxContainers)
          .where(inScope)
          .orderBy(sandboxContainers.position);
        return Object.freeze(rows.map(containerRow));
      }),

    /**
     * Runs `work` inside one database transaction, over a view whose reads
     * and commits use it; a throw from `work` rolls everything back, and a
     * failed commit through the view rolls back only itself (a savepoint).
     * In this process, the store's other calls wait for it. Across
     * connections, the transaction holds SQLite's write lock from its first
     * statement: Drizzle's libSQL driver opens every transaction with
     * libSQL's default mode, `BEGIN IMMEDIATE`. Another connection's write
     * then waits for it, for as long as that connection's busy timeout
     * allows, or fails with `SQLITE_BUSY`; it never lands between `work`'s
     * reads and its commit.
     */
    transaction: (work) =>
      turns.run(() =>
        database.transaction((transaction) =>
          work(
            createSqliteContainerStore({
              database: transaction,
              scope,
              ...(onCommit === undefined ? {} : { onCommit }),
            })
          )
        )
      ),
  };
}

/** A stored row as the record: a NULL `native_id` or `holder` is `undefined`, and left out. */
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

/** The row fields kept as plain text; each is checked by {@link storableText}. */
const TEXT_FIELDS = ["holder", "id", "nativeId", "spec", "status"] as const;

/** The row fields kept as integers; each is checked by {@link storableNumber}. */
const NUMBER_FIELDS = ["createdAt", "updatedAt"] as const;

/**
 * Whether SQLite gives `text` back as it was bound. It does not when the text
 * holds U+0000 (libSQL reads it back cut at the NUL) or is not well-formed
 * UTF-16: a lone surrogate is bound as U+FFFD on Node and as nothing on Bun,
 * so it reads back changed, and a key holding one would match another key's
 * row.
 */
function storableText(text: string): boolean {
  return text.isWellFormed() && !text.includes("\u0000");
}

/**
 * Whether SQLite gives `value` back as it was bound. The schema accepts any
 * number; SQLite does not keep these:
 *
 * - NaN and the infinities: libSQL refuses to bind them.
 * - `-0`: it reads back as `0`.
 * - An integer beyond `Number.MAX_SAFE_INTEGER` either way: an integer column
 *   keeps it as a 64-bit integer that libSQL then refuses to read, which
 *   would break every read of the scope. Integers too large even for that
 *   (1e20, say) would survive as REAL; they are refused too, for one simple
 *   bound.
 *
 * Every other number, whole or fractional, reads back exactly.
 */
function storableNumber(value: number): boolean {
  return !Object.is(value, -0) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

/**
 * The first field a write would put that SQLite would not give back intact,
 * as a path such as `putContainers[2].spec` with the reason. A storage limit
 * of this store, not a rule of the package.
 */
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
