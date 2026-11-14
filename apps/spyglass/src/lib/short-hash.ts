import { sha256Hex } from "./sha256";

export function hash16(value: unknown): string {
  return sha256Hex(JSON.stringify(value)).slice(0, 16);
}
