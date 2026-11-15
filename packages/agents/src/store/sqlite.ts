import { Turns } from "@foundry/lib/turns";
import type { ExtractTablesWithRelations, SQL } from "drizzle-orm";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type {
  BaseSQLiteDatabase,
  SQLiteColumn,
  SQLiteTransaction,
} from "drizzle-orm/sqlite-core";

import type { SessionMessage, SessionRecord } from "../schema";
import type { SessionStore, SessionStoreWrite } from "./index";
import { messageOf, sessionOf } from "./sqlite-decode";
import { storable } from "./sqlite-records";
import type { SessionRow, UnplacedMessageRow } from "./sqlite-rows";
import { captured, owned } from "./sqlite-rows";
import { agentMessages, agentSessions } from "./tables";

/**
 * An async Drizzle SQLite database, with or without a relational schema, or a
 * transaction on one. A `drizzle-orm/libsql` database and its transactions
 * both satisfy it, so a host can hand the store either.
 */
export type SessionDatabase = BaseSQLiteDatabase<
  "async",
  unknown,
  Record<string, unknown>
>;

/** How many messages a session holds, and whether one of them is a summary. */
export interface MessageTally {
  readonly messages: number;
  readonly summarized: boolean;
}

/** The transaction one `commit` runs in, as `onCommit` receives it. */
export type SessionTransaction = SQLiteTransaction<
  "async",
  unknown,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

export interface SqliteSessionStoreOptions {
  /** Opened, migrated, and owned by the host; the store never closes it. */
  readonly database: SessionDatabase;
  /**
   * Runs inside the commit's transaction after the store's own statements,
   * so the host can record the change atomically with it. A throw rolls the
   * whole commit back. It receives the store's own copy of the write, taken
   * when `commit` was called: exactly what the store wrote, every session
   * and message put, whole, in the write's order. It does not say which put
   * filed a record and which replaced one, what a replaced record held, or
   * which session a moved message left; the store has already written when
   * the hook runs, so that is gone.
   */
  readonly onCommit?: (
    transaction: SessionTransaction,
    write: SessionStoreWrite
  ) => Promise<void>;
  /** The partition this store reads and writes; any nonempty string. */
  readonly scope: string;
}

/**
 * The copy of `write` a `SqliteSessionStore` takes when `commit` is called:
 * each record read once, now, and checked by the rules `commit` checks, so
 * it throws the `RangeError` (or the error a field threw when read) that
 * `commit` would reject with. It shares nothing with `write`, and
 * committing it writes what committing `write` would have. For a host that
 * reads before it commits and must still own the write from the call.
 */
export function capturedSessionWrite(
  write: SessionStoreWrite
): SessionStoreWrite {
  return captured(write);
}

/** A column as SQLite returns it, with no mapping by Drizzle. */
function raw(column: SQLiteColumn): SQL<unknown> {
  return sql<unknown>`${column}`;
}

/**
 * Every column of a session row but `scope`, as SQLite returns it, for
 * `./sqlite-decode` to check.
 */
const sessionColumns = {
  createdAt: raw(agentSessions.createdAt),
  id: agentSessions.id,
  parentMessageId: raw(agentSessions.parentMessageId),
  parentSessionId: raw(agentSessions.parentSessionId),
  recursionDepth: raw(agentSessions.recursionDepth),
  status: raw(agentSessions.status),
  title: raw(agentSessions.title),
  updatedAt: raw(agentSessions.updatedAt),
};

/**
 * Every column of a message row but `scope` and `position`, as SQLite
 * returns it: the JSON columns as text, `summarized` as an integer.
 */
const messageColumns = {
  createdAt: raw(agentMessages.createdAt),
  id: agentMessages.id,
  metadata: raw(agentMessages.metadata),
  parts: raw(agentMessages.parts),
  role: raw(agentMessages.role),
  sessionId: agentMessages.sessionId,
  status: raw(agentMessages.status),
  summarized: raw(agentMessages.summarized),
  updatedAt: raw(agentMessages.updatedAt),
};

/** Where a message is filed: its session and its place there. */
const placementColumns = {
  id: agentMessages.id,
  position: agentMessages.position,
  sessionId: agentMessages.sessionId,
};

/** On a conflicting put, every column but the key takes the incoming value. */
const replaceSession = replacing(getTableColumns(agentSessions), [
  "scope",
  "id",
]);
const replaceMessage = replacing(getTableColumns(agentMessages), [
  "scope",
  "id",
]);

/** Why a call from inside the store's own transaction or hook is refused. */
const REENTRY =
  "SqliteSessionStore was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

