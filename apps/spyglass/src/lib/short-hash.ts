import { sha256Hex } from "./sha256";

/** 16 hex digits of the SHA-256 of a value's JSON: the short fingerprints readiness and the rules share. */
export function hash16(value: unknown): string {
  return sha256Hex(JSON.stringify(value)).slice(0, 16);
}
