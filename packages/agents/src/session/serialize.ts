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
 * store writes and a model is sent. A function or stream inside it drops
 * out, and a `URL` or `Date` becomes its string, so a kept message never
 * holds what a store cannot copy. Throws when `value` has no JSON form (a
 * BigInt, a cycle).
 */
export function keptValue(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}
