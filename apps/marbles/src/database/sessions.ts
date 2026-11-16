import type { SessionMessage, SessionRecord } from "@foundry/agents/schema";
import type { SessionStore, SessionStoreWrite } from "@foundry/agents/store";
import type {
  MessageTally,
  SessionTransaction,
} from "@foundry/agents/store/sqlite";
import {
  capturedSessionWrite,
  SqliteSessionStore,
} from "@foundry/agents/store/sqlite";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { ChangeRecorder } from "~/database/changes";
import { busyError } from "~/database/client";
import type { StoreDatabase } from "~/database/open";
import { marblesSessionRevisions } from "~/database/tables";
import { SESSIONS, sourceKey } from "~/lib/events/source";
import type { ListedSessionStore, SessionStamp } from "~/lib/usage-evidence";

export interface DatabaseSessionStoreOptions {
  readonly changes?: ChangeRecorder;
  readonly database: StoreDatabase;
  readonly scope: string;
}

const SESSIONS_KEY = sourceKey(SESSIONS) ?? "sessions";

const REVISION_BATCH = 500;

export class DatabaseSessionStore implements ListedSessionStore {
  readonly #database: StoreDatabase;
  readonly #scope: string;
  readonly #store: SqliteSessionStore;

  constructor(options: DatabaseSessionStoreOptions) {
    const { database, scope } = options;
    const changes = options.changes ?? new ChangeRecorder(scope);
    this.#database = database;
    this.#scope = scope;
    this.#store = changes.causing(
      new SqliteSessionStore({
        database,
        onCommit: async (transaction, write) => {
          await raiseRevisions(transaction, scope, write);
          await changes.record(transaction, SESSIONS_KEY, write.events);
        },
        scope,
      })
    );
  }

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

  getSessions(ids: readonly string[]): Promise<SessionRecord[]> {
    return asMarbles(() => this.#store.getSessions(ids));
  }

  messageTallies(
    sessionIds: readonly string[]
  ): Promise<Map<string, MessageTally>> {
    return asMarbles(() => this.#store.messageTallies(sessionIds));
  }

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

const raised = sql`${marblesSessionRevisions.revision} + 1`;

function batches<T>(items: readonly T[]): T[][] {
  const runs: T[][] = [];
  for (let start = 0; start < items.length; start += REVISION_BATCH) {
    runs.push(items.slice(start, start + REVISION_BATCH));
  }
  return runs;
}

async function asMarbles<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw busyError(error) ?? error;
  }
}
