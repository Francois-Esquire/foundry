#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import { runCli } from "~/cli/index";
import { envFilesLoaded } from "~/process/runtime";

const refusal = envFilesLoaded();
if (refusal === undefined) {
  await runCli(process.argv.slice(2), fileURLToPath(import.meta.url));
} else {
  process.stderr.write(`marbles: ${refusal}\n`);
  process.exitCode = 1;
}
