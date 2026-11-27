import type { StoreDatabase } from "~/database/types";

export type StoreTransaction = Parameters<
  Parameters<StoreDatabase["transaction"]>[0]
>[0];

export function transaction<T>(
  database: StoreDatabase,
  work: (tx: StoreTransaction) => Promise<T>
): Promise<T> {
  return database.transaction(work);
}
