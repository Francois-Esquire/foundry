import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { hasErrorCode } from "@foundry/lib/atomic-file";
import { generateId } from "ai";

/** Temp-and-rename, so a concurrent reader never sees a half-written file. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${generateId()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, path);
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

/** Kept for existing callers; new code imports `hasErrorCode` from `@foundry/lib/atomic-file`. */
export function hasCode(error: unknown, code: string): boolean {
  return hasErrorCode(error, code);
}

/**
 * JSON with sorted keys, so equal values hash equal. `undefined` reads as null.
 * For plain JSON data the output is byte-identical to `canonicalizeJson`
 * (`@foundry/lib/json`), which throws on `undefined` and non-plain objects
 * instead; switch a caller once nothing but plain data can reach it.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}
