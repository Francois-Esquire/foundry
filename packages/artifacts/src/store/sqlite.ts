import { Turns } from "@foundry/lib/turns";
import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import {
  and,
  asc,
  count,
  eq,
  getTableColumns,
  inArray,
  is,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { BaseSQLiteDatabase, SQLiteColumn } from "drizzle-orm/sqlite-core";
import { SQLiteTransaction } from "drizzle-orm/sqlite-core";

import type { ArtifactCursor } from "../listing";
import { ownedListQuery } from "../listing";
import type { ArtifactId, BlobId, ContentId } from "../ref";
import type { Artifact, Blob, Content } from "../schema";
import type {
  ArtifactListing,
  ArtifactListQuery,
  ArtifactStore,
  ArtifactStoreDurability,
  ArtifactStoreWrite,
  BlobListing,
  BlobReferences,
} from "./index";
import {
  artifactBlobChunks,
  artifactBlobs,
  artifactContentBlobs,
  artifactContents,
  artifacts,
} from "./tables";

/**
 * An async Drizzle SQLite database, with or without a relational schema, or a
 * transaction on one. A `drizzle-orm/libsql` database and its transactions
 * both satisfy it, so a host can hand the store either.
 */
export type ArtifactDatabase = BaseSQLiteDatabase<
  "async",
  unknown,
  Record<string, unknown>
>;

/**
 * The database transaction one `commit` runs in, as `onCommit` receives it.
 * (`ArtifactTransaction` names the package's own change transaction.)
 */
export type ArtifactDatabaseTransaction = SQLiteTransaction<
  "async",
  unknown,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export interface SqliteArtifactStoreOptions {
  /** Opened, migrated, and owned by the host; the store never closes it. */
  readonly database: ArtifactDatabase;
  /**
   * When a commit that resolved is there for good (see
   * `ArtifactStoreDurability`). A Drizzle transaction handed in as
   * `database` is one the host owns and may roll back, so the store is
   * `"host"` over it whatever this says, and refuses `"commit"`. Over a
   * plain database the default is `"commit"`; pass `"host"` when the host
   * has begun a transaction of its own on the connection (a raw `BEGIN`),
   * which the store cannot see.
   */
  readonly durability?: ArtifactStoreDurability;
  /**
   * Runs inside the commit's transaction after the store's own statements,
   * so the host can record the change atomically with it. A throw rolls the
   * whole commit back. It runs for every commit, a commit through a
   * transaction's view included; `ArtifactManager` makes no commit for a
   * change that writes nothing.
   *
   * It receives the store's own copy of the write, the one its rows were
   * made from, not the caller's object. That is all it can learn of the
   * change from this store: each record put, whole, as it now stands, and
   * only the id of each record deleted. It has no record as it stood
   * before (the rows are already replaced when it runs), and a deleted
   * Content or blob does not say which Artifact it belonged to. Deleting an
   * Artifact lists its Contents among the deletes, and a blob the change
   * stopped needing is a delete of its own.
   */
  readonly onCommit?: (
    transaction: ArtifactDatabaseTransaction,
    write: ArtifactStoreWrite
  ) => Promise<void>;
  /** The partition this store reads and writes; any nonempty string. */
  readonly scope: string;
}

type ContentRow = typeof artifactContents.$inferSelect;
type BlobRow = typeof artifactBlobs.$inferSelect;

/** Every column of an Artifact row that a record has: exactly an `Artifact`. */
const {
  idLower: _idLower,
  idOrder: _idOrder,
  nameLower: _nameLower,
  scope: _artifactScope,
  textUnits: _textUnits,
  typeLower: _typeLower,
  ...artifactColumns
} = getTableColumns(artifacts);

/** Every column of a Content row but `scope`: exactly a `Content`. */
const { scope: _contentScope, ...contentColumns } =
  getTableColumns(artifactContents);

/** Every column of a blob row but `scope`. */
const { scope: _blobScope, ...blobColumns } = getTableColumns(artifactBlobs);

/** On a conflicting put, every column but the key takes the incoming value. */
const replaceArtifact = replacing(getTableColumns(artifacts));
const replaceContent = replacing(getTableColumns(artifactContents));
const replaceBlob = replacing(getTableColumns(artifactBlobs));

/** Why a call from inside the store's own transaction or hook is refused. */
const REENTRY =
  "SqliteArtifactStore was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

/** Why a view used after its transaction is refused, as the other stores say. */
const SETTLED = "Artifact store transaction has settled";

/**
 * An `ArtifactStore` over the host's SQLite database, in the tables from
 * `@foundry/artifacts/store/tables`. It behaves as `InMemoryArtifactStore`
 * does, within its scope. Blob bytes it keeps are only those inline in a
 * blob record; a backing file is the package's, and the store keeps its
 * name.
 *
 * Its calls take turns, as the memory store's commits do: a call made while
 * a transaction or commit runs waits for it. That keeps two
 * `ArtifactManager`s over one store apart in this process, and keeps a
 * `:memory:` database, which has a single connection, from refusing a call
 * while a transaction holds it. Across connections and processes,
 * `transaction` takes the database's write lock (see there).
 */
export class SqliteArtifactStore implements ArtifactStore {
  readonly durability: ArtifactStoreDurability;
  readonly #database: ArtifactDatabase;
  readonly #scope: string;
  readonly #onCommit: SqliteArtifactStoreOptions["onCommit"];
  readonly #turns = new Turns(REENTRY);
  /** On a transaction's view, whether the transaction is still running. */
  // biome-ignore lint/style/useReadonlyClassProperties: `transaction` sets it on the view it makes.
  #open: { value: boolean } | undefined;

  constructor(options: SqliteArtifactStoreOptions) {
    if (options.scope.length === 0 || !storable(options.scope)) {
      throw new RangeError(
        "scope must be a nonempty string with no U+0000 and no lone surrogate"
      );
    }
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

  /**
   * One database transaction: the deletes, then the puts, then `onCommit`.
   *
   * The store takes the write as it stands when `commit` is called: one
   * `structuredClone` of the whole write, as the memory store takes it, and
   * that copy alone is checked, made into every row, and handed to
   * `onCommit`. Nothing the caller still holds is read again, so changing it
   * later changes nothing, and no getter or `toJSON` of the caller's runs
   * while the rows are encoded. A write the clone refuses (one holding a
   * function, say) rejects with the clone's error, as in the memory store.
   *
   * Rejects, before any statement runs, a write holding a value SQLite would
   * not give back intact (see {@link unstorableField}). A delete of a key no
   * row can hold does nothing.
   */
  commit(write: ArtifactStoreWrite): Promise<void> {
    let owned: ArtifactStoreWrite;
    try {
      owned = structuredClone(write);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#run(() => {
      let rows: WriteRows;
      try {
        rows = writeRows(this.#scope, owned);
      } catch (error) {
        return Promise.reject(error);
      }
      return this.#database.transaction(async (transaction) => {
        await this.#apply(transaction, rows);
        await this.#onCommit?.(transaction, owned);
      });
    });
  }

  /**
   * Runs `work` inside one database transaction, over a view whose reads
   * and commits use it; a throw from `work` rolls everything back. Each
   * commit through the view is a savepoint of its own, so one that fails
   * leaves the view's earlier commits standing. The view refuses calls once
   * `work` has settled. In this process, the store's other calls wait for
   * it. Across connections, the transaction holds SQLite's write lock from
   * its first statement: Drizzle's libSQL driver opens every transaction
   * with libSQL's default mode, `BEGIN IMMEDIATE`. Another connection's
   * write then waits for it, for as long as that connection's busy timeout
   * allows, or fails with `SQLITE_BUSY`; it never lands between `work`'s
   * reads and its commit.
   */
  transaction<T>(work: (view: ArtifactStore) => Promise<T>): Promise<T> {
    return this.#run(() =>
      this.#database.transaction(async (transaction) => {
        const view = new SqliteArtifactStore({
          database: transaction,
          scope: this.#scope,
          ...(this.#onCommit === undefined ? {} : { onCommit: this.#onCommit }),
        });
        const open = { value: true };
        view.#open = open;
        try {
          return await work(view);
        } finally {
          open.value = false;
          // A view call still running finishes before the transaction ends.
          await view.#turns.run(() => Promise.resolve());
        }
      })
    );
  }

  /** `null` for an id no row can hold (see {@link storable}). */
  getArtifact(id: ArtifactId): Promise<Artifact | null> {
    return this.#run(async () => {
      if (!storable(id)) {
        return null;
      }
      const [row] = await this.#database
        .select(artifactColumns)
        .from(artifacts)
        .where(and(eq(artifacts.scope, this.#scope), eq(artifacts.id, id)));
      return row ?? null;
    });
  }

  /** `null` for an id no row can hold (see {@link storable}). */
  getContent(id: ContentId): Promise<Content | null> {
    return this.#run(async () => {
      if (!storable(id)) {
        return null;
      }
      const [row] = await this.#database
        .select(contentColumns)
        .from(artifactContents)
        .where(
          and(
            eq(artifactContents.scope, this.#scope),
            eq(artifactContents.id, id)
          )
        );
      return row ?? null;
    });
  }

  /** `null` for an id no row can hold (see {@link storable}). */
  getBlob(id: BlobId): Promise<Blob | null> {
    return this.#run(async () => {
      if (!storable(id)) {
        return null;
      }
      const [row] = await this.#database
        .select(blobColumns)
        .from(artifactBlobs)
        .where(
          and(eq(artifactBlobs.scope, this.#scope), eq(artifactBlobs.id, id))
        );
      return row ? blobOf(this.#scope, row) : null;
    });
  }

  findBlobs(digest: string): Promise<readonly Blob[]> {
    return this.#run(async () => {
      if (!storable(digest)) {
        return [];
      }
      const rows = await this.#database
        .select(blobColumns)
        .from(artifactBlobs)
        .where(
          and(
            eq(artifactBlobs.scope, this.#scope),
            eq(artifactBlobs.digest, digest)
          )
        );
      return rows.map((row) => blobOf(this.#scope, row));
    });
  }

  /**
   * Both lookup tables as of one moment: the two reads share one database
   * transaction, which on libSQL holds the write lock while it reads.
   */
  findReferences(id: BlobId): Promise<BlobReferences> {
    return this.#run(() => {
      if (!storable(id)) {
        return Promise.resolve({ blobIds: [], contentIds: [] });
      }
      return this.#database.transaction(async (transaction) => {
        const contents = await transaction
          .select({ id: artifactContentBlobs.contentId })
          .from(artifactContentBlobs)
          .where(
            and(
              eq(artifactContentBlobs.scope, this.#scope),
              eq(artifactContentBlobs.blobId, id)
            )
          );
        const chunked = await transaction
          .select({ id: artifactBlobChunks.blobId })
          .from(artifactBlobChunks)
          .where(
            and(
              eq(artifactBlobChunks.scope, this.#scope),
              eq(artifactBlobChunks.chunkId, id)
            )
          );
        return {
          blobIds: chunked.map((row) => row.id),
          contentIds: contents.map((row) => row.id),
        };
      });
    });
  }

  /**
   * One page and the total as of one moment: the two reads share one
   * database transaction, which on libSQL holds the write lock while it
   * reads. Every filter is answered in SQL, as the memory store answers it
   * by `matchesArtifactFilter` and `isAfterCursor`, and `limit` bounds the
   * rows read; see {@link textMatch} and {@link afterCursor}. A `type` or
   * text no stored row can hold matches nothing, without a query. The query
   * is read as it stands at the call (see `ownedListQuery`), which refuses
   * a `limit` that is not a positive safe integer.
   */
  listArtifacts(query: ArtifactListQuery): Promise<ArtifactListing> {
    let owned: ArtifactListQuery;
    try {
      owned = ownedListQuery(query);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#listArtifacts(owned);
  }

  /** {@link listArtifacts} by the store's own copy of the query. */
  #listArtifacts(query: ArtifactListQuery): Promise<ArtifactListing> {
    return this.#run(() => {
      const needle = query.text?.toLowerCase();
      if (
        (query.type !== undefined && !storable(query.type)) ||
        needle?.includes("\u0000")
      ) {
        // Stored text holds no NUL, nor any type a row cannot hold.
        return Promise.resolve({ artifacts: [], total: 0 });
      }
      const matches = and(
        eq(artifacts.scope, this.#scope),
        query.includeArchived === true
          ? undefined
          : ne(artifacts.status, "archived"),
        query.type === undefined ? undefined : eq(artifacts.type, query.type),
        needle === undefined ? undefined : textMatch(needle)
      );
      return this.#database.transaction(async (transaction) => {
        const [counted] = await transaction
          .select({ total: count() })
          .from(artifacts)
          .where(matches);
        const page = await transaction
          .select(artifactColumns)
          .from(artifacts)
          .where(
            and(
              matches,
              query.after === undefined ? undefined : afterCursor(query.after)
            )
          )
          .orderBy(asc(artifacts.createdAt), asc(artifacts.idOrder))
          .limit(query.limit);
        return { artifacts: page, total: counted?.total ?? 0 };
      });
    });
  }

  /** One scope's run of the primary key, with no bytes read. */
  listBlobs(): Promise<readonly BlobListing[]> {
    return this.#run(async () => {
      const rows = await this.#database
        .select({ id: artifactBlobs.id, path: artifactBlobs.path })
        .from(artifactBlobs)
        .where(eq(artifactBlobs.scope, this.#scope));
      return rows.map((row) =>
        row.path === null ? { id: row.id } : { id: row.id, path: row.path }
      );
    });
  }

  /** `[]` for an Artifact id no row can hold (see {@link storable}). */
  listContents(artifactId?: ArtifactId): Promise<readonly Content[]> {
    return this.#run(() => {
      if (artifactId !== undefined && !storable(artifactId)) {
        return Promise.resolve([]);
      }
      return this.#database
        .select(contentColumns)
        .from(artifactContents)
        .where(
          and(
            eq(artifactContents.scope, this.#scope),
            artifactId === undefined
              ? undefined
              : eq(artifactContents.artifactId, artifactId)
          )
        );
    });
  }

  /** `operation` in this store's turn, refused on a view whose transaction settled. */
  #run<T>(operation: () => Promise<T>): Promise<T> {
    return this.#turns.run(() =>
      this.#open?.value === false
        ? Promise.reject(new Error(SETTLED))
        : operation()
    );
  }

  /**
   * The deletes, then the puts. A Content's or blob's lookup rows go with
   * it, and are written again for each one put.
   */
  async #apply(
    transaction: ArtifactDatabaseTransaction,
    rows: WriteRows
  ): Promise<void> {
    const scope = this.#scope;
    await deleteIn(
      transaction,
      artifacts,
      scope,
      artifacts.id,
      rows.deleteArtifacts
    );
    await deleteIn(
      transaction,
      artifactContentBlobs,
      scope,
      artifactContentBlobs.contentId,
      [...rows.deleteContents, ...rows.contents.map((row) => row.id)]
    );
    await deleteIn(
      transaction,
      artifactContents,
      scope,
      artifactContents.id,
      rows.deleteContents
    );
    await deleteIn(
      transaction,
      artifactBlobChunks,
      scope,
      artifactBlobChunks.blobId,
      [...rows.deleteBlobs, ...rows.blobs.map((row) => row.id)]
    );
    await deleteIn(
      transaction,
      artifactBlobs,
      scope,
      artifactBlobs.id,
      rows.deleteBlobs
    );

    await inOrder(batches(rows.artifacts, perStatement(artifacts)), (batch) =>
      transaction
        .insert(artifacts)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceArtifact,
          target: [artifacts.scope, artifacts.id],
        })
    );
    await inOrder(
      batches(rows.contents, perStatement(artifactContents)),
      (batch) =>
        transaction
          .insert(artifactContents)
          .values(batch)
          .onConflictDoUpdate({
            set: replaceContent,
            target: [artifactContents.scope, artifactContents.id],
          })
    );
    await inOrder(batches(rows.blobs, perStatement(artifactBlobs)), (batch) =>
      transaction
        .insert(artifactBlobs)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceBlob,
          target: [artifactBlobs.scope, artifactBlobs.id],
        })
    );
    await inOrder(
      batches(rows.contentBlobs, perStatement(artifactContentBlobs)),
      (batch) =>
        transaction
          .insert(artifactContentBlobs)
          .values(batch)
          .onConflictDoNothing()
    );
    await inOrder(
      batches(rows.blobChunks, perStatement(artifactBlobChunks)),
      (batch) =>
        transaction
          .insert(artifactBlobChunks)
          .values(batch)
          .onConflictDoNothing()
    );
  }
}

