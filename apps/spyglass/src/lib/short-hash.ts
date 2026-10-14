import { createHash } from "node:crypto";

/** 16 hex digits of the SHA-256 of a value's JSON: the short fingerprints readiness and the rules share. */
export function hash16(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}
