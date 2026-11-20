#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import { main } from "~/cli/command-line";
import { envFilesLoaded } from "~/process/runtime";

const refusal = envFilesLoaded();
if (refusal === undefined) {
  await main(fileURLToPath(import.meta.url));
} else {
  process.stderr.write(`marbles: ${refusal}\n`);
  process.exitCode = 1;
}
