import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { JsonValue } from "@foundry/lib/json";

/**
 * Temp-and-rename, so a concurrent reader never sees a half-written file. The
 * temporary is created exclusively and removed if the write fails. Sync,
 * like the state store and run files it writes; `writeFileAtomic`
 * (`@foundry/lib/atomic-file`) is the async writer with fsync for data that
 * must survive a crash.
 */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2), { flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** `undefined` for a missing or unparsable file: state is advisory, never fatal. */
export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `value` as plain JSON data, for `canonicalizeJson` (`@foundry/lib/json`)
 * to hash or compare when it may hold what that refuses. The coercions are
 * the ones trigger keys have always been hashed with, so they must not
 * change, or existing schedules would get new keys: `undefined` and
 * non-finite numbers read as null, any object as its own enumerable keys, so
 * a `Date` reads as `{}`, and a bigint throws. Functions and symbols read as
 * null too; the serializer this replaced wrote invalid JSON for them
 * (`"f":undefined`, or an empty array slot), so no real persisted key used it.
 */
export function jsonData(value: unknown): JsonValue {
  if (Array.isArray(value)) {
    return value.map(jsonData);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, jsonData(member)])
    );
  }
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      throw new TypeError("a bigint has no JSON form");
    default:
      return null;
  }
}

export class NotStorableError extends TypeError {
  override readonly name = "NotStorableError";
}

export function storableJson(at: string, value: unknown): JsonValue {
  return storable(at, value, new Set());
}

function storable(at: string, value: unknown, seen: Set<object>): JsonValue {
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new NotStorableError(
          `${at} holds ${String(value)}, which does not read back intact from JSON`
        );
      }
      return value + 0;
    case "object":
      if (value === null) {
        return null;
      }
      if (seen.has(value)) {
        throw new NotStorableError(`${at} contains itself`);
      }
      seen.add(value);
      try {
        return Array.isArray(value)
          ? storableArray(at, value, seen)
          : storableObject(at, value, seen);
      } finally {
        seen.delete(value);
      }
    default:
      throw new NotStorableError(
        `${at} holds ${value === undefined ? "undefined" : `a ${typeof value}`}, which has no JSON form`
      );
  }
}

function storableArray(
  at: string,
  value: readonly unknown[],
  seen: Set<object>
): JsonValue[] {
  return Array.from({ length: value.length }, (_, index) => {
    if (!Object.hasOwn(value, index)) {
      throw new NotStorableError(`${at}[${index}] is a hole in an array`);
    }
    const item = value[index];
    if (item === undefined) {
      throw new NotStorableError(
        `${at}[${index}] holds undefined, which reads back from JSON as null`
      );
    }
    return storable(`${at}[${index}]`, item, seen);
  });
}

function storableObject(
  at: string,
  value: object,
  seen: Set<object>
): { [key: string]: JsonValue } {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new NotStorableError(
      `${at} holds an object that is not plain, which does not read back intact from JSON`
    );
  }
  const copy: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) {
      continue;
    }
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: storable(`${at}.${key}`, item, seen),
      writable: true,
    });
  }
  return copy;
}