// ── Rows ──

/** What one write runs: the keys it deletes and every row it puts. */
interface WriteRows {
  readonly artifacts: (typeof artifacts.$inferInsert)[];
  readonly blobChunks: (typeof artifactBlobChunks.$inferInsert)[];
  readonly blobs: BlobRow[];
  readonly contentBlobs: (typeof artifactContentBlobs.$inferInsert)[];
  readonly contents: ContentRow[];
  readonly deleteArtifacts: readonly string[];
  readonly deleteBlobs: readonly string[];
  readonly deleteContents: readonly string[];
}

/**
 * The rows the store's own copy of a write runs, or a `RangeError` naming
 * the first value SQLite would not give back intact. The rows hold the
 * copy's values (its trees, chunks, metadata and dates), so they and the
 * lookup rows derived from them describe the same records. Deletes of keys
 * no row can hold are dropped. A record put twice in one list puts its last
 * value, as the memory store's maps do.
 */
function writeRows(scope: string, write: ArtifactStoreWrite): WriteRows {
  const fault = unstorableField(write);
  if (fault !== undefined) {
    throw new RangeError(
      `SqliteArtifactStore cannot store ${fault.name}: ${fault.reason}`
    );
  }
  const putArtifacts = lastById(write.putArtifacts ?? []);
  const putContents = lastById(write.putContents ?? []);
  const putBlobs = lastById(write.putBlobs ?? []);
  return {
    artifacts: putArtifacts.map((artifact) => ({
      archivedAt: artifact.archivedAt,
      contentId: artifact.contentId,
      createdAt: artifact.createdAt,
      id: artifact.id,
      idLower: artifact.id.toLowerCase(),
      idOrder: codeUnitOrder(artifact.id),
      metadata: artifact.metadata,
      name: artifact.name,
      nameLower: artifact.name.toLowerCase(),
      publishedAt: artifact.publishedAt,
      scope,
      status: artifact.status,
      textUnits: [artifact.name, artifact.type, artifact.id]
        .map((field) => codeUnitText(field.toLowerCase()))
        .join("|"),
      type: artifact.type,
      typeLower: artifact.type.toLowerCase(),
      updatedAt: artifact.updatedAt,
    })),
    blobChunks: putBlobs.flatMap((blob) =>
      [...new Set(blob.chunks ?? [])].map((chunkId) => ({
        blobId: blob.id,
        chunkId,
        scope,
      }))
    ),
    blobs: putBlobs.map((blob) => ({
      byteLength: blob.byteLength,
      bytes: blob.bytes === undefined ? null : Buffer.from(blob.bytes),
      chunks: blob.chunks ?? null,
      createdAt: blob.createdAt,
      digest: blob.digest,
      id: blob.id,
      path: blob.path ?? null,
      scope,
    })),
    contentBlobs: putContents.flatMap((content) =>
      [...new Set(treeBlobIds(content))].map((blobId) => ({
        blobId,
        contentId: content.id,
        scope,
      }))
    ),
    contents: putContents.map((content) => ({
      artifactId: content.artifactId,
      createdAt: content.createdAt,
      digest: content.digest,
      frozenAt: content.frozenAt,
      id: content.id,
      metadata: content.metadata,
      scope,
      state: content.state,
      tag: content.tag,
      tree: content.tree,
      updatedAt: content.updatedAt,
    })),
    deleteArtifacts: (write.deleteArtifacts ?? []).filter(storable),
    deleteBlobs: (write.deleteBlobs ?? []).filter(storable),
    deleteContents: (write.deleteContents ?? []).filter(storable),
  };
}

