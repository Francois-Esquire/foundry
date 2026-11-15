import type {
  Client,
  InArgs,
  InStatement,
  Transaction,
  TransactionMode,
} from "@libsql/client";

import type { ShippedMigration } from "~/database/migrate";
import { APPLIED, IncompatibleDatabaseError } from "~/database/migrate";

/**
 * A writer's client that refuses to touch the database once another
 * Marbles has migrated it past what this one ships. A handle is checked
 * in full when it opens (`schemaState`: every applied migration's hash
 * against the shipped one, in order); this keeps that true for as long as
 * the handle stays open, which for a host is hours.
 *
 * Every transaction checks, first thing, on that same transaction, that
 * the applied history is still the one the open verified, and fails with
 * `IncompatibleDatabaseError` otherwise, before any of its reads and
 * writes. A statement that may write, run outside a transaction, runs in
 * one of its own (`BEGIN IMMEDIATE`), checked the same way. So every store
 * over the handle (tasks, recorded changes and deliveries, the workspace
 * registry) is guarded here, in one place. A lone `SELECT` or `EXPLAIN`
 * outside a transaction passes as it is: it changes nothing, and a reader
 * must never wait for another process's writer.
 *
 * The check is one small query: the count of applied migrations and the
 * newest one's `created_at`, against the shipped count and the last
 * shipped migration's time. That is enough because, after the full check
 * at open, the applied history can change only by appending: every Marbles
 * migrates only a database whose history is an exact prefix of the one it
 * ships (`migrate` refuses anything else), and nothing in Marbles deletes
 * or rewrites an applied row. So a history that was exactly this Marbles'
 * at open and still has its length now is unchanged; a newer Marbles that
 * migrated meanwhile made it longer. The newest time also catches a row
 * edited by hand.
 */
/** A statement that cannot write: a plain query or a query plan. */
const READ_ONLY = /^\s*(select|explain)\b/i;

export function guardedClient(
  client: Client,
  file: string,
  shipped: readonly ShippedMigration[]
): Client {
  const expected = {
    applied: shipped.length,
    newest: shipped.at(-1)?.when ?? 0,
  };
  async function check(transaction: Transaction): Promise<void> {
    const { rows } = await transaction.execute(
      `SELECT count(*), max(created_at) FROM "${APPLIED}"`
    );
    const [row] = rows;
    const applied = Number(row?.[0] ?? 0);
    const newest = Number(row?.[1] ?? 0);
    if (applied !== expected.applied || newest !== expected.newest) {
      throw new IncompatibleDatabaseError(
        `the Marbles database at ${file} was migrated by another Marbles while this process had it open (it has ${String(applied)} migration(s), this Marbles ships ${String(expected.applied)}); restart this process with the Marbles that migrated it`
      );
    }
  }
  async function begin(mode?: TransactionMode): Promise<Transaction> {
    const transaction = await client.transaction(mode);
    try {
      await check(transaction);
    } catch (error) {
      try {
        await transaction.rollback();
      } finally {
        transaction.close();
      }
      throw error;
    }
    return transaction;
  }
  async function alone<T>(
    work: (transaction: Transaction) => Promise<T>
  ): Promise<T> {
    const transaction = await begin("write");
    try {
      const value = await work(transaction);
      await transaction.commit();
      return value;
    } catch (error) {
      if (!transaction.closed) {
        await transaction.rollback();
      }
      throw error;
    } finally {
      transaction.close();
    }
  }
  return {
    batch: (stmts: Array<InStatement | [string, InArgs?]>) =>
      alone((transaction) =>
        transaction.batch(
          stmts.map((stmt) =>
            Array.isArray(stmt) ? { args: stmt[1] ?? [], sql: stmt[0] } : stmt
          )
        )
      ),
    close: () => client.close(),
    get closed() {
      return client.closed;
    },
    execute: ((stmtOrSql: InStatement | string, args?: InArgs) => {
      const stmt =
        typeof stmtOrSql === "string"
          ? { args: args ?? [], sql: stmtOrSql }
          : stmtOrSql;
      return READ_ONLY.test(typeof stmt === "string" ? stmt : stmt.sql)
        ? client.execute(stmt)
        : alone((transaction) => transaction.execute(stmt));
    }) as Client["execute"],
    executeMultiple: (sql: string) =>
      alone((transaction) => transaction.executeMultiple(sql)),
    migrate: (stmts: InStatement[]) =>
      alone((transaction) => transaction.batch(stmts)),
    get protocol() {
      return client.protocol;
    },
    reconnect: () => client.reconnect(),
    sync: () => client.sync(),
    transaction: (mode?: TransactionMode) => begin(mode),
  };
}
