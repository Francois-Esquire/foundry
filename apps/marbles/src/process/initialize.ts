#!/usr/bin/env bun
import { initializeDatabase } from "~/database/open";
import { layout } from "~/layout";
import { envFilesLoaded } from "~/process/runtime";

async function main(): Promise<void> {
  const database = await initializeDatabase(layout().database);
  database.close();
}

try {
  const refusal = envFilesLoaded();
  if (refusal !== undefined) {
    throw new Error(refusal);
  }
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
}
process.exit(0);