/** The blobs a Content's file entries name, once per file. */
function treeBlobIds(content: Content): BlobId[] {
  return Object.values(content.tree).flatMap((node) =>
    node.type === "file" ? [node.blobId] : []
  );
}

/** Each id's last record, so one put twice in a list is put once. */
function lastById<T extends { readonly id: string }>(
  records: readonly T[]
): T[] {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

/**
 * The record a blob row holds: only the source its bytes are in. Rejects a
 * row this store would not have written, naming the scope, the blob and
 * the columns at fault.
 */
function blobOf(scope: string, row: Omit<BlobRow, "scope">): Blob {
  const fault = blobRowFault(row);
  if (fault !== undefined) {
    throw new Error(
      `SqliteArtifactStore cannot read blob ${JSON.stringify(row.id)} in scope ${JSON.stringify(scope)}: ${fault}`
    );
  }
  const common = {
    byteLength: row.byteLength,
    createdAt: row.createdAt,
    digest: row.digest,
    id: row.id,
  };
  if (row.bytes !== null) {
    // A copy: a plain `Uint8Array`, detached from the driver's buffer.
    return { ...common, bytes: new Uint8Array(row.bytes) };
  }
  return row.path === null
    ? { ...common, chunks: row.chunks as readonly BlobId[] }
    : { ...common, path: row.path };
}

/** What is wrong with a blob row, if anything. */
function blobRowFault(row: Omit<BlobRow, "scope">): string | undefined {
  const filled = (["bytes", "path", "chunks"] as const).filter(
    (column) => row[column] !== null
  );
  if (filled.length === 0) {
    return "none of bytes, path and chunks holds a value";
  }
  if (filled.length > 1) {
    return `${filled.join(" and ")} each hold a value, and a blob has one source`;
  }
  if (row.chunks !== null && !Array.isArray(row.chunks)) {
    return "chunks holds no list";
  }
}

/**
 * Whether an Artifact's name, type or id, lower-cased, holds `needle`, a
 * lower-cased text with no NUL, as `matchesArtifactFilter` asks by code
 * unit. Text that is well-formed UTF-16 holds another as code units exactly
 * when it does as code points, so `instr` on the lower-cased columns
 * answers it. A needle holding a lone surrogate can match half of a stored
 * pair, which no text comparison in SQLite can see, so it is matched by
 * {@link codeUnitText} on `text_units` instead.
 */
function textMatch(needle: string): SQL | undefined {
  if (!needle.isWellFormed()) {
    return sql`instr(${artifacts.textUnits}, ${codeUnitText(needle)}) > 0`;
  }
  return or(
    sql`instr(${artifacts.nameLower}, ${needle}) > 0`,
    sql`instr(${artifacts.typeLower}, ${needle}) > 0`,
    sql`instr(${artifacts.idLower}, ${needle}) > 0`
  );
}

/**
 * The rows `isAfterCursor` keeps. It compares creation times, then ids by
 * code unit; with a cursor whose time is no valid `Date`, the time
 * difference is `NaN`, so it compares by id alone, which is `id_order`.
 */
function afterCursor(cursor: ArtifactCursor): SQL {
  const time = cursor.createdAt.getTime();
  const order = codeUnitOrder(cursor.id);
  return Number.isFinite(time)
    ? sql`(${artifacts.createdAt}, ${artifacts.idOrder}) > (${time}, ${order})`
    : sql`${artifacts.idOrder} > ${order}`;
}

/**
 * `text` as its UTF-16 code units, each four lower-case hex digits and a
 * comma. One such string holds another exactly where the texts hold each
 * other by code unit: every comma of the needle must meet a comma of the
 * text, so a match cannot start inside a unit.
 */
function codeUnitText(text: string): string {
  let units = "";
  for (let index = 0; index < text.length; index += 1) {
    units += `${text.charCodeAt(index).toString(16).padStart(4, "0")},`;
  }
  return units;
}

/**
 * `id` as its UTF-16 code units, two bytes each, high byte first. SQLite
 * compares blobs byte by byte, so these sort as JavaScript compares the
 * strings by code unit, which text in SQLite (by code point) does not.
 */
function codeUnitOrder(id: string): Buffer {
  const bytes = Buffer.alloc(id.length * 2);
  for (let index = 0; index < id.length; index += 1) {
    bytes.writeUInt16BE(id.charCodeAt(index), index * 2);
  }
  return bytes;
}

// ── What SQLite cannot store ──

/**
 * Whether SQLite gives `text` back as it was bound. It does not when the text
 * holds U+0000 (libSQL reads it back cut at the NUL) or is not well-formed
 * UTF-16: a lone surrogate is bound as U+FFFD on Node and as nothing on Bun,
 * so it reads back changed, and a key holding one would match another key's
 * row. JSON columns are exempt: JSON escapes both. A key that is no string
 * at all (`undefined` from a caller) is no key a row holds either, as no
 * memory store's map holds one.
 */
function storable(text: unknown): text is string {
  return (
    typeof text === "string" && text.isWellFormed() && !text.includes("\u0000")
  );
}

const TEXT =
  "text holding U+0000 or a lone surrogate (not well-formed UTF-16) does not read back intact from SQLite";
const TIME =
  "a time that is not a valid Date has no epoch milliseconds to store";
const INTEGER =
  "SQLite keeps an integer column as a safe integer, and reads -0 back as 0";

/** A value SQLite would not give back intact, by its path, and why. */
interface Fault {
  readonly name: string;
  readonly reason: string;
}

/** One value a write puts, by its path in the write, and how it is stored. */
type Put = readonly [
  field: string,
  value: unknown,
  kind: "integer" | "json" | "text" | "time",
];

/**
 * The first value a write puts that SQLite would not give back intact, by
 * its path in the write, such as `putContents[2].tag`, and why. A storage
 * limit of this store, not a rule of the package. Reading a field that
 * throws throws here, before any statement runs.
 */
function unstorableField(write: ArtifactStoreWrite): Fault | undefined {
  const puts: Put[] = [
    ...(write.putArtifacts ?? []).flatMap((artifact, index) =>
      artifactPuts(`putArtifacts[${index}]`, artifact)
    ),
    ...(write.putContents ?? []).flatMap((content, index) =>
      contentPuts(`putContents[${index}]`, content)
    ),
  ];
  for (const [index, blob] of (write.putBlobs ?? []).entries()) {
    const at = `putBlobs[${index}]`;
    const source = sourceFault(blob);
    if (source !== undefined) {
      return { name: at, reason: source };
    }
    puts.push(...blobPuts(at, blob));
  }
  for (const [name, value, kind] of puts) {
    const fault =
      kind === "json" ? jsonFault(value, name) : whyUnstorable(value, kind);
    if (fault !== undefined) {
      return typeof fault === "string" ? { name, reason: fault } : fault;
    }
  }
}

function whyUnstorable(
  value: unknown,
  kind: Exclude<Put[2], "json">
): string | undefined {
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

/**
 * Why a blob's sources cannot be stored as they are: a blob row holds
 * exactly one of `bytes`, `path` and `chunks`, and has no way to keep a
 * source key that is present but `undefined` (the memory store keeps one).
 */
function sourceFault(blob: Blob): string | undefined {
  const keys = (["bytes", "path", "chunks"] as const).filter((key) =>
    Object.hasOwn(blob, key)
  );
  const empty = keys.find((key) => blob[key] === undefined);
  if (empty !== undefined) {
    return `its ${empty} key holds undefined; a row keeps only the source a blob has, so the key would read back absent`;
  }
  if (keys.length !== 1) {
    return "a blob row holds exactly one of bytes, path and chunks";
  }
  if (blob.bytes !== undefined && !(blob.bytes instanceof Uint8Array)) {
    return "inline bytes must be a Uint8Array";
  }
}

function artifactPuts(at: string, artifact: Artifact): Put[] {
  return [
    [`${at}.id`, artifact.id, "text"],
    [`${at}.name`, artifact.name, "text"],
    [`${at}.type`, artifact.type, "text"],
    [`${at}.status`, artifact.status, "text"],
    [`${at}.contentId`, artifact.contentId, "text"],
    [`${at}.createdAt`, artifact.createdAt, "time"],
    [`${at}.updatedAt`, artifact.updatedAt, "time"],
    [`${at}.archivedAt`, artifact.archivedAt, "time"],
    [`${at}.publishedAt`, artifact.publishedAt, "time"],
    [`${at}.metadata`, artifact.metadata, "json"],
  ];
}

function contentPuts(at: string, content: Content): Put[] {
  return [
    [`${at}.id`, content.id, "text"],
    [`${at}.artifactId`, content.artifactId, "text"],
    [`${at}.digest`, content.digest, "text"],
    [`${at}.state`, content.state, "text"],
    [`${at}.tag`, content.tag, "text"],
    [`${at}.createdAt`, content.createdAt, "time"],
    [`${at}.updatedAt`, content.updatedAt, "time"],
    [`${at}.frozenAt`, content.frozenAt, "time"],
    [`${at}.metadata`, content.metadata, "json"],
    [`${at}.tree`, content.tree, "json"],
    // Each blob a file names is also a key of the lookup table.
    ...Object.entries(content.tree).flatMap(([path, node]): Put[] =>
      node.type === "file"
        ? [[`${at}.tree[${JSON.stringify(path)}].blobId`, node.blobId, "text"]]
        : []
    ),
  ];
}

function blobPuts(at: string, blob: Blob): Put[] {
  return [
    [`${at}.id`, blob.id, "text"],
    [`${at}.digest`, blob.digest, "text"],
    [`${at}.path`, blob.path, "text"],
    [`${at}.byteLength`, blob.byteLength, "integer"],
    [`${at}.createdAt`, blob.createdAt, "time"],
    [`${at}.chunks`, blob.chunks, "json"],
    // Each chunk is also a key of the lookup table.
    ...(blob.chunks ?? []).map(
      (id, index): Put => [`${at}.chunks[${index}]`, id, "text"]
    ),
  ];
}

/**
 * The first value inside a JSON column that `JSON.stringify` and
 * `JSON.parse` would not give back as the memory store's `structuredClone`
 * does, by its path, and why: `-0` (read back as 0), a number that is not
 * finite (stored as `null`), `undefined`, a function, a symbol or a bigint
 * (dropped, or refused by `JSON.stringify`), an array hole or an array's
 * own named key, an object that is not plain (a `Date` would become a
 * string), or a cycle. Strings are exempt: JSON escapes U+0000 and lone
 * surrogates. An absent column (`undefined` at the top) has nothing to check.
 */
function jsonFault(
  value: unknown,
  at: string,
  ancestors: Set<object> = new Set()
): Fault | undefined {
  if (value === undefined && ancestors.size === 0) {
    return;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (Object.is(value, -0)) {
        return jsonValueFault(at, "-0");
      }
      return Number.isFinite(value)
        ? undefined
        : jsonValueFault(at, String(value));
    case "object":
      return value === null ? undefined : jsonObjectFault(value, at, ancestors);
    default:
      return jsonValueFault(at, `a value of type ${typeof value}`);
  }
}

/** {@link jsonFault} for an array or an object, and what it holds. */
function jsonObjectFault(
  value: object,
  at: string,
  ancestors: Set<object>
): Fault | undefined {
  if (ancestors.has(value)) {
    return jsonValueFault(at, "a circular reference");
  }
  let entries: [string, unknown][];
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    if (Object.keys(items).length !== items.length) {
      return jsonValueFault(at, "an array with holes or named keys");
    }
    entries = items.map((item, index) => [`${at}[${index}]`, item]);
  } else {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return jsonValueFault(at, "an object that is not plain");
    }
    entries = Object.entries(value).map(([key, entry]) => [
      `${at}${member(key)}`,
      entry,
    ]);
  }
  ancestors.add(value);
  try {
    for (const [path, entry] of entries) {
      const inner = jsonFault(entry, path, ancestors);
      if (inner !== undefined) {
        return inner;
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

function jsonValueFault(at: string, what: string): Fault {
  return {
    name: at,
    reason: `${what}, which JSON does not give back as written`,
  };
}

/** A key that can follow a path as `.key`. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** A key as a path step: `.name`, or `["any key"]`. */
function member(key: string): string {
  return IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

// ── Statements ──

/** SQLite's default limit on the parameters one statement binds. */
const MAX_PARAMETERS = 32_766;

/** The rows of `table` one multi-row insert can bind. */
function perStatement(
  table:
    | typeof artifacts
    | typeof artifactContents
    | typeof artifactBlobs
    | typeof artifactContentBlobs
    | typeof artifactBlobChunks
): number {
  return MAX_PARAMETERS / Object.keys(getTableColumns(table)).length;
}

/** Deletes the scope's rows of `table` whose `key` is one of `ids`. */
async function deleteIn(
  transaction: ArtifactDatabaseTransaction,
  table:
    | typeof artifacts
    | typeof artifactContents
    | typeof artifactBlobs
    | typeof artifactContentBlobs
    | typeof artifactBlobChunks,
  scope: string,
  key: SQLiteColumn,
  ids: readonly string[]
): Promise<void> {
  // `scope` takes one of the statement's parameters.
  await inOrder(batches(ids, MAX_PARAMETERS - 1), (batch) =>
    transaction
      .delete(table)
      .where(and(eq(table.scope, scope), inArray(key, batch)))
  );
}

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

/** `set` for an upsert: each column but the key takes the proposed value. */
function replacing(columns: Record<string, SQLiteColumn>): Record<string, SQL> {
  return Object.fromEntries(
    Object.entries(columns)
      .filter(([field]) => field !== "scope" && field !== "id")
      .map(([field, column]) => [field, excluded(column)])
  );
}

/** The value an `INSERT` proposed for `column`, inside its `ON CONFLICT`. */
function excluded(column: SQLiteColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}
