import type { Page, PageInput } from "@foundry/core/pagination";
import { FILE_KINDS, type FileKind } from "@foundry/lib/file-classification";
import { buildPage, pageLimit } from "@foundry/lib/pagination";
import { Turns } from "@foundry/lib/turns";
import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import {
  and,
  asc,
  count,
  eq,
  getTableColumns,
  inArray,
  sql,
} from "drizzle-orm";
import type {
  BaseSQLiteDatabase,
  SQLiteColumn,
  SQLiteTransaction,
} from "drizzle-orm/sqlite-core";
import type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceId,
  WorkspaceRegistration,
} from "../schema";
import { ownedWrite } from "./events";
import type {
  WorkspaceSave,
  WorkspaceStore,
  WorkspaceStoreWrite,
} from "./index";
import { byPathThenId, pageInputOf, pageOffset } from "./order";
import { workspaceEntries, workspaces } from "./tables";

/**
 * An async Drizzle SQLite database, with or without a relational schema, or a
 * transaction on one. A `drizzle-orm/libsql` database and its transactions
 * both satisfy it, so a host can hand the store either.
 */
export type WorkspaceDatabase = BaseSQLiteDatabase<
  "async",
  unknown,
  Record<string, unknown>
>;

/** The transaction one `commit` runs in, as `onCommit` receives it. */
export type WorkspaceTransaction = SQLiteTransaction<
  "async",
  unknown,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export interface SqliteWorkspaceStoreOptions {
  /** Opened, migrated, and owned by the host; the store never closes it. */
  readonly database: WorkspaceDatabase;
  /**
   * Runs inside the commit's transaction after the store's own statements,
   * so the host can record the change atomically with it. A throw rolls the
   * whole commit back. It receives the store's own copy of the write, the
   * one its rows were made from, not the caller's object: a removal names
   * only the Workspace, not the entries it deleted, so a hook that records
   * what a removal dropped has no entry ids from this store.
   */
  readonly onCommit?: (
    transaction: WorkspaceTransaction,
    write: WorkspaceStoreWrite
  ) => Promise<void>;
  /** The partition this store reads and writes; any nonempty string. */
  readonly scope: string;
}

type WorkspaceRow = typeof workspaces.$inferSelect;
type EntryRow = typeof workspaceEntries.$inferSelect;

/** Every column of a registration row but `scope`. */
const { scope: _workspaceScope, ...workspaceColumns } =
  getTableColumns(workspaces);

/** Every column of an entry row but `scope`. */
const { scope: _entryScope, ...entryColumns } =
  getTableColumns(workspaceEntries);

/** On a conflicting put, every column but the key takes the incoming value. */
const replaceWorkspace = replacing(workspaceColumns, ["id"]);
const replaceEntry = replacing(entryColumns, ["id", "workspaceId"]);

/** Why a call from inside the store's own transaction or hook is refused. */
const REENTRY =
  "SqliteWorkspaceStore was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

/**
 * A `WorkspaceStore` over the host's SQLite database, in the tables from
 * `@foundry/workspaces/store/tables`. It behaves as `MemoryWorkspaceStore`
 * does, within its scope.
 *
 * Its calls take turns, as the memory store's do: a call made while a
 * transaction or commit runs waits for it. That keeps two catalogs over one
 * store apart in this process, and keeps a `:memory:` database, which has a
 * single connection, from refusing a call while a transaction holds it.
 * Across connections and processes, `transaction` takes the database's write
 * lock (see there).
 */
export class SqliteWorkspaceStore implements WorkspaceStore {
  readonly #database: WorkspaceDatabase;
  readonly #scope: string;
  readonly #onCommit: SqliteWorkspaceStoreOptions["onCommit"];
  readonly #turns = new Turns(REENTRY);

