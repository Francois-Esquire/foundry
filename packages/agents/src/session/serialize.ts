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

const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/;

function propertyPath(at: string, key: string): string {
  return PLAIN_KEY.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`;
}

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
