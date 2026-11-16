import { isPlainObject, ownedEvents } from "@foundry/lib/plain-json";

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
      captured[property] = ownedEvents(value);
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
      } else if (!isPlainObject(item)) {
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
