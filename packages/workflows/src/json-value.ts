import type { JsonValue } from "@foundry/lib/json";

export type { JsonValue } from "@foundry/lib/json";

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    return checkJsonValue(value, new WeakSet());
  } catch {
    return false;
  }
}

function checkJsonValue(
  value: unknown,
  ancestors: WeakSet<object>
): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }

  if (ancestors.has(value)) {
    return false;
  }

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    return false;
  }

  const keys = Reflect.ownKeys(value);
  const enumerableKeys = Object.keys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    return false;
  }
  if (isArray) {
    if (
      enumerableKeys.length !== value.length ||
      keys.length !== enumerableKeys.length + 1 ||
      !keys.includes("length") ||
      enumerableKeys.some((key, index) => key !== String(index))
    ) {
      return false;
    }
  } else if (keys.length !== enumerableKeys.length) {
    return false;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  ancestors.add(value);
  for (const key of enumerableKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !checkJsonValue(descriptor.value, ancestors)
    ) {
      ancestors.delete(value);
      return false;
    }
  }
  ancestors.delete(value);
  return true;
}

export function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
