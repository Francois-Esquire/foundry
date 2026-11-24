import {
  assertScope,
  batches,
  replacing,
  SQLITE_MAX_PARAMETERS,
  type SqliteDatabase,
  type SqliteTransaction,
  storableText,
} from "@foundry/lib/sqlite";
import { Turns } from "@foundry/lib/turns";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import type { SessionMessage, SessionRecord } from "../schema";
import type { SessionStore, SessionStoreWrite } from "./index";
import { messageOf, sessionOf } from "./sqlite-decode";
import type { SessionRow, UnplacedMessageRow } from "./sqlite-rows";
import { captured, owned } from "./sqlite-rows";
import { agentMessages, agentSessions } from "./tables";

export type SessionDatabase = SqliteDatabase;

export interface MessageTally {
  readonly messages: number;
  readonly summarized: boolean;
}

export type SessionTransaction = SqliteTransaction;

export interface SqliteSessionStoreOptions {
  readonly database: SessionDatabase;
  readonly onCommit?: (
    transaction: SessionTransaction,
    write: SessionStoreWrite
  ) => Promise<void>;
  readonly scope: string;
}

export function capturedSessionWrite(
  write: SessionStoreWrite
): SessionStoreWrite {
  return captured(write);
}

function raw(column: SQLiteColumn): SQL<unknown> {
  return sql<unknown>`${column}`;
}

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

const placementColumns = {
  id: agentMessages.id,
  position: agentMessages.position,
  sessionId: agentMessages.sessionId,
};

const replaceSession = replacing(getTableColumns(agentSessions), [
  agentSessions.scope,
  agentSessions.id,
]);
const replaceMessage = replacing(getTableColumns(agentMessages), [
  agentMessages.scope,
  agentMessages.id,
]);

const REENTRY =
  "SqliteSessionStore was called from inside its own transaction or onCommit hook; use the view passed to the transaction's work, or the transaction passed to onCommit, instead";

export class SqliteSessionStore implements SessionStore {
  readonly #database: SessionDatabase;
  readonly #scope: string;
  readonly #onCommit: SqliteSessionStoreOptions["onCommit"];
  readonly #turns = new Turns(REENTRY);

  constructor(options: SqliteSessionStoreOptions) {
    assertScope(options.scope);
    this.#database = options.database;
    this.#scope = options.scope;
    this.#onCommit = options.onCommit;
  }

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

  getSession(id: string): Promise<SessionRecord | null> {
    return this.#turns.run(async () => {
      if (!storableText(id)) {
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

  getSessions(ids: readonly string[]): Promise<SessionRecord[]> {
    return this.#turns.run(async () => {
      const sessions: SessionRecord[] = [];
      for (const batch of batches(
        [...new Set(ids.filter(storableText))],
        SQLITE_MAX_PARAMETERS - 1
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

  messageTallies(
    sessionIds: readonly string[]
  ): Promise<Map<string, MessageTally>> {
    return this.#turns.run(async () => {
      const tallies = new Map<string, MessageTally>();
      for (const batch of batches(
        [...new Set(sessionIds.filter(storableText))],
        SQLITE_MAX_PARAMETERS - 1
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

  getMessage(id: string): Promise<SessionMessage | null> {
    return this.#turns.run(async () => {
      if (!storableText(id)) {
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

  listMessages(sessionId: string): Promise<SessionMessage[]> {
    return this.#turns.run(async () => {
      if (!storableText(sessionId)) {
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
    for (const batch of batches(
      rows,
      SQLITE_MAX_PARAMETERS / SESSION_COLUMNS
    )) {
      await transaction
        .insert(agentSessions)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceSession,
          target: [agentSessions.scope, agentSessions.id],
        });
    }
  }

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
    for (const batch of batches(
      [...placed.values()],
      SQLITE_MAX_PARAMETERS / MESSAGE_COLUMNS
    )) {
      await transaction
        .insert(agentMessages)
        .values(batch)
        .onConflictDoUpdate({
          set: replaceMessage,
          target: [agentMessages.scope, agentMessages.id],
        });
    }
  }

  async #placements(
    transaction: SessionTransaction,
    ids: readonly string[]
  ): Promise<Map<string, { position: number; sessionId: string }>> {
    const placements = new Map<
      string,
      { position: number; sessionId: string }
    >();
    for (const batch of batches([...new Set(ids)], SQLITE_MAX_PARAMETERS - 1)) {
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
    return placements;
  }

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

const SESSION_COLUMNS = Object.keys(getTableColumns(agentSessions)).length;
const MESSAGE_COLUMNS = Object.keys(getTableColumns(agentMessages)).length;
