import { resolve } from "node:path";

export function cliArgs(...args: readonly string[]): string[] {
  return [resolve(import.meta.dirname, "../../src/cli.ts"), ...args];
}
