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

export type WorkspaceDatabase = BaseSQLiteDatabase<
  "async",
  unknown,
  Record<string, unknown>
>;

export type WorkspaceTransaction = SQLiteTransaction<
  "async",
  unknown,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export interface SqliteWorkspaceStoreOptions {
  readonly database: WorkspaceDatabase;
  readonly onCommit?: (
    transaction: WorkspaceTransaction,
    write: WorkspaceStoreWrite
  ) => Promise<void>;
  readonly scope: string;
}

type WorkspaceRow = typeof workspaces.$inferSelect;
type EntryRow = typeof workspaceEntries.$inferSelect;

const { scope: _workspaceScope, ...workspaceColumns } =
  getTableColumns(workspaces);

const { scope: _entryScope, ...entryColumns } =
  getTableColumns(workspaceEntries);

const replaceWorkspace = replacing(workspaceColumns, ["id"]);
const replaceEntry = replacing(entryColumns, ["id", "workspaceId"]);

const REENTRY =
  "SqliteWorkspaceStore was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

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

function storable(text: string): boolean {
  return text.isWellFormed() && !text.includes("\u0000");
}

const TEXT =
  "text holding U+0000 or a lone surrogate (not well-formed UTF-16) does not read back intact from SQLite";
const TIME =
  "a time that is not a valid Date has no epoch milliseconds to store";
const INTEGER =
  "SQLite keeps an integer column as a safe integer, and reads -0 back as 0";

type Put = readonly [
  field: string,
  value: unknown,
  kind: "integer" | "text" | "time",
];

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

const MAX_PARAMETERS = 32_766;

const ENTRY_COLUMNS = Object.keys(getTableColumns(workspaceEntries)).length;

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

function excluded(column: SQLiteColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}