/**
 * A `SessionStore` over the host's SQLite database, in the tables from
 * `@foundry/agents/store/tables`. It behaves as `InMemorySessionStore` does,
 * within its scope.
 *
 * Its calls take turns, as the memory store's do: a call made while a
 * transaction or commit runs waits for it. That keeps two `Sessions` over
 * one store apart in this process, and keeps a `:memory:` database, which
 * has a single connection, from refusing a call while a transaction holds
 * it. Across connections and processes, `transaction` takes the database's
 * write lock (see there).
 */
export class SqliteSessionStore implements SessionStore {
  readonly #database: SessionDatabase;
  readonly #scope: string;
  readonly #onCommit: SqliteSessionStoreOptions["onCommit"];
  readonly #turns = new Turns(REENTRY);

  constructor(options: SqliteSessionStoreOptions) {
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
   * One database transaction: the sessions put, then the messages put, then
   * `onCommit`. The store takes its own copy of `write` when it is called,
   * before it waits for its turn, and writes that copy and hands it to
   * `onCommit`, so a caller changing `write` afterwards changes neither.
   * Rejects, before writing anything, a write holding a value SQLite or JSON
   * would not give back intact, naming its field (see `./sqlite-records`).
   */
  commit(write: SessionStoreWrite): Promise<void> {
    let taken: ReturnType<typeof owned>;
    try {
      taken = owned(this.#scope, write);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#turns.run(() =>
      this.#database.transaction(async (transaction) => {
        await this.#putSessions(transaction, taken.sessions);
        await this.#putMessages(transaction, taken.messages);
        await this.#onCommit?.(transaction, taken.write);
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
  transaction<T>(work: (view: SessionStore) => Promise<T>): Promise<T> {
    return this.#turns.run(() =>
      this.#database.transaction((transaction) =>
        work(
          new SqliteSessionStore({
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
  getSession(id: string): Promise<SessionRecord | null> {
    return this.#turns.run(async () => {
      if (!storable(id)) {
        return null;
      }
      const [row] = await this.#database
        .select(sessionColumns)
        .from(agentSessions)
        .where(
          and(eq(agentSessions.scope, this.#scope), eq(agentSessions.id, id))
        );
      return row ? sessionOf(row, this.#scope) : null;
    });
  }

  /**
   * The sessions with these ids, in no particular order, in as few
   * statements as the parameter limit allows; an id no row holds, or can,
   * is left out. Beyond `SessionStore`: a listing reads many at once.
   */
  getSessions(ids: readonly string[]): Promise<SessionRecord[]> {
    return this.#turns.run(async () => {
      const sessions: SessionRecord[] = [];
      for (const batch of batches(
        [...new Set(ids.filter(storable))],
        MAX_PARAMETERS - 1
      )) {
        const rows = await this.#database
          .select(sessionColumns)
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.scope, this.#scope),
              inArray(agentSessions.id, batch)
            )
          );
        sessions.push(...rows.map((row) => sessionOf(row, this.#scope)));
      }
      return sessions;
    });
  }

  /**
   * How many messages each of these sessions holds, and whether one is a
   * summary, by session id, in as few statements as the parameter limit
   * allows, reading no message itself; a session with none is left out.
   * Beyond `SessionStore`: a listing counts many at once.
   */
  messageTallies(
    sessionIds: readonly string[]
  ): Promise<Map<string, MessageTally>> {
    return this.#turns.run(async () => {
      const tallies = new Map<string, MessageTally>();
      for (const batch of batches(
        [...new Set(sessionIds.filter(storable))],
        MAX_PARAMETERS - 1
      )) {
        const rows = await this.#database
          .select({
            messages: sql<number>`count(*)`,
            sessionId: agentMessages.sessionId,
            summaries: sql<number>`sum(${agentMessages.role} = 'summary')`,
          })
          .from(agentMessages)
          .where(
            and(
              eq(agentMessages.scope, this.#scope),
              inArray(agentMessages.sessionId, batch)
            )
          )
          .groupBy(agentMessages.sessionId);
        for (const row of rows) {
          tallies.set(row.sessionId, {
            messages: Number(row.messages),
            summarized: Number(row.summaries) > 0,
          });
        }
      }
      return tallies;
    });
  }

  /** `null` for an id no row can hold (see {@link storable}). */
  getMessage(id: string): Promise<SessionMessage | null> {
    return this.#turns.run(async () => {
      if (!storable(id)) {
        return null;
      }
      const [row] = await this.#database
        .select(messageColumns)
        .from(agentMessages)
        .where(
          and(eq(agentMessages.scope, this.#scope), eq(agentMessages.id, id))
        );
      return row ? messageOf(row, this.#scope) : null;
    });
  }

  /**
   * One session's run of the position index, in order; empty for a key no
   * row can hold. A row that does not decode rejects the whole list.
   */
  listMessages(sessionId: string): Promise<SessionMessage[]> {
    return this.#turns.run(async () => {
      if (!storable(sessionId)) {
        return [];
      }
      const rows = await this.#database
        .select(messageColumns)
        .from(agentMessages)
        .where(
          and(
            eq(agentMessages.scope, this.#scope),
            eq(agentMessages.sessionId, sessionId)
          )
        )
        .orderBy(agentMessages.position);
      return rows.map((row) => messageOf(row, this.#scope));
    });
  }

  async #putSessions(
    transaction: SessionTransaction,
    rows: readonly SessionRow[]
  ): Promise<void> {
    // A later put of the same id in one statement replaces the earlier.
    await inOrder(batches(rows, MAX_PARAMETERS / SESSION_COLUMNS), (batch) =>
      transaction
        .insert(agentSessions)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceSession,
          target: [agentSessions.scope, agentSessions.id],
        })
    );
  }

  /**
   * Places each message as the memory store does, replaying the puts in
   * order: one put again in its session keeps its position; one new to the
   * store, or put under another session, takes the next position in its
   * session. Then writes one row per id, as its last put left it.
   */
  async #putMessages(
    transaction: SessionTransaction,
    rows: readonly UnplacedMessageRow[]
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const placements = await this.#placements(
      transaction,
      rows.map((row) => row.id)
    );
    const next = new Map<string, number>();
    const placed = new Map<string, typeof agentMessages.$inferSelect>();
    for (const row of rows) {
      const current = placements.get(row.id);
      const position =
        current?.sessionId === row.sessionId
          ? current.position
          : await this.#nextPosition(transaction, row.sessionId, next);
      placements.set(row.id, { position, sessionId: row.sessionId });
      placed.set(row.id, { ...row, position });
    }
    await inOrder(
      batches([...placed.values()], MAX_PARAMETERS / MESSAGE_COLUMNS),
      (batch) =>
        transaction
          .insert(agentMessages)
          .values(batch)
          .onConflictDoUpdate({
            set: replaceMessage,
            target: [agentMessages.scope, agentMessages.id],
          })
    );
  }

  /** Where each of `ids` is filed now, by id; an id not filed is missing. */
  async #placements(
    transaction: SessionTransaction,
    ids: readonly string[]
  ): Promise<Map<string, { position: number; sessionId: string }>> {
    const placements = new Map<
      string,
      { position: number; sessionId: string }
    >();
    // `scope` takes one of the statement's parameters.
    await inOrder(
      batches([...new Set(ids)], MAX_PARAMETERS - 1),
      async (batch) => {
        const found = await transaction
          .select(placementColumns)
          .from(agentMessages)
          .where(
            and(
              eq(agentMessages.scope, this.#scope),
              inArray(agentMessages.id, batch)
            )
          );
        for (const { id, position, sessionId } of found) {
          placements.set(id, { position, sessionId });
        }
      }
    );
    return placements;
  }

  /**
   * One past the last position in `sessionId`, read once per session and
   * counted on in `next` for the rest of the commit. A message that leaves
   * a session leaves a gap; only the order of positions matters.
   */
  async #nextPosition(
    transaction: SessionTransaction,
    sessionId: string,
    next: Map<string, number>
  ): Promise<number> {
    let position = next.get(sessionId);
    if (position === undefined) {
      const [last] = await transaction
        .select({ position: agentMessages.position })
        .from(agentMessages)
        .where(
          and(
            eq(agentMessages.scope, this.#scope),
            eq(agentMessages.sessionId, sessionId)
          )
        )
        .orderBy(desc(agentMessages.position))
        .limit(1);
      position = (last?.position ?? 0) + 1;
    }
    next.set(sessionId, position + 1);
    return position;
  }
}

/** SQLite's default limit on the parameters one statement binds. */
const MAX_PARAMETERS = 32_766;

/** The parameters one row of each table binds in a multi-row insert. */
const SESSION_COLUMNS = Object.keys(getTableColumns(agentSessions)).length;
const MESSAGE_COLUMNS = Object.keys(getTableColumns(agentMessages)).length;

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
    // In sequence: later batches follow earlier ones.
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
