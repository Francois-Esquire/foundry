import type { ModuleStorePageQuery } from "../store";

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
