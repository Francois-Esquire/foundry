import { resolve } from "node:path";

/** Run the source CLI from any working directory without a build. */
export function cliArgs(...args: readonly string[]): string[] {
  return [resolve(import.meta.dirname, "../../src/cli.ts"), ...args];
}
