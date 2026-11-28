import type { JsonValue } from "@foundry/lib/json";
import { canonicalizeJson } from "@foundry/lib/json";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function rejectHoles(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new Error(`an array has no item at index ${index}`);
      }
      rejectHoles(value[index]);
    }
    return;
  }
  for (const child of Object.values(value)) {
    rejectHoles(child);
  }
}

export function inputSnapshot(value: unknown): unknown {
  rejectHoles(value);
  return deepFreeze(JSON.parse(canonicalizeJson(value)));
}
