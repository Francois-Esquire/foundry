import { detached } from "../detached";
import { capturedQuery } from "./captured";
import type { WorkflowStorePageQuery } from "./index";

export function ownedQuery<Q extends WorkflowStorePageQuery>(input: Q): Q {
  const query = detached(capturedQuery(input));
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
