import crypto from "crypto";

/**
 * Calculate a SHA-256 hash for a string payload.
 * @param payload The string data to hash.
 * @returns The hex-encoded SHA-256 hash.
 */
export function calculateHash(payload: string): string {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

// Add other potential standalone utility functions here in the future
