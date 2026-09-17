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