  constructor(options: SqliteWorkspaceStoreOptions) {
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
   * One database transaction. A save runs its entry deletes, its entry puts,
   * and the registration; a removal deletes every entry row of the Workspace
   * and its registration. Then `onCommit`. Rejects, before writing anything, a write
   * holding a value SQLite would not return intact (see
   * {@link unstorableField}). A delete of a key no row can hold does nothing.
   *
   * The store takes the write as it stands when `commit` is called, as the
   * memory store takes it (see `./events`), before the commit waits its
   * turn. That copy alone is checked, made into
   * every row, and handed to `onCommit`, so a caller changing its write
   * later changes nothing. A write the clone refuses rejects with the
   * clone's error, as in the memory store.
   */
  commit(write: WorkspaceStoreWrite): Promise<void> {
    let owned: WorkspaceStoreWrite;
    let unstorable: RangeError | undefined;
    try {
      owned = ownedWrite(write);
      unstorable = refuseUnstorable(owned);
    } catch (error) {
      return Promise.reject(error);
    }
    if (unstorable !== undefined) {
      return Promise.reject(unstorable);
    }
    return this.#turns.run(() =>
      this.#database.transaction(async (transaction) => {
        if (owned.workspace === undefined) {
          await this.#remove(transaction, owned.removeWorkspace);
        } else {
          await this.#save(transaction, owned);
        }
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
  transaction<T>(work: (view: WorkspaceStore) => Promise<T>): Promise<T> {
    return this.#turns.run(() =>
      this.#database.transaction((transaction) =>
        work(
          new SqliteWorkspaceStore({
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
  getWorkspace(
    workspaceId: WorkspaceId
  ): Promise<WorkspaceRegistration | null> {
    return this.#turns.run(async () => {
      if (!storable(workspaceId)) {
        return null;
      }
      const [row] = await this.#database
        .select(workspaceColumns)
        .from(workspaces)
        .where(
          and(eq(workspaces.scope, this.#scope), eq(workspaces.id, workspaceId))
        );
      return row ? registrationOf(row) : null;
    });
  }

  findWorkspaceByPath(path: string): Promise<WorkspaceRegistration | null> {
    return this.#oldest(path, workspaces.sourcePath);
  }

  findWorkspaceBySourceId(
    sourceId: string
  ): Promise<WorkspaceRegistration | null> {
    return this.#oldest(sourceId, workspaces.sourceId);
  }

  /**
   * One page and the total as of one moment: the two reads share one
   * database transaction, so no commit lands between them. On libSQL that
   * transaction begins `BEGIN IMMEDIATE`, as every Drizzle transaction there
   * does, so a list holds the write lock while it reads. Reads `input` when
   * called; see {@link pageInputOf}.
   */
  listWorkspaces(
    input?: PageInput<number>
  ): Promise<Page<WorkspaceRegistration, number>> {
    let query: PageInput<number>;
    try {
      query = pageInputOf(input);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(() => {
      const limit = pageLimit(query.limit);
      const offset = pageOffset(query.cursor);
      const inScope = eq(workspaces.scope, this.#scope);
      return this.#database.transaction(async (transaction) => {
        const [counted] = await transaction
          .select({ total: count() })
          .from(workspaces)
          .where(inScope);
        const rows = await transaction
          .select(workspaceColumns)
          .from(workspaces)
          .where(inScope)
          .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
          .limit(limit + 1)
          .offset(offset);
        return buildPage(
          rows,
          limit,
          offset,
          counted?.total ?? 0,
          registrationOf
        );
      });
    });
  }

  /** `null` for a key no row can hold (see {@link storable}). */
  getEntry(
    workspaceId: WorkspaceId,
    entryId: WorkspaceEntryId
  ): Promise<WorkspaceEntry | null> {
    return this.#turns.run(async () => {
      if (!(storable(workspaceId) && storable(entryId))) {
        return null;
      }
      const [row] = await this.#database
        .select(entryColumns)
        .from(workspaceEntries)
        .where(
          and(
            eq(workspaceEntries.scope, this.#scope),
            eq(workspaceEntries.workspaceId, workspaceId),
            eq(workspaceEntries.id, entryId)
          )
        );
      return row ? entryOf(this.#scope, row) : null;
    });
  }

  /** Sorted here: SQLite orders text by code point, not by code unit. */
  listEntries(workspaceId: WorkspaceId): Promise<readonly WorkspaceEntry[]> {
    return this.#turns.run(async () => {
      if (!storable(workspaceId)) {
        return [];
      }
      const rows = await this.#database
        .select(entryColumns)
        .from(workspaceEntries)
        .where(
          and(
            eq(workspaceEntries.scope, this.#scope),
            eq(workspaceEntries.workspaceId, workspaceId)
          )
        );
      return rows.map((row) => entryOf(this.#scope, row)).sort(byPathThenId);
    });
  }

  /** The first registration, in list order, whose `column` holds `value`. */
  #oldest(
    value: string,
    column: typeof workspaces.sourcePath | typeof workspaces.sourceId
  ): Promise<WorkspaceRegistration | null> {
    return this.#turns.run(async () => {
      if (!storable(value)) {
        return null;
      }
      const [row] = await this.#database
        .select(workspaceColumns)
        .from(workspaces)
        .where(and(eq(workspaces.scope, this.#scope), eq(column, value)))
        .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
        .limit(1);
      return row ? registrationOf(row) : null;
    });
  }

  /** The save's own id is storable: the pre-check refused it otherwise. */
  async #save(
    transaction: WorkspaceTransaction,
    write: WorkspaceSave
  ): Promise<void> {
    await this.#deleteEntries(
      transaction,
      write.workspace.id,
      (write.deleteEntries ?? []).filter(storable)
    );
    await this.#putEntries(transaction, write.putEntries ?? []);
    await this.#putWorkspace(transaction, write.workspace);
  }

  /** Every entry row of the Workspace, then its registration. */
  async #remove(
    transaction: WorkspaceTransaction,
    workspaceId: WorkspaceId
  ): Promise<void> {
    if (!storable(workspaceId)) {
      return;
    }
    await transaction
      .delete(workspaceEntries)
      .where(
        and(
          eq(workspaceEntries.scope, this.#scope),
          eq(workspaceEntries.workspaceId, workspaceId)
        )
      );
    await transaction
      .delete(workspaces)
      .where(
        and(eq(workspaces.scope, this.#scope), eq(workspaces.id, workspaceId))
      );
  }

  async #deleteEntries(
    transaction: WorkspaceTransaction,
    workspaceId: WorkspaceId,
    ids: readonly WorkspaceEntryId[]
  ): Promise<void> {
    // `scope` and `workspace_id` take two of the statement's parameters.
    await inOrder(batches(ids, MAX_PARAMETERS - 2), (batch) =>
      transaction
        .delete(workspaceEntries)
        .where(
          and(
            eq(workspaceEntries.scope, this.#scope),
            eq(workspaceEntries.workspaceId, workspaceId),
            inArray(workspaceEntries.id, batch)
          )
        )
    );
  }

  async #putEntries(
    transaction: WorkspaceTransaction,
    entries: readonly WorkspaceEntry[]
  ): Promise<void> {
    const rows = entries.map((entry) => rowOfEntry(this.#scope, entry));
    await inOrder(batches(rows, MAX_PARAMETERS / ENTRY_COLUMNS), (batch) =>
      transaction
        .insert(workspaceEntries)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceEntry,
          target: [
            workspaceEntries.scope,
            workspaceEntries.workspaceId,
            workspaceEntries.id,
          ],
        })
    );
  }

  async #putWorkspace(
    transaction: WorkspaceTransaction,
    workspace: WorkspaceRegistration
  ): Promise<void> {
    await transaction
      .insert(workspaces)
      .values(rowOfWorkspace(this.#scope, workspace))
      .onConflictDoUpdate({
        set: replaceWorkspace,
        target: [workspaces.scope, workspaces.id],
      });
  }
}

function registrationOf(
  row: Omit<WorkspaceRow, "scope">
): WorkspaceRegistration {
  return {
    createdAt: row.createdAt,
    id: row.id,
    lastReconciledAt: row.lastReconciledAt,
    name: row.name,
    source: {
      kind: row.sourceKind,
      path: row.sourcePath,
      sourceId: row.sourceId,
    },
    updatedAt: row.updatedAt,
  };
}

function rowOfWorkspace(
  scope: string,
  workspace: WorkspaceRegistration
): WorkspaceRow {
  return {
    createdAt: workspace.createdAt,
    id: workspace.id,
    lastReconciledAt: workspace.lastReconciledAt,
    name: workspace.name,
    scope,
    sourceId: workspace.source.sourceId,
    sourceKind: workspace.source.kind,
    sourcePath: workspace.source.path,
    updatedAt: workspace.updatedAt,
  };
}

/**
 * The columns each entry type keeps beyond the common ones, and which of
 * them a record of that type always has.
 */
const ENTRY_VARIANTS: Readonly<
  Record<
    WorkspaceEntry["type"],
    {
      readonly columns: readonly VariantColumn[];
      readonly required: readonly VariantColumn[];
    }
  >
> = {
  device: { columns: [], required: [] },
  directory: { columns: [], required: [] },
  file: {
    columns: ["bytes", "digest", "extension", "kind", "mime"],
    required: ["bytes", "digest", "kind"],
  },
  pipe: { columns: [], required: [] },
  socket: { columns: [], required: [] },
  symlink: { columns: ["target"], required: ["target"] },
};

type VariantColumn =
  | "bytes"
  | "digest"
  | "extension"
  | "kind"
  | "mime"
  | "target";

const VARIANT_COLUMNS: readonly VariantColumn[] = [
  "bytes",
  "digest",
  "extension",
  "kind",
  "mime",
  "target",
];

/**
 * The record a row holds: only the fields its `type` has. Rejects a row
 * this store would not have written, naming the scope, the Workspace, the
 * entry, and the column at fault: an unknown type, a column its type
 * always has left null, a column another type has filled, or a file kind
 * the package does not know.
 */
function entryOf(scope: string, row: Omit<EntryRow, "scope">): WorkspaceEntry {
  const variant = Object.hasOwn(ENTRY_VARIANTS, row.type)
    ? ENTRY_VARIANTS[row.type]
    : undefined;
  const fault =
    variant === undefined
      ? `column type holds ${JSON.stringify(row.type)}, which is no entry type`
      : variantFault(row, variant);
  if (fault !== undefined) {
    throw new Error(
      `SqliteWorkspaceStore cannot read entry ${JSON.stringify(row.id)} of Workspace ${JSON.stringify(row.workspaceId)} in scope ${JSON.stringify(scope)}: ${fault}`
    );
  }
  const common = {
    createdAt: row.createdAt,
    id: row.id,
    name: row.name,
    path: row.path,
    updatedAt: row.updatedAt,
    workspaceId: row.workspaceId,
  };
  // Checked by `variantFault`: each value its type requires is present.
  switch (row.type) {
    case "file":
      return {
        ...common,
        bytes: row.bytes as number,
        digest: row.digest as string,
        extension: row.extension,
        kind: row.kind as FileKind,
        mime: row.mime,
        type: row.type,
      };
    case "symlink":
      return { ...common, target: row.target as string, type: row.type };
    default:
      return { ...common, type: row.type };
  }
}

/** What is wrong with a row of a known type, if anything. */
function variantFault(
  row: Omit<EntryRow, "scope">,
  variant: (typeof ENTRY_VARIANTS)[WorkspaceEntry["type"]]
): string | undefined {
  const missing = variant.required.find((column) => row[column] === null);
  if (missing !== undefined) {
    return `column ${missing} is null on a ${row.type} row`;
  }
  const foreign = VARIANT_COLUMNS.find(
    (column) => !variant.columns.includes(column) && row[column] !== null
  );
  if (foreign !== undefined) {
    return `column ${foreign} holds a value on a ${row.type} row, which has none`;
  }
  if (row.kind !== null && !FILE_KINDS.includes(row.kind)) {
    return `column kind holds ${JSON.stringify(row.kind)}, which is no file kind`;
  }
}

/** Every column, with explicit nulls for those the entry's type lacks. */
function rowOfEntry(scope: string, entry: WorkspaceEntry): EntryRow {
  return {
    bytes: entry.type === "file" ? entry.bytes : null,
    createdAt: entry.createdAt,
    digest: entry.type === "file" ? entry.digest : null,
    extension: entry.type === "file" ? entry.extension : null,
    id: entry.id,
    kind: entry.type === "file" ? entry.kind : null,
    mime: entry.type === "file" ? entry.mime : null,
    name: entry.name,
    path: entry.path,
    scope,
    target: entry.type === "symlink" ? entry.target : null,
    type: entry.type,
    updatedAt: entry.updatedAt,
    workspaceId: entry.workspaceId,
  };
}

/**
 * Whether SQLite gives `text` back as it was bound. It does not when the text
 * holds U+0000 (libSQL reads it back cut at the NUL) or is not well-formed
 * UTF-16: a lone surrogate is bound as U+FFFD on Node and as nothing on Bun,
 * so it reads back changed, and a key holding one would match another key's
 * row.
 */
function storable(text: string): boolean {
  return text.isWellFormed() && !text.includes("\u0000");
}

const TEXT =
  "text holding U+0000 or a lone surrogate (not well-formed UTF-16) does not read back intact from SQLite";
const TIME =
  "a time that is not a valid Date has no epoch milliseconds to store";
const INTEGER =
  "SQLite keeps an integer column as a safe integer, and reads -0 back as 0";

/** One value a write puts, by its path in the write, and how it is stored. */
type Put = readonly [
  field: string,
  value: unknown,
  kind: "integer" | "text" | "time",
];

/**
 * The refusal for the first value the store's copy of a write puts that
 * SQLite would not give back intact, naming it by its path, such as
 * `putEntries[2].path`. A storage limit of this store, not a rule of the
 * domain. The copy was taken by `structuredClone`, so a field that throws
 * when read, or holds a function, has already rejected the write before
 * any statement runs. A value that fails only when bound (an object posing
 * as a `Date`, which the clone makes a plain object) fails inside the
 * commit's transaction, which rolls back.
 */
function refuseUnstorable(write: WorkspaceStoreWrite): RangeError | undefined {
  const field = unstorableField(write);
  return field === undefined
    ? undefined
    : new RangeError(
        `SqliteWorkspaceStore cannot store ${field.name}: ${field.reason}`
      );
}

function unstorableField(
  write: WorkspaceStoreWrite
): { readonly name: string; readonly reason: string } | undefined {
  const puts: Put[] = [
    ...(write.workspace === undefined
      ? []
      : registrationPuts("workspace", write.workspace)),
    ...(write.putEntries ?? []).flatMap((entry, index) =>
      entryPuts(`putEntries[${index}]`, entry)
    ),
  ];
  for (const [name, value, kind] of puts) {
    const reason = whyUnstorable(value, kind);
    if (reason !== undefined) {
      return { name, reason };
    }
  }
}

function whyUnstorable(value: unknown, kind: Put[2]): string | undefined {
  switch (kind) {
    case "text":
      return typeof value === "string" && !storable(value) ? TEXT : undefined;
    case "time":
      return value instanceof Date && !Number.isFinite(value.getTime())
        ? TIME
        : undefined;
    default:
      return typeof value === "number" &&
        (!Number.isSafeInteger(value) || Object.is(value, -0))
        ? INTEGER
        : undefined;
  }
}

function registrationPuts(at: string, workspace: WorkspaceRegistration): Put[] {
  return [
    [`${at}.id`, workspace.id, "text"],
    [`${at}.name`, workspace.name, "text"],
    [`${at}.source.kind`, workspace.source.kind, "text"],
    [`${at}.source.path`, workspace.source.path, "text"],
    [`${at}.source.sourceId`, workspace.source.sourceId, "text"],
    [`${at}.createdAt`, workspace.createdAt, "time"],
    [`${at}.updatedAt`, workspace.updatedAt, "time"],
    [`${at}.lastReconciledAt`, workspace.lastReconciledAt, "time"],
  ];
}

function entryPuts(at: string, entry: WorkspaceEntry): Put[] {
  const common: Put[] = [
    [`${at}.id`, entry.id, "text"],
    [`${at}.workspaceId`, entry.workspaceId, "text"],
    [`${at}.type`, entry.type, "text"],
    [`${at}.name`, entry.name, "text"],
    [`${at}.path`, entry.path, "text"],
    [`${at}.createdAt`, entry.createdAt, "time"],
    [`${at}.updatedAt`, entry.updatedAt, "time"],
  ];
  switch (entry.type) {
    case "file":
      return [
        ...common,
        [`${at}.bytes`, entry.bytes, "integer"],
        [`${at}.digest`, entry.digest, "text"],
        [`${at}.extension`, entry.extension, "text"],
        [`${at}.kind`, entry.kind, "text"],
        [`${at}.mime`, entry.mime, "text"],
      ];
    case "symlink":
      return [...common, [`${at}.target`, entry.target, "text"]];
    default:
      return common;
  }
}

/** SQLite's default limit on the parameters one statement binds. */
const MAX_PARAMETERS = 32_766;

/** The parameters one entry row binds in a multi-row insert. */
const ENTRY_COLUMNS = Object.keys(getTableColumns(workspaceEntries)).length;

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

/** `set` for an upsert: each column but `key` takes the proposed value. */
function replacing(
  columns: Record<string, SQLiteColumn>,
  key: readonly string[]
): Record<string, SQL> {
  return Object.fromEntries(
    Object.entries(columns)
      .filter(([field]) => !key.includes(field))
      .map(([field, column]) => [field, excluded(column)])
  );
}

/** The value an `INSERT` proposed for `column`, inside its `ON CONFLICT`. */
function excluded(column: SQLiteColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}
