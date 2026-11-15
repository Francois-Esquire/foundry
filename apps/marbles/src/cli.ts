#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import { main } from "~/command-line";
import { envFilesLoaded } from "~/process/runtime";

/**
 * The `marbles` command: runs the command line whenever it loads, run
 * directly or imported by the package's `bin/marbles`. The commands, their
 * handlers and `main` are in `command-line.ts`, which a test can import.
 */

const refusal = envFilesLoaded();
if (refusal === undefined) {
  await main(fileURLToPath(import.meta.url));
} else {
  process.stderr.write(`marbles: ${refusal}\n`);
  process.exitCode = 1;
}
