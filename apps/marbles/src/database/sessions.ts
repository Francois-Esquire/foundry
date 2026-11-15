import type { SessionMessage, SessionRecord } from "@foundry/agents/schema";
import type { SessionStore, SessionStoreWrite } from "@foundry/agents/store";
import type { SessionTransaction } from "@foundry/agents/store/sqlite";
import { SqliteSessionStore } from "@foundry/agents/store/sqlite";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { busyError } from "~/database/client";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import { marblesSessionRevisions } from "~/database/tables";
import { stateDatabase } from "~/layout";
import type { ListedSessionStore, SessionStamp } from "~/lib/usage-evidence";

/**
 * A workspace's agent sessions in the Marbles database: the
 * `@foundry/agents` rows scoped by the workspace id, and Marbles' record of
 * which sessions they hold (`marbles_session_revisions`), each with a
 * revision every commit that touches the session raises.
 *
 * The revision is written by `SqliteSessionStore`'s `onCommit` hook, on the
 * transaction the hook is handed, so a session and its revision commit or
 * roll back together. Marbles lists sessions only through that record and
 * reads them only through the store, never through the package's tables.
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

  commit(write: SessionStoreWrite): Promise<void> {
    return asMarbles(() => this.#store.commit(write));
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
    return asMarbles(() => this.#store.transaction(work));
  }
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

/**
 * How many sessions each workspace under the state root holds, by
 * workspace id, through a read-only connection that never creates, migrates
 * or changes the database. Empty with no database, or nothing migrated
 * into it.
 */
export async function sessionCounts(
  state: string
): Promise<ReadonlyMap<string, number>> {
  const counted = await asMarbles(() =>
    readDatabase(stateDatabase(state), (database) =>
      database
        .select({
          scope: marblesSessionRevisions.scope,
          sessions: count(),
        })
        .from(marblesSessionRevisions)
        .groupBy(marblesSessionRevisions.scope)
    )
  );
  return new Map(counted?.map((row) => [row.scope, row.sessions]) ?? []);
}

/**
 * Run `work` on a workspace's sessions for a command that only reads them,
 * through a read-only connection (`readDatabase`). Undefined, and `work`
 * not run, with no database or nothing migrated into it: there are no
 * sessions yet.
 */
export function readSessions<T>(
  state: string,
  scope: string,
  work: (sessions: DatabaseSessionStore) => Promise<T>
): Promise<T | undefined> {
  return asMarbles(() =>
    readDatabase(stateDatabase(state), (database) =>
      work(new DatabaseSessionStore({ database, scope }))
    )
  );
}
