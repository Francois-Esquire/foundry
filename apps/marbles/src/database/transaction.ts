import type { StoreDatabase } from "~/database/open";

/** One transaction on the Marbles database; a store handed it writes inside it. */
export type StoreTransaction = Parameters<
  Parameters<StoreDatabase["transaction"]>[0]
>[0];

/**
 * Run `work` in one write transaction and commit it, or roll all of it
 * back if `work` throws. A store built over the transaction it is given
 * (`{ database: tx }`) commits inside it, through a savepoint, so the
 * writes of several stores, and an `onCommit` hook's, land together or
 * not at all.
 *
 * On libSQL the transaction begins `IMMEDIATE`: it takes the write lock up
 * front rather than upgrading a read halfway, so a writer in another
 * process waits for it instead of failing on a stale snapshot. In this
 * process it holds the file's turn until it ends, so `work` must use `tx`,
 * never the database it came from, or it waits on itself until refused.
 */
export function transaction<T>(
  database: StoreDatabase,
  work: (tx: StoreTransaction) => Promise<T>
): Promise<T> {
  return database.transaction(work);
}
