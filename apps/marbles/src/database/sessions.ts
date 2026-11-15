import type { SessionMessage, SessionRecord } from "@foundry/agents/schema";
import type { SessionStore, SessionStoreWrite } from "@foundry/agents/store";
import type { SessionTransaction } from "@foundry/agents/store/sqlite";
import {
  capturedSessionWrite,
  SqliteSessionStore,
} from "@foundry/agents/store/sqlite";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { busyError } from "~/database/client";
import type { StoreDatabase } from "~/database/open";
import { marblesSessionRevisions } from "~/database/tables";
import type { ListedSessionStore, SessionStamp } from "~/lib/usage-evidence";

/**
 * A workspace's agent sessions in the Marbles database: the
 * `@foundry/agents` rows scoped by the workspace id, and Marbles' record of
 * which sessions they hold (`marbles_session_revisions`), each with a
 * revision every commit that touches the session raises.
 *
 * The revision is written by `SqliteSessionStore`'s `onCommit` hook, on the
 * transaction the hook is handed, so a session and its revision commit or
 * roll back together. A message moved to another session raises the one
 * it left as well: a commit that puts messages first reads, in its own
 * transaction, where each is filed. Marbles lists sessions only through
 * that record and reads them only through the store, never through the
 * package's tables.
 */

export interface DatabaseSessionStoreOptions {
  /** The database or one of its transactions; the host opens and closes it. */
  readonly database: StoreDatabase;
  /** The workspace id. */
  readonly scope: string;
}

/** Rows per statement when a commit raises revisions: three parameters each, well under SQLite's limit. */
const REVISION_BATCH = 500;

/** The engine's `SessionStore` over the Marbles database, which can list its sessions. */
export class DatabaseSessionStore implements ListedSessionStore {
  readonly #database: StoreDatabase;
  readonly #scope: string;
  readonly #store: SqliteSessionStore;

