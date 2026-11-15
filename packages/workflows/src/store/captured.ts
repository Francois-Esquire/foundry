import type {
  FrameListQuery,
  JobListQuery,
  RunListQuery,
  SuspensionListQuery,
  WorkflowStoreWrite,
} from "./index";

/**
 * How every store takes a write or a list query from its caller: each
 * property the interface names is read once, by name, so a property that
 * is a getter on a prototype, or own but not enumerable, is read like any
 * other; nothing else on the object is read. The memory and SQLite stores
 * both start from this capture, so they cannot read a write differently.
 * A store copies the capture further (`detached`, or its own checks); the
 * capture copies each list, entry by entry, and nothing below that.
 */

/** Every property of a write, each `true`, so a property added to the type must be added here. */
const WRITE_PROPERTIES = {
  deleteJobs: true,
  deleteRunFrames: true,
  deleteRuns: true,
  deleteSuspensions: true,
  putFrames: true,
  putJobs: true,
  putQueues: true,
  putRuns: true,
  putSuspensions: true,
} as const satisfies Record<keyof WorkflowStoreWrite, true>;

const DELETES = new Set([
  "deleteJobs",
  "deleteRunFrames",
  "deleteRuns",
  "deleteSuspensions",
]);

type AnyListQuery = FrameListQuery &
  JobListQuery &
  RunListQuery &
  SuspensionListQuery;

/** Every property of any list query, each `true`. */
const QUERY_PROPERTIES = {
  after: true,
  limit: true,
  queueId: true,
  runId: true,
  status: true,
} as const satisfies Record<keyof AnyListQuery, true>;

/**
 * `write`'s properties, each read once, in a plain object that holds only
 * the ones that are not `undefined`. Refuses, with a `TypeError` naming the
 * property, a list that is not an array, a delete id that is not text, and
 * a record that is not a plain object (made by `{}` or `Object.create(null)`)
 * with every own property enumerable: a copy of anything else could keep
 * less than the record shows, and differently in each store.
 */
export function capturedWrite(write: WorkflowStoreWrite): WorkflowStoreWrite {
  const captured: Record<string, unknown> = {};
  for (const property of Object.keys(WRITE_PROPERTIES)) {
    const value: unknown = Reflect.get(write, property);
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value)) {
      throw new TypeError(`${property} must be an array`);
    }
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      // Each entry is read once; the capture holds what that read gave.
      const item: unknown = value[index];
      items.push(item);
      if (DELETES.has(property)) {
        if (typeof item !== "string") {
          throw new TypeError(`${property}[${index}] must be text`);
        }
      } else if (!isPlainData(item)) {
        throw new TypeError(
          `${property}[${index}] must be a plain object whose own properties are all enumerable`
        );
      }
    }
    captured[property] = items;
  }
  return captured as WorkflowStoreWrite;
}

/**
 * `query`'s properties, each read once, in a plain object; `undefined` ones
 * left out. Refuses, with a `TypeError`, a `status` that is not an array of
 * text and a `queueId` or `runId` that is not text, which the stores would
 * otherwise match differently. `limit` and `after` are checked by the
 * caller (`ownedQuery`).
 */
export function capturedQuery<Q extends object>(query: Q): Q {
  const captured: Record<string, unknown> = {};
  for (const property of Object.keys(QUERY_PROPERTIES)) {
    let value: unknown = Reflect.get(query, property);
    if (value === undefined) {
      continue;
    }
    if (property === "status") {
      if (!Array.isArray(value)) {
        throw new TypeError("status must be an array");
      }
      value = Array.from({ length: value.length }, (_, index) => {
        const entry: unknown = (value as unknown[])[index];
        if (typeof entry !== "string") {
          throw new TypeError(`status[${index}] must be text`);
        }
        return entry;
      });
    } else if (
      (property === "queueId" || property === "runId") &&
      typeof value !== "string"
    ) {
      throw new TypeError(`${property} must be text`);
    }
    captured[property] = value;
  }
  return captured as Q;
}

function isPlainData(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertyNames(value).length === Object.keys(value).length &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}
