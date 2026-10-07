import { createHash } from "node:crypto";

/** Synchronous SHA-256 hex, for building expected fixtures inline. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