  constructor(options: DatabaseSessionStoreOptions) {
    const { database, scope } = options;
    this.#database = database;
    this.#scope = scope;
    this.#store = new SqliteSessionStore({
      database,
      onCommit: (transaction, write) =>
        raiseRevisions(transaction, scope, write),
      scope,
    });
  }

  /**
   * The write, with the session each message it puts leaves raised too:
   * run in one transaction that reads where each message is filed before
   * it moves (`withLeftSessions`). A write that puts no message is
   * committed as it is.
   */
  commit(write: SessionStoreWrite): Promise<void> {
    return asMarbles(() =>
      committing(
        write,
        (owned) =>
          this.#store.transaction((view) => withLeftSessions(view, owned)),
        (plain) => this.#store.commit(plain)
      )
    );
  }

  getMessage(id: string): Promise<SessionMessage | null> {
    return asMarbles(() => this.#store.getMessage(id));
  }

  getSession(id: string): Promise<SessionRecord | null> {
    return asMarbles(() => this.#store.getSession(id));
  }

  listMessages(sessionId: string): Promise<SessionMessage[]> {
    return asMarbles(() => this.#store.listMessages(sessionId));
  }

  /**
   * Every session the workspace holds, by id, with its revision as the
   * stamp: one statement, so it reads one state without a transaction.
   */
  stamps(): Promise<readonly SessionStamp[]> {
    return asMarbles(async () => {
      const rows = await this.#database
        .select({
          id: marblesSessionRevisions.sessionId,
          revision: marblesSessionRevisions.revision,
        })
        .from(marblesSessionRevisions)
        .where(eq(marblesSessionRevisions.scope, this.#scope))
        .orderBy(asc(marblesSessionRevisions.sessionId));
      return rows.map((row) => ({ id: row.id, stamp: String(row.revision) }));
    });
  }

  transaction<T>(work: (view: SessionStore) => Promise<T>): Promise<T> {
    return asMarbles(() =>
      this.#store.transaction((view) => work(raisingLeft(view)))
    );
  }
}

/**
 * Commit `write` through `commit`, given the copy the package store takes
 * of it (`capturedSessionWrite`), taken now, when the caller hands it over,
 * since `commit` reads before the store takes its own. A write the package
 * store refuses rejects here with its error, before anything is read or
 * written. One that puts no message needs no read, and goes to `plain`.
 */
function committing(
  write: SessionStoreWrite,
  commit: (owned: SessionStoreWrite) => Promise<void>,
  plain: (owned: SessionStoreWrite) => Promise<void>
): Promise<void> {
  let owned: SessionStoreWrite;
  try {
    owned = capturedSessionWrite(write);
  } catch (error) {
    return Promise.reject(error);
  }
  return (owned.putMessages ?? []).length === 0 ? plain(owned) : commit(owned);
}

/**
 * A transaction's `view` whose commits, and those of any transaction
 * nested in it, raise the sessions their messages leave
 * (`withLeftSessions`), each read and its write in one savepoint.
 */
function raisingLeft(view: SessionStore): SessionStore {
  return {
    commit: (write) =>
      committing(
        write,
        (owned) =>
          view.transaction === undefined
            ? withLeftSessions(view, owned)
            : view.transaction((inner) => withLeftSessions(inner, owned)),
        (plain) => view.commit(plain)
      ),
    getMessage: (id) => view.getMessage(id),
    getSession: (id) => view.getSession(id),
    listMessages: (sessionId) => view.listMessages(sessionId),
    transaction: (work) =>
      view.transaction === undefined
        ? work(raisingLeft(view))
        : view.transaction((inner) => work(raisingLeft(inner))),
  };
}

/**
 * Commit `write` through `view`, with the record of every session a
 * message it puts is leaving put again beside it: the commit hook is told
 * only where each message goes, and raises a session put like one a
 * message joins. Read through `view`, so in the transaction the write
 * lands in, before it lands.
 */
async function withLeftSessions(
  view: SessionStore,
  write: SessionStoreWrite
): Promise<void> {
  const put = new Set((write.putSessions ?? []).map((session) => session.id));
  const left = new Set<string>();
  for (const message of write.putMessages ?? []) {
    const filed = await view.getMessage(message.id);
    if (
      filed !== null &&
      filed.sessionId !== message.sessionId &&
      !put.has(filed.sessionId)
    ) {
      left.add(filed.sessionId);
    }
  }
  const again: SessionRecord[] = [];
  for (const id of left) {
    const record = await view.getSession(id);
    if (record !== null) {
      again.push(record);
    }
  }
  await view.commit(
    again.length === 0
      ? write
      : { ...write, putSessions: [...(write.putSessions ?? []), ...again] }
  );
}

/**
 * Raise the revision of every session `write` touches, in the commit's own
 * `transaction`: never through a store, which would wait on the commit
 * that is running this. A session record put gets its row, at revision 1
 * the first time; a message raises only a session that has a row, so the
 * listing holds exactly the sessions `getSession` finds. A session put
 * after messages were written under its id starts at its put.
 */
async function raiseRevisions(
  transaction: SessionTransaction,
  scope: string,
  write: SessionStoreWrite
): Promise<void> {
  const put = new Set((write.putSessions ?? []).map((session) => session.id));
  const rows = [...put].map((sessionId) => ({ revision: 1, scope, sessionId }));
  for (const batch of batches(rows)) {
    await transaction
      .insert(marblesSessionRevisions)
      .values(batch)
      .onConflictDoUpdate({
        set: { revision: raised },
        target: [
          marblesSessionRevisions.scope,
          marblesSessionRevisions.sessionId,
        ],
      });
  }
  const touched = new Set(
    (write.putMessages ?? [])
      .map((message) => message.sessionId)
      .filter((sessionId) => !put.has(sessionId))
  );
  for (const batch of batches([...touched])) {
    await transaction
      .update(marblesSessionRevisions)
      .set({ revision: raised })
      .where(
        and(
          eq(marblesSessionRevisions.scope, scope),
          inArray(marblesSessionRevisions.sessionId, batch)
        )
      );
  }
}

/** A revision one above the one stored. */
const raised = sql`${marblesSessionRevisions.revision} + 1`;

/** `items` in runs short enough for one statement's parameters. */
function batches<T>(items: readonly T[]): T[][] {
  const runs: T[][] = [];
  for (let start = 0; start < items.length; start += REVISION_BATCH) {
    runs.push(items.slice(start, start + REVISION_BATCH));
  }
  return runs;
}

/** Run `call`, with a lock SQLite waited too long for as a `DatabaseBusyError`. */
async function asMarbles<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw busyError(error) ?? error;
  }
}
