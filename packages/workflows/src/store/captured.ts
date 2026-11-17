import type {
  FrameListQuery,
  JobListQuery,
  RunListQuery,
  SuspensionListQuery,
  WorkflowStoreWrite,
} from "./index";

const WRITE_PROPERTIES = {
  deleteJobs: true,
  deleteRunFrames: true,
  deleteRuns: true,
  deleteSuspensions: true,
  events: true,
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

const QUERY_PROPERTIES = {
  after: true,
  limit: true,
  queueId: true,
  runId: true,
  status: true,
} as const satisfies Record<keyof AnyListQuery, true>;

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
    if (property === "events") {
      captured[property] = plainJson("events", value, new Set());
      continue;
    }
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
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

function plainJson(
  at: string,
  value: unknown,
  ancestors: Set<object>
): unknown {
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new TypeError(`${at} must be a finite number other than -0`);
      }
      return value;
    case "object":
      break;
    default:
      throw new TypeError(`${at} has no JSON form (${typeof value})`);
  }
  if (value === null) {
    return null;
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${at} contains itself`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return plainArray(at, value, ancestors);
    }
    if (!isPlainData(value)) {
      throw new TypeError(
        `${at} must be a plain object whose own properties are all enumerable`
      );
    }
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: plainJson(`${at}.${key}`, Reflect.get(value, key), ancestors),
        writable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
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

function plainArray(
  at: string,
  value: readonly unknown[],
  ancestors: Set<object>
): unknown[] {
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new TypeError(`${at} must be a plain array holding only its entries`);
  }
  const copy = Array.from({ length: value.length }, (_, index) => {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${at}[${index}] is a hole in an array`);
    }
    return plainJson(`${at}[${index}]`, value[index], ancestors);
  });
  if (Object.getOwnPropertyNames(value).length !== copy.length + 1) {
    throw new TypeError(`${at} must be a plain array holding only its entries`);
  }
  return copy;
}
