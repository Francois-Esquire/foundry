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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
