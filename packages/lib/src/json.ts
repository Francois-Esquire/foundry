export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

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
