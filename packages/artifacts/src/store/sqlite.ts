import {
  type AsyncSQLiteDatabase,
  type AsyncSQLiteTransaction,
  assertScope,
  batches,
  replacing,
  SQLITE_MAX_PARAMETERS,
  storable,
  whyUnstorable,
} from "@foundry/lib/sqlite";
import { Turns } from "@foundry/lib/turns";
import type { SQL } from "drizzle-orm";
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
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
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
import { ownedWrite } from "./owned";
import {
  artifactBlobChunks,
  artifactBlobs,
  artifactContentBlobs,
  artifactContents,
  artifacts,
} from "./tables";

export type ArtifactDatabase = AsyncSQLiteDatabase;

export type ArtifactDatabaseTransaction = AsyncSQLiteTransaction;

export interface SqliteArtifactStoreOptions {
  readonly database: ArtifactDatabase;
  readonly durability?: ArtifactStoreDurability;
  readonly onCommit?: (
    transaction: ArtifactDatabaseTransaction,
    write: ArtifactStoreWrite
  ) => Promise<void>;
  readonly scope: string;
}

type ContentRow = typeof artifactContents.$inferSelect;
type BlobRow = typeof artifactBlobs.$inferSelect;

const {
  idLower: _idLower,
  idOrder: _idOrder,
  nameLower: _nameLower,
  scope: _artifactScope,
  textUnits: _textUnits,
  typeLower: _typeLower,
  ...artifactColumns
} = getTableColumns(artifacts);

const { scope: _contentScope, ...contentColumns } =
  getTableColumns(artifactContents);

const { scope: _blobScope, ...blobColumns } = getTableColumns(artifactBlobs);

const replaceArtifact = replacing(getTableColumns(artifacts), [
  artifacts.scope,
  artifacts.id,
]);
const replaceContent = replacing(getTableColumns(artifactContents), [
  artifactContents.scope,
  artifactContents.id,
]);
const replaceBlob = replacing(getTableColumns(artifactBlobs), [
  artifactBlobs.scope,
  artifactBlobs.id,
]);

const REENTRY =
  "SqliteArtifactStore was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

const SETTLED = "Artifact store transaction has settled";

export class SqliteArtifactStore implements ArtifactStore {
  readonly durability: ArtifactStoreDurability;
  readonly #database: ArtifactDatabase;
  readonly #scope: string;
  readonly #onCommit: SqliteArtifactStoreOptions["onCommit"];
  readonly #turns = new Turns(REENTRY);
  // biome-ignore lint/style/useReadonlyClassProperties: `transaction` sets it on the view it makes.
  #open: { value: boolean } | undefined;

  constructor(options: SqliteArtifactStoreOptions) {
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

  commit(write: ArtifactStoreWrite): Promise<void> {
    let owned: ArtifactStoreWrite;
    try {
      owned = ownedWrite(write);
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
          await view.#turns.run(() => Promise.resolve());
        }
      })
    );
  }

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

  listArtifacts(query: ArtifactListQuery): Promise<ArtifactListing> {
    let owned: ArtifactListQuery;
    try {
      owned = ownedListQuery(query);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#listArtifacts(owned);
  }

  #listArtifacts(query: ArtifactListQuery): Promise<ArtifactListing> {
    return this.#run(() => {
      const needle = query.text?.toLowerCase();
      if (
        (query.type !== undefined && !storable(query.type)) ||
        needle?.includes("\u0000")
      ) {
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

  #run<T>(operation: () => Promise<T>): Promise<T> {
    return this.#turns.run(() =>
      this.#open?.value === false
        ? Promise.reject(new Error(SETTLED))
        : operation()
    );
  }

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

    for (const batch of batches(rows.artifacts, perStatement(artifacts))) {
      await transaction
        .insert(artifacts)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceArtifact,
          target: [artifacts.scope, artifacts.id],
        });
    }
    for (const batch of batches(
      rows.contents,
      perStatement(artifactContents)
    )) {
      await transaction
        .insert(artifactContents)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceContent,
          target: [artifactContents.scope, artifactContents.id],
        });
    }
    for (const batch of batches(rows.blobs, perStatement(artifactBlobs))) {
      await transaction
        .insert(artifactBlobs)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceBlob,
          target: [artifactBlobs.scope, artifactBlobs.id],
        });
    }
    for (const batch of batches(
      rows.contentBlobs,
      perStatement(artifactContentBlobs)
    )) {
      await transaction
        .insert(artifactContentBlobs)
        .values(batch)
        .onConflictDoNothing();
    }
    for (const batch of batches(
      rows.blobChunks,
      perStatement(artifactBlobChunks)
    )) {
      await transaction
        .insert(artifactBlobChunks)
        .values(batch)
        .onConflictDoNothing();
    }
  }
}

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

function treeBlobIds(content: Content): BlobId[] {
  return Object.values(content.tree).flatMap((node) =>
    node.type === "file" ? [node.blobId] : []
  );
}

function lastById<T extends { readonly id: string }>(
  records: readonly T[]
): T[] {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

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
    return { ...common, bytes: new Uint8Array(row.bytes) };
  }
  return row.path === null
    ? { ...common, chunks: row.chunks as readonly BlobId[] }
    : { ...common, path: row.path };
}

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

function afterCursor(cursor: ArtifactCursor): SQL {
  const time = cursor.createdAt.getTime();
  const order = codeUnitOrder(cursor.id);
  return Number.isFinite(time)
    ? sql`(${artifacts.createdAt}, ${artifacts.idOrder}) > (${time}, ${order})`
    : sql`${artifacts.idOrder} > ${order}`;
}

function codeUnitText(text: string): string {
  let units = "";
  for (let index = 0; index < text.length; index += 1) {
    units += `${text.charCodeAt(index).toString(16).padStart(4, "0")},`;
  }
  return units;
}

function codeUnitOrder(id: string): Buffer {
  const bytes = Buffer.alloc(id.length * 2);
  for (let index = 0; index < id.length; index += 1) {
    bytes.writeUInt16BE(id.charCodeAt(index), index * 2);
  }
  return bytes;
}

interface Fault {
  readonly name: string;
  readonly reason: string;
}

type Put = readonly [
  field: string,
  value: unknown,
  kind: "integer" | "json" | "text" | "time",
];

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
    ...(blob.chunks ?? []).map(
      (id, index): Put => [`${at}.chunks[${index}]`, id, "text"]
    ),
  ];
}

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

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function member(key: string): string {
  return IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function perStatement(
  table:
    | typeof artifacts
    | typeof artifactContents
    | typeof artifactBlobs
    | typeof artifactContentBlobs
    | typeof artifactBlobChunks
): number {
  return SQLITE_MAX_PARAMETERS / Object.keys(getTableColumns(table)).length;
}

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
  for (const batch of batches(ids, SQLITE_MAX_PARAMETERS - 1)) {
    await transaction
      .delete(table)
      .where(and(eq(table.scope, scope), inArray(key, batch)));
  }
}
