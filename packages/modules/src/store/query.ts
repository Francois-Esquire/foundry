import type { ModuleStorePageQuery } from "../store";

/**
 * The list query a store reads by, as it stands now: a copy, so a caller
 * changing its query while the read waits for its turn changes nothing.
 * Refuses a query a store could not honour alike: a `limit` that is not a
 * positive safe integer (SQLite reads a negative one as no limit), or an
 * `after` that is not a safe integer.
 */
export function ownedQuery<Q extends ModuleStorePageQuery>(query: Q): Q {
  const owned = structuredClone(query);
  if (!(Number.isSafeInteger(owned.limit) && owned.limit > 0)) {
    throw new RangeError(
      `limit must be a positive safe integer; got ${String(owned.limit)}`
    );
  }
  if (owned.after !== undefined && !Number.isSafeInteger(owned.after)) {
    throw new RangeError(
      `after must be a cursor a page returned; got ${String(owned.after)}`
    );
  }
  return owned;
}
