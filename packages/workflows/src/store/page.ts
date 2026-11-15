import { detached } from "../detached";
import type { WorkflowStorePageQuery } from "./index";

/**
 * The list query a store reads by, as it stands now: one copy, which reads
 * each of the caller's properties once, so a caller changing its query
 * while the read waits for its turn changes nothing.
 * Refuses a query a store could not honour alike: a `limit` that is not a
 * positive safe integer (SQLite reads a negative one as no limit), or an
 * `after` that is not a safe integer.
 */
export function ownedQuery<Q extends WorkflowStorePageQuery>(input: Q): Q {
  const query = detached(input);
  if (!(Number.isSafeInteger(query.limit) && query.limit > 0)) {
    throw new RangeError(
      `limit must be a positive safe integer; got ${String(query.limit)}`
    );
  }
  if (query.after !== undefined && !Number.isSafeInteger(query.after)) {
    throw new RangeError(
      `after must be a cursor a page returned; got ${String(query.after)}`
    );
  }
  return query;
}
