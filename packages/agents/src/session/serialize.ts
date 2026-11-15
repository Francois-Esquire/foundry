/**
 * Stringify an unknown value for persistence/summarization: pass strings
 * through, JSON-encode everything else, and fall back to `String(value)` when
 * the value isn't JSON-serializable (cycles, BigInt, etc.).
 */
export function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * `value` in the form a session keeps it: its JSON form, which every durable
 * store writes and a model is sent. So a kept message never holds what a
 * store cannot copy, and every store keeps the same thing. JSON changes:
 *
 * - `-0` to `0`, and NaN and the infinities to `null`;
 * - a property holding `undefined`, a function or a symbol: left out; in an
 *   array, or a hole in one: `null`;
 * - a value with a `toJSON` (a `Date`, a `URL`): what it returns;
 * - any other object (a `Map`, a class instance): its own enumerable
 *   string-keyed properties, as a plain object.
 *
 * Strings, lone surrogates and U+0000 included, are kept as they are.
 * Throws a `TypeError` naming the first path below `at` with no JSON form:
 * a `bigint`, or a value that contains itself. A getter or `toJSON` that
 * throws is reported at its path the same way.
 */
export function keptValue(value: unknown, at = "value"): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (cause) {
    throw new TypeError(
      `${unkeptPath(value, at, []) ?? at} has no JSON form: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }
  return text === undefined ? undefined : JSON.parse(text);
}

/** A key that reads plainly after a dot in a path. */
const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/;

function propertyPath(at: string, key: string): string {
  return PLAIN_KEY.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`;
}

/**
 * Where `JSON.stringify(value)` fails, walked as it walks: through
 * `toJSON`, then each array element and each own enumerable property.
 * `undefined` when the walk finds no fault, so the caller names `at`.
 */
function unkeptPath(
  value: unknown,
  at: string,
  ancestors: unknown[]
): string | undefined {
  let current = value;
  try {
    const toJSON = (current as { toJSON?: unknown } | null | undefined)?.toJSON;
    if (typeof toJSON === "function") {
      current = toJSON.call(current);
    }
  } catch {
    return at;
  }
  if (typeof current === "bigint") {
    return at;
  }
  if (current === null || typeof current !== "object") {
    return;
  }
  if (ancestors.includes(current)) {
    return at;
  }
  ancestors.push(current);
  try {
    // Indices from the length alone: reading an element is the guarded read below.
    const keys = Array.isArray(current)
      ? Array.from({ length: current.length }, (_, index) => index)
      : Object.keys(current);
    for (const key of keys) {
      const path =
        typeof key === "number" ? `${at}[${key}]` : propertyPath(at, key);
      let item: unknown;
      try {
        item = (current as Record<string | number, unknown>)[key];
      } catch {
        return path;
      }
      const found = unkeptPath(item, path, ancestors);
      if (found !== undefined) {
        return found;
      }
    }
  } finally {
    ancestors.pop();
  }
}
