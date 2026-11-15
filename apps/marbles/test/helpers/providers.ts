import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gc } from "bun";
import { initializeDatabase } from "~/database/open";
import { DatabaseProviderStore } from "~/database/providers";
import { stateDatabase } from "~/layout";

/** The CLI providers a test machine is configured with, in preference order. */
const TEST_PROVIDERS = ["claude-code", "codex", "pi"] as const;

/**
 * Where the run's template database is: a Marbles database with
 * `TEST_PROVIDERS` configured for the machine and nothing else, made once
 * by the run's setup (`makeProvidersTemplate`).
 */
export const PROVIDERS_TEMPLATE_ENV = "MARBLES_TEST_PROVIDERS_DB";

/**
 * Make the template database in `dir`, closed and in one file, as a
 * machine that has been set up keeps it.
 */
export async function makeProvidersTemplate(
  dir: string,
  ids: readonly string[] = TEST_PROVIDERS
): Promise<string> {
  const file = join(dir, "providers-template.db");
  const opened = await initializeDatabase(file);
  try {
    await new DatabaseProviderStore({ database: opened.database }).update(
      undefined,
      () => ({
        machine: {
          providers: ids.map((id) => ({ enabled: true, id, plugin: id })),
          version: 1,
        },
      })
    );
  } finally {
    opened.close();
  }
  // libSQL lets the native connection go, and so checkpoints the WAL into
  // the file and removes it, only once its statements are collected.
  for (let attempt = 0; existsSync(`${file}-wal`); attempt += 1) {
    if (attempt === 20) {
      throw new Error(`the template database at ${file} kept its WAL file`);
    }
    gc(true);
    await new Promise((settle) => setTimeout(settle, 50));
  }
  return file;
}

/**
 * Configure the CLI providers for the whole machine at the Marbles state
 * root `state`, which has no database yet: a copy of the run's template.
 */
export function configureProviders(state: string): void {
  const template = process.env[PROVIDERS_TEMPLATE_ENV];
  if (template === undefined || !existsSync(template)) {
    throw new Error("configureProviders runs inside the suite's setup only");
  }
  mkdirSync(state, { recursive: true });
  copyFileSync(template, stateDatabase(state));
}
