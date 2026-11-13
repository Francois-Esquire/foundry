import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Lowercase hexadecimal SHA-256 of `text`'s UTF-8 encoding, synchronously
 * and in any runtime. Lone surrogates encode as U+FFFD, as Node's own UTF-8
 * conversion does, so the digest equals `createHash("sha256").update(text)`.
 */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}
