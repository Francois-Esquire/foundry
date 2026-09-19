export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Serializes a value to a canonical JSON string: object keys sorted
 * lexicographically at every level, so two objects with identical content but
 * different key order produce identical output. Rejects anything that is not
 * plain JSON data — `undefined`, functions, symbols, bigints, non-finite
 * numbers, non-plain objects, and circular structures all throw.
 */
export function canonicalizeJson(value: unknown): string {
  return canonicalize(value, new WeakSet());
}

function canonicalize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(
          `cannot canonicalize non-finite number: ${String(value)}`
        );
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new Error(
        `cannot canonicalize unsupported value of type "${typeof value}"`
      );
  }

  if (seen.has(value)) {
    throw new Error("cannot canonicalize a circular structure");
  }
  seen.add(value);

  // `seen` tracks the current ancestor path, not every visited node: the
  // `finally` below pops each value back off on the way out. Without that pop,
  // a value legitimately referenced twice in a tree — the same frozen
  // requirement record reachable by two paths — would be misread as a cycle.
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalize(item, seen)).join(",")}]`;
    }

    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("cannot canonicalize a non-plain object");
    }

    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`)
      .join(",");
    return `{${body}}`;
  } finally {
    seen.delete(value);
  }
}
